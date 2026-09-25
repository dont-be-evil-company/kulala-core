import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { normalizeSentPayload } from "./display";
import type { KulalaWebSocketMessage } from "./messages";

export type WebSocketConnectOptions = {
  url: string;
  body?: string;
  headers?: Record<string, string>;
  /** When set, run this script instead of sending `body` once on open. */
  messages?: KulalaWebSocketMessage[];
  /** Bounds each `wait-for-server` step. Unset waits until a frame or close. */
  timeoutMs?: number;
};

type OutboundMessage =
  | { type: "ready" }
  | { type: "message"; data: string }
  | { type: "sent"; data: string }
  | { type: "waiting"; remaining: number }
  | { type: "script-done" }
  | { type: "error"; error: string }
  | { type: "closed"; code?: number };

function isEagain(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EAGAIN"
  );
}

/**
 * Compact NDJSON to stdout. Uses writeSync (same rationale as writePayloadToFd):
 * async process.stdout.write can deadlock / throw under parent pipe backpressure.
 */
function writeOutbound(msg: OutboundMessage): void {
  const buffer = Buffer.from(`${JSON.stringify(msg)}\n`);
  let offset = 0;
  while (offset < buffer.length) {
    try {
      const written = writeSync(1, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error("failed to write WebSocket outbound message");
      }
      offset += written;
    } catch (error) {
      if (isEagain(error)) continue;
      throw error;
    }
  }
}

/** DOM lib types only allow protocols as the 2nd arg; Bun accepts `{ headers }`. */
type BunClientWebSocket = {
  new (
    url: string | URL,
    options?: { headers?: Record<string, string> },
  ): WebSocket;
};

function openClientWebSocket(
  url: string,
  headers?: Record<string, string>,
): WebSocket {
  if (headers && Object.keys(headers).length > 0) {
    const Ws = WebSocket as unknown as BunClientWebSocket;
    return new Ws(url, { headers });
  }
  return new WebSocket(url);
}

function normalizeWsUrl(method: string, target: string): string {
  // Defensive: strip a trailing HTTP version if a caller passed a raw request line.
  const withoutVersion = target
    .replace(/\s+HTTP\/\d+(?:\.\d+)?\s*$/i, "")
    .trim();
  const t = withoutVersion;
  if (/^wss?:\/\//i.test(t)) return t;
  const scheme = method.toUpperCase() === "WSS" ? "wss" : "ws";
  return `${scheme}://${t}`;
}

function errorEventMessage(ev: Event): string {
  if (ev instanceof ErrorEvent) {
    if (ev.message) return ev.message;
    const nested = (ev as ErrorEvent & { error?: unknown }).error;
    if (nested instanceof Error && nested.message) return nested.message;
    if (typeof nested === "string" && nested) return nested;
  }
  return "WebSocket error";
}

function closeCodeHint(code: number): string {
  if (code === 1002) return "WebSocket handshake failed (protocol error)";
  if (code === 1006) return "WebSocket connection closed abnormally";
  return `WebSocket closed before handshake (code ${code})`;
}

/** Read HTTP status/body when the server rejects the WebSocket upgrade (e.g. 429 rate limit). */
async function describeHandshakeFailure(url: string): Promise<string> {
  const httpUrl = url.replace(/^ws/i, "http");
  try {
    const res = await fetch(httpUrl, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
      redirect: "manual",
    });
    if (res.status === 101) {
      return "WebSocket handshake failed unexpectedly";
    }
    const body = (await res.text()).trim();
    if (body) return `HTTP ${res.status}: ${body}`;
    return `HTTP ${res.status} (expected 101 Switching Protocols)`;
  } catch (e) {
    return e instanceof Error ? e.message : "WebSocket handshake failed";
  }
}

function isGenericHandshakeError(message: string): boolean {
  return (
    message === "WebSocket error" ||
    message.includes("Expected 101") ||
    message.includes("Unexpected server response")
  );
}

/**
 * Long-lived WebSocket session for kulala.nvim (replaces websocat).
 * Invoked via `kulala-core --websocket -i <connect.json>`.
 * Reads JSON lines from stdin: `{ "op": "send", "data": "..." }`, `{ "op": "close" }`.
 */
export async function runWebSocketSession(
  connect: WebSocketConnectOptions,
): Promise<void> {
  const url = normalizeWsUrl("WS", connect.url);

  await new Promise<void>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = openClientWebSocket(url, connect.headers);
    } catch (e) {
      reject(e);
      return;
    }

    const rl = createInterface({ input: process.stdin, terminal: false });
    let opened = false;
    let errorSent = false;
    let sessionClosed = false;
    let handshakeError: Promise<void> | undefined;
    const inbox: string[] = [];
    let inboxWaiter: (() => void) | null = null;
    const useScript = Array.isArray(connect.messages);

    const cleanup = () => {
      sessionClosed = true;
      inboxWaiter?.();
      inboxWaiter = null;
      rl.close();
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    const waitForInbox = (
      timeoutLeft: number | undefined,
    ): Promise<boolean> => {
      if (sessionClosed) return Promise.resolve(false);
      if (inbox.length > 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (inboxWaiter === onInbox) inboxWaiter = null;
          resolve(ok);
        };
        const onInbox = () => finish(!sessionClosed && inbox.length > 0);
        inboxWaiter = onInbox;
        if (inbox.length > 0 || sessionClosed) {
          finish(!sessionClosed && inbox.length > 0);
          return;
        }
        if (timeoutLeft !== undefined) {
          timer = setTimeout(() => finish(false), timeoutLeft);
        }
      });
    };

    const waitForServerMessages = async (
      count: number,
    ): Promise<"ok" | "timeout" | "closed"> => {
      let remaining = count;
      const deadline =
        connect.timeoutMs !== undefined
          ? Date.now() + connect.timeoutMs
          : undefined;
      writeOutbound({ type: "waiting", remaining });
      while (remaining > 0) {
        if (sessionClosed) return "closed";
        if (inbox.length > 0) {
          inbox.shift();
          remaining -= 1;
          if (remaining > 0) writeOutbound({ type: "waiting", remaining });
          continue;
        }
        const timeoutLeft =
          deadline !== undefined ? deadline - Date.now() : undefined;
        if (timeoutLeft !== undefined && timeoutLeft <= 0) {
          writeOutbound({
            type: "error",
            error: "Timed out waiting for server message",
          });
          return "timeout";
        }
        const woke = await waitForInbox(timeoutLeft);
        if (sessionClosed) return "closed";
        if (!woke) {
          writeOutbound({
            type: "error",
            error: "Timed out waiting for server message",
          });
          return "timeout";
        }
      }
      return "ok";
    };

    const runScript = async () => {
      if (!useScript) {
        if (connect.body && connect.body.trim()) sendPayload(connect.body);
        return;
      }
      for (const step of connect.messages ?? []) {
        if (sessionClosed) return;
        if (step.waitForServer > 0) {
          const status = await waitForServerMessages(step.waitForServer);
          if (status !== "ok") return;
        }
        if (sessionClosed) return;
        if (step.data.trim()) sendPayload(step.data);
      }
      if (!sessionClosed) writeOutbound({ type: "script-done" });
    };

    const emitHandshakeError = async (fallback: string): Promise<void> => {
      if (errorSent) return;
      errorSent = true;
      let message = fallback;
      if (isGenericHandshakeError(fallback)) {
        message = await describeHandshakeFailure(url);
      }
      writeOutbound({ type: "error", error: message });
    };

    const sendPayload = (data: string) => {
      if (sessionClosed || ws.readyState !== WebSocket.OPEN) return;
      const payload = data.endsWith("\n") ? data : data + "\n";
      ws.send(payload);
      writeOutbound({ type: "sent", data: normalizeSentPayload(data) });
    };

    ws.addEventListener("open", () => {
      opened = true;
      writeOutbound({ type: "ready" });
      void runScript();
    });

    ws.addEventListener("message", (ev) => {
      const data =
        typeof ev.data === "string"
          ? ev.data
          : ev.data instanceof ArrayBuffer
            ? new TextDecoder().decode(ev.data)
            : String(ev.data);
      writeOutbound({ type: "message", data });
      inbox.push(data);
      inboxWaiter?.();
    });

    ws.addEventListener("error", (ev) => {
      handshakeError = emitHandshakeError(errorEventMessage(ev));
    });

    ws.addEventListener("close", (ev) => {
      sessionClosed = true;
      inboxWaiter?.();
      void (async () => {
        if (!opened) {
          if (handshakeError) {
            await handshakeError;
          } else if (!errorSent) {
            await emitHandshakeError(closeCodeHint(ev.code));
          }
        }
        writeOutbound({ type: "closed", code: ev.code });
        cleanup();
        resolve();
      })();
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const cmd = JSON.parse(trimmed) as { op?: string; data?: string };
        if (cmd.op === "close") {
          ws.close();
          cleanup();
          resolve();
          return;
        }
        if (cmd.op === "send" && cmd.data != null) {
          sendPayload(cmd.data);
        }
      } catch {
        writeOutbound({ type: "error", error: "Invalid stdin command JSON" });
      }
    });

    // Do not close the socket when stdin hits EOF. Neovim (and other parents) may
    // deliver EOF before the stdin pipe is fully wired; closing here disconnects
    // immediately with no echoed messages. Shutdown is driven by `{ op: "close" }`
    // or process termination.
  });
}

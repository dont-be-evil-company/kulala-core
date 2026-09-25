import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type OutboundMessage = {
  type: string;
  data?: string;
  error?: string;
  code?: number;
};

class StdoutCollector {
  readonly events: OutboundMessage[] = [];
  private buf = "";
  private readonly waiters: Array<() => void> = [];
  private done = false;
  private readonly pump: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.pump = this.read(stream);
  }

  private notify(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  private async read(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this.events.push(JSON.parse(line) as OutboundMessage);
        }
        this.notify();
      }
    } finally {
      this.done = true;
      this.notify();
    }
  }

  async waitUntil(
    predicate: (events: OutboundMessage[]) => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (this.done) {
        throw new Error(
          `stdout ended before ${label}; events=${JSON.stringify(this.events)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for ${label}; events=${JSON.stringify(this.events)}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async finish(): Promise<OutboundMessage[]> {
    await this.pump;
    return this.events;
  }
}

describe("runWebSocketSession", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("emits sent for initial body and stdin send", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("Upgrade failed", { status: 500 });
      },
      websocket: {
        open() {},
        message(ws, message) {
          ws.send(String(message));
        },
      },
    });

    const dir = mkdtempSync(join(tmpdir(), "kulala-ws-test-"));
    const connectFile = join(dir, "connect.json");
    writeFileSync(
      connectFile,
      JSON.stringify({
        url: `ws://127.0.0.1:${server.port}`,
        body: '{"name":"world"}',
      }),
    );

    const cliPath = join(import.meta.dir, "../../cli.ts");
    const child = Bun.spawn(
      ["bun", "run", cliPath, "--websocket", "-i", connectFile],
      {
        cwd: join(import.meta.dir, "../../../../../"),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stderrChunks: string[] = [];
    void child.stderr.pipeTo(
      new WritableStream({
        write(chunk) {
          stderrChunks.push(new TextDecoder().decode(chunk));
        },
      }),
    );

    const collector = new StdoutCollector(child.stdout);

    try {
      await collector.waitUntil(
        (events) =>
          events.some((e) => e.type === "ready") &&
          events.filter((e) => e.type === "sent").length >= 1 &&
          events.filter((e) => e.type === "message").length >= 1,
        "initial sent+echo",
      );

      child.stdin.write(
        `${JSON.stringify({ op: "send", data: '{"foo":1}' })}\n`,
      );

      await collector.waitUntil(
        (events) =>
          events.filter((e) => e.type === "sent").length >= 2 &&
          events.filter((e) => e.type === "message").length >= 2,
        "stdin sent+echo",
      );

      child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
      child.stdin.end();

      await collector.waitUntil(
        (events) => events.some((e) => e.type === "closed"),
        "closed",
      );
    } catch (error) {
      child.kill();
      const stderr = stderrChunks.join("").trim();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${
          stderr ? `\nstderr: ${stderr}` : ""
        }`,
      );
    }

    const events = await collector.finish();
    const exitCode = await child.exited;
    expect(exitCode).toBe(0);

    expect(events.map((e) => e.type)).toEqual([
      "ready",
      "sent",
      "message",
      "sent",
      "message",
      "closed",
    ]);
    expect(events.filter((e) => e.type === "sent").map((e) => e.data)).toEqual([
      '{"name":"world"}',
      '{"foo":1}',
    ]);
  }, 15000);

  async function startSession(
    connect: Record<string, unknown>,
    serverPort: number | undefined,
  ) {
    if (serverPort === undefined) {
      throw new Error("WebSocket test server has no port");
    }
    const dir = mkdtempSync(join(tmpdir(), "kulala-ws-test-"));
    const connectFile = join(dir, "connect.json");
    writeFileSync(
      connectFile,
      JSON.stringify({ url: `ws://127.0.0.1:${serverPort}`, ...connect }),
    );
    const cliPath = join(import.meta.dir, "../../cli.ts");
    const child = Bun.spawn(
      ["bun", "run", cliPath, "--websocket", "-i", connectFile],
      {
        cwd: join(import.meta.dir, "../../../../../"),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderrChunks: string[] = [];
    void child.stderr.pipeTo(
      new WritableStream({
        write(chunk) {
          stderrChunks.push(new TextDecoder().decode(chunk));
        },
      }),
    );
    return {
      child,
      collector: new StdoutCollector(child.stdout),
      stderr: () => stderrChunks.join("").trim(),
    };
  }

  test("waits for a server frame before the next scripted send", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("Upgrade failed", { status: 500 });
      },
      websocket: {
        open() {},
        message(ws, message) {
          const text = String(message);
          if (text.includes("ping")) {
            setTimeout(() => ws.send("pong"), 80);
          }
        },
      },
    });

    const { child, collector, stderr } = await startSession(
      {
        messages: [
          { waitForServer: 0, data: '{"op":"ping"}' },
          { waitForServer: 1, data: '{"op":"after"}' },
        ],
        timeoutMs: 5000,
      },
      server.port,
    );

    try {
      await collector.waitUntil(
        (events) => events.some((e) => e.type === "script-done"),
        "script-done",
      );
      child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
      child.stdin.end();
      await collector.waitUntil(
        (events) => events.some((e) => e.type === "closed"),
        "closed",
      );
    } catch (error) {
      child.kill();
      const errText = stderr();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${
          errText ? `\nstderr: ${errText}` : ""
        }`,
      );
    }

    const events = await collector.finish();
    expect(await child.exited).toBe(0);
    const pingIdx = events.findIndex(
      (e) => e.type === "sent" && e.data?.includes("ping"),
    );
    const pongIdx = events.findIndex(
      (e) => e.type === "message" && e.data?.includes("pong"),
    );
    const afterIdx = events.findIndex(
      (e) => e.type === "sent" && e.data?.includes("after"),
    );
    expect(pingIdx).toBeGreaterThanOrEqual(0);
    expect(pongIdx).toBeGreaterThan(pingIdx);
    expect(afterIdx).toBeGreaterThan(pongIdx);
    expect(events.some((e) => e.type === "waiting")).toBe(true);
  }, 15000);

  test("sends plain === messages without waiting", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("Upgrade failed", { status: 500 });
      },
      websocket: {
        open() {},
        message() {},
      },
    });

    const { child, collector, stderr } = await startSession(
      {
        messages: [
          { waitForServer: 0, data: "one" },
          { waitForServer: 0, data: "two" },
        ],
      },
      server.port,
    );

    try {
      await collector.waitUntil(
        (events) =>
          events.filter((e) => e.type === "sent").length >= 2 &&
          events.some((e) => e.type === "script-done"),
        "both sent",
      );
      const sentDone = collector.events.findIndex(
        (e) => e.type === "script-done",
      );
      const waitingBeforeDone = collector.events
        .slice(0, sentDone)
        .some((e) => e.type === "waiting");
      expect(waitingBeforeDone).toBe(false);
      child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
      child.stdin.end();
      await collector.waitUntil(
        (events) => events.some((e) => e.type === "closed"),
        "closed",
      );
    } catch (error) {
      child.kill();
      const errText = stderr();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${
          errText ? `\nstderr: ${errText}` : ""
        }`,
      );
    }

    const events = await collector.finish();
    expect(await child.exited).toBe(0);
    expect(events.filter((e) => e.type === "sent").map((e) => e.data)).toEqual([
      "one",
      "two",
    ]);
  }, 15000);

  test("stacked wait-for-server consumes that many inbound frames", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("Upgrade failed", { status: 500 });
      },
      websocket: {
        open() {},
        message(ws, message) {
          if (!String(message).includes("start")) return;
          ws.send("1");
          ws.send("2");
          setTimeout(() => ws.send("3"), 40);
        },
      },
    });

    const { child, collector, stderr } = await startSession(
      {
        messages: [
          { waitForServer: 0, data: "start" },
          { waitForServer: 3, data: "done" },
        ],
        timeoutMs: 5000,
      },
      server.port,
    );

    try {
      await collector.waitUntil(
        (events) => events.some((e) => e.type === "script-done"),
        "script-done",
      );
      child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
      child.stdin.end();
      await collector.waitUntil(
        (events) => events.some((e) => e.type === "closed"),
        "closed",
      );
    } catch (error) {
      child.kill();
      const errText = stderr();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${
          errText ? `\nstderr: ${errText}` : ""
        }`,
      );
    }

    const events = await collector.finish();
    expect(await child.exited).toBe(0);
    const third = events.findIndex(
      (e) => e.type === "message" && e.data?.includes("3"),
    );
    const done = events.findIndex(
      (e) => e.type === "sent" && e.data === "done",
    );
    expect(third).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(third);
  }, 15000);

  test("times out a wait and still accepts a later manual send", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("Upgrade failed", { status: 500 });
      },
      websocket: {
        open() {},
        message() {},
      },
    });

    const { child, collector, stderr } = await startSession(
      {
        messages: [
          { waitForServer: 0, data: "hello" },
          { waitForServer: 1, data: "never" },
        ],
        timeoutMs: 200,
      },
      server.port,
    );

    try {
      await collector.waitUntil(
        (events) =>
          events.some(
            (e) =>
              e.type === "error" &&
              e.error === "Timed out waiting for server message",
          ),
        "timeout error",
      );
      expect(collector.events.some((e) => e.type === "script-done")).toBe(
        false,
      );
      expect(
        collector.events.some((e) => e.type === "sent" && e.data === "never"),
      ).toBe(false);

      child.stdin.write(`${JSON.stringify({ op: "send", data: "manual" })}\n`);
      await collector.waitUntil(
        (events) =>
          events.some((e) => e.type === "sent" && e.data === "manual"),
        "manual send",
      );
      child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
      child.stdin.end();
      await collector.waitUntil(
        (events) => events.some((e) => e.type === "closed"),
        "closed",
      );
    } catch (error) {
      child.kill();
      const errText = stderr();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${
          errText ? `\nstderr: ${errText}` : ""
        }`,
      );
    }

    expect(await child.exited).toBe(0);
    await collector.finish();
  }, 15000);
});

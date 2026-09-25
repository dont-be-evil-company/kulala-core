import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import type {
  HttpRequestOptions,
  HttpRequestResponse,
  HttpRequestTimings,
} from "./http-client";
import { resolveCurlPath } from "./embedded-curl";
import { performance } from "node:perf_hooks";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { headersFromDump } from "../curl/headers-dump";
import { emitHttpStreamEvent, type HttpStreamSink } from "./http-stream";
import {
  cookieAppliesToRequest,
  getCookiePairsForRequest,
  parseCookieHeaderValue,
  selectCookieHeaderCandidates,
  type CookieHeaderCandidate,
  type NormalizedSetCookie,
  normalizeSetCookieFromLine,
} from "../persistence";

type CurlWriteOut = {
  http_code: number;
  url_effective: string;
  time_namelookup: number;
  time_connect: number;
  time_appconnect: number;
  time_pretransfer: number;
  time_starttransfer: number;
  time_total: number;
  time_redirect: number;
};

function parseCurlWriteOut(stdout: string): CurlWriteOut {
  const out: Partial<Record<keyof CurlWriteOut, string>> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq) as keyof CurlWriteOut;
    const v = line.slice(eq + 1);
    out[k] = v;
  }

  const num = (k: keyof CurlWriteOut): number => {
    const raw = out[k];
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    http_code: Math.trunc(num("http_code")),
    url_effective: out.url_effective ?? "",
    time_namelookup: num("time_namelookup"),
    time_connect: num("time_connect"),
    time_appconnect: num("time_appconnect"),
    time_pretransfer: num("time_pretransfer"),
    time_starttransfer: num("time_starttransfer"),
    time_total: num("time_total"),
    time_redirect: num("time_redirect"),
  };
}

function secondsToMs(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0) return 0;
  return sec * 1000;
}

function buildCookieHeaderForRedirect(
  nextUrl: string,
  opts: {
    cookieJarEnabled: boolean;
    initialRequestUrl: string;
    initialCookieHeader: string | undefined;
    absorbedCookies: NormalizedSetCookie[];
  },
): string | undefined {
  const candidates: CookieHeaderCandidate[] = [];
  let seq = 0;

  if (opts.cookieJarEnabled) {
    for (const c of getCookiePairsForRequest(nextUrl)) {
      candidates.push({
        name: c.name,
        value: c.value,
        path: c.path,
        tier: 0,
        seq: seq++,
      });
    }
  }

  const nextHost = new URL(nextUrl).hostname.toLowerCase();
  const initialHost = new URL(opts.initialRequestUrl).hostname.toLowerCase();
  if (nextHost === initialHost && opts.initialCookieHeader) {
    for (const [name, value] of Object.entries(
      parseCookieHeaderValue(opts.initialCookieHeader),
    )) {
      candidates.push({
        name,
        value,
        path: "",
        tier: 1,
        seq: seq++,
      });
    }
  }

  for (const c of opts.absorbedCookies) {
    if (cookieAppliesToRequest(c, nextUrl)) {
      candidates.push({
        name: c.name,
        value: c.value,
        path: c.path,
        tier: 2,
        seq: seq++,
      });
    }
  }

  return selectCookieHeaderCandidates(candidates);
}

function stripCookieHeader(headers: Record<string, string>): void {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "cookie") delete headers[k];
  }
}

import { curlHeaderArg } from "../curl/format";

/** Whether curl needs an explicit `--request` / `-X` (avoids verbose "already inferred" notes). */
export function curlNeedsRequestFlag(
  method: string,
  hasBody: boolean,
): boolean {
  if (method === "GET" && !hasBody) return false;
  if (method === "POST" && hasBody) return false;
  return true;
}

function buildTimings(w: CurlWriteOut): HttpRequestTimings {
  const dns = secondsToMs(w.time_namelookup);
  const connect = secondsToMs(w.time_connect);
  const appconnect = secondsToMs(w.time_appconnect);
  const pretransfer = secondsToMs(w.time_pretransfer);
  const startTransfer = secondsToMs(w.time_starttransfer);
  const total = secondsToMs(w.time_total);
  const redirect = secondsToMs(w.time_redirect);

  const tcp = Math.max(0, connect - dns);
  const tls =
    appconnect > 0 && connect > 0 ? Math.max(0, appconnect - connect) : 0;

  // Approximate: pretransfer is "ready to transfer"; treat it as request time.
  // Then firstByte = startTransfer - pretransfer (server think + network to first byte).
  const request = Math.max(0, pretransfer - (dns + tcp + tls));
  const firstByte = Math.max(0, startTransfer - pretransfer);

  return {
    phases: {
      dns,
      tcp,
      tls,
      request,
      firstByte,
      startTransfer,
      redirect,
      total,
    },
  };
}

async function spawnCurl(args: string[]): Promise<ChildProcess> {
  const curlPath = await resolveCurlPath();
  const env = { ...process.env };
  if (!env.CURL_CA_BUNDLE) {
    try {
      const ca = join(dirname(curlPath), "curl-ca-bundle.crt");
      await access(ca, fsConstants.R_OK);
      env.CURL_CA_BUNDLE = ca;
    } catch {
      // ignore
    }
  }
  return spawn(curlPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

const activeStreamingCurl = new Set<ChildProcess>();
let streamingCurlHooks = 0;

function killStreamingCurl(signal: NodeJS.Signals): void {
  for (const child of activeStreamingCurl) {
    try {
      child.kill(signal);
    } catch {
      // already exited
    }
  }
}

function onStreamingSigTerm(): void {
  killStreamingCurl("SIGTERM");
  process.exit(143);
}

function onStreamingSigInt(): void {
  killStreamingCurl("SIGINT");
  process.exit(130);
}

/** While a keep-alive curl is running, cancel signals must reap it too. */
function trackStreamingCurl(child: ChildProcess): void {
  activeStreamingCurl.add(child);
  if (streamingCurlHooks === 0) {
    process.on("SIGTERM", onStreamingSigTerm);
    process.on("SIGINT", onStreamingSigInt);
  }
  streamingCurlHooks++;
  const untrack = (): void => {
    if (!activeStreamingCurl.delete(child)) return;
    streamingCurlHooks--;
    if (streamingCurlHooks === 0) {
      process.off("SIGTERM", onStreamingSigTerm);
      process.off("SIGINT", onStreamingSigInt);
    }
  };
  child.on("close", untrack);
  child.on("error", untrack);
}

async function runCurl(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const child = await spawnCurl(args);
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    throw new Error("curl stdio pipes were not created");
  }
  return await new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 0,
      });
    });
  });
}

export type KulalaCurlArgsInput = {
  method: string;
  url: string;
  headers: Record<string, string>;
  headerPath: string;
  bodyPath: string;
  writeOut: string;
  extra: string[];
  timeoutSec?: number;
  connectionTimeoutSec?: number;
  insecure?: boolean;
  httpVersion?: HttpRequestOptions["httpVersion"];
  stream: boolean;
  uploadPath?: string;
};

/** Curl argv for one hop. Streaming puts the body on stdout and forces `-N`. */
export function buildKulalaCurlArgs(input: KulalaCurlArgsInput): string[] {
  const args: string[] = [
    "--silent",
    "--verbose",
    "--show-error",
    "--dump-header",
    input.headerPath,
  ];
  if (!input.stream) {
    args.push("--output", input.bodyPath);
  }
  args.push("--write-out", input.writeOut);

  const hasBody = input.uploadPath !== undefined;
  if (input.method === "HEAD") {
    args.push("--head");
  } else if (curlNeedsRequestFlag(input.method, hasBody)) {
    args.push("--request", input.method);
  }

  const extra = input.extra;
  if (
    input.timeoutSec !== undefined &&
    Number.isFinite(input.timeoutSec) &&
    !extra.includes("--max-time")
  ) {
    args.push("--max-time", String(Math.max(0, input.timeoutSec)));
  }
  if (
    input.connectionTimeoutSec !== undefined &&
    Number.isFinite(input.connectionTimeoutSec) &&
    !extra.includes("--connect-timeout")
  ) {
    args.push(
      "--connect-timeout",
      String(Math.max(0, input.connectionTimeoutSec)),
    );
  }
  if (
    input.insecure &&
    !extra.includes("--insecure") &&
    !extra.includes("-k")
  ) {
    args.push("--insecure");
  }
  if (extra.length > 0) args.push(...extra);

  if (input.httpVersion === "HTTP/1.0") args.push("--http1.0");
  else if (input.httpVersion === "HTTP/1.1") args.push("--http1.1");
  else if (input.httpVersion === "HTTP/2") {
    const parsed = new URL(input.url);
    if (parsed.protocol === "https:") {
      args.push("--http2");
    } else if (parsed.protocol === "http:") {
      args.push("--http2-prior-knowledge");
    } else {
      throw new Error("HTTP/2 is only supported for http/https URLs");
    }
  }

  for (const [k, v] of Object.entries(input.headers)) {
    args.push("--header", curlHeaderArg(k, v));
  }

  if (input.uploadPath) {
    args.push("--data-binary", `@${input.uploadPath}`);
  }

  if (input.stream) {
    args.push("--output", "-");
    if (!args.includes("-N") && !args.includes("--no-buffer")) {
      args.push("-N");
    }
  }

  args.push(input.url);
  return args;
}

function dumpHeadersReady(dump: string, force: boolean): boolean {
  if (!dump.includes("HTTP/")) return false;
  if (force) return true;
  return /\r?\n\r?\n/.test(dump);
}

async function readHeaderDump(
  headerPath: string,
  force: boolean,
): Promise<string | undefined> {
  try {
    const dump = await fs.readFile(headerPath, "utf-8");
    if (!dumpHeadersReady(dump, force)) return undefined;
    return dump;
  } catch {
    return undefined;
  }
}

async function runCurlStreaming(opts: {
  args: string[];
  headerPath: string;
  stream: HttpStreamSink;
  currentUrl: string;
  followRedirects: boolean;
  redirectStatuses: Set<number>;
}): Promise<{ stderr: string; exitCode: number; body: Buffer<ArrayBuffer> }> {
  const child = await spawnCurl(opts.args);
  trackStreamingCurl(child);
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill("SIGTERM");
    throw new Error("curl stdio pipes were not created");
  }

  const stderrChunks: Buffer[] = [];
  const rawBody: Buffer[] = [];
  let held = Buffer.alloc(0);
  let headersReady = false;
  let suppressEvents = false;
  let decoder: TextDecoder | null = null;
  let headerChain: Promise<void> = Promise.resolve();
  let poll: ReturnType<typeof setInterval> | undefined;
  const stopPoll = (): void => {
    if (!poll) return;
    clearInterval(poll);
    poll = undefined;
  };

  const emitChunk = (chunk: Buffer, final: boolean): void => {
    if (suppressEvents || !headersReady) return;
    decoder ??= new TextDecoder("utf-8", { fatal: false });
    const text = decoder.decode(chunk, { stream: !final });
    if (!text) return;
    emitHttpStreamEvent(opts.stream, { event: "chunk", data: text });
  };

  const tryHeaders = async (force: boolean): Promise<void> => {
    if (headersReady) return;
    const dump = await readHeaderDump(opts.headerPath, force);
    if (!dump || headersReady) return;
    const parsed = headersFromDump(dump);
    const location = parsed.headers["location"];
    const isRedirect =
      opts.followRedirects &&
      opts.redirectStatuses.has(parsed.statusCode) &&
      !!location;
    headersReady = true;
    stopPoll();
    const snapshot = held;
    held = Buffer.alloc(0);
    if (isRedirect) {
      suppressEvents = true;
      return;
    }
    emitHttpStreamEvent(opts.stream, {
      event: "headers",
      status: parsed.statusCode,
      ...(parsed.httpVersion ? { httpVersion: parsed.httpVersion } : {}),
      headers: parsed.headers,
      url: opts.currentUrl,
    });
    if (snapshot.length > 0) emitChunk(snapshot, false);
  };

  const scheduleHeaders = (force: boolean): void => {
    headerChain = headerChain.then(() => tryHeaders(force));
  };

  stderr.on("data", (c: Buffer) => stderrChunks.push(c));
  stdout.on("data", (c: Buffer) => {
    rawBody.push(c);
    if (!headersReady) {
      held = Buffer.concat([held, c]);
      scheduleHeaders(false);
      return;
    }
    if (!suppressEvents) emitChunk(c, false);
  });

  poll = setInterval(() => {
    if (headersReady) {
      stopPoll();
      return;
    }
    scheduleHeaders(false);
  }, 20);
  if (typeof poll.unref === "function") poll.unref();

  const exitCode = await new Promise<number>((resolve, reject) => {
    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      stopPoll();
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      stopPoll();
      resolve(signal ? 1 : (code ?? 0));
    });
  });

  await headerChain;
  await tryHeaders(true);
  if (!suppressEvents && headersReady) emitChunk(Buffer.alloc(0), true);

  return {
    stderr: Buffer.concat(stderrChunks).toString("utf-8"),
    exitCode,
    body: Buffer.concat(rawBody),
  };
}

export async function curlHttpRequest(
  options: HttpRequestOptions,
): Promise<HttpRequestResponse> {
  const MAX_REDIRECTS = 10;
  const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
  const followRedirects = options.followRedirects !== false;

  const wallStart = performance.now();
  let redirectTime = 0;
  let elapsedBeforeFinal = 0;

  let currentUrl = options.url;
  let currentMethod = (options.method || "GET").toUpperCase();
  let currentHeaders = { ...(options.headers ?? {}) };
  let currentBody: string | Buffer | undefined = options.body as
    | string
    | Buffer
    | undefined;

  const chain: NonNullable<HttpRequestResponse["redirectChain"]> = [];

  // Browser-like cookies across redirect hops: Set-Cookie Domain/Path/Secure are respected;
  // the initial request Cookie header is only replayed when the next hop is the same host;
  // the persistent jar is consulted per hop when enabled.
  const propagateCookies = options.propagateCookiesOnRedirect !== false;
  const cookieJarEnabled = options.cookieJarEnabled !== false;
  const initialRequestUrl = options.url;
  const initialCookieHeader = (() => {
    const key = Object.keys(currentHeaders).find(
      (k) => k.toLowerCase() === "cookie",
    );
    return key ? currentHeaders[key] : undefined;
  })();
  const absorbedCookies: NormalizedSetCookie[] = [];

  const absorbSetCookieFromResponse = (
    headers: Record<string, string>,
    responseUrl: string,
  ): void => {
    const raw = headers["set-cookie"];
    if (!raw) return;
    const lines = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      const n = normalizeSetCookieFromLine(line, responseUrl);
      if (n) absorbedCookies.push(n);
    }
  };

  const requestOnce = async (): Promise<HttpRequestResponse> => {
    const tempBase = await fs.mkdtemp(join(tmpdir(), "kulala-curl-"));
    const bodyPath = join(tempBase, `body-${randomUUID()}`);
    const headerPath = join(tempBase, `headers-${randomUUID()}`);
    const cleanup = async (): Promise<void> => {
      await fs.rm(tempBase, { recursive: true, force: true });
    };

    const writeOutBody = [
      "http_code=%{http_code}",
      "url_effective=%{url_effective}",
      "time_namelookup=%{time_namelookup}",
      "time_connect=%{time_connect}",
      "time_appconnect=%{time_appconnect}",
      "time_pretransfer=%{time_pretransfer}",
      "time_starttransfer=%{time_starttransfer}",
      "time_total=%{time_total}",
      "time_redirect=%{time_redirect}",
      "",
    ].join("\n");
    const streaming = options.stream != null;
    const writeOutPath = join(tempBase, `writeout-${randomUUID()}`);
    // `%output{file}` (curl >= 8.3) keeps timings off the body stream.
    const writeOut = streaming
      ? `%output{${writeOutPath}}${writeOutBody}`
      : writeOutBody;

    const hasBody = currentBody !== undefined;
    let uploadPath: string | undefined;
    if (hasBody) {
      const body =
        typeof currentBody === "string" || Buffer.isBuffer(currentBody)
          ? currentBody
          : Buffer.from(String(currentBody));
      uploadPath = join(tempBase, `upload-${randomUUID()}`);
      await fs.writeFile(uploadPath, body);
    }

    const args = buildKulalaCurlArgs({
      method: currentMethod,
      url: currentUrl,
      headers: currentHeaders,
      headerPath,
      bodyPath,
      writeOut,
      extra: options.extraCurlArgv ?? [],
      timeoutSec: options.timeoutSec,
      connectionTimeoutSec: options.connectionTimeoutSec,
      insecure: options.insecure,
      httpVersion: options.httpVersion,
      stream: streaming,
      uploadPath,
    });

    try {
      let stderr: string;
      let exitCode: number;
      let body = Buffer.alloc(0);
      let writeOutText: string;
      if (streaming) {
        const exec = await runCurlStreaming({
          args,
          headerPath,
          stream: options.stream!,
          currentUrl,
          followRedirects,
          redirectStatuses: REDIRECT_STATUSES,
        });
        stderr = exec.stderr;
        exitCode = exec.exitCode;
        body = exec.body;
        try {
          writeOutText = await fs.readFile(writeOutPath, "utf-8");
        } catch {
          writeOutText = "";
        }
      } else {
        const exec = await runCurl(args);
        stderr = exec.stderr;
        exitCode = exec.exitCode;
        writeOutText = exec.stdout;
      }
      if (exitCode !== 0) {
        const msg = stderr.trim() || `curl failed with exit code ${exitCode}`;
        if (streaming && options.stream) {
          emitHttpStreamEvent(options.stream, { event: "error", error: msg });
        }
        throw new Error(msg);
      }
      if (!streaming) {
        body = await fs.readFile(bodyPath);
      }

      const w = parseCurlWriteOut(writeOutText);
      const dump = await fs.readFile(headerPath, "utf-8");
      const { statusCode, headers, httpVersion } = headersFromDump(dump);
      const timings = buildTimings(w);
      return {
        statusCode: statusCode || w.http_code || 0,
        headers,
        body,
        timings,
        url: w.url_effective || currentUrl,
        firstByteTime: 0,
        verboseTrace: stderr,
        ...(httpVersion ? { httpVersion } : {}),
      };
    } finally {
      await cleanup();
    }
  };

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await requestOnce();
    if (propagateCookies) absorbSetCookieFromResponse(res.headers, res.url);
    chain.push({
      statusCode: res.statusCode,
      headers: res.headers,
      body: res.body,
      timings: res.timings,
      url: res.url,
      verboseTrace: res.verboseTrace,
      ...(res.httpVersion ? { httpVersion: res.httpVersion } : {}),
    });

    const location = res.headers["location"];
    const isRedirect =
      followRedirects && REDIRECT_STATUSES.has(res.statusCode) && !!location;

    if (!isRedirect) {
      // Aggregate redirect + wall-clock total across hops.
      const wallTotal = performance.now() - wallStart;
      elapsedBeforeFinal = wallTotal - (res.timings.phases.total ?? 0);

      const phases = { ...res.timings.phases };
      phases.redirect = redirectTime;
      phases.total = wallTotal;
      // Adjust startTransfer to include time spent in previous hops (best-effort).
      phases.startTransfer =
        (phases.startTransfer ?? 0) > 0
          ? elapsedBeforeFinal + (phases.startTransfer ?? 0)
          : phases.startTransfer;
      res.timings.phases = phases;

      // Only expose a chain when there was at least one redirect (multiple hops).
      // A single-hop response is not a "redirect chain" for API consumers.
      return {
        ...res,
        ...(chain.length > 1 ? { redirectChain: chain } : {}),
        verboseTrace: res.verboseTrace,
        url: res.url,
      };
    }

    if (i === MAX_REDIRECTS) {
      throw new Error(`Maximum redirects (${MAX_REDIRECTS}) exceeded`);
    }

    redirectTime += res.timings.phases.total ?? 0;

    currentUrl = new URL(location!, currentUrl).href;

    if (propagateCookies) {
      const built = buildCookieHeaderForRedirect(currentUrl, {
        cookieJarEnabled,
        initialRequestUrl,
        initialCookieHeader,
        absorbedCookies,
      });
      stripCookieHeader(currentHeaders);
      if (built) currentHeaders.Cookie = built;
    }

    if (
      (res.statusCode === 301 ||
        res.statusCode === 302 ||
        res.statusCode === 303) &&
      !(currentMethod === "POST" && currentBody !== undefined)
    ) {
      // Historically many clients switch POST to GET for 301/302/303.
      // However, GraphQL endpoints frequently redirect and require the POST body.
      // Preserve POST+body by default; only switch for non-POST or bodyless requests.
      currentMethod = "GET";
      currentBody = undefined;
      currentHeaders = Object.fromEntries(
        Object.entries(currentHeaders).filter(
          ([k]) =>
            k.toLowerCase() !== "content-length" &&
            k.toLowerCase() !== "content-type",
        ),
      );
    }
  }

  throw new Error(`Maximum redirects (${MAX_REDIRECTS}) exceeded`);
}

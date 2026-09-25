import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  createServer as createHttp2Server,
  type Http2Server,
  type ServerHttp2Stream,
} from "node:http2";
import { closeDb, getDbInMemory, setDbForTesting } from "../persistence";
import { httpRequest } from "./http-client";
import { buildKulalaCurlArgs, curlNeedsRequestFlag } from "./curl-transport";
import type { HttpStreamEvent } from "./http-stream";
import { resolveCurlPath } from "./embedded-curl";

async function hasCurl(): Promise<boolean> {
  try {
    await resolveCurlPath();
    return true;
  } catch {
    return false;
  }
}

function listenHttp(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no address"));
    });
  });
}

function listenHttp2(server: Http2Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no address"));
    });
  });
}

describe("curl transport", () => {
  beforeEach(() => {
    setDbForTesting(getDbInMemory());
  });

  afterEach(() => {
    closeDb();
  });

  test("forces HTTP/1.0 when requested", async () => {
    if (!(await hasCurl())) return;

    let seenVersion: string | undefined;
    const server = createServer((req, res) => {
      seenVersion = req.httpVersion;
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });
    const port = await listenHttp(server);

    const res = await httpRequest({
      url: `http://127.0.0.1:${port}/`,
      method: "GET",
      headers: {},
      httpVersion: "HTTP/1.0",
    });

    server.close();
    expect(res.statusCode).toBe(200);
    expect(seenVersion).toBe("1.0");
    expect(res.redirectChain).toBeUndefined();
  });

  test("follows redirects and returns final url", async () => {
    if (!(await hasCurl())) return;

    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.statusCode = 302;
        res.setHeader("location", "/final");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("final");
    });
    const port = await listenHttp(server);

    const res = await httpRequest({
      url: `http://127.0.0.1:${port}/`,
      method: "GET",
      headers: {},
    });

    server.close();
    expect(res.statusCode).toBe(200);
    expect(res.url).toContain("/final");
    expect(res.redirectChain?.length).toBe(2);
    expect(res.redirectChain?.[0]?.statusCode).toBe(302);
    expect(res.redirectChain?.[1]?.statusCode).toBe(200);
    expect(res.timings.phases.redirect).toBeGreaterThanOrEqual(0);
    expect(res.timings.phases.total).toBeGreaterThanOrEqual(0);
  });

  test("keeps POST body across 301/302/303 redirects (GraphQL-style)", async () => {
    if (!(await hasCurl())) return;

    const server = createServer(async (req, res) => {
      if (req.url === "/start") {
        res.statusCode = 302;
        res.setHeader("location", "/graphql");
        res.end();
        return;
      }
      if (req.url === "/graphql") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (req.method !== "POST" || raw.trim() === "") {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ errors: [{ message: "Missing body" }] }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const port = await listenHttp(server);
    const res = await httpRequest({
      url: `http://127.0.0.1:${port}/start`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { __typename }" }),
    });

    server.close();
    expect(res.statusCode).toBe(200);
  });

  test("supports HTTP/2 (h2c prior knowledge) locally", async () => {
    if (!(await hasCurl())) return;

    const server = createHttp2Server();
    server.on("stream", (stream: ServerHttp2Stream) => {
      stream.respond({ ":status": 200, "content-type": "text/plain" });
      stream.end("h2");
    });
    const port = await listenHttp2(server);

    try {
      const res = await httpRequest({
        url: `http://127.0.0.1:${port}/`,
        method: "GET",
        headers: {},
        httpVersion: "HTTP/2",
      });

      expect(res.statusCode).toBe(200);
      expect(res.timings.phases.total).toBeGreaterThanOrEqual(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // INFO:
      // curl h2c prior knowledge against Node's http2 server is flaky on some nghttp2 builds.
      if (!msg.includes("nghttp2 recv error")) throw err;
    } finally {
      server.close();
    }
  });

  test("cross-host redirect does not forward client Cookie or host-only Set-Cookie", async () => {
    if (!(await hasCurl())) return;

    let cookieSeenOnB = "";
    const serverB = createServer((req, res) => {
      cookieSeenOnB = req.headers.cookie ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("b");
    });
    const portB = await listenHttp(serverB);

    const serverA = createServer((req, res) => {
      if (req.url === "/") {
        res.statusCode = 302;
        // `localhost` vs `127.0.0.1`: different URL hosts so client cookies are not replayed.
        res.setHeader("location", `http://localhost:${portB}/on-b`);
        res.setHeader("set-cookie", "from_a=1; Path=/");
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const portA = await listenHttp(serverA);

    const res = await httpRequest({
      url: `http://127.0.0.1:${portA}/`,
      method: "GET",
      headers: { Cookie: "client_only=1" },
    });

    serverA.close();
    serverB.close();

    expect(res.statusCode).toBe(200);
    expect(cookieSeenOnB).toBe("");
  });

  test("same-host redirect still sends client Cookie and Set-Cookie applies on next hop", async () => {
    if (!(await hasCurl())) return;

    let cookieOnFinal = "";
    const server = createServer((req, res) => {
      if (req.url === "/" || req.url?.startsWith("/?")) {
        res.statusCode = 302;
        res.setHeader("location", "/final");
        res.setHeader("set-cookie", "from_redirect=1; Path=/");
        res.end();
        return;
      }
      if (req.url === "/final") {
        cookieOnFinal = req.headers.cookie ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const port = await listenHttp(server);

    const res = await httpRequest({
      url: `http://127.0.0.1:${port}/`,
      method: "GET",
      headers: { Cookie: "client=xyz" },
    });

    server.close();

    expect(res.statusCode).toBe(200);
    expect(cookieOnFinal).toContain("client=xyz");
    expect(cookieOnFinal).toContain("from_redirect=1");
  });

  test("sends JSON body when Content-Type is omitted", async () => {
    if (!(await hasCurl())) return;

    let raw = "";
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      raw = Buffer.concat(chunks).toString("utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          raw,
          contentType: req.headers["content-type"] ?? null,
        }),
      );
    });
    const port = await listenHttp(server);

    const res = await httpRequest({
      url: `http://127.0.0.1:${port}/`,
      method: "POST",
      headers: { "Content-Type;": "" },
      body: '{"foo":"bar"}',
    });

    server.close();

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body.toString("utf8")) as {
      raw: string;
      contentType: string | null;
    };
    expect(parsed.raw).toBe('{"foo":"bar"}');
    expect(parsed.contentType).toBeNull();
  });

  test("emits body chunks before the server closes the stream", async () => {
    if (!(await hasCurl())) return;

    const events: HttpStreamEvent[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let serverEnded = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write("data: one\n\n");
      void gate.then(() => {
        serverEnded = true;
        res.end("data: two\n\n");
      });
    });
    const port = await listenHttp(server);

    let settleChunk: () => void = () => {};
    const chunkBeforeClose = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no body chunk before the server closed")),
        8000,
      );
      settleChunk = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    const pending = httpRequest({
      url: `http://127.0.0.1:${port}/`,
      method: "GET",
      headers: { Accept: "text/event-stream" },
      stream: {
        emit(event) {
          events.push(event);
          if (
            event.event === "chunk" &&
            (event.data ?? "").includes("data: one") &&
            !serverEnded
          ) {
            settleChunk();
          }
        },
      },
    });

    try {
      await chunkBeforeClose;
      expect(serverEnded).toBe(false);
      expect(events[0]?.event).toBe("headers");
      expect(events[0]?.status).toBe(200);
      expect(events.some((event) => event.event === "chunk")).toBe(true);
      release();
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.body.toString("utf8")).toBe("data: one\n\ndata: two\n\n");
      expect(events.some((event) => event.event === "error")).toBe(false);
    } finally {
      release();
      server.close();
    }
  });

  test("streams only the final hop after a redirect", async () => {
    if (!(await hasCurl())) return;

    const events: HttpStreamEvent[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(302, { location: "/final" });
        res.end("redirect-body");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("final-body");
    });
    const port = await listenHttp(server);

    try {
      const res = await httpRequest({
        url: `http://127.0.0.1:${port}/`,
        method: "GET",
        headers: {},
        stream: {
          emit(event) {
            events.push(event);
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.toString("utf8")).toBe("final-body");
      expect(events.filter((event) => event.event === "headers")).toHaveLength(
        1,
      );
      expect(events[0]?.status).toBe(200);
      expect(events.map((event) => event.data ?? "").join("")).toBe(
        "final-body",
      );
      expect(events.map((event) => event.data ?? "").join("")).not.toContain(
        "redirect-body",
      );
    } finally {
      server.close();
    }
  });
});

describe("buildKulalaCurlArgs", () => {
  const base = {
    method: "GET",
    url: "http://127.0.0.1/",
    headers: {},
    headerPath: "/tmp/headers",
    bodyPath: "/tmp/body",
    writeOut: "http_code=%{http_code}",
    extra: [] as string[],
  };

  test("buffered requests do not pass -N", () => {
    const args = buildKulalaCurlArgs({ ...base, stream: false });
    expect(args).not.toContain("-N");
    expect(args).not.toContain("--no-buffer");
    expect(args).toContain("/tmp/body");
  });

  test("keep-alive streaming forces unbuffered stdout", () => {
    const args = buildKulalaCurlArgs({
      ...base,
      stream: true,
      writeOut: "%output{/tmp/writeout}http_code=%{http_code}",
    });
    expect(args).toContain("-N");
    const outputAt = args.indexOf("--output");
    expect(args[outputAt + 1]).toBe("-");
    expect(args.at(-1)).toBe("http://127.0.0.1/");
  });
});

describe("curlNeedsRequestFlag", () => {
  test("omits -X for default GET and POST with body", () => {
    expect(curlNeedsRequestFlag("GET", false)).toBe(false);
    expect(curlNeedsRequestFlag("POST", true)).toBe(false);
  });

  test("requires -X for non-inferred combinations", () => {
    expect(curlNeedsRequestFlag("GET", true)).toBe(true);
    expect(curlNeedsRequestFlag("POST", false)).toBe(true);
    expect(curlNeedsRequestFlag("PUT", true)).toBe(true);
    expect(curlNeedsRequestFlag("DELETE", false)).toBe(true);
  });
});

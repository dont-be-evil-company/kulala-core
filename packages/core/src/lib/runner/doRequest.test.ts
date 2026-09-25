import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { KulalaBlock } from "../parser/types/block";
import type { KulalaHttpURL } from "../parser/types/request";
import {
  closeDb,
  getDbInMemory,
  getVariable,
  listHistoryEntries,
  setDbForTesting,
  setVariable,
} from "../persistence";
import { doRequestFromBlock, type DoRequestFromBlockResult } from "./doRequest";
import type {
  KulalaRequestErrorResponse,
  KulalaRequestSuccessResponse,
} from "./types";
import type { KulalaOperator } from "../parser/types/operator";

type HttpDoRequestResult =
  | KulalaRequestSuccessResponse
  | KulalaRequestErrorResponse;

function unwrapHttpDoRequestResult(
  result: DoRequestFromBlockResult | DoRequestFromBlockResult[],
): HttpDoRequestResult {
  const r = Array.isArray(result) ? result[0]! : result;
  if ("protocol" in r) {
    throw new Error("expected HTTP result, got websocket plan");
  }
  if ("prompt" in r) {
    throw new Error("expected HTTP result, got prompt");
  }
  if ("skipped" in r) {
    throw new Error("expected HTTP result, got skipped");
  }
  return r;
}

async function httpDoRequestFromBlock(
  ...args: Parameters<typeof doRequestFromBlock>
): Promise<HttpDoRequestResult> {
  return unwrapHttpDoRequestResult(await doRequestFromBlock(...args));
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let preScriptAbortProbeHits = 0;

function testOperator(
  name: KulalaOperator["name"],
  args?: string,
  lineNumber = 1,
): KulalaOperator {
  return { name, args, lineNumber };
}

function makeBlock(overrides: Partial<KulalaBlock> = {}): KulalaBlock {
  return {
    name: "TEST_BLOCK",
    errors: [],
    preamble: [],
    comments: [],
    operators: [],
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
    },
    scripts: { preRequest: [], postRequest: [] },
    position: { start: 1, end: 10 },
    ...overrides,
  };
}

beforeAll(() => {
  // Set test environment to prevent browser opening
  process.env.NODE_ENV = "test";

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const path = u.pathname;
      const method = req.method;
      if (path === "/get" && method === "GET") {
        return Response.json({ json: { success: true, url: baseUrl } });
      }
      if (path === "/pre-script-abort-probe" && method === "GET") {
        preScriptAbortProbeHits += 1;
        return Response.json({ ok: true });
      }
      if (path === "/auth" && method === "GET") {
        return Response.json({
          authorization: req.headers.get("authorization"),
        });
      }
      if (path === "/path" && method === "GET") {
        return Response.json({
          url: req.url,
          headers: {
            "x-custom": req.headers.get("x-custom"),
          },
        });
      }
      if (path === "/post-query-echo" && method === "POST") {
        return Response.json({ url: req.url });
      }
      if (path === "/post" && method === "POST") {
        return Response.json({ received: true });
      }
      if (path === "/echo-body" && method === "POST") {
        const raw = await req.text();
        return Response.json({ echoed: raw });
      }
      if (path === "/echo-binary" && method === "PUT") {
        const raw = Buffer.from(await req.arrayBuffer());
        return new Response(raw, {
          headers: {
            "Content-Type":
              req.headers.get("content-type") ?? "application/octet-stream",
          },
        });
      }
      if (path === "/openapi.json" && method === "GET") {
        return Response.json({
          openapi: "3.0.0",
          info: { title: "Test API", version: "1.0.0" },
          paths: {
            "/hello": {
              get: { responses: { "200": { description: "OK" } } },
            },
          },
        });
      }
      if (path === "/graphql" && method === "POST") {
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("application/json")) {
          return new Response(
            JSON.stringify({
              errors: [{ message: "Content-Type must be application/json" }],
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const raw = await req.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return new Response(
            JSON.stringify({ errors: [{ message: "Body is not valid JSON" }] }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (typeof parsed !== "object" || parsed === null) {
          return new Response(
            JSON.stringify({ errors: [{ message: "Body must be an object" }] }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const obj = parsed as Record<string, unknown>;
        if ("data" in obj && Object.keys(obj).length === 1) {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  message:
                    "Body must be { query, variables }, not wrapped in data",
                },
              ],
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (typeof obj.query !== "string") {
          return new Response(
            JSON.stringify({
              errors: [{ message: "Body must have query as a string" }],
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (
          "variables" in obj &&
          obj.variables !== undefined &&
          (typeof obj.variables !== "object" || obj.variables === null)
        ) {
          return new Response(
            JSON.stringify({
              errors: [{ message: "variables must be an object when present" }],
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (obj.query.includes("\\\\") || obj.query.includes("\\{")) {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  message:
                    "Query must not be double-escaped (no backslash-brace)",
                },
              ],
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return Response.json({ data: {} });
      }
      if (path === "/text" && method === "GET") {
        return new Response("plain text response", {
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  // Bun's type allows `port` to be undefined; once started it will be set.
  if (server.port === undefined) {
    throw new Error("Test server did not expose a listening port");
  }
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

beforeEach(() => {
  setDbForTesting(getDbInMemory());
});

afterEach(() => {
  closeDb();
});

test("doRequestFromBlock: GET request returns success response (real response)", async () => {
  const block = makeBlock();
  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.status).toBe(200);
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      expect(result.body.content).toEqual({
        json: { success: true, url: baseUrl },
      });
    }
    expect(result.timings).toHaveProperty("dns");
    expect(result.timings).toHaveProperty("tcp");
    expect(result.timings).toHaveProperty("firstByte");
    expect(result.timings).toHaveProperty("startTransfer");
    expect(result.timings).toHaveProperty("request");
    expect(result.timings).toHaveProperty("tls");
    expect(result.timings).toHaveProperty("redirect");
    expect(result.timings).toHaveProperty("total");
    expect(result).toHaveProperty("url");
    expect(typeof result.url).toBe("string");
    expect(result.url.length).toBeGreaterThan(0);
  }
});

test("doRequestFromBlock: substitutes URL and headers when vars provided", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: `http://{{host}}/path`,
      headerSection: [{ type: "header", name: "X-Custom", value: "{{token}}" }],
    },
  });
  const vars = { host: `localhost:${server.port}`, token: "secret123" };

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    vars,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success && "request" in result && result.request) {
    expect(result.request.url).toBe(`http://localhost:${server.port}/path`);
    expect(result.request.headers?.["X-Custom"]).toBe("secret123");
  }
});

test("doRequestFromBlock: # @kulala-prompt returns a prompt response when variable missing", async () => {
  const block = makeBlock({
    operators: [testOperator("kulala-prompt", "TOKEN")],
    request: {
      method: "GET",
      url: `${baseUrl}/get?token={{TOKEN}}` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", false);
  if (!Array.isArray(result) && "prompt" in result && result.prompt) {
    expect(result.promptType).toBe("custom");
    expect(result.inputs[0]?.id).toBe("TOKEN");
  }
});

test("doRequestFromBlock: @kulala-prompt supports quoted label + var name (continue id remains var)", async () => {
  const block = makeBlock({
    operators: [testOperator("kulala-prompt", `"What is your name?" NAME`)],
    request: {
      method: "GET",
      url: `${baseUrl}/get?name={{NAME}}` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", false);
  if (!Array.isArray(result) && "prompt" in result && result.prompt) {
    expect(result.promptType).toBe("custom");
    expect(result.inputs[0]?.id).toBe("NAME");
    expect(result.inputs[0]?.label).toBe("What is your name?");
  }
});

test("doRequestFromBlock: @kulala-prompt supports password type option", async () => {
  const block = makeBlock({
    operators: [
      testOperator(
        "kulala-prompt",
        `"What is your prompt?" MY_VAR_NAME_PROMPT { type: "password" }`,
      ),
    ],
    request: {
      method: "GET",
      url: `${baseUrl}/get?prompt={{MY_VAR_NAME_PROMPT}}` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", false);
  if (!Array.isArray(result) && "prompt" in result && result.prompt) {
    expect(result.promptType).toBe("custom");
    expect(result.inputs[0]?.id).toBe("MY_VAR_NAME_PROMPT");
    expect(result.inputs[0]?.label).toBe("What is your prompt?");
    expect(result.inputs[0]?.type).toBe("password");
  }
});

test("doRequestFromBlock: pre-request script error aborts HTTP (JetBrains parity)", async () => {
  preScriptAbortProbeHits = 0;
  const block = makeBlock({
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `throw new Error("pre-request failed");`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
    request: {
      method: "GET",
      url: `${baseUrl}/pre-script-abort-probe` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", false);
  if (!result.success && "error" in result) {
    expect(result.error).toContain("pre-request failed");
    expect(result.httpCompleted).toBeUndefined();
  }
  expect(preScriptAbortProbeHits).toBe(0);
});

test("doRequestFromBlock: post-request script error keeps HTTP response (JetBrains parity)", async () => {
  const block = makeBlock({
    scripts: {
      preRequest: [],
      postRequest: [
        {
          type: "postRequest",
          source: "inline",
          lang: "js",
          content: `client.assert(response.status === 999, "expected 999");`,
          lineNumber: 1,
        },
      ],
    },
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", false);
  if (!result.success && "error" in result) {
    expect(result.httpCompleted).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBeDefined();
  }
});

test("doRequestFromBlock: $kulala.request.skip in pre-script skips HTTP", async () => {
  const block = makeBlock({
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `$kulala.request.skip();`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", true);
  expect(result).toHaveProperty("skipped", true);
});

test("doRequestFromBlock: client.log before skip is preserved in scriptConsole", async () => {
  const block = makeBlock({
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `
            client.log("before skip");
            $kulala.request.skip();
          `,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", true);
  expect(result).toHaveProperty("skipped", true);
  expect(result).toHaveProperty("scriptConsole");
  if ("scriptConsole" in result && Array.isArray(result.scriptConsole)) {
    expect(result.scriptConsole.some((l) => l.message === "before skip")).toBe(
      true,
    );
  }
  if ("body" in result && result.body && result.body.type === "text") {
    expect(result.body.content).toContain("before skip");
    expect(result.body.content).toContain("Request skipped by script");
  } else {
    throw new Error("expected skip body with script logs");
  }
});

test("doRequestFromBlock: $kulala.request.skip with message skips HTTP at info level", async () => {
  const block = makeBlock({
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `
            client.log("before skip");
            $kulala.request.skip("not applicable in dev");
          `,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", true);
  expect(result).toHaveProperty("skipped", true);
  expect(result).toHaveProperty("message", "not applicable in dev");
  if ("scriptConsole" in result && Array.isArray(result.scriptConsole)) {
    expect(result.scriptConsole.some((l) => l.message === "before skip")).toBe(
      true,
    );
    const skipLine = result.scriptConsole.find(
      (l) => l.message === "not applicable in dev",
    );
    expect(skipLine?.level).toBe("info");
  }
  if ("body" in result && result.body && result.body.type === "text") {
    expect(result.body.content).toContain("before skip");
    expect(result.body.content).toContain("not applicable in dev");
    expect(result.body.content).not.toContain(
      "not applicable in dev\n\nnot applicable in dev",
    );
  } else {
    throw new Error("expected skip body with script logs");
  }
});

test("doRequestFromBlock: $kulala.request.abort in pre-script fails without HTTP", async () => {
  const block = makeBlock({
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `
            client.log("before abort");
            $kulala.request.abort("missing token");
          `,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", false);
  expect(result).toHaveProperty("aborted", true);
  expect(result).toHaveProperty("error", "missing token");
  expect(result).not.toHaveProperty("httpCompleted", true);
  if ("scriptConsole" in result && Array.isArray(result.scriptConsole)) {
    expect(result.scriptConsole.some((l) => l.message === "before abort")).toBe(
      true,
    );
    const abortLine = result.scriptConsole.find(
      (l) => l.message === "missing token",
    );
    expect(abortLine?.level).toBe("error");
  }
  if ("body" in result && result.body && result.body.type === "text") {
    expect(result.body.content).toContain("before abort");
    expect(result.body.content).toContain("missing token");
    expect(result.body.content).not.toContain("missing token\n\nmissing token");
  } else {
    throw new Error("expected abort body with script logs");
  }
});

test("doRequestFromBlock: request.abort alias aborts without HTTP", async () => {
  const block = makeBlock({
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `request.abort();`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", false);
  expect(result).toHaveProperty("aborted", true);
  expect(result).toHaveProperty("error", "Request aborted by script");
});

test("doRequestFromBlock: shared block pre-script abort stops the main request", async () => {
  preScriptAbortProbeHits = 0;
  const sharedBlock = makeBlock({
    name: "KULALA_SHARED",
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `$kulala.request.abort("shared abort");`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
    },
  });
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/pre-script-abort-probe` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    {
      globalHeaders: {},
      sharedBlocks: [sharedBlock],
      sharedHttpExecuted: new Set(),
      collectedSharedHttpResults: [],
    },
  );

  expect(result).toMatchObject({
    success: false,
    aborted: true,
    error: "shared abort",
  });
  expect(preScriptAbortProbeHits).toBe(0);
});

test("doRequestFromBlock: shared HTTP block pre-script abort stops the main request", async () => {
  preScriptAbortProbeHits = 0;
  const sharedBlock = makeBlock({
    name: "KULALA_SHARED",
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `
            if (!client.global.get("SHARED_PRE_RAN")) {
              client.global.set("SHARED_PRE_RAN", true);
              client.exit(0);
            }
            $kulala.request.abort("shared http abort");
          `,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
    },
    hasRequest: true,
  });
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/pre-script-abort-probe` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    {
      globalHeaders: {},
      sharedBlocks: [sharedBlock],
      sharedHttpExecuted: new Set(),
      collectedSharedHttpResults: [],
    },
  );

  expect(result).toMatchObject({
    success: false,
    aborted: true,
    error: "shared http abort",
  });
  expect(preScriptAbortProbeHits).toBe(0);
});

test("doRequestFromBlock: $kulala.request.replay in pre-script re-runs with updated vars", async () => {
  const block = makeBlock({
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `
            if (!client.global.get("REPLAYED")) {
              client.global.set("REPLAYED", true);
              request.variables.set("HIT", "second");
              $kulala.request.replay();
            }
          `,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
    request: {
      method: "GET",
      url: `${baseUrl}/get?n={{HIT}}` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    { HIT: "first" },
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", true);
  if (result.success && "url" in result) {
    expect(result.url).toContain("n=second");
  }
});

test("doRequestFromBlock: $kulala.prompt in pre-script returns prompt when variable missing", async () => {
  const block = makeBlock({
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `$kulala.prompt("Password?", "TOKEN", { type: "password" });`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
    request: {
      method: "GET",
      url: `${baseUrl}/get?token={{TOKEN}}` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", false);
  if (!Array.isArray(result) && "prompt" in result && result.prompt) {
    expect(result.inputs[0]?.id).toBe("TOKEN");
    expect(result.inputs[0]?.type).toBe("password");
    expect(result.inputs[0]?.label).toBe("Password?");
  }
});

test("doRequestFromBlock: prompt variable is single-use (deleted after next run of this request)", async () => {
  // Simulate a completed `continue` by storing a request-scoped var.
  setVariable("request", "NAME", "marco", {
    document: "stable-doc",
    blockName: "TEST_BLOCK",
  });
  expect(
    getVariable("request", "NAME", {
      document: "stable-doc",
      blockName: "TEST_BLOCK",
    }),
  ).toBe("marco");

  const block = makeBlock({
    operators: [testOperator("kulala-prompt", `"What is your name?" NAME`)],
    request: {
      method: "GET",
      url: `${baseUrl}/get?name={{NAME}}` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    { NAME: "marco" }, // represents resolved vars for this run
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", true);
  expect(
    getVariable("request", "NAME", {
      document: "stable-doc",
      blockName: "TEST_BLOCK",
    }),
  ).toBeUndefined();
});

test("doRequestFromBlock: # @kulala-file-contents-to-variable loads file content into vars for substitution", async () => {
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const fs = await import("fs/promises");
  const dir = mkdtempSync(join(tmpdir(), "kulala-op-"));
  const httpFilePath = join(dir, "request.http");
  await fs.writeFile(join(dir, "v.txt"), "hello-world", "utf-8");

  const block = makeBlock({
    operators: [testOperator("kulala-file-contents-to-variable", "FOO v.txt")],
    request: {
      method: "GET",
      url: `${baseUrl}/path?name={{FOO}}` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    httpFilePath,
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result).toHaveProperty("success", true);
  if (result.success && result.body.type === "json") {
    expect(String(result.body.content.url ?? "")).toContain("name=hello-world");
  }
});

test("doRequestFromBlock: # @kulala-expect-status-code returns error when status does not match", async () => {
  const block = makeBlock({
    operators: [testOperator("kulala-expect-status-code", "201")],
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result.success).toBe(false);
  if (!result.success && "error" in result) {
    expect(result.error).toContain("Expected status code");
  }
});

test("doRequestFromBlock: # @timeout triggers a timeout against a slow endpoint", async () => {
  const block = makeBlock({
    operators: [
      {
        name: "timeout",
        args: "50 ms", // 50 ms timeout should trigger against our 100ms delayed endpoint
        lineNumber: 1,
      } as KulalaOperator,
    ],
    request: {
      method: "GET",
      url: `${baseUrl}/slow` as KulalaHttpURL,
      headerSection: [],
    },
  });

  // Add /slow handler by creating a second server is overkill; reuse the existing one by hitting an undefined path
  // would return fast 404. Instead, we simulate slowness via a query parameter and server-side delay.
  // Our test server doesn't have /slow, so we must add it there; simplest is to call /text?delay=...
  // but fetch() ignores. We'll just use /text and set a tiny timeout to provoke curl DNS/connection?
  // Reliable: create a dedicated slow server.
  const slowServer = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise((r) => setTimeout(r, 100));
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    },
  });
  if (slowServer.port === undefined) {
    throw new Error("Slow server did not expose a listening port");
  }
  const slowUrl = `http://localhost:${slowServer.port}/slow`;

  const slowBlock = makeBlock({
    operators: block.operators,
    request: {
      method: "GET",
      url: slowUrl as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    slowBlock,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  slowServer.stop();

  expect(result.success).toBe(false);
});

test("doRequestFromBlock: # @timeout overrides default --max-time", async () => {
  const { mkdtempSync, writeFileSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");

  const dir = mkdtempSync(join(tmpdir(), "kulala-timeout-"));
  const httpClientEnvPath = join(dir, "http-client.env.json");

  // Default curl options apply when `doRequestFromBlock` receives a `filePath`
  // and searches upward from that directory.
  writeFileSync(
    httpClientEnvPath,
    JSON.stringify(
      {
        $kulalaShared: {
          $kulalaDefaultCurlOptions: ["--max-time 2"],
        },
        default: { env_name: "default" },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const filePath = join(dir, "example.http");

  const slowServer = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise((r) => setTimeout(r, 100));
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    },
  });

  if (slowServer.port === undefined) {
    throw new Error("Slow server did not expose a listening port");
  }

  const slowUrl = `http://localhost:${slowServer.port}/slow`;

  const block = makeBlock({
    operators: [
      {
        name: "timeout",
        args: "50 ms", // should override default --max-time 2 and therefore timeout
        lineNumber: 1,
      } as KulalaOperator,
    ],
    request: {
      method: "GET",
      url: slowUrl as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    filePath,
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  slowServer.stop();

  expect(result.success).toBe(false);
});

test("doRequestFromBlock: # @timeout 5 s uses seconds for curl (not milliseconds)", async () => {
  const slowServer = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise((r) => setTimeout(r, 200));
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    },
  });
  if (slowServer.port === undefined) {
    throw new Error("Slow server did not expose a listening port");
  }
  const slowUrl = `http://localhost:${slowServer.port}/slow`;

  const block = makeBlock({
    operators: [
      {
        name: "timeout",
        args: "5 s",
        lineNumber: 1,
      } as KulalaOperator,
    ],
    request: {
      method: "GET",
      url: slowUrl as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  slowServer.stop();

  // 5 s budget should allow a 200 ms response (would fail if 5000 s were passed to curl).
  expect(result.success).toBe(true);
});

test("doRequestFromBlock: // @no-redirect does not follow redirects (keeps 302)", async () => {
  const redirectServer = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/from") {
        return new Response("", { status: 302, headers: { Location: "/to" } });
      }
      if (u.pathname === "/to") {
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  if (redirectServer.port === undefined) {
    throw new Error("Redirect server did not expose a listening port");
  }
  const base = `http://localhost:${redirectServer.port}`;

  const block = makeBlock({
    operators: [testOperator("no-redirect")],
    request: {
      method: "GET",
      url: `${base}/from` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  redirectServer.stop();

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.status).toBe(302);
  }
});

test("doRequestFromBlock: // @no-auto-encoding sends form-urlencoded body without encoding", async () => {
  const formServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const raw = await req.text();
      return Response.json({ raw });
    },
  });
  if (formServer.port === undefined) {
    throw new Error("Form server did not expose a listening port");
  }
  const base = `http://localhost:${formServer.port}`;

  const block = makeBlock({
    operators: [testOperator("no-auto-encoding")],
    request: {
      method: "POST",
      url: `${base}/` as KulalaHttpURL,
      headerSection: [
        {
          type: "header",
          name: "Content-Type",
          value: "application/x-www-form-urlencoded",
        },
      ],
      body: { name: "@#$somebody" },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  formServer.stop();

  expect(result.success).toBe(true);
  if (result.success && result.body.type === "json") {
    expect(String(result.body.content.raw ?? "")).toBe("name=@#$somebody");
  }
});

test("doRequestFromBlock: encodes query parameters in URL by default", async () => {
  const urlServer = Bun.serve({
    port: 0,
    fetch(req) {
      return Response.json({ url: req.url });
    },
  });
  if (urlServer.port === undefined) {
    throw new Error("URL server did not expose a listening port");
  }
  const base = `http://localhost:${urlServer.port}`;

  const block = makeBlock({
    request: {
      method: "GET",
      url: `${base}/get?name=@#$somebody&qwerty=%40%23%24` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  urlServer.stop();

  expect(result.success).toBe(true);
  if (result.success && result.body.type === "json") {
    const sentUrl = String(result.body.content.url ?? "");
    expect(sentUrl).toContain("name=%40%23%24somebody");
    expect(sentUrl).toContain("qwerty=%40%23%24");
    expect(sentUrl).not.toContain("name=@");
  }
});

test("doRequestFromBlock: // @no-auto-encoding leaves URL query parameters unencoded", async () => {
  const urlServer = Bun.serve({
    port: 0,
    fetch(req) {
      return Response.json({ url: req.url });
    },
  });
  if (urlServer.port === undefined) {
    throw new Error("URL server did not expose a listening port");
  }
  const base = `http://localhost:${urlServer.port}`;

  const block = makeBlock({
    operators: [testOperator("no-auto-encoding")],
    request: {
      method: "GET",
      url: `${base}/get?name=@$somebody&status=ok` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  urlServer.stop();

  expect(result.success).toBe(true);
  if (result.success && result.body.type === "json") {
    const sentUrl = String(result.body.content.url ?? "");
    expect(sentUrl).toContain("name=@$somebody");
    expect(sentUrl).toContain("status=ok");
    expect(sentUrl).not.toContain("name=%40");
  }
});

test("doRequestFromBlock: cookie jar stores Set-Cookie and sends Cookie on subsequent request (unless @no-cookie-jar)", async () => {
  const cookieServer = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/set") {
        return new Response("ok", {
          status: 200,
          headers: { "Set-Cookie": "sid=abc; Path=/; HttpOnly" },
        });
      }
      if (u.pathname === "/echo") {
        return Response.json({ cookie: req.headers.get("cookie") ?? "" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  if (cookieServer.port === undefined) {
    throw new Error("Cookie server did not expose a listening port");
  }
  const base = `http://localhost:${cookieServer.port}`;

  const setBlock = makeBlock({
    request: {
      method: "GET",
      url: `${base}/set` as KulalaHttpURL,
      headerSection: [],
    },
  });
  const echoBlock = makeBlock({
    request: {
      method: "GET",
      url: `${base}/echo` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const r1 = await httpDoRequestFromBlock(
    setBlock,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  expect(r1.success).toBe(true);

  const r2 = await httpDoRequestFromBlock(
    echoBlock,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  expect(r2.success).toBe(true);
  if (r2.success && r2.body.type === "json") {
    expect(String(r2.body.content.cookie ?? "")).toContain("sid=abc");
  }

  const noJarEcho = makeBlock({
    operators: [testOperator("no-cookie-jar")],
    request: {
      method: "GET",
      url: `${base}/echo` as KulalaHttpURL,
      headerSection: [],
    },
  });
  const r3 = await httpDoRequestFromBlock(
    noJarEcho,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  expect(r3.success).toBe(true);
  if (r3.success && r3.body.type === "json") {
    expect(String(r3.body.content.cookie ?? "")).toBe("");
  }

  cookieServer.stop();
});

test("doRequestFromBlock: merges jar cookies with explicit Cookie header (explicit wins per name)", async () => {
  const cookieServer = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/set") {
        const headers = new Headers();
        headers.append("Set-Cookie", "sid=from-jar; Path=/");
        headers.append("Set-Cookie", "other=jar-only; Path=/");
        return new Response("ok", { status: 200, headers });
      }
      if (u.pathname === "/echo") {
        return Response.json({ cookie: req.headers.get("cookie") ?? "" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  if (cookieServer.port === undefined) {
    throw new Error("Cookie server did not expose a listening port");
  }
  const base = `http://localhost:${cookieServer.port}`;

  const setBlock = makeBlock({
    request: {
      method: "GET",
      url: `${base}/set` as KulalaHttpURL,
      headerSection: [],
    },
  });
  const echoBlock = makeBlock({
    request: {
      method: "GET",
      url: `${base}/echo` as KulalaHttpURL,
      headerSection: [
        { type: "header", name: "Cookie", value: "sid=from-request; extra=1" },
      ],
    },
  });

  await httpDoRequestFromBlock(
    setBlock,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  const result = await httpDoRequestFromBlock(
    echoBlock,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  cookieServer.stop();

  expect(result.success).toBe(true);
  if (result.success && result.body.type === "json") {
    const cookie = String(result.body.content.cookie ?? "");
    expect(cookie).toContain("sid=from-request");
    expect(cookie).not.toContain("sid=from-jar");
    expect(cookie).toContain("other=jar-only");
    expect(cookie).toContain("extra=1");
  }
});

test("doRequestFromBlock: cookies set on redirect response are sent to the next hop (regression)", async () => {
  const redirectCookieServer = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/set") {
        return new Response("", {
          status: 302,
          headers: {
            Location: "/final",
            "Set-Cookie": "sid=abc; Path=/",
          },
        });
      }
      if (u.pathname === "/final") {
        return Response.json({ cookie: req.headers.get("cookie") ?? "" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  if (redirectCookieServer.port === undefined) {
    throw new Error("Redirect cookie server did not expose a listening port");
  }
  const base = `http://localhost:${redirectCookieServer.port}`;

  const block = makeBlock({
    request: {
      method: "GET",
      url: `${base}/set` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  redirectCookieServer.stop();

  expect(result.success).toBe(true);
  if (result.success && result.body.type === "json") {
    expect(String(result.body.content.cookie ?? "")).toContain("sid=abc");
  }
});

test("doRequestFromBlock: @no-cookie-jar prevents redirect cookie propagation (regression)", async () => {
  const redirectCookieServer = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/set") {
        return new Response("", {
          status: 302,
          headers: {
            Location: "/final",
            "Set-Cookie": "sid=abc; Path=/",
          },
        });
      }
      if (u.pathname === "/final") {
        return Response.json({ cookie: req.headers.get("cookie") ?? "" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  if (redirectCookieServer.port === undefined) {
    throw new Error("Redirect cookie server did not expose a listening port");
  }
  const base = `http://localhost:${redirectCookieServer.port}`;

  const block = makeBlock({
    operators: [testOperator("no-cookie-jar")],
    request: {
      method: "GET",
      url: `${base}/set` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  redirectCookieServer.stop();

  expect(result.success).toBe(true);
  if (result.success && result.body.type === "json") {
    expect(String(result.body.content.cookie ?? "")).toBe("");
  }
});

test("doRequestFromBlock: request history records entries unless // @no-log", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
    },
  });
  const r1 = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  expect(r1.success).toBe(true);
  const hist1 = listHistoryEntries(10);
  expect(hist1.length).toBeGreaterThan(0);

  const noLogBlock = makeBlock({
    operators: [testOperator("no-log")],
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
    },
  });
  const before = listHistoryEntries(100).length;
  const r2 = await httpDoRequestFromBlock(
    noLogBlock,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );
  expect(r2.success).toBe(true);
  const after = listHistoryEntries(100).length;
  expect(after).toBe(before);
});

test("doRequestFromBlock: applies client.global.headers.set from pre-request script", async () => {
  const flow = { globalHeaders: {} as Record<string, string> };
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/path` as KulalaHttpURL,
      headerSection: [],
    },
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `client.global.headers.set("X-Custom", "from-flow");`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    undefined,
    undefined,
    "default",
    flow,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success && result.body.type === "json") {
    const content = result.body.content as { headers: Record<string, string> };
    expect(content.headers["x-custom"]).toBe("from-flow");
  }
});

test("doRequestFromBlock: applies client.global.headers.set from post-request script to subsequent requests in same run", async () => {
  const flow = { globalHeaders: {} as Record<string, string> };

  const first = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
    },
    scripts: {
      preRequest: [],
      postRequest: [
        {
          type: "postRequest",
          source: "inline",
          lang: "js",
          content: `client.global.headers.set("X-Custom", "from-post");`,
          lineNumber: 1,
        },
      ],
    },
  });

  const second = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/path` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const r1 = await httpDoRequestFromBlock(
    first,
    "/tmp/example.http",
    undefined,
    undefined,
    undefined,
    "default",
    flow,
  );
  expect(r1).toHaveProperty("success", true);

  const r2 = await httpDoRequestFromBlock(
    second,
    "/tmp/example.http",
    undefined,
    undefined,
    undefined,
    "default",
    flow,
  );
  expect(r2).toHaveProperty("success", true);
  if (r2.success && r2.body.type === "json") {
    const content = r2.body.content as { headers: Record<string, string> };
    expect(content.headers["x-custom"]).toBe("from-post");
  }
});

test("doRequestFromBlock: pre-request Lua variables are available for substitution", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/path?name={{NAME}}` as KulalaHttpURL,
      headerSection: [],
    },
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "lua",
          content: `request.variables.set("NAME", "kulala")`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      const url = String(result.body.content.url ?? "");
      expect(url).toContain("name=kulala");
    }
  }
});

test("doRequestFromBlock: collection variable expands requests with 0-based request.iteration()", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/path?id={{id}}` as KulalaHttpURL,
      headerSection: [],
    },
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `request.variables.set("id", [1, 2]);`,
          lineNumber: 1,
        },
      ],
      postRequest: [
        {
          type: "postRequest",
          source: "inline",
          lang: "js",
          content: `client.global.set("LAST_ITER", String(request.iteration()));`,
          lineNumber: 1,
        },
      ],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    undefined,
    undefined,
  );

  expect(Array.isArray(result)).toBe(true);
  const batch = result as KulalaRequestSuccessResponse[];
  expect(batch).toHaveLength(2);
  expect(batch.every((r) => r.success)).toBe(true);
  expect(getVariable("global", "LAST_ITER")).toBe("1");

  const urls = batch.map((r) => {
    if (r.success && r.body?.type === "json") {
      return String((r.body.content as { url?: string }).url ?? "");
    }
    return "";
  });
  expect(urls[0]).toContain("id=1");
  expect(urls[1]).toContain("id=2");
});

test("doRequestFromBlock: JSONPath collection {{users[*].name}} expands requests", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/path?user={{users[*].name}}` as KulalaHttpURL,
      headerSection: [],
    },
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `client.log("pre-" + String(request.iteration()));
          request.variables.set("users", [
            { name: "Alice" },
            { name: "Bob" },
          ]);`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await doRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    undefined,
    undefined,
  );

  expect(Array.isArray(result)).toBe(true);
  const batch = result as KulalaRequestSuccessResponse[];
  expect(batch).toHaveLength(2);
  expect(batch.every((r) => r.success)).toBe(true);

  const urls = batch.map((r) => {
    if (r.body.type === "json") {
      return String((r.body.content as { url?: string }).url ?? "");
    }
    return "";
  });
  expect(urls[0]).toContain("user=Alice");
  expect(urls[1]).toContain("user=Bob");

  const msgs0 = (batch[0]!.scriptConsole ?? []).map((l) => l.message);
  const msgs1 = (batch[1]!.scriptConsole ?? []).map((l) => l.message);
  expect(msgs0).toContain("pre-0");
  expect(msgs1).toContain("pre-1");
});

test("doRequestFromBlock: pre-request JS with await still substitutes {{NAME}} in URL", async () => {
  const block = makeBlock({
    request: {
      method: "POST",
      url: `${baseUrl}/post-query-echo?name={{NAME}}` as KulalaHttpURL,
      headerSection: [
        { type: "header", name: "Content-Type", value: "application/json" },
      ],
      body: "{}",
    },
    scripts: {
      preRequest: [
        {
          type: "preRequest",
          source: "inline",
          lang: "js",
          content: `await Promise.resolve();
request.variables.set("NAME", "kulala");`,
          lineNumber: 1,
        },
      ],
      postRequest: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      const url = String(result.body.content.url ?? "");
      expect(url).toContain("name=kulala");
    }
  }
});

test("doRequestFromBlock: encodes Authorization Basic username:password", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/auth` as KulalaHttpURL,
      headerSection: [
        { type: "header", name: "Authorization", value: "Basic myUser:secret" },
      ],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      expect(result.body.content.authorization).toBe(
        `Basic ${Buffer.from("myUser:secret", "utf8").toString("base64")}`,
      );
    }
  }
});

test("doRequestFromBlock: keeps Authorization Basic base64 as-is", async () => {
  const already = Buffer.from("myUser:secret", "utf8").toString("base64");
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/auth` as KulalaHttpURL,
      headerSection: [
        { type: "header", name: "Authorization", value: `Basic ${already}` },
      ],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      expect(result.body.content.authorization).toBe(`Basic ${already}`);
    }
  }
});

test("doRequestFromBlock: keeps Authorization Bearer as-is", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/auth` as KulalaHttpURL,
      headerSection: [
        {
          type: "header",
          name: "Authorization",
          value: "Bearer token123",
        },
      ],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      expect(result.body.content.authorization).toBe("Bearer token123");
    }
  }
});

test("doRequestFromBlock: sends JSON body for POST with Content-Type application/json", async () => {
  const block = makeBlock({
    request: {
      method: "POST",
      url: `${baseUrl}/post` as KulalaHttpURL,
      headerSection: [
        {
          type: "header",
          name: "Content-Type",
          value: "application/json",
        },
      ],
      body: { key: "value", nested: { a: 1 } },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      expect(result.body.content).toEqual({ received: true });
    }
  }
});

test("doRequestFromBlock: GRAPHQL sends as POST with query and variables", async () => {
  const block = makeBlock({
    request: {
      method: "GRAPHQL",
      url: `${baseUrl}/graphql` as KulalaHttpURL,
      headerSection: [],
      body: {
        query: "query { user { name } }",
        variables: { id: "1" },
      },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      expect(result.body.content).toEqual({ data: {} });
    }
  }
});

test("doRequestFromBlock: GRAPHQL sends as POST with query only", async () => {
  const block = makeBlock({
    request: {
      method: "GRAPHQL",
      url: `${baseUrl}/graphql` as KulalaHttpURL,
      headerSection: [],
      body: {
        query: "query { viewer { id } }",
      },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("json");
    if (result.body.type === "json") {
      expect(result.body.content).toEqual({ data: {} });
    }
  }
});

test("doRequestFromBlock: returns error response when request fails (connection refused)", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: "http://127.0.0.1:1/get",
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", false);
  if (!result.success && "error" in result) {
    expect(result.error.length).toBeGreaterThan(0);
  }
});

test("doRequestFromBlock: maps text response body when Content-Type is not json", async () => {
  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/text` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success) {
    expect(result.body.type).toBe("text");
    if (result.body.type === "text") {
      expect(result.body.content).toBe("plain text response");
    }
  }
});

test("doRequestFromBlock: GRAPHQL with body from file and inline variables", async () => {
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const dir = mkdtempSync(join(tmpdir(), "kulala-gql-vars-"));
  const queryFile = join(dir, "query.graphql");
  await Bun.write(
    queryFile,
    ["query Person($id: ID) {", "  person(personID: $id) { name }", "}"].join(
      "\n",
    ),
  );
  const httpFilePath = join(dir, "request.http");

  const block = makeBlock({
    request: {
      method: "GRAPHQL",
      url: `${baseUrl}/graphql` as KulalaHttpURL,
      headerSection: [],
      body: {
        __bodyFromFile: "query.graphql",
        __graphqlVariablesSuffix: '{ "id": 1 }',
      },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    httpFilePath,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success && result.body.type === "json") {
    expect(result.body.content).toEqual({ data: {} });
  }
});

test("doRequestFromBlock: GRAPHQL with body from file sends JSON query payload", async () => {
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const dir = mkdtempSync(join(tmpdir(), "kulala-gql-body-"));
  const queryFile = join(dir, "query.graphql");
  await Bun.write(
    queryFile,
    ["query User {", "  viewer {", "    bio", "  }", "}"].join("\n"),
  );
  const httpFilePath = join(dir, "request.http");

  const block = makeBlock({
    request: {
      method: "GRAPHQL",
      url: `${baseUrl}/graphql` as KulalaHttpURL,
      headerSection: [],
      body: { __bodyFromFile: "query.graphql" },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    httpFilePath,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success && result.body.type === "json") {
    expect(result.body.content).toEqual({ data: {} });
  }
});

describe("body with or without content-type", () => {
  test("without body, with content-type", async () => {
    const { mkdtempSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "kulala-body-"));
    const bodyFile = join(dir, "input.json");
    await Bun.write(bodyFile, JSON.stringify({ from: "file", n: 42 }));
    const httpFilePath = join(dir, "request.http");

    const contentType = "application/json";

    const block = makeBlock({
      request: {
        method: "POST",
        url: `${baseUrl}/echo-body` as KulalaHttpURL,
        headerSection: [
          {
            type: "header",
            name: "Content-Type",
            value: contentType,
          },
        ],
      },
    });

    const result = await httpDoRequestFromBlock(
      block,
      httpFilePath,
      undefined,
      undefined,
      undefined,
    );

    expect(result).toHaveProperty("success", true);
    // Body should be undefined since no body was provided,
    expect(block.request?.body).toBeUndefined();
    // Content-Type should be present (case-insensitive)
    // since it was provided in the block's headerSection,
    // even if the underlying HTTP client normalizes or
    // omits it in the final request object.
    const headers: Record<string, string> = result.request?.headers ?? {};
    const contentTypeValue = Object.keys(headers).find(
      (k) => k.toLowerCase() === "content-type",
    );
    expect(contentTypeValue).toBeDefined();
    expect(headers[contentTypeValue!]).toBe(contentType);
  });
  test("with body, with content-type", async () => {
    const { mkdtempSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "kulala-body-"));
    const bodyFile = join(dir, "input.json");
    await Bun.write(bodyFile, JSON.stringify({ from: "file", n: 42 }));
    const httpFilePath = join(dir, "request.http");

    const contentType = "application/json";

    const block = makeBlock({
      request: {
        method: "POST",
        url: `${baseUrl}/echo-body` as KulalaHttpURL,
        headerSection: [
          {
            type: "header",
            name: "Content-Type",
            value: contentType,
          },
        ],
        body: { __bodyFromFile: "input.json" },
      },
    });

    const result = await httpDoRequestFromBlock(
      block,
      httpFilePath,
      undefined,
      undefined,
      undefined,
    );

    expect(result).toHaveProperty("success", true);
    if (
      result.success &&
      result.body.type === "json" &&
      "content" in result.body
    ) {
      const content = result.body.content as { echoed?: string };
      expect(content.echoed).toBe(JSON.stringify({ from: "file", n: 42 }));
    }
    // Content-Type should be present (case-insensitive)
    // since it was provided in the block's headerSection,
    // even if the underlying HTTP client normalizes or
    // omits it in the final request object.
    const headers: Record<string, string> = result.request?.headers ?? {};
    const contentTypeValue = Object.keys(headers).find(
      (k) => k.toLowerCase() === "content-type",
    );
    expect(contentTypeValue).toBeDefined();
    expect(headers[contentTypeValue!]).toBe(contentType);
  });

  test("with body, without content-type", async () => {
    const { mkdtempSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "kulala-body-"));
    const bodyFile = join(dir, "input.json");
    await Bun.write(bodyFile, JSON.stringify({ from: "file", n: 42 }));
    const httpFilePath = join(dir, "request.http");

    const block = makeBlock({
      request: {
        method: "POST",
        url: `${baseUrl}/echo-body` as KulalaHttpURL,
        headerSection: [],
        body: { __bodyFromFile: "input.json" },
      },
    });

    const result = await httpDoRequestFromBlock(
      block,
      httpFilePath,
      undefined,
      undefined,
      undefined,
    );

    expect(result).toHaveProperty("success", true);
    if (
      result.success &&
      result.body.type === "json" &&
      "content" in result.body
    ) {
      const content = result.body.content as { echoed?: string };
      expect(content.echoed).toBe(JSON.stringify({ from: "file", n: 42 }));
    }

    // Content-Type should not be present since
    // it was not provided in the block's headerSection,
    const headers: Record<string, string> = result.request?.headers ?? {};
    const contentTypeValue = Object.keys(headers).find(
      (k) => k.toLowerCase() === "content-type",
    );
    expect(contentTypeValue).toBeUndefined();
    expect(headers["Content-Type;"]).toBe("");
  });
});

test("doRequestFromBlock: reads request body from file (JetBrains < path syntax)", async () => {
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const dir = mkdtempSync(join(tmpdir(), "kulala-body-"));
  const bodyFile = join(dir, "input.json");
  await Bun.write(bodyFile, JSON.stringify({ from: "file", n: 42 }));
  const httpFilePath = join(dir, "request.http");

  const block = makeBlock({
    request: {
      method: "POST",
      url: `${baseUrl}/echo-body` as KulalaHttpURL,
      headerSection: [
        { type: "header", name: "Content-Type", value: "application/json" },
      ],
      body: { __bodyFromFile: "input.json" },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    httpFilePath,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (
    result.success &&
    result.body.type === "json" &&
    "content" in result.body
  ) {
    const content = result.body.content as { echoed?: string };
    expect(content.echoed).toBe(JSON.stringify({ from: "file", n: 42 }));
  }
});

test("doRequestFromBlock: reads binary request body from file (< path syntax)", async () => {
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const dir = mkdtempSync(join(tmpdir(), "kulala-body-bin-"));
  const bodyFile = join(dir, "image.png");
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe,
  ]);
  await Bun.write(bodyFile, pngBytes);
  const httpFilePath = join(dir, "request.http");

  const block = makeBlock({
    request: {
      method: "PUT",
      url: `${baseUrl}/echo-binary` as KulalaHttpURL,
      headerSection: [
        { type: "header", name: "Content-Type", value: "image/png" },
      ],
      body: { __bodyFromFile: "image.png" },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    httpFilePath,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  if (result.success && result.body.type === "binary") {
    const echoed = Buffer.from(result.body.content, "base64");
    expect(Buffer.compare(echoed, pngBytes)).toBe(0);
  } else {
    throw new Error("expected binary response body");
  }
});

test("doRequestFromBlock: redirects response to file (>>! overwrite)", async () => {
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const fs = await import("fs/promises");
  const dir = mkdtempSync(join(tmpdir(), "kulala-redirect-"));
  const httpFilePath = join(dir, "request.http");
  const outFile = join(dir, "response.json");

  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/get` as KulalaHttpURL,
      headerSection: [],
      responseRedirect: { filePath: "response.json", overwrite: true },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    httpFilePath,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  const content = await fs.readFile(outFile, "utf-8");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  expect(parsed.json).toBeDefined();
  expect((parsed.json as Record<string, unknown>)?.success).toBe(true);
});

test("doRequestFromBlock: redirects response to file (>> create with suffix if exists)", async () => {
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const fs = await import("fs/promises");
  const dir = mkdtempSync(join(tmpdir(), "kulala-redirect2-"));
  const httpFilePath = join(dir, "request.http");
  const existingFile = join(dir, "out.json");
  await fs.writeFile(existingFile, "existing", "utf-8");

  const block = makeBlock({
    request: {
      method: "GET",
      url: `${baseUrl}/text` as KulalaHttpURL,
      headerSection: [],
      responseRedirect: { filePath: "out.json", overwrite: false },
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    httpFilePath,
    undefined,
    undefined,
    undefined,
  );

  expect(result).toHaveProperty("success", true);
  expect(await fs.readFile(existingFile, "utf-8")).toBe("existing");
  const newFile = join(dir, "out-1.json");
  expect(await fs.readFile(newFile, "utf-8")).toBe("plain text response");
});

test("doRequestFromBlock: kulala-openapi-explorer returns explorer UI payload", async () => {
  const block = makeBlock({
    operators: [testOperator("kulala-openapi-explorer")],
    request: {
      method: "GET",
      url: `${baseUrl}/openapi.json` as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    "/tmp/example.http",
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.openapiUi).toBe(true);
    expect(result.openapi?.tree?.length).toBeGreaterThan(0);
    expect(result.openapi?.title).toBe("Test API");
  }
});

test("doRequestFromBlock: kulala-openapi-explorer loads local spec file", async () => {
  const { mkdtempSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const fs = await import("fs/promises");
  const dir = mkdtempSync(join(tmpdir(), "kulala-openapi-"));
  const httpFilePath = join(dir, "request.http");
  const specPath = join(dir, "spec.json");
  await fs.writeFile(
    specPath,
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Local", version: "2" },
      paths: {},
    }),
    "utf-8",
  );

  const block = makeBlock({
    operators: [testOperator("kulala-openapi-explorer")],
    request: {
      method: "GET",
      url: "spec.json" as KulalaHttpURL,
      headerSection: [],
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    httpFilePath,
    undefined,
    "stable-doc",
    undefined,
    "default",
    { globalHeaders: {} },
  );

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.openapiUi).toBe(true);
    expect(result.openapi?.title).toBe("Local");
  }
});

test("doRequestFromBlock: WEBSOCKET plan splits === wait-for-server", async () => {
  const block = makeBlock({
    operators: [testOperator("timeout", "2 s")],
    request: {
      method: "WEBSOCKET",
      url: "ws://127.0.0.1:9/ws" as KulalaHttpURL,
      headerSection: [],
      body: [
        '{"a":1}',
        "===",
        '{"b":2}',
        "=== wait-for-server",
        '{"c":3}',
      ].join("\n"),
    },
  });

  const result = await doRequestFromBlock(
    block,
    undefined,
    {},
    undefined,
    undefined,
    "default",
  );
  expect(Array.isArray(result)).toBe(false);
  if (Array.isArray(result) || !("protocol" in result)) {
    throw new Error("expected websocket plan");
  }
  expect(result.protocol).toBe("websocket");
  expect(result.initialMessage).toBe('{"a":1}');
  expect(result.messages).toEqual([
    { waitForServer: 0, data: '{"a":1}' },
    { waitForServer: 0, data: '{"b":2}' },
    { waitForServer: 1, data: '{"c":3}' },
  ]);
  expect(result.timeoutMs).toBe(2000);
  expect(result.request?.body).toContain("=== wait-for-server");
});

test("doRequestFromBlock: WEBSOCKET omits initialMessage when the first step waits", async () => {
  const block = makeBlock({
    request: {
      method: "WEBSOCKET",
      url: "ws://127.0.0.1:9/ws" as KulalaHttpURL,
      headerSection: [],
      body: '=== wait-for-server\n{"c":3}',
    },
  });

  const result = await doRequestFromBlock(
    block,
    undefined,
    {},
    undefined,
    undefined,
    "default",
  );
  if (Array.isArray(result) || !("protocol" in result)) {
    throw new Error("expected websocket plan");
  }
  expect(result.initialMessage).toBeUndefined();
  expect(result.messages).toEqual([{ waitForServer: 1, data: '{"c":3}' }]);
  expect(result.timeoutMs).toBeUndefined();
});

test("doRequestFromBlock: POST body containing === stays one payload", async () => {
  const raw = "hello\n===\nworld\n=== wait-for-server\nmore";
  const block = makeBlock({
    request: {
      method: "POST",
      url: `${baseUrl}/echo-body` as KulalaHttpURL,
      headerSection: [],
      body: raw,
    },
  });

  const result = await httpDoRequestFromBlock(
    block,
    undefined,
    {},
    undefined,
    undefined,
    "default",
  );
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.request?.body).toBe(raw);
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { formatHttp } from "./format";

const exampleDir = join(import.meta.dir, "../../../../../http-example-files");

describe("formatHttp", () => {
  test("formats simple.http successfully", async () => {
    const content = readFileSync(join(exampleDir, "simple.http"), "utf-8");
    const result = await formatHttp(content, join(exampleDir, "simple.http"), {
      formatBody: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.formatted.length).toBeGreaterThan(0);
      expect(result.formatted).toContain("###");
    }
  });

  test("returns error for documents with parse errors", async () => {
    const result = await formatHttp(
      `import ./nonexistent.http

### MAIN_BLOCK

POST https://example.com/post HTTP/1.1
`,
      undefined,
      { formatBody: false },
    );
    expect(result.success).toBe(false);
  });

  test("respects bodyFormat.indent for JSON bodies without Content-Type", async () => {
    const content = `### MOO
POST https://echo.kulala.app/get?foo=bar HTTP/1.1
Accept: application/json

{
  "foo": "bar"
}
`;
    const result = await formatHttp(content, undefined, {
      formatBody: true,
      bodyFormat: { indent: 8, line_width: 80, expand_tabs: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.formatted).toContain('        "foo": "bar"');
    }
  });

  test("adds default http version on the same line for simple requests", async () => {
    const content = `### MOO
POST https://echo.kulala.app/get?foo=bar
Accept: application/json
`;
    const result = await formatHttp(content, undefined, {
      formatBody: false,
      defaults: { http_version: "HTTP/1.1" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.formatted).toContain(
        "POST https://echo.kulala.app/get?foo=bar HTTP/1.1",
      );
      expect(result.formatted).not.toMatch(
        /POST https:\/\/httpbin\.org\/get\?foo=bar\n\s+HTTP\/1\.1/,
      );
    }
  });

  test("omits http version for GRPC requests", async () => {
    const content = `### GRPC_ECHO
GRPC localhost:8080 grpc_echo.v1.EchoService/Echo
Content-Type: application/json

{ "ping": "Hello" }
`;
    const result = await formatHttp(content, undefined, {
      formatBody: false,
      defaults: { http_version: "HTTP/1.1" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.formatted).toContain(
        "GRPC localhost:8080 grpc_echo.v1.EchoService/Echo\n",
      );
      expect(result.formatted).not.toContain("HTTP/1.1");
    }
  });

  test("omits http version when defaults.http_version is false", async () => {
    const content = `### FOO
GET https://echo.kulala.app/get?foo=bar HTTP/1.1
Accept: application/json

### MOO
POST https://echo.kulala.app/get?foo=bar
Accept: application/json
`;
    const result = await formatHttp(content, undefined, {
      formatBody: false,
      defaults: { http_version: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.formatted).toContain(
        "GET https://echo.kulala.app/get?foo=bar\nAccept:",
      );
      expect(result.formatted).toContain(
        "POST https://echo.kulala.app/get?foo=bar\nAccept:",
      );
      expect(result.formatted).not.toContain("HTTP/1.1");
      expect(result.formatted).not.toContain("HTTP/2");
    }
  });

  test("expand_tabs false indents JSON bodies with tab characters", async () => {
    const content = `### MOO
POST https://example.com

{
  "foo": "bar"
}
`;
    const result = await formatHttp(content, undefined, {
      formatBody: true,
      bodyFormat: { indent: 4, line_width: 80, expand_tabs: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.formatted).toContain('\t"foo": "bar"');
      expect(result.formatted).not.toMatch(/\n {4}"foo": "bar"/);
    }
  });

  test("expand_tabs true converts literal tabs in JSON bodies to spaces", async () => {
    const content = `### MOO
POST https://example.com

{
\t"foo": "bar"
}
`;
    const result = await formatHttp(content, undefined, {
      formatBody: true,
      bodyFormat: { indent: 4, line_width: 80, expand_tabs: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.formatted).toContain('    "foo": "bar"');
      expect(result.formatted).not.toContain('\t"foo"');
    }
  });

  test("formatBody false preserves original JSON body text", async () => {
    const content = `### MOO
POST https://example.com

{
    "foo": "bar"
}
`;
    const withBody = await formatHttp(content, undefined, {
      formatBody: true,
      bodyFormat: { indent: 2, line_width: 80, expand_tabs: true },
    });
    const withoutBody = await formatHttp(content, undefined, {
      formatBody: false,
    });
    expect(withBody.success).toBe(true);
    expect(withoutBody.success).toBe(true);
    if (withBody.success && withoutBody.success) {
      expect(withBody.formatted).toContain('  "foo": "bar"');
      expect(withoutBody.formatted).toContain('    "foo": "bar"');
    }
  });

  test("preserves trailing commented-out GraphQL request after body format", async () => {
    const content = `### GQL_PERSON

GRAPHQL https://example.com/graphql HTTP/1.1
Accept: application/json

query Person($id: ID) {
  person(personID: $id) {
    name
  }
}

{ "id": 1 }

# ### GQL_PLANET
#
# GRAPHQL https://example.com/graphql HTTP/1.1
#
# query Planet($id: ID) {
#   planet(planetID: $id) {
#     name
#   }
# }
#
# { "id": 1 }

### NEXT
GET https://example.com/next
`;
    const result = await formatHttp(content, undefined, { formatBody: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.formatted).toContain("# ### GQL_PLANET");
    expect(result.formatted).toContain("# query Planet($id: ID) {");
    expect(result.formatted).toContain('# { "id": 1 }');
    expect(result.formatted).not.toContain("\nGET / HTTP/1.1\n");
    expect(result.formatted).toContain("### NEXT");
  });

  test("preserves leading commented-out request before first ###", async () => {
    const content = `# ### OLD
# GET https://old.example.com

### ACTIVE
GET https://example.com
`;
    const result = await formatHttp(content, undefined, { formatBody: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.formatted).toContain("# ### OLD");
    expect(result.formatted).toContain("# GET https://old.example.com");
    expect(result.formatted).toContain("### ACTIVE");
  });

  test("preserves commented-out @VAR = value preamble lines", async () => {
    const content = `# @CARD_CODE = gorillamoe
# @EMAIL = marco@example.com
# @SHOPIFY_SHOP_NAME = Urban Classics B2B
#
# ### Find customer by cardcode
#
# GRAPHQL {{ URL }} HTTP/1.1
# Accept: application/json
#
# query { __typename }
#
# { "query": "x" }

### Other
GET https://example.com
`;
    const result = await formatHttp(content, undefined, { formatBody: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.formatted).toContain("# @CARD_CODE = gorillamoe");
    expect(result.formatted).toContain("# @EMAIL = marco@example.com");
    expect(result.formatted).toContain(
      "# @SHOPIFY_SHOP_NAME = Urban Classics B2B",
    );
    expect(result.formatted).toContain("# ### Find customer by cardcode");
    expect(result.formatted).toContain("### Other");
  });

  test("pretty-prints each WebSocket message and keeps === separators", async () => {
    const content = `### WS
WEBSOCKET ws://localhost:8080/websocket
Content-Type: application/json

{"message":"First"}
===  // message separator
{"message":"Second"}
=== wait-for-server // after the server
{"message":"Third"}
`;
    const result = await formatHttp(content, undefined, { formatBody: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.formatted).toContain('{ "message": "First" }');
    expect(result.formatted).toContain("===  // message separator");
    expect(result.formatted).toContain('{ "message": "Second" }');
    expect(result.formatted).toContain(
      "=== wait-for-server // after the server",
    );
    expect(result.formatted).toContain('{ "message": "Third" }');
  });

  test("leaves === inside a non-websocket body intact", async () => {
    const content = `### POST
POST https://example.com

not-json
===
still one body
=== wait-for-server
tail
`;
    const result = await formatHttp(content, undefined, { formatBody: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.formatted).toContain(
      "not-json\n===\nstill one body\n=== wait-for-server\ntail",
    );
  });
});

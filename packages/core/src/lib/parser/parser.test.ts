import { expect, test } from "bun:test";
import { resolveVariables, substituteInString } from "../variables";
import { getDocument } from "./parser";

test("parser: CRLF line endings parse ### blocks", async () => {
  const content = "### GET_example\r\nGET https://example.com\r\n";
  const doc = await getDocument(content, "/test.http");
  expect(doc.blocks).toHaveLength(1);
  expect(doc.blocks[0]?.name).toBe("GET_example");
  expect(doc.blocks[0]?.request.method).toBe("GET");
});

test("parser: first request does not require a block delimiter", async () => {
  const content = `GRAPHQL https://api.github.com/graphql HTTP/1.1
Accept: application/json

query User() {
  viewer {
    bio
  }
}`;

  const doc = await getDocument(content);
  const block = doc.blocks[0];

  expect(doc.blocks).toHaveLength(1);
  expect(block.errors).toEqual([]);
  expect(block.name).toBe("REQUEST_001");
  expect(block.request.method).toBe("GRAPHQL");
  expect(block.request.url).toBe("https://api.github.com/graphql");
  expect(block.request.httpVersion).toBe("HTTP/1.1");
  expect(block.request.body).toEqual({
    query: `query User() {
  viewer {
    bio
  }
}`,
  });
});

test("parser: implicit first request can be followed by delimited requests", async () => {
  const content = `GET https://example.com HTTP/1.1

### Next
GET https://nixos.org HTTP/1.1`;

  const doc = await getDocument(content);

  expect(doc.blocks).toHaveLength(2);
  expect(doc.blocks[0]?.name).toBe("REQUEST_001");
  expect(doc.blocks[0]?.request.url).toBe("https://example.com");
  expect(doc.blocks[1]?.name).toBe("Next");
  expect(doc.blocks[1]?.request.url).toBe("https://nixos.org");
});

test("parser: implicit first request starts after file header metadata", async () => {
  const content = `@TOKEN = header-value
# @no-log

POST https://example.com HTTP/1.1
Content-Type: text/plain

@TOKEN = body-value
# @no-cookie-jar
run ./not-a-directive.http
import ./also-not-a-directive.http`;

  const doc = await getDocument(content);
  const block = doc.blocks[0];

  expect(doc.directives).toEqual([]);
  expect(doc.fileHeaderVariables).toEqual({ TOKEN: "header-value" });
  expect(doc.fileHeaderOperators?.map((o) => o.name)).toEqual(["no-log"]);
  expect(block?.preambleVariables).toBeUndefined();
  expect(block?.operators).toEqual([]);
  expect(block?.position).toEqual({ start: 1, end: 10 });
  expect(block?.contentStartLine).toBe(4);
  expect(block?.request.body).toBe(
    `@TOKEN = body-value
# @no-cookie-jar
run ./not-a-directive.http
import ./also-not-a-directive.http`,
  );
});

test("parser: GraphQL query with type annotations not parsed as header", async () => {
  const content = `### GQL_WITH_VARIABLES

GRAPHQL https://swapi-graphql.netlify.app/.netlify/functions/index HTTP/1.1
Accept: application/json

query Person($id: ID) {
  person(personID: $id) {
    name
  }
}

{
  "id": 1
}`;

  const doc = await getDocument(content);
  const block = doc.blocks[0];

  expect(block.errors).toEqual([]);
  expect(block.request.method).toBe("GRAPHQL");
  expect(block.request.httpVersion).toBe("HTTP/1.1");
  expect(
    block.request.headerSection.filter((h) => h.type === "header"),
  ).toHaveLength(1);
  expect(block.request.headerSection[0]?.type).toBe("header");
  if (block.request.headerSection[0]?.type === "header") {
    expect(block.request.headerSection[0].name).toBe("Accept");
    expect(block.request.headerSection[0].value).toBe("application/json");
  }
  expect(block.request.body).toBeDefined();
  if (
    block.request.body &&
    typeof block.request.body === "object" &&
    "query" in block.request.body
  ) {
    expect((block.request.body as { query: string }).query).toContain(
      "query Person($id: ID)",
    );
    expect((block.request.body as { query: string }).query).toContain(
      "person(personID: $id)",
    );
    expect(
      (block.request.body as { variables?: Record<string, unknown> }).variables,
    ).toEqual({
      id: 1,
    });
  }
});

test("parser: GraphQL query with multiple type annotations", async () => {
  const content = `### GQL_COMPLEX

GRAPHQL https://api.example.com/graphql HTTP/1.1
Content-Type: application/json
Authorization: Bearer token123

query GetUsers($filter: UserFilter, $limit: Int, $offset: Int) {
  users(filter: $filter, limit: $limit, offset: $offset) {
    id
    name
    email: String
  }
}

{
  "filter": { "active": true },
  "limit": 10,
  "offset": 0
}`;

  const doc = await getDocument(content);
  const block = doc.blocks[0];

  expect(block.errors).toEqual([]);
  expect(block.request.method).toBe("GRAPHQL");
  const headers = block.request.headerSection.filter(
    (h) => h.type === "header",
  );
  expect(headers).toHaveLength(2);
  expect(headers.map((h) => (h.type === "header" ? h.name : null))).toEqual([
    "Content-Type",
    "Authorization",
  ]);
  expect(block.request.body).toBeDefined();
  if (
    block.request.body &&
    typeof block.request.body === "object" &&
    "query" in block.request.body
  ) {
    const body = block.request.body as {
      query: string;
      variables?: Record<string, unknown>;
    };
    expect(body.query).toContain("query GetUsers($filter: UserFilter");
    expect(body.query).toContain("$limit: Int");
    expect(body.query).toContain("$offset: Int");
    expect(body.variables).toEqual({
      filter: { active: true },
      limit: 10,
      offset: 0,
    });
  }
});

test("parser: regular POST with JSON body containing colons not parsed as headers", async () => {
  const content = `### POST_REQUEST

POST https://api.example.com/users HTTP/1.1
Content-Type: application/json

{
  "user": {
    "name": "John",
    "settings": {
      "theme": "dark",
      "timezone": "UTC"
    }
  }
}`;

  const doc = await getDocument(content);
  const block = doc.blocks[0];

  expect(block.errors).toEqual([]);
  expect(block.request.method).toBe("POST");
  const headers = block.request.headerSection.filter(
    (h) => h.type === "header",
  );
  expect(headers).toHaveLength(1);
  expect(headers[0]?.type).toBe("header");
  if (headers[0]?.type === "header") {
    expect(headers[0].name).toBe("Content-Type");
  }
  expect(block.request.body).toBeDefined();
});

test("parser: GRAPHQL with query file and inline variables", async () => {
  const content = `### GQL_FILE_AND_VARS

GRAPHQL https://swapi-graphql.netlify.app/graphql HTTP/1.1
Accept: application/json

< ./graphql.graphql

{
  "id": 1
}`;

  const doc = await getDocument(content);
  const block = doc.blocks[0];

  expect(block.errors).toEqual([]);
  expect(block.request.method).toBe("GRAPHQL");
  expect(block.request.body).toEqual({
    __bodyFromFile: "./graphql.graphql",
    __graphqlVariablesSuffix: '{\n  "id": 1\n}',
  });
});

test("parser: POST with body from file (< path) JetBrains syntax", async () => {
  const content = `### POST_BODY_FROM_FILE

POST https://example.com:8080/api/html/post HTTP/1.1
Content-Type: application/json

< ./input.json`;

  const doc = await getDocument(content);
  const block = doc.blocks[0];

  expect(block.errors).toEqual([]);
  expect(block.request.method).toBe("POST");
  expect(block.request.body).toEqual({ __bodyFromFile: "./input.json" });
});

test("parser: redirect response to file (>> and >>!) JetBrains syntax", async () => {
  const contentWithAppend = `### SAVE_RESPONSE

GET https://echo.kulala.app/get HTTP/1.1

>> myFolder/myFile.json`;

  const docAppend = await getDocument(contentWithAppend);
  const blockAppend = docAppend.blocks[0];
  expect(blockAppend.errors).toEqual([]);
  expect(blockAppend.request.responseRedirect).toEqual({
    filePath: "myFolder/myFile.json",
    overwrite: false,
  });

  const contentWithOverwrite = `### OVERWRITE_RESPONSE

POST https://echo.kulala.app/post HTTP/1.1
Content-Type: application/json

{}
>>! output/result.json`;

  const docOverwrite = await getDocument(contentWithOverwrite);
  const blockOverwrite = docOverwrite.blocks[0];
  expect(blockOverwrite.errors).toEqual([]);
  expect(blockOverwrite.request.responseRedirect).toEqual({
    filePath: "output/result.json",
    overwrite: true,
  });
});

test("parser: request line sets httpVersion (HTTP/1.1, HTTP/2)", async () => {
  const contentHttp11 = `### GET_HTTP_1_1
GET https://example.com/ HTTP/1.1

### GET_HTTP_2
GET https://example.com/ HTTP/2
`;

  const doc = await getDocument(contentHttp11);
  expect(doc.blocks).toHaveLength(2);
  expect(doc.blocks[0]?.request.method).toBe("GET");
  expect(doc.blocks[0]?.request.httpVersion).toBe("HTTP/1.1");
  expect(doc.blocks[1]?.request.method).toBe("GET");
  expect(doc.blocks[1]?.request.httpVersion).toBe("HTTP/2");
});

test("parser: @DOC_ENV_TEST=production before blocks is parsed and substitutes in URL", async () => {
  const content = `@DOC_ENV_TEST=production

### Req
GET https://example.com/{{DOC_ENV_TEST}}/v1 HTTP/1.1
`;

  const doc = await getDocument(content.trim());
  expect(doc.fileHeaderVariables?.DOC_ENV_TEST).toBe("production");
  const block = doc.blocks[0];
  expect(block?.errors).toEqual([]);
  const vars = await resolveVariables(
    "default",
    "doc-id",
    block!.name,
    process.cwd(),
    {
      fileHeader: doc.fileHeaderVariables,
      blockPreamble: block!.preambleVariables,
    },
  );
  expect(vars.DOC_ENV_TEST).toBe("production");
  expect(substituteInString(block!.request.url, vars)).toBe(
    "https://example.com/production/v1",
  );
});

test("parser: @ variable with spaces and POST full-URL template", async () => {
  const content = `@API_URL = https://api.example.com

### Create
POST {{API_URL}}/items HTTP/1.1
`;

  const doc = await getDocument(content.trim());
  expect(doc.fileHeaderVariables?.API_URL).toBe("https://api.example.com");
  const block = doc.blocks[0];
  expect(block?.errors).toEqual([]);
  const vars = await resolveVariables(
    "default",
    "doc-id",
    block!.name,
    process.cwd(),
    {
      fileHeader: doc.fileHeaderVariables,
      blockPreamble: block!.preambleVariables,
    },
  );
  expect(substituteInString(block!.request.url, vars)).toBe(
    "https://api.example.com/items",
  );
});

test("parser: @ variable in block preamble before request", async () => {
  const content = `### Req
@SEGMENT = beta
GET https://example.com/{{SEGMENT}}/x HTTP/1.1
`;

  const doc = await getDocument(content.trim());
  const block = doc.blocks[0];
  expect(block?.errors).toEqual([]);
  expect(block?.preambleVariables?.SEGMENT).toBe("beta");
  const vars = await resolveVariables(
    "default",
    "doc-id",
    block!.name,
    process.cwd(),
    {
      fileHeader: doc.fileHeaderVariables,
      blockPreamble: block!.preambleVariables,
    },
  );
  expect(substituteInString(block!.request.url, vars)).toBe(
    "https://example.com/beta/x",
  );
});

test("parser: file-header kulala-curl-- passthrough operators", async () => {
  const content = `# @kulala-curl--insecure
# @kulala-curl--max-time 30

### REQ
GET https://example.com HTTP/1.1
`;
  const doc = await getDocument(content.trim());
  expect(doc.fileHeaderOperators?.map((o) => o.name)).toEqual([
    "kulala-curl--insecure",
    "kulala-curl--max-time",
  ]);
  expect(doc.fileHeaderOperators?.[1]?.args).toBe("30");
});

test("parser: # @kulala-vscode-restclient-compat before first ### enables file flag", async () => {
  const content = `# @kulala-vscode-restclient-compat

### REQUEST_ONE
GET https://example.com HTTP/1.1
`;
  const doc = await getDocument(content.trim());
  expect(doc.vscodeRestclientCompat).toBe(true);
});

test("parser: # @kulala-vscode-restclient-compat before import keeps file flag", async () => {
  const content = `# @kulala-vscode-restclient-compat
import ./other.http

### REQUEST_ONE
GET https://example.com HTTP/1.1
`;
  const doc = await getDocument(content.trim());
  expect(doc.vscodeRestclientCompat).toBe(true);
});

test("parser: parses JetBrains # @name operator", async () => {
  const content = `### AUTH_REQUEST
# @name LOGIN_REQUEST
POST https://example.com/login HTTP/1.1
`;
  const doc = await getDocument(content.trim());
  const block = doc.blocks[0]!;
  expect(block.errors).toEqual([]);
  expect(block.operators.map((o) => o.name)).toEqual(["name"]);
  expect(block.operators[0]?.args).toBe("LOGIN_REQUEST");
});

test("parser: parses kulala-prefixed operators in block preamble", async () => {
  const content = `### Ops
# @kulala-file-contents-to-variable FOO ./bar.txt
# @kulala-expect-status-code 200,201
# @kulala-curl--insecure
# @kulala-curl--connect-timeout 5
# @kulala-curl--max-time 10
# @kulala-prompt "What is your name?" NAME
GET https://example.com/{{FOO}} HTTP/1.1
`;

  const doc = await getDocument(content.trim());
  const block = doc.blocks[0]!;
  expect(block.errors).toEqual([]);
  const names = block.operators.map((o) => o.name);
  expect(names).toEqual([
    "kulala-file-contents-to-variable",
    "kulala-expect-status-code",
    "kulala-curl--insecure",
    "kulala-curl--connect-timeout",
    "kulala-curl--max-time",
    "kulala-prompt",
  ]);
  expect(block.operators[5]?.args).toBe(`"What is your name?" NAME`);
});

test("parser: parses kulala-keep-alive-stream operator", async () => {
  const content = `### Stream
# @kulala-keep-alive-stream
GET https://example.com/events HTTP/1.1
`;
  const doc = await getDocument(content.trim());
  const block = doc.blocks[0]!;
  expect(block.errors).toEqual([]);
  expect(block.operators.map((o) => o.name)).toEqual([
    "kulala-keep-alive-stream",
  ]);
});

test("parser: parses kulala-openapi-explorer operator", async () => {
  const content = `### OpenAPI
# @kulala-openapi-explorer
GET https://echo.kulala.app/openapi.json HTTP/1.1
`;
  const doc = await getDocument(content.trim());
  const block = doc.blocks[0]!;
  expect(block.errors).toEqual([]);
  expect(block.operators.map((o) => o.name)).toEqual([
    "kulala-openapi-explorer",
  ]);
});

test("parser: parses kulala-openapi-no-cache operator", async () => {
  const content = `### OpenAPI
# @kulala-openapi-explorer
# @kulala-openapi-no-cache
GET https://echo.kulala.app/openapi.json HTTP/1.1
`;
  const doc = await getDocument(content.trim());
  const block = doc.blocks[0]!;
  expect(block.errors).toEqual([]);
  expect(block.operators.map((o) => o.name)).toEqual([
    "kulala-openapi-explorer",
    "kulala-openapi-no-cache",
  ]);
});

test("parser: parses JetBrains // @ tags as operators", async () => {
  const content = `### Tags
// @no-redirect
// @timeout 100 ms
// @connection-timeout 2 s
// @no-log
// @no-cookie-jar
// @no-auto-encoding
GET https://example.com HTTP/1.1
`;
  const doc = await getDocument(content.trim());
  const block = doc.blocks[0]!;
  expect(block.errors).toEqual([]);
  expect(block.operators.map((o) => o.name)).toEqual([
    "no-redirect",
    "timeout",
    "connection-timeout",
    "no-log",
    "no-cookie-jar",
    "no-auto-encoding",
  ]);
  expect(block.operators[1]?.args).toBe("100 ms");
  expect(block.operators[2]?.args).toBe("2 s");
});

test("stdin-style JSON round-trip must preserve {{var}} (core.sh must not escape curlies)", () => {
  const content =
    "@DOC_ENV_TEST=production\n\n### R\nGET https://ex.test/{{NAME}} HTTP/1.1\n";
  const payload = {
    action: "run",
    filepath: "/tmp/example.http",
    content,
    limit: [{ filter: "cursorPosition" as const, line: 5, column: 1 }],
  };
  const round = JSON.parse(JSON.stringify(payload)) as typeof payload;
  expect(round.content).toContain("{{NAME}}");
  expect(round.content).not.toContain("\\{\\{");
});

test("scripts-style block keeps {{NAME}} in request URL after parse (inlined fixture)", async () => {
  const content = `@DOC_ENV_TEST=production

### JS_SCRIPT_REQ

< {%
  request.variables.set("NAME", "kulala")
  client.global.set("GLOBAL_FOO", "bar")
%}

POST https://echo.kulala.app/post?name={{NAME}}
Content-Type: application/json
X-Global-Foo: {{GLOBAL_FOO}}

{
  "username": "user123",
  "password": "pass123",
  "withsecrets_env_test": "{{ SOME_HARD_CODED_ENV }}",
  "doc_env_test": "{{ DOC_ENV_TEST }}",
  "OS_USER": "{{ $env.USER }}"
}

> {% lang=lua
  request.variables.set("STATUS", tostring(response.status))
  request.variables.set("DATE", response.headers.valueOf("Date") or "")
%}
`;

  const doc = await getDocument(content, "/tmp/scripts-regression.http");
  const block = doc.blocks.find((b) => b.name === "JS_SCRIPT_REQ");
  expect(block).toBeDefined();
  expect(block!.errors).toEqual([]);
  expect(block!.request.url).toContain("{{NAME}}");
  expect(block!.request.url).not.toMatch(/\\\{\{/);
});

test("parses GRPC request line and grpc operators", async () => {
  const content = `
### Greet

# @grpc-import-path ../protos
# @grpc-proto helloworld.proto

GRPC localhost:50051 helloworld.Greeter/SayHello
Content-Type: application/json

{"name": "world"}
`;
  const doc = await getDocument(content, "/tmp/grpc.http");
  const block = doc.blocks.find((b) => b.name === "Greet");
  expect(block).toBeDefined();
  expect(block!.errors).toEqual([]);
  expect(block!.request.method).toBe("GRPC");
  expect(block!.request.grpcCommand?.address).toBe("localhost:50051");
  expect(block!.request.grpcCommand?.symbol).toBe(
    "helloworld.Greeter/SayHello",
  );
  const opNames = block!.operators.map((o) => o.name);
  expect(opNames).toContain("grpc-import-path");
  expect(opNames).toContain("grpc-proto");
});

test("parses # @grpc-authority operator", async () => {
  const content = `
### Tunnelled

# @grpc-authority real.example.com
# @grpc-plaintext

GRPC localhost:50051 helloworld.Greeter/SayHello
`;
  const doc = await getDocument(content, "/tmp/grpc-authority.http");
  const block = doc.blocks.find((b) => b.name === "Tunnelled");
  expect(block).toBeDefined();
  expect(block!.errors).toEqual([]);
  const authority = block!.operators.find((o) => o.name === "grpc-authority");
  expect(authority?.args).toBe("real.example.com");
});

test("parses # @grpc-insecure operator", async () => {
  const content = `
### LocalTls

# @grpc-insecure

GRPC localhost:50051 helloworld.Greeter/SayHello
`;
  const doc = await getDocument(content, "/tmp/grpc-insecure.http");
  const block = doc.blocks.find((b) => b.name === "LocalTls");
  expect(block).toBeDefined();
  expect(block!.errors).toEqual([]);
  const insecure = block!.operators.find((o) => o.name === "grpc-insecure");
  expect(insecure).toBeDefined();
  expect(insecure?.args).toBeUndefined();
});

test("parses WEBSOCKET request line", async () => {
  const content = `
### Echo

WEBSOCKET wss://echo.websocket.org

{"hello": true}
`;
  const doc = await getDocument(content, "/tmp/ws.http");
  const block = doc.blocks.find((b) => b.name === "Echo");
  expect(block).toBeDefined();
  expect(block!.request.method).toBe("WEBSOCKET");
  expect(block!.request.url).toBe("wss://echo.websocket.org");
});

test("parses WEBSOCKET request line with trailing HTTP version", async () => {
  const content = `
### Echo

WEBSOCKET wss://ws.ifelse.io HTTP/1.1

{"hello": true}
`;
  const doc = await getDocument(content, "/tmp/ws.http");
  const block = doc.blocks.find((b) => b.name === "Echo");
  expect(block).toBeDefined();
  expect(block!.request.method).toBe("WEBSOCKET");
  expect(block!.request.url).toBe("wss://ws.ifelse.io");
  expect(block!.request.httpVersion).toBe("HTTP/1.1");
});

test("parses WEBSOCKET request line with spaced variable placeholder", async () => {
  const content = `
### Echo

WEBSOCKET {{ websocket.addr }}

{"hello": true}
`;
  const doc = await getDocument(content, "/tmp/ws.http");
  const block = doc.blocks.find((b) => b.name === "Echo");
  expect(block).toBeDefined();
  expect(block!.request.url).toBe("{{ websocket.addr }}");
});

test("parser: multi-line URL with HTTP version on same continuation line", async () => {
  const content = `GET https://echo.kulala.app/get?foo=echo.kulala.app/get?foo=1
  &bar=1 HTTP/1.1
Accept: application/json
`;
  const doc = await getDocument(content);
  const block = doc.blocks[0];

  expect(doc.blocks).toHaveLength(1);
  expect(block.errors).toEqual([]);
  expect(block.request.method).toBe("GET");
  expect(block.request.url).toBe(
    "https://echo.kulala.app/get?foo=echo.kulala.app/get?foo=1&bar=1",
  );
  expect(block.request.httpVersion).toBe("HTTP/1.1");
  expect(block.request.headerSection).toEqual([
    { type: "header", name: "Accept", value: "application/json" },
  ]);
});

test("parser: # ### commented separator does not start a new block", async () => {
  const content = `### FIRST
GET https://example.com/first

# ### COMMENTED
# GET https://example.com/commented

### SECOND
GET https://example.com/second
`;
  const doc = await getDocument(content);

  expect(doc.blocks).toHaveLength(2);
  expect(doc.blocks.map((b) => b.name)).toEqual(["FIRST", "SECOND"]);
});

test("parser: // ### commented separator does not start a new block", async () => {
  const content = `### FIRST
GET https://example.com/first

// ### COMMENTED
// GET https://example.com/commented

### SECOND
GET https://example.com/second
`;
  const doc = await getDocument(content);

  expect(doc.blocks).toHaveLength(2);
  expect(doc.blocks.map((b) => b.name)).toEqual(["FIRST", "SECOND"]);
});

test("parser: issue #168 commented ### LIST-POKEMON is not a block separator", async () => {
  const content = `### GET-POKEMON
GET https://pokeapi.co/api/v2/pokemon/pikachu

# ### LIST-POKEMON
# GET https://pokeapi.co/api/v2/pokemon
#   ?limit=5
#   &offset=0

### GET-TYPE
GET https://pokeapi.co/api/v2/type/electric
`;
  const doc = await getDocument(content);

  expect(doc.blocks).toHaveLength(2);
  expect(doc.blocks.map((b) => b.name)).toEqual(["GET-POKEMON", "GET-TYPE"]);
  expect(doc.blocks.some((b) => b.name === "LIST-POKEMON")).toBe(false);
});

test("parser: trailing commented-out request is kept on the previous block", async () => {
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
  const doc = await getDocument(content);
  expect(doc.blocks).toHaveLength(2);
  expect(doc.blocks[0]!.name).toBe("GQL_PERSON");
  expect(doc.blocks[0]!.trailingComments?.map((c) => c.content)).toEqual([
    "### GQL_PLANET",
    "",
    "GRAPHQL https://example.com/graphql HTTP/1.1",
    "",
    "query Planet($id: ID) {",
    "  planet(planetID: $id) {",
    "    name",
    "  }",
    "}",
    "",
    '{ "id": 1 }',
  ]);
  expect(doc.blocks[0]!.request.body).toEqual({
    query:
      "query Person($id: ID) {\n  person(personID: $id) {\n    name\n  }\n}",
    variables: { id: 1 },
  });
});

test("parser: leading commented-out request is kept as file header comments", async () => {
  const content = `# ### OLD
# GET https://old.example.com

### ACTIVE
GET https://example.com
`;
  const doc = await getDocument(content);
  expect(doc.blocks).toHaveLength(1);
  expect(doc.blocks[0]!.name).toBe("ACTIVE");
  expect(doc.fileHeaderComments?.map((c) => c.content)).toEqual([
    "### OLD",
    "GET https://old.example.com",
  ]);
});

test("parser: commented-out @VAR = value preamble is kept as comments", async () => {
  const content = `# @CARD_CODE = gorillamoe
# @EMAIL = marco@example.com
# @FIRST_NAME = Gorilla
#
# ### Find customer by cardcode
#
# GRAPHQL {{ URL }} HTTP/1.1
#
# query { __typename }
#
# { "query": "x" }

### Other
GET https://example.com
`;
  const doc = await getDocument(content);
  expect(doc.fileHeaderOperators).toBeUndefined();
  expect(doc.fileHeaderComments?.map((c) => c.content).slice(0, 5)).toEqual([
    "@CARD_CODE = gorillamoe",
    "@EMAIL = marco@example.com",
    "@FIRST_NAME = Gorilla",
    "",
    "### Find customer by cardcode",
  ]);
});

test("parser: real file-header operators still parse alongside comments", async () => {
  const content = `# @kulala-curl--insecure
# @CARD_CODE = gorillamoe
# plain note

### Active
GET https://example.com
`;
  const doc = await getDocument(content);
  expect(doc.fileHeaderOperators?.map((o) => o.name)).toEqual([
    "kulala-curl--insecure",
  ]);
  expect(doc.fileHeaderComments?.map((c) => c.content)).toEqual([
    "@CARD_CODE = gorillamoe",
    "plain note",
  ]);
});

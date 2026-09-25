import {
  scriptApiCompletionDetail,
  scriptApiDocumentationMarkdown,
  snippetToSignature,
} from "./script-api-docs";
import {
  type LspCompletionItem,
  LspCompletionItemKind,
  LspInsertTextFormat,
} from "./types";

type SourceItem = {
  label: string;
  insertText?: string;
  documentation?: string;
};

function makeItem(opts: {
  item: SourceItem;
  description?: string;
  kind?: number;
  insertTextFormat?: number;
  sortText?: string;
  detail?: string;
  documentation?: string;
}): LspCompletionItem {
  const { item, description, kind, insertTextFormat, sortText } = opts;
  const detail = opts.detail ?? item.insertText ?? item.label;
  const documentation =
    opts.documentation ??
    (item.documentation
      ? (scriptApiDocumentationMarkdown(item.label, item.documentation) ??
        item.documentation)
      : undefined);
  return {
    label: item.label,
    labelDetails: description ? { description } : undefined,
    kind,
    detail,
    documentation: documentation
      ? { kind: "markdown", value: documentation }
      : undefined,
    insertText: item.insertText ?? item.label,
    insertTextFormat,
    sortText,
  };
}

export function staticCompletionItems(sourceName: string): LspCompletionItem[] {
  const kindValue = LspCompletionItemKind.Value;
  const kindSnippet = LspCompletionItemKind.Snippet;
  const formatSnippet = LspInsertTextFormat.Snippet;

  // These are ported from kulala.nvim `lua/kulala/cmd/lsp_sources.lua`.
  const methods: SourceItem[] = [
    { label: "GET", insertText: "GET " },
    { label: "POST", insertText: "POST " },
    { label: "PUT", insertText: "PUT " },
    { label: "DELETE", insertText: "DELETE " },
    { label: "PATCH", insertText: "PATCH " },
    { label: "HEAD", insertText: "HEAD " },
    { label: "OPTIONS", insertText: "OPTIONS " },
    { label: "TRACE", insertText: "TRACE " },
    { label: "CONNECT", insertText: "CONNECT " },
    { label: "GRAPHQL", insertText: "GRAPHQL " },
    { label: "GRPC", insertText: "GRPC " },
    { label: "WEBSOCKET", insertText: "WEBSOCKET " },
  ];

  const schemes: SourceItem[] = [
    { label: "http", insertText: "http://" },
    { label: "https", insertText: "https://" },
    { label: "ws", insertText: "ws://" },
    { label: "wss", insertText: "wss://" },
  ];

  const commands: SourceItem[] = [
    { label: "run #", insertText: "run #", documentation: "Run request #name" },
    {
      label: "run ../",
      insertText: "run ",
      documentation: "Run requests in file",
    },
    {
      label: "import",
      insertText: "import ",
      documentation: "Import requests",
    },
  ];

  const metadata: SourceItem[] = [
    { label: "grpc", insertText: "grpc", documentation: "Grpc flag" },
    {
      label: "kulala-expect-status-code",
      insertText: "kulala-expect-status-code 404",
      documentation: "Assert response status code",
    },
    {
      label: "kulala-jq",
      insertText: "kulala-jq ",
      documentation: "Filter response body in UI with jq",
    },
    {
      label: "kulala-keep-alive-stream",
      insertText: "kulala-keep-alive-stream",
      documentation:
        "Stream the response body as it arrives (curl --no-buffer). Use for SSE, ndjson, and other long-lived HTTP responses.",
    },
    {
      label: "kulala-prompt",
      insertText:
        'kulala-prompt "What is your password?" MY_VAR_NAME { type: "password|text" }',
      documentation: "Prompt for a variable",
    },
    {
      label: "kulala-curl--",
      insertText: "kulala-curl--",
      documentation: "Curl flag",
    },
    {
      label: "no-log",
      insertText: "no-log",
      documentation: "Do not store request and response in history",
    },
    {
      label: "kulala-vscode-restclient-compat",
      insertText: "kulala-vscode-restclient-compat",
      documentation:
        "Enable VS Code REST Client request chaining\n\nSee: https://kulala.app/usage/request-variables#vs-code-rest-client-chaining",
    },
    {
      label: "kulala-openapi-explorer",
      insertText: "kulala-openapi-explorer",
      documentation:
        "Load OpenAPI spec from request URL or local path and open explorer UI",
    },
    {
      label: "kulala-openapi-no-cache",
      insertText: "kulala-openapi-no-cache",
      documentation:
        "Do not cache this OpenAPI spec; reload from source on every explorer open",
    },
    {
      label: "kulala-file-contents-to-variable",
      insertText: "kulala-file-contents-to-variable my-var file.txt",
      documentation: "Fail if response status is not in the list (200,201,204)",
    },
    {
      label: "timeout",
      insertText: "timeout 500 ms",
      documentation: "Total request timeout (500 ms, 5 s)",
    },
    {
      label: "no-cookie-jar",
      insertText: "no-cookie-jar",
      documentation: "Do not send or store cookies for this request",
    },
    {
      label: "connection-timeout",
      insertText: "connection-timeout 5 s",
      documentation: "Connection phase timeout (500 ms, 5 s)",
    },
    {
      label: "no-redirect",
      insertText: "no-redirect",
      documentation: "Do not follow HTTP redirects (3xx responses)",
    },
    {
      label: "no-auto-encoding",
      insertText: "no-auto-encoding",
      documentation:
        "Send URL query parameters and form-urlencoded body without percent-encoding",
    },
  ];

  const grpc: SourceItem[] = [
    {
      label: "grpc-import-path",
      insertText: "grpc-import-path",
      documentation: "Proto import path",
    },
    {
      label: "grpc-proto",
      insertText: "grpc-proto",
      documentation: "Proto file",
    },
    {
      label: "grpc-protoset",
      insertText: "grpc-protoset",
      documentation: "Protoset file",
    },
    {
      label: "grpc-plaintext",
      insertText: "grpc-plaintext",
      documentation: "No TLS",
    },
    {
      label: "grpc-insecure",
      insertText: "grpc-insecure",
      documentation:
        "Skip TLS certificate verification (grpcurl -insecure); useful for local/self-signed certs",
    },
    {
      label: "grpc-authority",
      insertText: "grpc-authority",
      documentation:
        "SSL server name / :authority (grpcurl -authority); useful when tunneling via localhost",
    },
    { label: "grpc-v", insertText: "grpc-verbose", documentation: "Verbose" },
  ];

  const headerValues: SourceItem[] = [
    { label: "Bearer " },
    { label: "Basic " },
    { label: "Digest " },
    { label: "NTLM " },
    { label: "Negotiate" },
    { label: "AWS" },
    { label: "application/json" },
    { label: "application/xml" },
    { label: "application/x-www-form-urlencoded" },
    { label: "application/octet-stream" },
    { label: "application/pdf" },
    { label: "application/zip" },
    { label: "application/graphql-response+json" },
    { label: "GraphQL" },
    { label: "text/plain" },
    { label: "text/html" },
    { label: "text/css" },
    { label: "text/javascript" },
    { label: "text/xml" },
    { label: "image/jpeg" },
    { label: "image/png" },
    { label: "image/gif" },
    { label: "image/svg+xml" },
    { label: "image/webp" },
    { label: "audio/mpeg" },
    { label: "audio/wav" },
    { label: "audio/ogg" },
    { label: "video/mp4" },
    { label: "video/webm" },
    { label: "video/ogg" },
    { label: "multipart/form-data" },
    {
      label:
        "multipart/form-data; boundary=----WebKitFormBoundary{{$timestamp}}",
    },
    { label: "chunked" },
    { label: "gzip" },
    { label: "deflate" },
    { label: "br" },
    { label: "identity" },
    { label: "compress" },
    { label: "x-gzip" },
    { label: "x-bzip2" },
    { label: "x-compress" },
    { label: "x-zip-compress" },
    { label: "x-zip" },
  ];

  const snippetsIn: SourceItem[] = [
    {
      label: "< {% %}",
      insertText: "< {%\n\t${0}\n%}\n",
      documentation: "Pre-request script",
    },
    {
      label: "< ",
      insertText: "< ${1:path/to/script.js|lua}",
      documentation: "Pre-request script file",
    },
    {
      label: "< {% %}",
      insertText: "< {%\n\t-- lua\n${0}\n%}\n",
      documentation: "Pre-request lua script",
    },
  ];

  const snippetsOut: SourceItem[] = [
    {
      label: ">>",
      insertText: ">> ",
      documentation: "Redirect output to file",
    },
    {
      label: ">>!",
      insertText: ">>! ",
      documentation: "Redirect output overwriting",
    },
    {
      label: "> {% %}",
      insertText: "> {%\n\t${0}\n%}\n",
      documentation: "Post-request script",
    },
    {
      label: "> ",
      insertText: "> ${1:path/to/script.js|lua}",
      documentation: "Post-request script file",
    },
    {
      label: "> {% %}",
      insertText: "> {%\n\t-- lua\n${0}\n%}\n",
      documentation: "Post-request lua script",
    },
  ];

  const scriptApi: SourceItem[] = [
    {
      label: "$kulala.prompt",
      insertText:
        '$kulala.prompt(${1:"label"}, ${2:"varName"}, { type: "${3|text,password,url|}" })$0',
      documentation: "Prompt for a request-scoped variable",
    },
    {
      label: "$kulala.request.skip",
      insertText: "$kulala.request.skip(${1:message})$0",
      documentation: "Skip sending this request (pre-request only)",
    },
    {
      label: "$kulala.request.abort",
      insertText: "$kulala.request.abort(${1:message})$0",
      documentation: "Abort this request as an error (pre-request only)",
    },
    {
      label: "$kulala.request.replay",
      insertText: "$kulala.request.replay()$0",
      documentation: "Re-run the current request",
    },
    {
      label: "$kulala.runRequest",
      insertText:
        'await $kulala.runRequest(${1:"BlockName"}, ${2:"./other.http"})$0',
      documentation: "Run a named HTTP request and return its response",
    },
    {
      label: "$kulala.client.global.headers.set",
      insertText:
        '$kulala.client.global.headers.set(${1:"headerName"}, ${2:"headerValue"})$0',
      documentation: "Set a persisted default HTTP header",
    },
    {
      label: "$kulala.client.global.headers.get",
      insertText: '$kulala.client.global.headers.get(${1:"headerName"})$0',
      documentation: "Get a persisted default HTTP header",
    },
    {
      label: "$kulala.client.global.headers.clear",
      insertText: '$kulala.client.global.headers.clear(${1:"headerName"})$0',
      documentation: "Clear a persisted default HTTP header",
    },
    {
      label: "client.global.get",
      insertText: 'client.global.get(${1:"varName"})$0',
      documentation: "Get a global variable",
    },
    {
      label: "client.global.set",
      insertText: 'client.global.set(${1:"varName"}, ${2:"value"})$0',
      documentation: "Set a global variable",
    },
    {
      label: "client.log",
      insertText: 'client.log(${1:"message"})$0',
      documentation: "Log message",
    },
    {
      label: "client.test",
      insertText: 'client.test(${1:"name"}, ${2:fn})$0',
      documentation: "Define a test suite",
    },
    {
      label: "client.assert",
      insertText: 'client.assert(${1:value}, ${2:"message"?})$0',
      documentation: "Checks if value is truthy",
    },
    {
      label: "client.isEmpty",
      insertText: "client.isEmpty()$0",
      documentation: "Check if globals are empty",
    },
    {
      label: "client.global.clear",
      insertText: 'client.global.clear(${1:"varName"})$0',
      documentation: "Clear a global variable",
    },
    {
      label: "client.global.clearAll",
      insertText: "client.global.clearAll()$0",
      documentation: "Clear all global variables",
    },
    {
      label: "client.exit",
      insertText: "client.exit()$0",
      documentation: "Exit script",
    },
    {
      label: "request.variables.set",
      insertText: 'request.variables.set(${1:"varName"}, ${2:"value"})$0',
      documentation: "Set a request variable",
    },
    {
      label: "request.variables.get",
      insertText: 'request.variables.get(${1:"varName"})$0',
      documentation: "Get a request variable",
    },
    {
      label: "request.headers.all",
      insertText: "request.headers.all()$0",
      documentation: "Get all request headers",
    },
    {
      label: "request.headers.findByName",
      insertText: 'request.headers.findByName(${1:"name"})$0',
      documentation: "Find request header by name",
    },
    {
      label: "request.body.getRaw",
      insertText: "request.body.getRaw()$0",
      documentation: "Get raw request body",
    },
    {
      label: "request.body.tryGetSubstituted",
      insertText: "request.body.tryGetSubstituted()$0",
      documentation: "Get substituted request body",
    },
    {
      label: "request.body.getComputed",
      insertText: "request.body.getComputed()$0",
      documentation: "Get computed request body",
    },
    {
      label: "request.environment.get",
      insertText: 'request.environment.get(${1:"varName"})$0',
      documentation: "Get environment variable",
    },
    {
      label: "request.method",
      insertText: "request.method$0",
      documentation: "Get request method",
    },
    {
      label: "request.url.getRaw",
      insertText: "request.url.getRaw()$0",
      documentation: "Get raw request URL",
    },
    {
      label: "request.url.tryGetSubstituted",
      insertText: "request.url.tryGetSubstituted()$0",
      documentation: "Get substituted request URL",
    },
    {
      label: "request.skip",
      insertText: "request.skip(${1:message})$0",
      documentation: "Skip sending this request (pre-request only)",
    },
    {
      label: "request.abort",
      insertText: "request.abort(${1:message})$0",
      documentation: "Abort this request as an error (pre-request only)",
    },
    {
      label: "request.replay",
      insertText: "request.replay()$0",
      documentation: "Re-run the current request",
    },
    {
      label: "request.iteration",
      insertText: "request.iteration()$0",
      documentation: "Current replay count",
    },
    {
      label: "response.status",
      insertText: "response.status$0",
      documentation: "Get response status code, e.g. 200",
    },
    {
      label: "response.body",
      insertText: "response.body()$0",
      documentation: "Get response body",
    },
    {
      label: "response.headers.valueOf",
      insertText: 'response.headers.valueOf(${1:"headerName"})$0',
      documentation:
        "Retrieves the first value of the headerName response header or null if the headerName response header does not exist.",
    },
    {
      label: "response.headers.valuesOf",
      insertText: 'response.headers.valuesOf(${1:"headerName"})$0',
      documentation:
        "Retrieves the array containing all values of the headerName response header. Returns an empty array if the headerName response header does not exist.",
    },
  ];

  const mk = (items: SourceItem[], description: string, kind = kindValue) =>
    items.map((item) =>
      makeItem({
        item,
        description,
        kind,
        sortText: "1.02", // keep parity with kulala.nvim's blink.cmp workaround
      }),
    );

  switch (sourceName) {
    case "methods":
      return mk(methods, "Method", kindValue);
    case "schemes":
      return mk(schemes, "Scheme", kindValue);
    case "commands":
      return mk(commands, "Command", kindValue);
    case "metadata":
      return mk(metadata, "Metadata", kindValue);
    case "grpc":
      return mk(grpc, "Grpc", kindValue);
    case "header_values":
      return mk(headerValues, "Header value", kindValue);
    case "snippets_in":
      return snippetsIn.map((item) =>
        makeItem({
          item,
          description: "Snippets",
          kind: kindSnippet,
          insertTextFormat: formatSnippet,
          sortText: "1.02",
        }),
      );
    case "snippets_out":
      return snippetsOut.map((item) =>
        makeItem({
          item,
          description: "Snippets",
          kind: kindSnippet,
          insertTextFormat: formatSnippet,
          sortText: "1.02",
        }),
      );
    case "scripts":
      return scriptApi.map((item) => {
        const isKulalaApi = item.label.startsWith("$kulala");
        const itemForInsert =
          isKulalaApi && item.insertText
            ? { ...item, insertText: snippetToSignature(item.insertText) }
            : item;
        return makeItem({
          item: itemForInsert,
          description: "API",
          kind: kindSnippet,
          // blink.cmp treats `$` as non-keyword and `vim.snippet.expand` strips a shared
          // prefix from Snippet items - use PlainText for `$kulala.*` completions.
          insertTextFormat: isKulalaApi
            ? LspInsertTextFormat.PlainText
            : formatSnippet,
          sortText: "1.02",
          detail: scriptApiCompletionDetail(item.label, item.insertText),
          documentation:
            scriptApiDocumentationMarkdown(item.label, item.documentation) ??
            undefined,
        });
      });
    default:
      return [];
  }
}

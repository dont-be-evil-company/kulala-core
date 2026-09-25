import type { KulalaScriptType } from "../parser/types/script";
import type { KulalaWebSocketMessage } from "../websocket/messages";
import type { KulalaResponseFormatOptions } from "./http-response-body";

export type { KulalaWebSocketMessage };

/** Where captured script output came from (pre/post phase, directive site, optional callsite). */
export type KulalaScriptConsoleOrigin = {
  phase: KulalaScriptType;
  source: "inline" | "file";
  /** Target file absolute path (.http when inline; .js/.ts/.lua script when external). */
  file: string;
  /** 1-based line in HTTP where `<` / `>` script directive begins. */
  httpDirectiveLine: number;
  /**
   * Optional 1-based line in `file` at callsite (`console.*` / etc.).
   * For inline, this equals the computed line in the same HTTP document.
   */
  line?: number;
  column?: number;
};

/** Captured `console.log` / `console.error` / etc. from pre- and post-request scripts (stdout stays JSON-only). */
export type KulalaScriptConsoleLine = {
  level: "log" | "error" | "warn" | "info" | "debug";
  message: string;
  origin: KulalaScriptConsoleOrigin;
  /** Structured script output kind (tests/asserts vs plain logs). */
  kind?: "log" | "test" | "assert";
  /** Parent test name when `kind` is `assert`. */
  testName?: string;
  status?: "pass" | "fail";
};

/** Request as sent (after scripts and variable substitution). */
export type KulalaRequestSent = {
  method: string;
  /** URL used for the initial request (before redirects). */
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

/** Returned for WEBSOCKET/WS/WSS - nvim starts a native WebSocket session via kulala-core. */
export type KulalaWebSocketPlanResponse = {
  success: true;
  protocol: "websocket";
  url: string;
  /**
   * First frame when it is sent on connect (`waitForServer === 0`).
   * Omitted when the script waits before the first send, so older hosts
   * do not emit that frame early.
   */
  initialMessage?: string;
  /** IntelliJ `===` / `=== wait-for-server` script. Empty when the body is empty. */
  messages: KulalaWebSocketMessage[];
  /** From `# @timeout`, when set. Hosts pass this through to the session. */
  timeoutMs?: number;
  request?: KulalaRequestSent;
  /** jq filter from `# @kulala-jq` (block overrides file header). */
  jqFilter?: string;
};

export type KulalaRequestSuccessResponse = {
  success: true;
  /** `###` block name for this request (for multi-run / `run ./file.http` consumers). */
  blockName?: string;
  status: number;
  /** Protocol version from the response status line (e.g. HTTP/2). */
  httpVersion?: string;
  headers: Record<string, string>;
  /** Final resolved URL (after redirects). */
  url: string;
  /** Resolved request as sent (matches scripts, env, and magic variables). */
  request?: KulalaRequestSent;
  /** Present only when at least one redirect occurred (ordered hops, including the final response). */
  redirectChain?: Array<{
    status: number;
    httpVersion?: string;
    headers: Record<string, string>;
    url: string;
    body:
      | { type: "text"; content: string; mediaType?: string }
      | {
          type: "binary";
          /** Base64-encoded bytes. */
          content: string;
          encoding: "base64";
          byteLength: number;
          mediaType?: string;
        }
      | {
          type: "json";
          content: Record<string, unknown>;
          formatted?: string;
        };
    timings: {
      dns: number;
      tcp: number;
      tls: number;
      request: number;
      redirect: number;
      firstByte: number;
      startTransfer: number;
      total: number;
    };
    /** curl `-v` stderr for this hop. */
    verboseTrace?: string;
  }>;
  /** curl `-v` stderr for the final hop. */
  verboseTrace?: string;
  timings: {
    dns: number;
    tcp: number;
    tls: number;
    request: number;
    redirect: number;
    /** Time from request sent to first byte (server TTFB). */
    firstByte: number;
    /** Time from start to first byte; matches curl time_starttransfer. */
    startTransfer: number;
    total: number;
  };
  body:
    | { type: "text"; content: string; mediaType?: string }
    | {
        type: "binary";
        /** Base64-encoded bytes. */
        content: string;
        encoding: "base64";
        byteLength: number;
        mediaType?: string;
      }
    | {
        type: "json";
        content: Record<string, unknown>;
        formatted?: string;
      };
  /** Unformatted response body (for on-demand jq filtering). */
  rawBody?: string;
  /** jq-filtered body when a filter is active (`# @kulala-jq` or run-time filter). */
  filteredBody?: KulalaRequestSuccessResponse["body"];
  /** Active jq filter when `filteredBody` is present. */
  jqFilter?: string;
  /** Present when scripts emitted console output (including client.test / client.log). */
  scriptConsole?: KulalaScriptConsoleLine[];
  /** Open OpenAPI explorer instead of standard response UI. */
  openapiUi?: true;
  openapi?: import("../openapi/types").OpenAPIUiPayload;
};

export type KulalaRequestErrorResponse = {
  success: false;
  blockName?: string;
  error: string;
  /** Present when scripts ran before the failure (e.g. pre-request or failed expect-status). */
  scriptConsole?: KulalaScriptConsoleLine[];
  /** Pre-request script called `$kulala.request.abort()` - no HTTP request was sent. */
  aborted?: true;
  /**
   * HTTP finished before the failure (JetBrains: response-handler script errors).
   * Response fields below are populated so the UI can still show the received response.
   */
  httpCompleted?: boolean;
  status?: number;
  httpVersion?: string;
  headers?: Record<string, string>;
  url?: string;
  request?: KulalaRequestSent;
  timings?: KulalaRequestSuccessResponse["timings"];
  body?: KulalaRequestSuccessResponse["body"];
  rawBody?: string;
  filteredBody?: KulalaRequestSuccessResponse["body"];
  redirectChain?: KulalaRequestSuccessResponse["redirectChain"];
  verboseTrace?: string;
};

export type KulalaPromptResponse = {
  success: false;
  prompt: true;
  promptId: string;
  promptType: string;
  message: string;
  inputs: Array<{
    id: string;
    label: string;
    type: "text" | "password" | "url";
    required?: boolean;
  }>;
};

/** Pre-request script called `$kulala.request.skip()` - no HTTP request was sent. */
export type KulalaSkippedResponse = {
  success: true;
  skipped: true;
  /** Human-readable skip reason (default: "Request skipped by script"). */
  message?: string;
  blockName?: string;
  scriptConsole?: KulalaScriptConsoleLine[];
  /** Synthetic body so UIs that default to the body pane still show pre-skip logs. */
  body: KulalaRequestSuccessResponse["body"];
};

export type KulalaResponseWrapper =
  | {
      type: "responses";
      data: Array<
        | KulalaRequestSuccessResponse
        | KulalaRequestErrorResponse
        | KulalaPromptResponse
        | KulalaSkippedResponse
        | KulalaWebSocketPlanResponse
      >;
    }
  | {
      type: "error";
      data: Array<KulalaRequestErrorResponse>;
    };

export type RequestHeaderType =
  | "json"
  | "form-data"
  | "form-urlencoded"
  | "invalid";

export type VariableResolver = (name: string) => string | undefined;

export type KulalaRunOptions = {
  /** Raw document content (for stable ID when filepath is absent). */
  content?: string;
  /** Environment name for variable resolution (withsecrets, etc.). Defaults to "default". */
  env?: string;
  /** Pretty-print response bodies (indentation, tabs vs spaces). */
  responseFormat?: KulalaResponseFormatOptions;
  /** Optional jq filter override for this run (block `# @kulala-jq` still wins). */
  jqFilter?: string;
  /** Stop running remaining requests after the first failure. */
  haltOnError?: boolean;
};

/** Response-like value passed to scripts (fetch Response or compatible). */
export type RunnerResponseLike = {
  body: unknown;
  statusCode: number;
  headers: Record<string, string>;
  timings: { phases: Record<string, number> };
};

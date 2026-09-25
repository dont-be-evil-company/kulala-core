export type KulalaResponseBody =
  | { type: "text"; content: string; mediaType?: string }
  | {
      type: "binary";
      /** Base64-encoded bytes. */
      content: string;
      encoding: "base64";
      byteLength: number;
      mediaType?: string;
    }
  | { type: "json"; content: Record<string, unknown>; formatted?: string };

export type KulalaScriptConsoleLine = {
  level: "log" | "error" | "warn" | "info" | "debug";
  message: string;
  origin: { type: string; name?: string; line?: number };
};

export type KulalaRequestSuccessResponse = {
  success: true;
  blockName?: string;
  status: number;
  headers: Record<string, string>;
  url: string;
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
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
  body: KulalaResponseBody;
  filteredBody?: KulalaResponseBody;
  scriptConsole?: KulalaScriptConsoleLine[];
};

export type KulalaRequestErrorResponse = {
  success: false;
  blockName?: string;
  error: string;
  scriptConsole?: KulalaScriptConsoleLine[];
  httpCompleted?: boolean;
  status?: number;
  headers?: Record<string, string>;
  url?: string;
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  };
  body?: KulalaResponseBody;
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

export type KulalaSkippedResponse = {
  success: true;
  skipped: true;
  message?: string;
  blockName?: string;
  scriptConsole?: KulalaScriptConsoleLine[];
};

export type KulalaWebSocketMessage = {
  waitForServer: number;
  data: string;
};

export type KulalaWebSocketPlanResponse = {
  success: true;
  protocol: "websocket";
  url: string;
  initialMessage?: string;
  messages?: KulalaWebSocketMessage[];
  timeoutMs?: number;
};

export type KulalaResponseItem =
  | KulalaRequestSuccessResponse
  | KulalaRequestErrorResponse
  | KulalaPromptResponse
  | KulalaSkippedResponse
  | KulalaWebSocketPlanResponse;

export type KulalaResponseWrapper =
  | { type: "responses"; data: KulalaResponseItem[] }
  | { type: "error"; data: KulalaRequestErrorResponse[] };

export type RunLimit =
  | { filter: "name"; name: string }
  | { filter: "cursorPosition"; line: number; column: number };

export type KulalaDocument = {
  hasErrors: boolean;
  blocks: Array<{
    name: string;
    errors?: Array<{ message: string; lineNumber?: number }>;
  }>;
  [key: string]: unknown;
};

export type KulalaHttpFormatResult = {
  content: string;
  changed: boolean;
};

export type KulalaRunInput = {
  content: string;
  filepath?: string;
  env?: string;
  limit?: RunLimit[];
  haltOnError?: boolean;
};

export type KulalaParseInput = {
  content: string;
  filepath?: string;
};

export type KulalaFormatInput = {
  content: string;
  filepath?: string;
  formatBody?: boolean;
  bodyFormat?: {
    indent?: number;
    line_width?: number;
    expand_tabs?: boolean;
  };
  defaults?: {
    http_method?: string;
    http_version?: string | false;
  };
};

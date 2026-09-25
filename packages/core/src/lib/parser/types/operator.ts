/** `# @kulala-curl--*` passthrough operators (dynamic curl long-option names). */
export type KulalaCurlPassthroughOperatorName = `kulala-curl--${string}`;

export type KulalaOperatorName =
  | "name"
  | "accept"
  | "no-redirect"
  | "no-log"
  | "no-cookie-jar"
  | "no-auto-encoding"
  | "timeout"
  | "connection-timeout"
  | "kulala-file-contents-to-variable"
  | "kulala-expect-status-code"
  | "kulala-prompt"
  | "grpc-import-path"
  | "grpc-proto"
  | "grpc-protoset"
  | "grpc-plaintext"
  | "grpc-insecure"
  | "grpc-authority"
  | "grpc-v"
  | "kulala-vscode-restclient-compat"
  | "kulala-openapi-explorer"
  | "kulala-openapi-no-cache"
  | "kulala-jq"
  | "jq"
  | "kulala-keep-alive-stream"
  | KulalaCurlPassthroughOperatorName;

export const kulalaOperatorNames: Set<KulalaOperatorName> = new Set([
  "name",
  "accept",
  "no-redirect",
  "no-log",
  "no-cookie-jar",
  "no-auto-encoding",
  "timeout",
  "connection-timeout",
  "kulala-file-contents-to-variable",
  "kulala-expect-status-code",
  "kulala-prompt",
  "grpc-import-path",
  "grpc-proto",
  "grpc-protoset",
  "grpc-plaintext",
  "grpc-insecure",
  "grpc-authority",
  "grpc-v",
  "kulala-vscode-restclient-compat",
  "kulala-openapi-explorer",
  "kulala-openapi-no-cache",
  "kulala-jq",
  "jq",
  "kulala-keep-alive-stream",
]);

export type KulalaOperatorArgs = string | number | boolean;

export type KulalaOperatorString =
  `# @${KulalaOperatorName}${KulalaOperatorArgs extends string
    ? ` ${KulalaOperatorArgs}`
    : ""}`;

export type KulalaOperator = {
  name: KulalaOperatorName;
  args?: KulalaOperatorArgs;
  lineNumber: number;
  /** Comment marker used in the source file (`#` or `//`). */
  commentStyle?: "#" | "//";
};

import {
  substituteInObject,
  substituteInString,
} from "../variables/substitute";
import type { WebSocketConnectOptions } from "./websocket-session";

export type WebSocketConnectInput = WebSocketConnectOptions & {
  /** When url/body/headers still contain {{var}}, substitute with this map. */
  vars?: Record<string, string>;
};

function messagesHaveTemplates(
  messages: WebSocketConnectOptions["messages"],
): boolean {
  return messages?.some((message) => message.data.includes("{{")) ?? false;
}

/**
 * Apply variable substitution to a WebSocket connect payload before opening the session.
 * Callers should pass values already resolved by kulala-core run when possible; `vars`
 * is a fallback for direct `--websocket` invocations.
 */
export function prepareWebSocketConnect(
  input: WebSocketConnectInput,
): WebSocketConnectOptions {
  const vars = input.vars ?? {};
  const hasTemplates =
    input.url.includes("{{") ||
    (input.body?.includes("{{") ?? false) ||
    messagesHaveTemplates(input.messages) ||
    Object.values(input.headers ?? {}).some((v) => v.includes("{{"));

  if (!hasTemplates) {
    return {
      url: input.url,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.messages !== undefined ? { messages: input.messages } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };
  }

  if (Object.keys(vars).length === 0) {
    throw new Error(
      "WebSocket connect URL or payload contains unresolved {{variables}}; resolve the request in kulala-core first",
    );
  }

  const headers = input.headers
    ? (substituteInObject(input.headers, vars) as Record<string, string>)
    : undefined;
  const body =
    input.body != null
      ? (substituteInObject(input.body, vars) as string)
      : undefined;
  const messages = input.messages?.map((message) => ({
    waitForServer: message.waitForServer,
    data: substituteInString(message.data, vars),
  }));

  return {
    url: substituteInString(input.url, vars),
    ...(body !== undefined ? { body } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(messages !== undefined ? { messages } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
}

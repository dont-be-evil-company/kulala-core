/** One client frame in an IntelliJ-style WebSocket message script. */
export type KulalaWebSocketMessage = {
  /** Inbound server frames to consume before this payload is sent. */
  waitForServer: number;
  data: string;
};

/**
 * `===` or `=== wait-for-server`, optionally followed by a `//` or `#` comment.
 * Any other text after `===` stays part of the payload.
 */
const SEPARATOR_LINE = /^===\s*(wait-for-server\b)?\s*(?:\/\/.*|#.*)?$/;

export function matchWebSocketSeparator(
  line: string,
): { waitForServer: boolean } | null {
  const match = line.match(SEPARATOR_LINE);
  if (!match) return null;
  return { waitForServer: Boolean(match[1]) };
}

export function hasWebSocketMessageSeparator(body: string): boolean {
  return body
    .split(/\r?\n/)
    .some((line) => matchWebSocketSeparator(line) !== null);
}

function trimEdgeBlankLines(text: string): string {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

/**
 * Split a WEBSOCKET request body into client frames.
 * `===` sends the next payload immediately. Each `=== wait-for-server` line
 * adds one server frame to wait for before the next payload. Consecutive
 * wait lines accumulate. Empty regions between separators are not frames.
 */
export function splitWebSocketMessages(body: string): KulalaWebSocketMessage[] {
  if (!body.trim()) return [];

  const messages: KulalaWebSocketMessage[] = [];
  let buf: string[] = [];
  let pendingWait = 0;

  const takeBuffer = (): string => {
    const data = trimEdgeBlankLines(buf.join("\n"));
    buf = [];
    return data;
  };

  for (const line of body.split(/\r?\n/)) {
    const separator = matchWebSocketSeparator(line);
    if (!separator) {
      buf.push(line);
      continue;
    }

    const data = takeBuffer();
    if (separator.waitForServer) {
      if (data.length > 0) {
        messages.push({ waitForServer: pendingWait, data });
        pendingWait = 1;
      } else {
        pendingWait += 1;
      }
      continue;
    }

    if (data.length > 0) {
      messages.push({ waitForServer: pendingWait, data });
    }
    pendingWait = 0;
  }

  const tail = takeBuffer();
  if (tail.length > 0) {
    messages.push({ waitForServer: pendingWait, data: tail });
  }
  return messages;
}

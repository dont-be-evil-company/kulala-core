import { writeSync } from "node:fs";

/** Incremental HTTP body event written to stdout while `action: "run"` is still in progress. */
export type HttpStreamEvent = {
  type: "http-stream";
  event: "headers" | "chunk" | "error";
  status?: number;
  httpVersion?: string;
  headers?: Record<string, string>;
  url?: string;
  /** Raw text decoded from the response body as it arrives. */
  data?: string;
  error?: string;
  blockName?: string;
};

/** Optional sink for keep-alive streaming. Defaults to NDJSON on stdout. */
export type HttpStreamSink = {
  blockName?: string;
  /** Test hook. Production uses {@link writeHttpStreamEvent}. */
  emit?: (event: HttpStreamEvent) => void;
};

function isEagain(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EAGAIN"
  );
}

/**
 * Compact NDJSON to stdout. Uses writeSync so a slow reader cannot deadlock
 * the curl pipe the way async `process.stdout.write` can.
 */
export function writeHttpStreamEvent(event: HttpStreamEvent): void {
  const buffer = Buffer.from(`${JSON.stringify(event)}\n`);
  let offset = 0;
  while (offset < buffer.length) {
    try {
      const written = writeSync(1, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error("failed to write http-stream event");
      }
      offset += written;
    } catch (error) {
      if (isEagain(error)) continue;
      throw error;
    }
  }
}

export function emitHttpStreamEvent(
  sink: HttpStreamSink,
  event: Omit<HttpStreamEvent, "type" | "blockName"> & { blockName?: string },
): void {
  const blockName = event.blockName ?? sink.blockName;
  const full: HttpStreamEvent = {
    type: "http-stream",
    ...event,
    ...(blockName ? { blockName } : {}),
  };
  if (sink.emit) sink.emit(full);
  else writeHttpStreamEvent(full);
}

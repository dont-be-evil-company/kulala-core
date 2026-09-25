/**
 * HTTP client via embedded/system cURL with timing instrumentation
 * (dns, tcp, tls, request, firstByte, total).
 */

import type { FormDataLike } from "form-data-encoder";
import { curlHttpRequest } from "./curl-transport";
import type { HttpStreamSink } from "./http-stream";

export type HttpRequestTimings = {
  phases: {
    dns: number;
    tcp: number;
    tls: number;
    request: number;
    /** Time from request sent to first byte (server TTFB). */
    firstByte: number;
    /** Time from start (t0) to first byte; matches curl time_starttransfer. */
    startTransfer: number;
    /** Total time spent on redirect steps (curl time_redirect). 0 if no redirects. */
    redirect: number;
    total: number;
  };
};

export type HttpRequestResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Buffer;
  timings: HttpRequestTimings;
  /** Protocol version from the response status line (e.g. HTTP/2). */
  httpVersion?: string;
  /** Final resolved URL (after redirects). */
  url: string;
  /** performance.now() when first byte of this response was received (for startTransfer from wall start). */
  firstByteTime: number;
  /** Present only when at least one redirect occurred (ordered hops, including the final response). */
  redirectChain?: Array<{
    statusCode: number;
    headers: Record<string, string>;
    body: string | Buffer;
    timings: HttpRequestTimings;
    url: string;
    httpVersion?: string;
    /** curl `-v` stderr for this hop (connection, TLS, cert details). */
    verboseTrace?: string;
  }>;
  /** curl `-v` stderr for the final hop (when no redirect chain is exposed). */
  verboseTrace?: string;
};

export type HttpRequestOptions = {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Body: string, Buffer, or FormData (multipart). For FormData we encode with form-data-encoder. */
  body?: string | Buffer | FormData;
  /** When "HTTP/2", use http2 for https URLs. Otherwise use http/https. */
  httpVersion?: "HTTP/1.0" | "HTTP/1.1" | "HTTP/2";
  /** Request timeout in seconds (curl --max-time). JetBrains `# @timeout` only. */
  timeoutSec?: number;
  /** Connection timeout in seconds (curl --connect-timeout). */
  connectionTimeoutSec?: number;
  /** Whether to follow redirects (default true). */
  followRedirects?: boolean;
  /** Whether to propagate Set-Cookie -> Cookie across redirect hops (default true). */
  propagateCookiesOnRedirect?: boolean;
  /**
   * When true (default), each redirect hop may add cookies from the persistent jar for the
   * next URL (browser-like, with domain/path filtering via the jar).
   */
  cookieJarEnabled?: boolean;
  /** Extra curl argv from `# @kulala-curl-*` operators (merged file + block). */
  extraCurlArgv?: string[];
  /** Skip TLS certificate verification (curl --insecure / -k). */
  insecure?: boolean;
  /**
   * When set, curl runs with `--no-buffer` and body bytes are emitted as
   * `http-stream` NDJSON events while the response is still open.
   * Redirect hops are not streamed; only the final response is.
   */
  stream?: HttpStreamSink;
};

/** Encode FormData to buffer and content-type using form-data-encoder. */
async function encodeFormData(
  form: FormData,
): Promise<{ body: Buffer; contentType: string }> {
  const { FormDataEncoder } = await import("form-data-encoder");
  const encoder = new FormDataEncoder(form as unknown as FormDataLike);
  const chunks: Uint8Array[] = [];
  for await (const chunk of encoder) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const contentType = encoder.contentType;
  return { body, contentType };
}

/**
 * Perform an HTTP request via cURL (spawned), with timing instrumentation.
 */
export async function httpRequest(
  options: HttpRequestOptions,
): Promise<HttpRequestResponse> {
  const headers = { ...options.headers };
  let body: string | Buffer | undefined = undefined;

  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      const { body: encoded, contentType } = await encodeFormData(options.body);
      body = encoded;
      headers["Content-Type"] = contentType;
      headers["Content-Length"] = String(encoded.length);
    } else if (typeof options.body === "string") {
      body = options.body;
    } else {
      body = options.body;
    }
  }

  return await curlHttpRequest({
    ...options,
    headers,
    body,
  });
}

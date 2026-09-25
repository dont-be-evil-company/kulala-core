import type { KulalaDocument } from "./types/document";
import type { KulalaBlock } from "./types/block";
import type {
  KulalaHeaderSectionEntry,
  KulalaHttpVersion,
} from "./types/request";
import { getDocument } from "./parser";
import { serializeHttp } from "./serde";
import {
  formatWithBundledPrettier,
  type BundledPrettierOptions,
} from "./prettier-bundled";
import {
  hasWebSocketMessageSeparator,
  matchWebSocketSeparator,
} from "../websocket/messages";

export type KulalaHttpBodyFormatOptions = {
  indent?: number;
  line_width?: number;
  expand_tabs?: boolean;
};

export type KulalaHttpFormatDefaults = {
  http_method?: string;
  /** When `false`, always omit the HTTP version from request lines. */
  http_version?: string | false;
};

export type KulalaHttpFormatOptions = {
  formatBody?: boolean;
  bodyFormat?: KulalaHttpBodyFormatOptions;
  defaults?: KulalaHttpFormatDefaults;
};

export type KulalaHttpFormatResult =
  | { success: true; formatted: string; doc: KulalaDocument }
  | { success: false; error: string; doc?: KulalaDocument };

function headerToPascalCase(str: string): string {
  return str
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("-");
}

function getHeaderValue(
  headerSection: KulalaHeaderSectionEntry[],
  key: string,
): string | undefined {
  for (const entry of headerSection) {
    if (
      entry.type === "header" &&
      entry.name.toLowerCase() === key.toLowerCase()
    ) {
      return entry.value?.toLowerCase();
    }
  }
  return undefined;
}

function formatUrl(url: string): string {
  const parts = url.split("?");
  if (parts.length === 1) {
    return parts[0]!;
  }
  const [base, query] = parts;
  return `${base}?${query!.split("&").join("\n  &")}`.replace(/\n\s*\n/g, "\n");
}

function formatFormBody(body: string): string {
  const compact = body.replace(/\n/g, "").replace(/\s+/g, "");
  const parts = compact.split("&");
  if (parts.length === 1) {
    return parts[0]!;
  }
  return parts.join("&\n").replace(/\n\s*\n/g, "\n");
}

function splitGraphQLBody(body: string): {
  query: string;
  variables: string | null;
} {
  const parts = body.split(/\n\s*\n(\s*{)/);
  if (parts.length >= 2) {
    const variables = parts.slice(1).join("");
    return { query: parts[0]!.trim(), variables: variables.trim() };
  }
  return { query: body.trim(), variables: null };
}

function preservePlaceholders(body: string): {
  replacedBody: string;
  placeholders: Map<string, string>;
} {
  const placeholderRegex = /(?<!")({{\$?\w+}})(?!")/g;
  const placeholders = new Map<string, string>();
  let replacedBody = body.replace(placeholderRegex, (match) => {
    const key = `__KULALA_FMT_PLACEHOLDER_${placeholders.size}__`;
    placeholders.set(key, match);
    return `"${key}"`;
  });
  replacedBody = replacedBody.replace(
    /__""__KULALA_FMT_PLACEHOLDER_/g,
    "____KULALA_FMT_PLACEHOLDER_",
  );
  return { replacedBody, placeholders };
}

function restorePlaceholders(
  formattedBody: string,
  placeholders: Map<string, string>,
): string {
  let restoredBody = formattedBody;
  const placeholdersLength = placeholders.size;
  let idx = 0;
  placeholders.forEach((original, key) => {
    let firstQuote = "";
    let lastQuote = "";
    if (idx === 0) {
      firstQuote = '"';
    }
    if (idx === placeholdersLength - 1) {
      lastQuote = '"';
    }
    restoredBody = restoredBody.replace(
      `${firstQuote}${key}${lastQuote}`,
      original,
    );
    idx++;
  });
  return restoredBody;
}

function getFormatParser(block: KulalaBlock): null | "graphql" | "json" {
  const headers = block.request.headerSection ?? [];
  if (getHeaderValue(headers, "x-request-type") === "graphql") {
    return "graphql";
  }
  if (getHeaderValue(headers, "content-type") === "application/json") {
    return "json";
  }
  return null;
}

function prettierOptions(
  bodyFormat: KulalaHttpBodyFormatOptions,
): BundledPrettierOptions {
  const expandTabs = bodyFormat.expand_tabs ?? true;
  return {
    tabWidth: bodyFormat.indent ?? 2,
    printWidth: bodyFormat.line_width ?? 80,
    // expand_tabs: true  → indent with spaces (expand tabs to spaces)
    // expand_tabs: false → indent with tab characters
    useTabs: !expandTabs,
  };
}

function prepareBodyForFormatting(
  content: string,
  bodyFormat: KulalaHttpBodyFormatOptions,
): string {
  const expandTabs = bodyFormat.expand_tabs ?? true;
  if (!expandTabs) {
    return content;
  }
  const tabWidth = bodyFormat.indent ?? 2;
  return content.replace(/\t/g, " ".repeat(tabWidth));
}

async function formatWithPrettier(
  content: string,
  parser: "json" | "graphql",
  bodyFormat: KulalaHttpBodyFormatOptions,
): Promise<string> {
  try {
    return await formatWithBundledPrettier(
      prepareBodyForFormatting(content, bodyFormat),
      parser,
      prettierOptions(bodyFormat),
    );
  } catch {
    return content.trim();
  }
}

async function formatGraphQLBodyObject(
  body: { query: string; variables?: Record<string, unknown> },
  bodyFormat: KulalaHttpBodyFormatOptions,
): Promise<{ query: string; variables?: Record<string, unknown> }> {
  const trimmedQuery = body.query.trim();
  const looksLikeJson =
    trimmedQuery.startsWith("{") || trimmedQuery.startsWith("[");
  const formattedQuery = looksLikeJson
    ? await formatWithPrettier(trimmedQuery, "json", bodyFormat)
    : await formatWithPrettier(body.query, "graphql", bodyFormat);

  if (body.variables === undefined) {
    return { query: formattedQuery };
  }

  const formattedVariables = await formatWithPrettier(
    JSON.stringify(body.variables),
    "json",
    bodyFormat,
  );

  return {
    query: formattedQuery,
    variables: JSON.parse(formattedVariables) as Record<string, unknown>,
  };
}

function looksLikeJsonContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

async function tryFormatJsonString(
  content: string,
  bodyFormat: KulalaHttpBodyFormatOptions,
): Promise<string | null> {
  if (!looksLikeJsonContent(content)) {
    return null;
  }
  try {
    const jsonStr = content
      .replace(/\\\{/g, "{")
      .replace(/\\\}/g, "}")
      .replace(/,(\s*[}\]])/g, "$1");
    JSON.parse(jsonStr);
    const { replacedBody, placeholders } = preservePlaceholders(content);
    const pretty = await formatWithPrettier(replacedBody, "json", bodyFormat);
    return restorePlaceholders(pretty, placeholders);
  } catch {
    return null;
  }
}

/** Pretty-print each JSON frame and keep `===` / `=== wait-for-server` lines. */
async function formatWebSocketScriptBody(
  body: string,
  bodyFormat: KulalaHttpBodyFormatOptions,
): Promise<string> {
  const pieces: string[] = [];
  let buf: string[] = [];

  const flush = async () => {
    const raw = buf.join("\n");
    buf = [];
    const trimmed = raw.trim();
    if (!trimmed) return;
    const pretty = await tryFormatJsonString(trimmed, bodyFormat);
    pieces.push((pretty ?? trimmed).trimEnd());
  };

  for (const line of body.split(/\r?\n/)) {
    if (matchWebSocketSeparator(line)) {
      await flush();
      pieces.push(line.trimEnd());
      continue;
    }
    buf.push(line);
  }
  await flush();
  return pieces.join("\n");
}

async function formatJsonObjectBody(
  body: object,
  bodyFormat: KulalaHttpBodyFormatOptions,
): Promise<string> {
  // Seed with multiline JSON so prettier applies tabWidth instead of collapsing.
  return formatWithPrettier(JSON.stringify(body, null, 2), "json", bodyFormat);
}

function sortHeaderSection(
  section: KulalaHeaderSectionEntry[],
): KulalaHeaderSectionEntry[] {
  const headers = section.filter((e) => e.type === "header");
  const comments = section.filter((e) => e.type === "comment");
  headers.sort((a, b) => {
    if (a.type !== "header" || b.type !== "header") return 0;
    return a.name.localeCompare(b.name);
  });
  if (comments.length === 0) {
    return headers;
  }
  return [...comments, ...headers];
}

function applyHeaderCasing(
  section: KulalaHeaderSectionEntry[],
  httpVersion?: string,
): KulalaHeaderSectionEntry[] {
  return section.map((entry) => {
    if (entry.type !== "header") return entry;
    let name = entry.name;
    switch (httpVersion) {
      case "HTTP/1.0":
      case "HTTP/1.1":
        name = headerToPascalCase(entry.name);
        break;
      case "HTTP/2":
        name = entry.name.toLowerCase();
        break;
    }
    return { ...entry, name };
  });
}

function normalizeBlock(
  block: KulalaBlock,
  defaults: KulalaHttpFormatDefaults,
): void {
  if (block.hasRequest === false) return;

  const method =
    block.request.method.toUpperCase() as typeof block.request.method;
  block.request.method = method;

  if (defaults.http_version === false) {
    block.request.httpVersion = undefined;
  } else if (
    !block.request.httpVersion &&
    !["WEBSOCKET", "GRPC"].includes(method)
  ) {
    block.request.httpVersion = (defaults.http_version ??
      "HTTP/1.1") as KulalaHttpVersion;
  }

  if (["WEBSOCKET", "GRPC"].includes(method)) {
    block.request.httpVersion = undefined;
  }

  if (block.request.url) {
    block.request.url = formatUrl(block.request.url);
  }

  if (block.request.requestLineParts?.length) {
    for (const part of block.request.requestLineParts) {
      if (part.type === "url") {
        part.line = formatUrl(part.line);
      }
    }
    collapseSimpleRequestLine(block);
  }

  if (block.request.headerSection?.length) {
    block.request.headerSection = applyHeaderCasing(
      sortHeaderSection(block.request.headerSection),
      block.request.httpVersion,
    );
  }
}

/** Use compact `METHOD url HTTP/x.x` when the request is a single URL line. */
function collapseSimpleRequestLine(block: KulalaBlock): void {
  const parts = block.request.requestLineParts;
  if (!parts?.length) {
    return;
  }
  const hasOnlySingleUrl =
    parts.length === 1 &&
    parts[0]?.type === "url" &&
    !parts[0].line.includes("\n");
  if (hasOnlySingleUrl) {
    block.request.requestLineParts = undefined;
  }
}

function normalizeDocument(
  doc: KulalaDocument,
  options: KulalaHttpFormatOptions,
): void {
  const defaults = options.defaults ?? {};
  const blocks = doc.blocks.slice(0, doc.nativeBlockCount ?? doc.blocks.length);
  for (const block of blocks) {
    normalizeBlock(block, defaults);
  }
}

async function formatBodyContent(
  block: KulalaBlock,
  formatBody: boolean,
  bodyFormat: KulalaHttpBodyFormatOptions,
): Promise<void> {
  if (block.hasRequest === false) return;
  const body = block.request.body;
  if (body === undefined || body === null) return;
  if (!formatBody) return;

  const headers = block.request.headerSection ?? [];
  const formatParser = getFormatParser(block);

  if (typeof body === "string") {
    const formatted = body.trim();
    if (
      block.request.method === "WEBSOCKET" &&
      hasWebSocketMessageSeparator(formatted)
    ) {
      block.request.body = await formatWebSocketScriptBody(
        formatted,
        bodyFormat,
      );
      return;
    }
    if (formatParser === "graphql") {
      const { replacedBody, placeholders } = preservePlaceholders(formatted);
      const { query, variables } = splitGraphQLBody(replacedBody);
      let result = await formatWithPrettier(query, "graphql", bodyFormat);
      if (variables) {
        const formattedVariables = await formatWithPrettier(
          variables,
          "json",
          bodyFormat,
        );
        result += `\n\n${formattedVariables}`;
      }
      block.request.body = restorePlaceholders(result, placeholders);
    } else if (formatParser === "json") {
      const { replacedBody, placeholders } = preservePlaceholders(formatted);
      const pretty = await formatWithPrettier(replacedBody, "json", bodyFormat);
      block.request.body = restorePlaceholders(pretty, placeholders);
    } else if (
      getHeaderValue(headers, "content-type") ===
      "application/x-www-form-urlencoded"
    ) {
      block.request.body = formatFormBody(formatted);
    } else {
      const jsonFormatted = await tryFormatJsonString(formatted, bodyFormat);
      if (jsonFormatted !== null) {
        block.request.body = jsonFormatted;
      }
    }
    return;
  }

  if (typeof body === "object" && !("__bodyFromFile" in body)) {
    if (block.request.method === "GRAPHQL" && "query" in body) {
      const gqlBody = body as {
        query: string;
        variables?: Record<string, unknown>;
        variablesSourceText?: string;
      };
      if (gqlBody.variablesSourceText !== undefined) {
        const formattedQuery = await formatWithPrettier(
          gqlBody.query,
          "graphql",
          bodyFormat,
        );
        block.request.body = `${formattedQuery}\n\n${gqlBody.variablesSourceText}`;
        return;
      }
      const formatted = await formatGraphQLBodyObject(gqlBody, bodyFormat);
      let result = formatted.query;
      if (formatted.variables !== undefined) {
        result += `\n\n${await formatWithPrettier(
          JSON.stringify(formatted.variables),
          "json",
          bodyFormat,
        )}`;
      }
      block.request.body = result;
    } else {
      block.request.body = await formatJsonObjectBody(body, bodyFormat);
    }
  }
}

async function formatDocumentBodies(
  doc: KulalaDocument,
  options: KulalaHttpFormatOptions,
): Promise<void> {
  const formatBody = options.formatBody !== false;
  const bodyFormat = options.bodyFormat ?? {};
  const blocks = doc.blocks.slice(0, doc.nativeBlockCount ?? doc.blocks.length);
  for (const block of blocks) {
    await formatBodyContent(block, formatBody, bodyFormat);
  }
}

export async function formatHttp(
  content: string,
  filepath?: string,
  options: KulalaHttpFormatOptions = {},
): Promise<KulalaHttpFormatResult> {
  const doc = await getDocument(content, filepath);

  if (doc.hasErrors) {
    const message =
      doc.errors?.map((e) => e.errorMessage).join("; ") ?? "Parse error";
    return { success: false, error: message, doc };
  }

  normalizeDocument(doc, options);
  await formatDocumentBodies(doc, options);

  const formatted = serializeHttp(doc, {
    preserveBodyText: options.formatBody === false,
  });
  return { success: true, formatted, doc };
}

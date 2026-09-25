import { encodeRequestUrl } from "./encode-url";
import { httpRequest } from "./http-client";
import { grpcNativeRequest } from "../grpc";
import { formatGrpcurlCommand } from "../grpc/format";
import { grpcFlagsFromOperators } from "../grpc/collect-flags";
import { mergeGrpcFlags, parseGrpcTarget } from "../grpc/parse-target";
import type { KulalaWebSocketPlanResponse } from "./types";
import type { KulalaDocument } from "../parser/types";
import type { KulalaBlock } from "../parser/types/block";
import { curlArgvHasFlag } from "../curl/passthrough";
import { enrichResponseWithJq } from "../jq";
import {
  getEffectiveCurlArgv,
  getEffectiveJqFilter,
  getEffectiveOperators,
  stripInheritedMaxTime,
} from "./effective-operators";
import {
  applyDefaultHeaders,
  loadDefaultHeaders,
  resolveUrlFromHostHeader,
  substituteInObject,
  substituteInObjectAsync,
  substituteInString,
  substituteInStringAsync,
} from "../variables";
import { OAuth2Manager } from "../auth/oauth2/manager";
import { OAuth2PromptError } from "../auth/oauth2/prompt-error";
import {
  getCookieHeaderForRequest,
  mergeCookieHeaderValues,
  incrementReplayCount,
  saveHistoryEntry,
  setVariable,
  storeCookiesFromResponse,
  getVariable,
} from "../persistence";
import {
  buildCustomPromptResponse,
  consumeRequestPromptVariable,
  parseKulalaPromptOperatorArgs,
} from "./custom-prompt";
import { ScriptPromptError } from "./script-prompt-error";
import {
  MAX_SCRIPT_REPLAYS,
  ScriptAbortError,
  ScriptReplayError,
  ScriptSkipError,
} from "./script-control-error";
import {
  buildRunnerResponseBody,
  buildRunnerResponseBodyFromRaw,
  responseBodyDisplayText,
  type KulalaResponseFormatOptions,
} from "./http-response-body";
import {
  runScripts,
  type ScriptFlowContext,
  type ScriptRunScope,
} from "./scripts";
import {
  isSharedBlockName,
  isSharedEachBlockName,
  sharedBlockHasHttpRequest,
} from "../shared-blocks";
import { recordRequestVarResult } from "./request-var-context";
import type { KulalaScriptType } from "../parser/types/script";
import {
  bodyPayloadToScriptString,
  buildScriptRequestContextFromBlock,
} from "./script-request-context";
import {
  detectCollectionIterationPlan,
  varsForCollectionIndex,
} from "./collection-iteration";
import type { CollectionIterationPlan } from "./collection-iteration";
import {
  buildHeadersFromSection,
  normalizeAuthorizationHeader,
  setUserAgentHeaderIfNotPresent,
} from "./headers";
import {
  applyRawBodyWithoutContentType,
  buildMultipartBody,
  ensureMultipartContentTypeHeader,
  getFormRequestBody,
  getGraphQLRequestBody,
  getJSONRequestBody,
  getRequestHeaderType,
  graphQLRawSubstitutionText,
  isBodyFromFileRef,
  isRawMultipartTemplateBody,
  resolveEffectiveBodyFromFileRef,
  resolveInlineBodyFileRefs,
  stripHttpClientDoubleSlashLineComments,
  substituteGraphQLRequestBody,
} from "./body";
import type {
  KulalaPromptResponse,
  KulalaRequestErrorResponse,
  KulalaRequestSent,
  KulalaRequestSuccessResponse,
  KulalaScriptConsoleLine,
  KulalaSkippedResponse,
  RunnerResponseLike,
  VariableResolver,
} from "./types";
import { runOpenAPIFromBlock } from "../openapi/run-block";

export type { RunnerResponseLike } from "./types";

export type DoRequestFromBlockResult =
  | KulalaRequestSuccessResponse
  | KulalaRequestErrorResponse
  | KulalaPromptResponse
  | KulalaSkippedResponse
  | KulalaWebSocketPlanResponse;

const CLIENT_GLOBAL_HEADERS_VAR = "__kulala_client_global_headers__";

function scriptConsolePlainText(lines: KulalaScriptConsoleLine[]): string {
  return lines
    .map((l) => (typeof l.message === "string" ? l.message : String(l.message)))
    .filter((m) => m.trim().length > 0)
    .join("\n");
}

/** Visible body for skip/abort so clients with a body-first UI show pre-exit logs. */
function controlFlowBody(
  scriptConsole: KulalaScriptConsoleLine[],
  footer: string,
): KulalaRequestSuccessResponse["body"] {
  const logs = scriptConsolePlainText(scriptConsole);
  const footerTrim = footer.trim();
  const omitFooter =
    footerTrim.length > 0 &&
    (logs === footerTrim ||
      logs.endsWith(`\n${footerTrim}`) ||
      logs.includes(footerTrim));
  const content =
    logs.length > 0 ? (omitFooter ? logs : `${logs}\n\n${footer}`) : footer;
  return { type: "text", content, mediaType: "text/plain" };
}

function readClientGlobalHeaders(): Record<string, string> {
  const v = getVariable("global", CLIENT_GLOBAL_HEADERS_VAR);
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw === "string") out[k] = raw;
  }
  return out;
}

export type DoRequestFromBlockOptions = {
  /** 0-based collection loop index (JetBrains request.iteration()). */
  collectionIndex?: number;
  collectionPlan?: CollectionIterationPlan;
  /** Internal: child call when expanding a collection variable. */
  skipPreScripts?: boolean;
  /** Internal: prevent recursive collection expansion in child runs. */
  skipCollectionExpansion?: boolean;
  /** Internal: `$kulala.request.replay()` counter for this block run. */
  scriptReplayIndex?: number;
  /** Parsed document (file-header operators merged into each request). */
  doc?: KulalaDocument;
  /** Internal: skip shared pre/post hooks and nested shared HTTP (shared block HTTP hook). */
  skipSharedHooks?: boolean;
  /** Pretty-print response bodies for this run. */
  responseFormat?: KulalaResponseFormatOptions;
  /** Optional jq filter override (block `# @kulala-jq` still wins). */
  jqFilter?: string;
  /** Nested `$kulala.runRequest()` call stack for recursion detection. */
  runRequestStack?: string[];
};

/** `### KULALA_SHARED` pre/post scripts wrap each request in the file. */
async function runSharedScriptsForPhase(
  phase: KulalaScriptType,
  opts: {
    flow?: ScriptFlowContext;
    requestBlock: KulalaBlock;
    filePath: string | undefined;
    effectiveBody: KulalaBlock["request"]["body"];
    env: string;
    startDir: string;
    mutableVars: Record<string, string>;
    resolver: VariableResolver | undefined;
    iteration: number;
    collectionPlan?: CollectionIterationPlan;
    scriptConsole: KulalaScriptConsoleLine[];
    response?: RunnerResponseLike;
    urlSent?: string;
    headersSent?: Record<string, string>;
    bodySent?: string;
    responseUrl?: string;
    responseHeaders?: Record<string, string>;
    stableDocId: string;
    doc?: KulalaDocument;
    runRequestStack?: string[];
  },
): Promise<void> {
  for (const shared of opts.flow?.sharedBlocks ?? []) {
    const scripts =
      phase === "preRequest"
        ? shared.scripts.preRequest
        : shared.scripts.postRequest;
    if (scripts.length === 0) continue;
    const ctx = buildScriptRequestContextFromBlock({
      block: opts.requestBlock,
      phase,
      effectiveBody: opts.effectiveBody,
      env: opts.env,
      startDir: opts.startDir,
      mutableVars: opts.mutableVars,
      resolver: opts.resolver,
      iteration: opts.iteration,
      collectionPlan: opts.collectionPlan,
      urlSent: opts.urlSent,
      headersSent: opts.headersSent,
      bodySent: opts.bodySent,
      responseUrl: opts.responseUrl,
      responseHeaders: opts.responseHeaders,
    });
    await runScripts(
      scripts,
      phase,
      shared,
      opts.filePath,
      opts.response,
      opts.mutableVars,
      opts.flow,
      opts.scriptConsole,
      ctx,
      {
        stableDocId: opts.stableDocId,
        doc: opts.doc,
        env: opts.env,
        resolver: opts.resolver,
        runRequestStack: opts.runRequestStack,
      },
    );
  }
}

/** Run HTTP request(s) embedded in KULALA_SHARED* blocks before the target request. */
async function runSharedBlockHttpRequests(opts: {
  flow?: ScriptFlowContext;
  requestBlock: KulalaBlock;
  filePath: string | undefined;
  env: string;
  stableDocId: string;
  doc?: KulalaDocument;
  mutableVars: Record<string, string>;
  resolver: VariableResolver | undefined;
  responseFormat?: KulalaResponseFormatOptions;
}): Promise<Exclude<RunPreRequestScriptsResult, { ok: true }> | undefined> {
  const flow = opts.flow;
  if (!flow) return undefined;
  const sharedBlocks = flow.sharedBlocks;
  if (!sharedBlocks?.length) return undefined;
  if (isSharedBlockName(opts.requestBlock.name)) return undefined;

  if (!flow.sharedHttpExecuted) {
    flow.sharedHttpExecuted = new Set();
  }
  if (!flow.collectedSharedHttpResults) {
    flow.collectedSharedHttpResults = [];
  }

  for (const shared of sharedBlocks) {
    if (!sharedBlockHasHttpRequest(shared)) continue;

    const each = isSharedEachBlockName(shared.name);
    const key = shared.name;
    if (!each && flow.sharedHttpExecuted.has(key)) continue;

    const result = await doRequestFromBlock(
      shared,
      opts.filePath,
      opts.mutableVars,
      opts.stableDocId,
      opts.resolver,
      opts.env,
      flow,
      {
        doc: opts.doc,
        skipSharedHooks: true,
        responseFormat: opts.responseFormat,
      },
    );

    flow.sharedHttpExecuted.add(key);

    const items = Array.isArray(result) ? result : [result];
    for (const item of items) {
      const control = doRequestResultToPreRequestControlFlow(item);
      if (control) return control;
      flow.collectedSharedHttpResults.push({ ...item, blockName: key });
      if (
        opts.doc &&
        item.success &&
        "status" in item &&
        "body" in item &&
        flow.requestVarResults
      ) {
        const nameOp = shared.operators.find((o) => o.name === "name");
        const alias = nameOp?.args != null ? String(nameOp.args).trim() : "";
        const resultKey = alias !== "" ? alias : shared.name;
        recordRequestVarResult(
          opts.doc,
          shared,
          opts.stableDocId,
          resultKey,
          {
            body:
              item.body.type === "binary"
                ? {
                    type: "text",
                    content: "",
                    ...(item.body.mediaType
                      ? { mediaType: item.body.mediaType }
                      : {}),
                  }
                : item.body,
            headers: item.headers,
          },
          flow.requestVarResults,
        );
      }
    }
  }
  return undefined;
}

export type RunPreRequestScriptsResult =
  | { ok: true; effectiveBody: KulalaBlock["request"]["body"] }
  | KulalaPromptResponse
  | KulalaSkippedResponse
  | KulalaRequestErrorResponse;

export function isPreRequestScriptsOk(
  result: RunPreRequestScriptsResult,
): result is { ok: true; effectiveBody: KulalaBlock["request"]["body"] } {
  return "ok" in result && result.ok === true;
}

function doRequestResultToPreRequestControlFlow(
  item: DoRequestFromBlockResult,
): Exclude<RunPreRequestScriptsResult, { ok: true }> | undefined {
  if (Array.isArray(item)) {
    for (const one of item) {
      const control = doRequestResultToPreRequestControlFlow(one);
      if (control) return control;
    }
    return undefined;
  }
  if ("prompt" in item && item.prompt) return item;
  if ("skipped" in item && item.skipped) return item;
  if (item.success === false && "aborted" in item && item.aborted === true) {
    return item;
  }
  return undefined;
}

/** Shared + block pre-request scripts (and `@prompt` / file-to-var operators). */
export async function runPreRequestScriptsForBlock(
  block: KulalaBlock,
  filePath: string | undefined,
  mutableVars: Record<string, string>,
  stableDocId: string,
  resolver: VariableResolver | undefined,
  env: string,
  flow: ScriptFlowContext | undefined,
  scriptConsole: KulalaScriptConsoleLine[],
  iterationOptions?: DoRequestFromBlockOptions,
): Promise<RunPreRequestScriptsResult> {
  const startDir = filePath
    ? (await import("path")).dirname(filePath)
    : process.cwd();
  const scriptRunScope: ScriptRunScope = {
    stableDocId,
    doc: iterationOptions?.doc,
    env,
    resolver,
    runRequestStack: iterationOptions?.runRequestStack ?? [],
  };
  const effectiveOperators = getEffectiveOperators(
    iterationOptions?.doc,
    block,
  );
  const getOps = (names: string[]) =>
    effectiveOperators.filter((o) => names.includes(o.name));
  const getOpArgs = (names: string[]): string | undefined =>
    getOps(names)
      .map((o) => String(o.args ?? ""))
      .find((s) => s.trim() !== "");
  const parsePromptArgs = parseKulalaPromptOperatorArgs;

  const scriptReplayIndex = iterationOptions?.scriptReplayIndex ?? 0;

  if (scriptReplayIndex === 0) {
    const promptVar = getOpArgs(["prompt", "kulala-prompt"]);
    if (promptVar) {
      const parsed = parsePromptArgs(promptVar);
      const varName = parsed?.varName?.trim() ?? "";
      const label = parsed?.label?.trim();

      consumeRequestPromptVariable({
        stableDocId,
        blockName: block.name,
        varName,
        mutableVars,
      });

      if (varName && mutableVars[varName] === undefined) {
        return buildCustomPromptResponse({
          stableDocId,
          blockName: block.name,
          varName,
          label,
          inputType: parsed?.inputType,
        });
      }
    }

    const fileToVarArgs = getOpArgs(["kulala-file-contents-to-variable"]);
    if (fileToVarArgs) {
      const parts = fileToVarArgs.trim().split(/\s+/);
      const varName = parts.shift();
      const relPath = parts.join(" ").trim();
      if (varName && relPath) {
        const pathMod = await import("path");
        const fs = await import("fs/promises");
        const resolved = pathMod.resolve(startDir, relPath);
        const content = await fs.readFile(resolved, "utf-8");
        mutableVars[varName] = content;
        if (stableDocId) {
          setVariable("document", varName, content, { document: stableDocId });
        }
      }
    }
  }

  let effectiveBody: typeof block.request.body = block.request.body;
  if (isBodyFromFileRef(effectiveBody)) {
    effectiveBody = await resolveEffectiveBodyFromFileRef(
      effectiveBody,
      startDir,
      block.request.method,
    );
  }

  while (true) {
    if (scriptReplayIndex > MAX_SCRIPT_REPLAYS) {
      return {
        success: false,
        error: `Too many $kulala.request.replay() calls (max ${MAX_SCRIPT_REPLAYS})`,
        ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
      } as KulalaRequestErrorResponse;
    }

    try {
      if (!iterationOptions?.skipSharedHooks) {
        const iter = iterationOptions?.collectionIndex ?? 0;
        await runSharedScriptsForPhase("preRequest", {
          flow,
          requestBlock: block,
          filePath,
          effectiveBody,
          env,
          startDir,
          mutableVars,
          resolver,
          iteration: iter,
          collectionPlan: iterationOptions?.collectionPlan,
          scriptConsole,
          stableDocId,
          doc: iterationOptions?.doc,
          runRequestStack: scriptRunScope.runRequestStack,
        });

        const sharedHttpControl = await runSharedBlockHttpRequests({
          flow,
          requestBlock: block,
          filePath,
          env,
          stableDocId,
          doc: iterationOptions?.doc,
          mutableVars,
          resolver,
          responseFormat: iterationOptions?.responseFormat,
        });
        if (sharedHttpControl) return sharedHttpControl;
      }

      const preScriptRequestCtx = buildScriptRequestContextFromBlock({
        block,
        phase: "preRequest",
        effectiveBody,
        env,
        startDir,
        mutableVars,
        resolver,
        iteration: iterationOptions?.collectionIndex ?? 0,
        collectionPlan: iterationOptions?.collectionPlan,
      });

      await runScripts(
        block.scripts.preRequest,
        "preRequest",
        block,
        filePath,
        undefined,
        mutableVars,
        flow,
        scriptConsole,
        preScriptRequestCtx,
        scriptRunScope,
      );

      if (
        iterationOptions?.skipCollectionExpansion &&
        iterationOptions.collectionPlan &&
        typeof iterationOptions.collectionIndex === "number"
      ) {
        Object.assign(
          mutableVars,
          varsForCollectionIndex(
            mutableVars,
            iterationOptions.collectionPlan.collections,
            iterationOptions.collectionIndex,
          ),
        );
      }
    } catch (error) {
      if (error instanceof ScriptPromptError) {
        return error.promptResponse;
      }
      if (error instanceof ScriptSkipError) {
        return {
          success: true,
          skipped: true,
          message: error.message,
          body: controlFlowBody(scriptConsole, error.message),
          ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
        } as KulalaSkippedResponse;
      }
      if (error instanceof ScriptAbortError) {
        return {
          success: false,
          aborted: true,
          error: error.message,
          body: controlFlowBody(scriptConsole, error.message),
          ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
        } as KulalaRequestErrorResponse;
      }
      if (error instanceof ScriptReplayError) {
        return runPreRequestScriptsForBlock(
          block,
          filePath,
          mutableVars,
          stableDocId,
          resolver,
          env,
          flow,
          scriptConsole,
          {
            ...iterationOptions,
            scriptReplayIndex: scriptReplayIndex + 1,
          },
        );
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
      } as KulalaRequestErrorResponse;
    }

    return { ok: true, effectiveBody };
  }
}

function buildSentRequestSnapshot(
  method: string,
  url: string,
  headers: Record<string, string>,
  bodyPayload: string | Buffer | FormData | undefined,
): KulalaRequestSent {
  let body: string | undefined;
  if (typeof bodyPayload === "string") body = bodyPayload;
  else if (Buffer.isBuffer(bodyPayload)) body = bodyPayload.toString("utf-8");
  return {
    method,
    url,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

export async function doRequestFromBlock(
  block: KulalaBlock,
  filePath: string | undefined,
  vars: Record<string, string> | undefined,
  stableDocIdForReplay: string | undefined,
  resolver: VariableResolver | undefined,
  env: string = "default",
  flow?: import("./scripts").ScriptFlowContext,
  iterationOptions?: DoRequestFromBlockOptions,
): Promise<DoRequestFromBlockResult | DoRequestFromBlockResult[]> {
  const scriptConsole: KulalaScriptConsoleLine[] = [];

  // Pre-request scripts may set variables that affect substitution.
  // Keep `vars` mutable within this block.
  const mutableVars = vars ?? {};

  // Initialize OAuth2 manager if needed
  const startDir = filePath
    ? (await import("path")).dirname(filePath)
    : process.cwd();
  const oauth2Manager = new OAuth2Manager(env, startDir, mutableVars);
  const authResolver = async (
    func: "token" | "idToken",
    authId: string,
  ): Promise<string | undefined> => {
    if (func === "token") {
      return await oauth2Manager.getAccessToken(authId);
    } else {
      return await oauth2Manager.getIdToken(authId);
    }
  };

  const stableDocId = stableDocIdForReplay ?? filePath ?? "";
  const scriptRunScope: ScriptRunScope = {
    stableDocId,
    doc: iterationOptions?.doc,
    env,
    resolver,
    runRequestStack: iterationOptions?.runRequestStack ?? [],
  };
  const effectiveOperators = getEffectiveOperators(
    iterationOptions?.doc,
    block,
  );
  const extraCurlArgv = getEffectiveCurlArgv(
    iterationOptions?.doc,
    block,
    env,
    startDir,
  );
  const jqFilter = getEffectiveJqFilter(
    iterationOptions?.doc,
    block,
    iterationOptions?.jqFilter,
  );
  const getOps = (names: string[]) =>
    effectiveOperators.filter((o) => names.includes(o.name));
  const getOpArgs = (names: string[]): string | undefined =>
    getOps(names)
      .map((o) => String(o.args ?? ""))
      .find((s) => s.trim() !== "");
  const hasOp = (names: string[]): boolean => getOps(names).length > 0;
  const cookieJarEnabled = !hasOp(["no-cookie-jar"]);
  const logEnabled = !hasOp(["no-log"]);

  let scriptReplayIndex = iterationOptions?.scriptReplayIndex ?? 0;
  let effectiveBody: typeof block.request.body = block.request.body;
  if (iterationOptions?.skipPreScripts && isBodyFromFileRef(effectiveBody)) {
    effectiveBody = await resolveEffectiveBodyFromFileRef(
      effectiveBody,
      startDir,
      block.request.method,
    );
  }

  scriptReplay: while (true) {
    if (scriptReplayIndex > MAX_SCRIPT_REPLAYS) {
      return {
        success: false,
        error: `Too many $kulala.request.replay() calls (max ${MAX_SCRIPT_REPLAYS})`,
        ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
      } as KulalaRequestErrorResponse;
    }

    if (!iterationOptions?.skipPreScripts || scriptReplayIndex > 0) {
      const preResult = await runPreRequestScriptsForBlock(
        block,
        filePath,
        mutableVars,
        stableDocId,
        resolver,
        env,
        flow,
        scriptConsole,
        { ...iterationOptions, scriptReplayIndex },
      );
      if (!isPreRequestScriptsOk(preResult)) {
        return preResult as DoRequestFromBlockResult;
      }
      effectiveBody = preResult.effectiveBody;

      if (!iterationOptions?.skipPreScripts && scriptReplayIndex === 0) {
        const collectionPlan = detectCollectionIterationPlan(
          block,
          effectiveBody,
          mutableVars,
        );
        if (
          collectionPlan.count > 1 &&
          !iterationOptions?.skipCollectionExpansion
        ) {
          const batch: DoRequestFromBlockResult[] = [];
          for (let i = 0; i < collectionPlan.count; i++) {
            const iterVars = varsForCollectionIndex(
              mutableVars,
              collectionPlan.collections,
              i,
            );
            const child = await doRequestFromBlock(
              block,
              filePath,
              iterVars,
              stableDocIdForReplay,
              resolver,
              env,
              flow,
              {
                collectionIndex: i,
                collectionPlan,
                // Pre-request scripts should run per expanded request.
                skipCollectionExpansion: true,
                doc: iterationOptions?.doc,
                responseFormat: iterationOptions?.responseFormat,
                jqFilter: iterationOptions?.jqFilter,
              },
            );
            const one = Array.isArray(child) ? child[0]! : child;
            batch.push(one);
            if (
              !one.success ||
              ("prompt" in one && one.prompt) ||
              ("skipped" in one && one.skipped)
            ) {
              return batch;
            }
          }
          incrementReplayCount(
            stableDocIdForReplay ?? filePath ?? "",
            block.name,
          );
          return batch;
        }
      }
    }

    const collectionIndex = iterationOptions?.collectionIndex ?? 0;
    const collectionPlan =
      iterationOptions?.collectionPlan ??
      detectCollectionIterationPlan(block, effectiveBody, mutableVars);
    const scriptCollectionPlan =
      collectionPlan.count > 1 ? collectionPlan : undefined;

    // Check if we need async substitution (for $auth.token() calls)
    // Unescape braces in header values before checking (similar to header parser)
    const unescapeBraces = (str: string): string => {
      return str.replace(/\\+{/g, "{").replace(/\\+}/g, "}");
    };
    const urlStr =
      typeof block.request.url === "string" ? block.request.url : "";
    // Unescape braces in header values before stringifying to detect $auth. correctly
    const headerSectionWithUnescapedBraces = block.request.headerSection.map(
      (entry) =>
        entry.type === "header" && entry.value
          ? { ...entry, value: unescapeBraces(entry.value) }
          : entry,
    );
    const headerStr = JSON.stringify(headerSectionWithUnescapedBraces);
    const bodyStr = JSON.stringify(effectiveBody ?? {});
    const graphqlRawText = graphQLRawSubstitutionText(
      block.request.body,
      block.request.sourceBodyText,
    );
    const needsAsyncSubstitution =
      urlStr.includes("$auth.") ||
      headerStr.includes("$auth.") ||
      bodyStr.includes("$auth.") ||
      (graphqlRawText?.includes("$auth.") ?? false);
    const shouldSubstituteRequestFields =
      needsAsyncSubstitution ||
      Object.keys(mutableVars).length > 0 ||
      resolver !== undefined;

    let url: string;
    try {
      url = needsAsyncSubstitution
        ? await substituteInStringAsync(
            block.request.url,
            mutableVars,
            resolver,
            authResolver,
          )
        : substituteInString(block.request.url, mutableVars, resolver);
    } catch (error) {
      if (error instanceof OAuth2PromptError) {
        return error.promptResponse;
      }
      throw error;
    }

    let headers = setUserAgentHeaderIfNotPresent(
      buildHeadersFromSection(block.request.headerSection),
    );
    const envDefaultHeaders = loadDefaultHeaders(env, startDir);
    if (Object.keys(envDefaultHeaders).length > 0) {
      const withDefaults = applyDefaultHeaders({
        headers,
        url,
        defaultHeaders: envDefaultHeaders,
      });
      headers = withDefaults.headers;
      url = withDefaults.url;
    }
    const accept = getOpArgs(["accept"]);
    if (
      accept &&
      !Object.keys(headers).some((k) => k.toLowerCase() === "accept")
    ) {
      headers.Accept = accept;
    }
    // Persisted client global headers are applied to all outgoing requests,
    // but must not override explicit request headers.
    {
      const explicitLc = new Set(
        Object.keys(headers).map((k) => k.toLowerCase()),
      );
      const clientHeaders = readClientGlobalHeaders();
      for (const [k, v] of Object.entries(clientHeaders)) {
        if (!explicitLc.has(k.toLowerCase())) headers[k] = v;
      }
    }
    // JetBrains parity: global headers are applied implicitly to outgoing requests
    // within the same execution flow, but should not override explicit request headers.
    if (flow?.globalHeaders) {
      const explicitLc = new Set(
        Object.keys(headers).map((k) => k.toLowerCase()),
      );
      // Allow flow-local headers to override persisted client headers (but not explicit request headers).
      for (const [k, v] of Object.entries(flow.globalHeaders)) {
        if (!explicitLc.has(k.toLowerCase())) headers[k] = v;
      }
    }
    if (shouldSubstituteRequestFields) {
      try {
        const substitutedHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          substitutedHeaders[k] = needsAsyncSubstitution
            ? await substituteInStringAsync(
                v,
                mutableVars,
                resolver,
                authResolver,
              )
            : substituteInString(v, mutableVars, resolver);
        }
        headers = substitutedHeaders;
      } catch (error) {
        if (error instanceof OAuth2PromptError) {
          return error.promptResponse;
        }
        throw error;
      }
    }
    headers = normalizeAuthorizationHeader(headers);
    ({ headers, url } = resolveUrlFromHostHeader({ headers, url }));
    if (!hasOp(["no-auto-encoding"])) {
      url = encodeRequestUrl(url, block.request.method);
    }

    let body: typeof block.request.body;
    try {
      if (block.request.method === "GRAPHQL") {
        body = (await substituteGraphQLRequestBody({
          method: block.request.method,
          originalBody: block.request.body,
          effectiveBody,
          sourceBodyText: block.request.sourceBodyText,
          vars: mutableVars,
          resolver,
          authResolver,
          needsAsyncSubstitution,
        })) as typeof block.request.body;
      } else {
        body = needsAsyncSubstitution
          ? ((await substituteInObjectAsync(
              effectiveBody,
              mutableVars,
              resolver,
              authResolver,
            )) as typeof block.request.body)
          : (substituteInObject(
              effectiveBody,
              mutableVars,
              resolver,
            ) as typeof block.request.body);
      }
    } catch (error) {
      if (error instanceof OAuth2PromptError) {
        return error.promptResponse;
      }
      throw error;
    }

    const requestHeaderType = getRequestHeaderType(headers);
    const isGraphQL = block.request.method === "GRAPHQL";
    const noAutoEncoding = hasOp(["no-auto-encoding"]);
    const graphqlBody = isGraphQL ? getGraphQLRequestBody(body) : undefined;
    let json =
      !isGraphQL && requestHeaderType === "json"
        ? getJSONRequestBody(body)
        : undefined;
    // Body-from-file yields bytes; parse as JSON when Content-Type is json
    if (
      json === undefined &&
      requestHeaderType === "json" &&
      (typeof body === "string" || Buffer.isBuffer(body))
    ) {
      try {
        const text = typeof body === "string" ? body : body.toString("utf-8");
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // leave json undefined, may fall through to raw body
      }
    }
    const form =
      requestHeaderType === "form-urlencoded"
        ? getFormRequestBody(body, "form-urlencoded")
        : undefined;
    const rawMultipartTemplate =
      requestHeaderType === "form-data" &&
      typeof body === "string" &&
      isRawMultipartTemplateBody(body);
    const formDataBody =
      requestHeaderType === "form-data" && !rawMultipartTemplate
        ? getFormRequestBody(body, "form-data")
        : undefined;

    let rawMultipartBody: Buffer | undefined;
    if (rawMultipartTemplate) {
      const text = stripHttpClientDoubleSlashLineComments(body as string);
      headers = ensureMultipartContentTypeHeader(headers, text);
      rawMultipartBody = await resolveInlineBodyFileRefs(text, startDir);
    }

    let multipartBody: FormData | undefined;
    if (
      !rawMultipartTemplate &&
      formDataBody &&
      typeof formDataBody === "object" &&
      Object.keys(formDataBody).length > 0
    ) {
      multipartBody = await buildMultipartBody(
        formDataBody as Record<string, unknown>,
        startDir,
      );
      headers = Object.fromEntries(
        Object.entries(headers).filter(
          ([k]) => k.toLowerCase() !== "content-type",
        ),
      );
    }

    const methodUpper = (block.request.method || "GET").toUpperCase();

    if (hasOp(["kulala-openapi-explorer"])) {
      const requestHeaders = { ...headers };
      return await runOpenAPIFromBlock({
        block,
        filePath,
        url,
        headers: requestHeaders,
        method: methodUpper,
        mutableVars,
        stableDocId,
        resolver,
        env,
        flow,
        scriptRunScope,
        effectiveBody,
        scriptConsole,
        collectionIndex,
        collectionPlan: scriptCollectionPlan,
        iterationOptions,
        extraCurlArgv,
        startDir,
        runSharedPostScripts: async () => {
          const responseLike: RunnerResponseLike = {
            body: "",
            statusCode: 200,
            headers: { "content-type": "application/json" },
            timings: { phases: { total: 0 } },
          };
          await runSharedScriptsForPhase("postRequest", {
            flow,
            requestBlock: block,
            filePath,
            effectiveBody,
            env,
            startDir,
            mutableVars,
            resolver,
            iteration: collectionIndex,
            collectionPlan: scriptCollectionPlan,
            scriptConsole,
            response: responseLike,
            urlSent: url,
            headersSent: requestHeaders,
            bodySent: bodyPayloadToScriptString(undefined),
            responseUrl: url,
            responseHeaders: responseLike.headers,
            stableDocId,
            doc: iterationOptions?.doc,
            runRequestStack: scriptRunScope.runRequestStack,
          });
        },
      });
    }

    if (methodUpper === "WEBSOCKET") {
      const bodyStr =
        typeof body === "string"
          ? body
          : body != null
            ? JSON.stringify(body)
            : "";
      return {
        success: true,
        protocol: "websocket",
        url,
        initialMessage: bodyStr || undefined,
        request: buildSentRequestSnapshot(
          methodUpper,
          url,
          headers,
          bodyStr || undefined,
        ),
        ...(jqFilter ? { jqFilter } : {}),
      };
    }

    if (methodUpper === "GRPC") {
      const grpcFlags = mergeGrpcFlags(
        flow?.sharedGrpcFlags ?? [],
        grpcFlagsFromOperators(effectiveOperators),
      );
      const grpcBodyText =
        typeof body === "string"
          ? body
          : body != null
            ? JSON.stringify(body)
            : undefined;
      const grpcInsecure =
        curlArgvHasFlag(extraCurlArgv, "--insecure") ||
        curlArgvHasFlag(extraCurlArgv, "-k");
      const grpcVerboseTrace = formatGrpcurlCommand({
        grpcCommand: parseGrpcTarget(url),
        flags: grpcFlags,
        headers,
        body: grpcBodyText,
        cwd: startDir,
        vars: mutableVars,
        insecure: grpcInsecure,
      });
      const grpcSentRequest = buildSentRequestSnapshot(
        "GRPC",
        url,
        headers,
        grpcBodyText,
      );
      const grpcRes = await grpcNativeRequest({
        target: url,
        metadataFlags: grpcFlags,
        headers,
        body: grpcBodyText,
        cwd: startDir,
        vars: mutableVars,
        insecure: grpcInsecure,
      });
      const ok = grpcRes.statusCode >= 200 && grpcRes.statusCode < 400;
      if (!ok) {
        return {
          success: false,
          error: grpcRes.body || grpcRes.stderr || "gRPC request failed",
          url,
          request: grpcSentRequest,
          verboseTrace: grpcVerboseTrace,
          ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
        };
      }
      const grpcBodyRaw = grpcRes.body ?? "";
      const grpcContentType = ok ? "application/json" : "text/plain";
      const grpcResponseBody = await buildRunnerResponseBody(
        grpcBodyRaw,
        grpcContentType,
        iterationOptions?.responseFormat,
      );
      const grpcEnriched = await enrichResponseWithJq(
        grpcBodyRaw,
        grpcContentType,
        grpcResponseBody,
        jqFilter,
        iterationOptions?.responseFormat,
      );
      if (!grpcEnriched.ok) {
        return {
          success: false,
          error: grpcEnriched.error,
          url,
          request: grpcSentRequest,
          verboseTrace: grpcVerboseTrace,
          ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
        };
      }
      return {
        success: true,
        status: grpcRes.statusCode,
        headers: {
          "content-type": ok ? "application/json" : "kulala/grpc_error",
        },
        url,
        request: grpcSentRequest,
        verboseTrace: grpcVerboseTrace,
        timings: {
          dns: 0,
          tcp: 0,
          tls: 0,
          request: 0,
          redirect: 0,
          firstByte: grpcRes.timings.total,
          startTransfer: grpcRes.timings.total,
          total: grpcRes.timings.total,
        },
        body: grpcEnriched.body,
        rawBody: grpcEnriched.rawBody,
        ...(grpcEnriched.filteredBody
          ? { filteredBody: grpcEnriched.filteredBody, jqFilter }
          : {}),
        scriptConsole: scriptConsole.length > 0 ? scriptConsole : undefined,
      };
    }

    const method = (isGraphQL ? "POST" : block.request.method) || "GET";

    const followRedirects = !hasOp(["no-redirect"]);

    try {
      let bodyPayload: string | Buffer | FormData | undefined;
      if (multipartBody) {
        bodyPayload = multipartBody;
      } else if (rawMultipartBody) {
        bodyPayload = rawMultipartBody;
      } else if (graphqlBody !== undefined) {
        const payload: { query: string; variables?: Record<string, unknown> } =
          {
            query:
              typeof graphqlBody.query === "string" ? graphqlBody.query : "",
            ...(graphqlBody.variables != null
              ? { variables: graphqlBody.variables }
              : {}),
          };
        bodyPayload = JSON.stringify(payload);
      } else if (json !== undefined) {
        bodyPayload = JSON.stringify(json);
      } else if (form !== undefined) {
        if (noAutoEncoding) {
          const pairs = Object.entries(form as Record<string, string>);
          bodyPayload = pairs.map(([k, v]) => `${k}=${v}`).join("&");
        } else {
          bodyPayload = new URLSearchParams(
            form as Record<string, string>,
          ).toString();
        }
      } else if (body !== null && body !== undefined) {
        ({ headers, bodyPayload } = applyRawBodyWithoutContentType(
          headers,
          body,
        ));
      }

      const requestHeaders: Record<string, string> = isGraphQL
        ? { ...headers, "Content-Type": "application/json" }
        : headers;

      // Cookie jar: merge stored cookies with any explicit Cookie header (explicit wins per name).
      if (cookieJarEnabled) {
        const cookieKey = Object.keys(requestHeaders).find(
          (k) => k.toLowerCase() === "cookie",
        );
        const explicit = cookieKey ? requestHeaders[cookieKey] : undefined;
        const jar = getCookieHeaderForRequest(url);
        const merged = mergeCookieHeaderValues(jar, explicit);
        if (merged) {
          if (cookieKey && cookieKey !== "Cookie")
            delete requestHeaders[cookieKey];
          requestHeaders.Cookie = merged;
        }
      }

      const keepAliveStream = hasOp(["kulala-keep-alive-stream"]);
      const res = await httpRequest({
        url,
        method,
        headers: requestHeaders,
        body: bodyPayload,
        httpVersion: block.request.httpVersion,
        followRedirects,
        propagateCookiesOnRedirect: cookieJarEnabled,
        cookieJarEnabled,
        extraCurlArgv: keepAliveStream
          ? stripInheritedMaxTime(extraCurlArgv, effectiveOperators)
          : extraCurlArgv,
        ...(keepAliveStream
          ? {
              stream: {
                ...(block.name ? { blockName: block.name } : {}),
              },
            }
          : {}),
      });

      const rawBody = res.body;

      // Cookie jar: store Set-Cookie response headers unless disabled.
      if (cookieJarEnabled) {
        // Persist cookies from redirect chain too (servers often set cookies on 302).
        if (res.redirectChain && res.redirectChain.length > 0) {
          for (const hop of res.redirectChain) {
            const hopSetCookieRaw = hop.headers["set-cookie"];
            if (
              typeof hopSetCookieRaw === "string" &&
              hopSetCookieRaw.trim().length > 0
            ) {
              const lines = hopSetCookieRaw
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean);
              if (lines.length > 0) storeCookiesFromResponse(hop.url, lines);
            }
          }
        }
        const setCookieRaw = res.headers["set-cookie"];
        if (
          typeof setCookieRaw === "string" &&
          setCookieRaw.trim().length > 0
        ) {
          const lines = setCookieRaw
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          if (lines.length > 0) storeCookiesFromResponse(url, lines);
        }
      }
      const contentType = res.headers["content-type"] || "";
      const responseFormat = iterationOptions?.responseFormat;
      const { body: responseBody, rawBodyStr } =
        await buildRunnerResponseBodyFromRaw(
          rawBody,
          contentType,
          responseFormat,
        );

      const mapChainEntry = async (
        entry: NonNullable<typeof res.redirectChain>[number],
      ): Promise<
        NonNullable<KulalaRequestSuccessResponse["redirectChain"]>[number]
      > => {
        const raw = entry.body;
        const ct = entry.headers["content-type"] || "";
        const { body } = await buildRunnerResponseBodyFromRaw(
          raw,
          ct,
          responseFormat,
        );
        const p = entry.timings.phases;
        return {
          status: entry.statusCode,
          headers: entry.headers,
          url: entry.url,
          body,
          ...(entry.httpVersion ? { httpVersion: entry.httpVersion } : {}),
          timings: {
            dns: p.dns ?? 0,
            tcp: p.tcp ?? 0,
            tls: p.tls ?? 0,
            request: p.request ?? 0,
            redirect: p.redirect ?? 0,
            firstByte: p.firstByte ?? 0,
            startTransfer: p.startTransfer ?? 0,
            total: p.total ?? 0,
          },
          ...(entry.verboseTrace ? { verboseTrace: entry.verboseTrace } : {}),
        };
      };

      const redirectChainEntries = res.redirectChain
        ? await Promise.all(res.redirectChain.map(mapChainEntry))
        : undefined;

      // Redirect response to file (>> path or >>! path)
      const redirect = block.request.responseRedirect;
      if (redirect?.filePath) {
        const pathMod = await import("path");
        const fs = await import("fs/promises");
        const resolved = pathMod.resolve(startDir, redirect.filePath);
        await fs.mkdir(pathMod.dirname(resolved), { recursive: true });
        const isBuffer = Buffer.isBuffer(rawBody);
        const bodyToWrite: string | Buffer = isBuffer
          ? rawBody
          : responseBodyDisplayText(responseBody);
        const writeOpts: { encoding?: BufferEncoding } = isBuffer
          ? {}
          : { encoding: "utf-8" };
        if (redirect.overwrite) {
          await fs.writeFile(resolved, bodyToWrite, writeOpts);
        } else {
          let target = resolved;
          let n = 0;
          const ext = pathMod.extname(resolved);
          const base = resolved.slice(0, -ext.length || undefined);
          while (true) {
            try {
              await fs.access(target);
              n += 1;
              target = n === 1 ? `${base}-1${ext}` : `${base}-${n}${ext}`;
            } catch {
              await fs.writeFile(target, bodyToWrite, writeOpts);
              break;
            }
          }
        }
      }

      const { phases } = res.timings;
      const total = phases.total ?? 0;
      const firstByte = phases.firstByte ?? 0;
      const startTransfer = phases.startTransfer ?? 0;
      const redirectTime = phases.redirect ?? 0;
      const timingsForScripts: RunnerResponseLike["timings"] = {
        phases: { ...phases },
      };
      const responseLike: RunnerResponseLike = {
        body: rawBody,
        statusCode: res.statusCode,
        headers: res.headers,
        timings: timingsForScripts,
      };

      const postScriptRequestCtx = buildScriptRequestContextFromBlock({
        block,
        phase: "postRequest",
        effectiveBody,
        env,
        startDir,
        mutableVars,
        resolver,
        iteration: collectionIndex,
        collectionPlan: scriptCollectionPlan,
        urlSent: url,
        headersSent: requestHeaders,
        bodySent: bodyPayloadToScriptString(bodyPayload),
        responseUrl: url,
        responseHeaders: res.headers,
      });

      try {
        await runScripts(
          block.scripts.postRequest,
          "postRequest",
          block,
          filePath,
          responseLike,
          mutableVars,
          flow,
          scriptConsole,
          postScriptRequestCtx,
          scriptRunScope,
        );

        if (!iterationOptions?.skipSharedHooks) {
          await runSharedScriptsForPhase("postRequest", {
            flow,
            requestBlock: block,
            filePath,
            effectiveBody,
            env,
            startDir,
            mutableVars,
            resolver,
            iteration: collectionIndex,
            collectionPlan: scriptCollectionPlan,
            scriptConsole,
            response: responseLike,
            urlSent: url,
            headersSent: requestHeaders,
            bodySent: bodyPayloadToScriptString(bodyPayload),
            responseUrl: url,
            responseHeaders: res.headers,
            stableDocId,
            doc: iterationOptions?.doc,
            runRequestStack: scriptRunScope.runRequestStack,
          });
        }
      } catch (error) {
        if (error instanceof ScriptReplayError) {
          scriptReplayIndex += 1;
          continue scriptReplay;
        }
        const { phases } = res.timings;
        const redirectTime = phases.redirect ?? 0;
        const firstByte = phases.firstByte ?? 0;
        const startTransfer = phases.startTransfer ?? 0;
        const total = phases.total ?? 0;
        return {
          success: false,
          httpCompleted: true,
          error: error instanceof Error ? error.message : String(error),
          status: res.statusCode,
          ...(res.httpVersion ? { httpVersion: res.httpVersion } : {}),
          headers: res.headers,
          url: res.url,
          request: buildSentRequestSnapshot(
            method,
            url,
            requestHeaders,
            bodyPayload,
          ),
          timings: {
            dns: phases.dns ?? 0,
            tcp: phases.tcp ?? 0,
            tls: phases.tls ?? 0,
            request: phases.request ?? 0,
            redirect: redirectTime,
            firstByte,
            startTransfer,
            total,
          },
          body: responseBody,
          ...(redirectChainEntries
            ? { redirectChain: redirectChainEntries }
            : {}),
          ...(res.verboseTrace ? { verboseTrace: res.verboseTrace } : {}),
          ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
        } as KulalaRequestErrorResponse;
      }

      // @kulala-expect-status-code 200 (or 200,201)
      const expectArgs = getOpArgs(["kulala-expect-status-code"]);
      if (expectArgs) {
        const codes = expectArgs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n));
        if (codes.length > 0 && !codes.includes(res.statusCode)) {
          return {
            success: false,
            error: `Expected status code ${codes.join(", ")} but got ${res.statusCode}`,
            ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
          } as KulalaRequestErrorResponse;
        }
      }

      if (!iterationOptions?.skipPreScripts) {
        incrementReplayCount(
          stableDocIdForReplay ?? filePath ?? "",
          block.name,
        );
      }

      if (logEnabled) {
        saveHistoryEntry({
          stableDocId: stableDocId || undefined,
          blockName: block.name,
          method,
          url,
          requestHeaders,
          requestBodyText:
            typeof bodyPayload === "string"
              ? bodyPayload
              : Buffer.isBuffer(bodyPayload)
                ? bodyPayload.toString("utf-8")
                : undefined,
          statusCode: res.statusCode,
          responseHeaders: res.headers,
          responseBodyText: rawBodyStr,
        });
      }

      if (jqFilter?.trim() && responseBody.type === "binary") {
        return {
          success: false,
          error: "Cannot apply jq filter to a binary response body",
          ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
        } as KulalaRequestErrorResponse;
      }

      const enriched = await enrichResponseWithJq(
        rawBodyStr,
        contentType,
        responseBody,
        jqFilter,
        responseFormat,
      );
      if (!enriched.ok) {
        return {
          success: false,
          error: enriched.error,
          ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
        };
      }

      return {
        success: true,
        status: res.statusCode,
        ...(res.httpVersion ? { httpVersion: res.httpVersion } : {}),
        headers: res.headers,
        url: res.url,
        request: buildSentRequestSnapshot(
          method,
          url,
          requestHeaders,
          bodyPayload,
        ),
        ...(redirectChainEntries
          ? { redirectChain: redirectChainEntries }
          : {}),
        timings: {
          dns: phases.dns ?? 0,
          tcp: phases.tcp ?? 0,
          tls: phases.tls ?? 0,
          request: phases.request ?? 0,
          redirect: redirectTime,
          firstByte,
          startTransfer,
          total,
        },
        body: enriched.body,
        rawBody: enriched.rawBody,
        ...(enriched.filteredBody
          ? { filteredBody: enriched.filteredBody, jqFilter }
          : {}),
        ...(res.verboseTrace ? { verboseTrace: res.verboseTrace } : {}),
        ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
      } as KulalaRequestSuccessResponse;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...(scriptConsole.length > 0 ? { scriptConsole } : {}),
      } as KulalaRequestErrorResponse;
    }
  }
}

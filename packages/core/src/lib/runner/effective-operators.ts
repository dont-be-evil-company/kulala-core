import {
  curlArgvFromOperators,
  curlPassthroughFlagKey,
  mergeCurlArgv,
} from "../curl/passthrough";
import type { KulalaDocument } from "../parser/types";
import type { KulalaBlock } from "../parser/types/block";
import type { KulalaOperator } from "../parser/types/operator";
import { loadDefaultCurlOptions } from "../variables/default-curl-options";

const JQ_OPERATOR_NAMES = ["kulala-jq", "jq"] as const;

/** JetBrains `# @timeout` / `# @connection-timeout` duration → seconds for curl. */
export function parseDurationToSec(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms") return n / 1000;
  if (unit === "m") return n * 60;
  return n;
}

function getOperatorArgs(
  operators: KulalaOperator[],
  names: string[],
): string | undefined {
  for (const op of operators) {
    if (!names.includes(op.name)) continue;
    const args = String(op.args ?? "").trim();
    if (args) return args;
  }
  return undefined;
}

/** JetBrains timeout tags → curl `--max-time` / `--connect-timeout`. */
export function jetbrainsOperatorsToCurlArgv(
  operators: KulalaOperator[],
): string[] {
  const argv: string[] = [];
  const timeoutSec = parseDurationToSec(
    getOperatorArgs(operators, ["timeout"]) ?? "",
  );
  if (timeoutSec !== undefined) {
    argv.push("--max-time", String(Math.max(0, timeoutSec)));
  }
  const connectionTimeoutSec = parseDurationToSec(
    getOperatorArgs(operators, ["connection-timeout"]) ?? "",
  );
  if (connectionTimeoutSec !== undefined) {
    argv.push("--connect-timeout", String(Math.max(0, connectionTimeoutSec)));
  }
  return argv;
}

/**
 * File-header operators merged with block operators; block wins on same operator name.
 */
export function getEffectiveOperators(
  doc: KulalaDocument | undefined,
  block: KulalaBlock,
): KulalaOperator[] {
  const docOps =
    block.sourceFileHeaderOperators ?? doc?.fileHeaderOperators ?? [];
  const byName = new Map<string, KulalaOperator>();
  for (const op of docOps) byName.set(op.name, op);
  for (const op of block.operators) byName.set(op.name, op);
  return [...byName.values()];
}

/**
 * Env default curl options merged with file-header and block curl operators.
 * Request operators override project defaults on the same flag token.
 */
/**
 * Effective jq filter: run-time override, then block operator (overrides file header).
 */
export function getEffectiveJqFilter(
  doc: KulalaDocument | undefined,
  block: KulalaBlock,
  runTimeFilter?: string,
): string | undefined {
  for (const op of getEffectiveOperators(doc, block)) {
    if (
      !JQ_OPERATOR_NAMES.includes(op.name as (typeof JQ_OPERATOR_NAMES)[number])
    )
      continue;
    if (op.args == null) continue;
    const filter = String(op.args).trim();
    if (filter) return filter;
  }

  const runtime = runTimeFilter?.trim();
  if (runtime) return runtime;
  return undefined;
}

export function getEffectiveCurlArgv(
  doc: KulalaDocument | undefined,
  block: KulalaBlock,
  env: string,
  startDir: string,
): string[] {
  const operators = getEffectiveOperators(doc, block);
  const envArgv = loadDefaultCurlOptions(env, startDir);
  const jetbrainsArgv = jetbrainsOperatorsToCurlArgv(operators);
  const passthroughArgv = curlArgvFromOperators(operators);
  return mergeCurlArgv([envArgv, jetbrainsArgv, passthroughArgv]);
}

/** `# @timeout` or `# @kulala-curl--max-time` / `# @kulala-curl-m` set a deliberate cap. */
export function hasExplicitMaxTime(operators: KulalaOperator[]): boolean {
  if (
    operators.some(
      (op) => op.name === "timeout" && String(op.args ?? "").trim() !== "",
    )
  ) {
    return true;
  }
  return operators.some((op) => {
    const flag = curlPassthroughFlagKey(op.name);
    return flag === "--max-time" || flag === "-m";
  });
}

/**
 * Drop env/default `--max-time` so a keep-alive stream is not killed by a project timeout.
 * Explicit `# @timeout` and `# @kulala-curl--max-time` are left in place.
 */
export function stripInheritedMaxTime(
  argv: string[],
  operators: KulalaOperator[],
): string[] {
  if (hasExplicitMaxTime(operators)) return argv;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--max-time" || token === "-m") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    if (token.startsWith("--max-time=")) continue;
    out.push(token);
  }
  return out;
}

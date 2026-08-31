/**
 * Persistence layer for Kulala: SQLite-backed storage in an OS-specific data directory.
 *
 * - Documents: parsed HTTP documents for replay (by filepath).
 * - Request runs: replay count per request block.
 * - Variables: global, per-document, or per-request.
 *
 * Schema changes use versioned SQL migrations (see migrations/versions/) applied on DB open.
 *
 * Data directory:
 * - Linux: $XDG_DATA_HOME/kulala-core (~/.local/share/kulala-core)
 * - macOS: ~/Library/Application Support/kulala-core
 * - Windows: %APPDATA%/kulala-core
 *
 * Optional OS keychain lock/unlock:
 * - macOS: Keychain Access; Linux: Secret Service (secret-tool); Windows: Credential Manager (PowerShell P/Invoke).
 * - unlockDb() / lockDb() encrypt the DB at rest when locked.
 * - Fallback: if keychain is unavailable or you never call unlockDb(), getDb() uses a normal unencrypted SQLite file.
 */

export { getDataDir, ensureDataDir } from "./data-dir";
export {
  getDb,
  closeDb,
  getDbInMemory,
  setDbForTesting,
  unlockDb,
  lockDb,
  isUnlockedWithKeychain,
  isKeychainAvailable,
} from "./db";
export { getAppliedMigrations, runMigrations } from "./migrations/runner";
export { MIGRATIONS, type Migration } from "./migrations";
export {
  saveDocument,
  loadDocument,
  listDocumentFilepaths,
} from "./document-store";
export {
  incrementReplayCount,
  getReplayCount,
  listRequestRuns,
  type RequestRun,
} from "./replay-store";
export {
  setVariable,
  getVariable,
  getVariables,
  deleteVariable,
  type VariableScope,
} from "./variable-store";
export {
  createPrompt,
  getPrompt,
  deletePrompt,
  cleanupExpiredPrompts,
  type PromptType,
  type PromptContext,
  type PendingPrompt,
} from "./prompt-store";

export {
  saveHistoryEntry,
  listHistoryEntries,
  type HistoryEntry,
} from "./history-store";

export {
  saveRequestVarResult,
  loadRequestVarResults,
  mergePersistedRequestVarResults,
} from "./request-var-store";

export {
  storeCookiesFromResponse,
  getCookieHeaderForRequest,
  getCookiePairsForRequest,
  parseCookieHeaderValue,
  formatCookieHeaderValue,
  mergeCookieHeaderValues,
  selectCookieHeaderCandidates,
  cookieAppliesToRequest,
  domainMatches,
  normalizeSetCookieFromLine,
  pathMatches,
  type CookieHeaderCandidate,
  type CookiePairForRequest,
  type CookieRecord,
  type NormalizedSetCookie,
} from "./cookie-store";

export {
  loadGraphQLSchema,
  saveGraphQLSchema,
  deleteGraphQLSchema,
  clearGraphQLSchemas,
  listGraphQLSchemaHosts,
  type GraphQLSchemaRecord,
} from "./graphql-schema-store";

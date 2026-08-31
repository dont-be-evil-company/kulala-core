import type { Database } from "bun:sqlite";
import { migration000001Initial } from "./versions/000001_initial";
import { migration000002GraphqlSchemas } from "./versions/000002_graphql_schemas";
import { migration000003CookieJarPort } from "./versions/000003_cookie_jar_port";
import { migration000004CookieJarDefaultPort } from "./versions/000004_cookie_jar_default_port";
import { migration000005OpenapiSchemas } from "./versions/000005_openapi_schemas";
import { migration000006CookieJarDropPort } from "./versions/000006_cookie_jar_drop_port";

export type Migration = {
  version: number;
  name: string;
  statements: readonly string[];
  /** Optional imperative step (e.g. rebuild a table when ALTER is insufficient). */
  apply?: (db: Database) => void;
};

/** Ordered migrations (definitions live under versions/). Append only; never reorder or edit applied migrations. */
export const MIGRATIONS: readonly Migration[] = [
  migration000001Initial,
  migration000002GraphqlSchemas,
  migration000003CookieJarPort,
  migration000004CookieJarDefaultPort,
  migration000005OpenapiSchemas,
  migration000006CookieJarDropPort,
];

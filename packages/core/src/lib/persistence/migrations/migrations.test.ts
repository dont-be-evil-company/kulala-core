import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { getAppliedMigrations, runMigrations } from "./runner";

function openMemoryDb(): Database {
  return new Database(":memory:", { create: true });
}

const DB_MIGRATION_COUNT = 6;

/** Migration 4 tests still need the port column, so they stop before the drop. */
function runMigrationsBeforePortDrop(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(
    "INSERT INTO schema_migrations (version, name) VALUES (6, 'cookie_jar_drop_port')",
  );
  runMigrations(db);
}

afterEach(() => {
  // no shared state
});

test("runMigrations creates app tables and records baseline", () => {
  const db = openMemoryDb();
  runMigrations(db);

  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((r) => r.name);

  expect(tables).toContain("documents");
  expect(tables).toContain("schema_migrations");

  const applied = getAppliedMigrations(db);
  expect(applied).toHaveLength(DB_MIGRATION_COUNT);
  expect(applied[0]).toMatchObject({ version: 1, name: "initial" });
  expect(applied[1]).toMatchObject({ version: 2, name: "graphql_schemas" });
  expect(applied[2]).toMatchObject({ version: 3, name: "cookie_jar_port" });
  expect(applied[3]).toMatchObject({
    version: 4,
    name: "cookie_jar_default_port",
  });
  expect(applied[4]).toMatchObject({
    version: 5,
    name: "openapi_schemas",
  });
  expect(applied[5]).toMatchObject({
    version: 6,
    name: "cookie_jar_drop_port",
  });
  expect(tables).toContain("graphql_schemas");
  expect(tables).toContain("openapi_schemas");

  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(cookie_jar)")
    .all()
    .map((r) => r.name);
  expect(cols).not.toContain("port");

  const droppedIndex = db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_cookie_jar_identity'")
    .get();
  expect(droppedIndex).toBeNull();

  const index = db
    .query<
      { sql: string },
      []
    >("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_cookie_jar_domain_path'")
    .get();
  expect(index?.sql).toContain("domain, path");
});

test("runMigrations is idempotent", () => {
  const db = openMemoryDb();
  runMigrations(db);
  runMigrations(db);
  expect(getAppliedMigrations(db)).toHaveLength(DB_MIGRATION_COUNT);
});

test("runMigrations on pre-migration DB that already has tables", () => {
  const db = openMemoryDb();
  db.run(`CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT NOT NULL,
    parsed_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(filepath)
  )`);

  runMigrations(db);

  expect(getAppliedMigrations(db)).toHaveLength(DB_MIGRATION_COUNT);
  expect(db.query("SELECT 1 FROM documents LIMIT 1").get()).toBeNull();
});

test("runMigrations upgrades legacy cookie_jar without port column", () => {
  const db = openMemoryDb();
  db.run(`CREATE TABLE cookie_jar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TEXT,
    secure INTEGER NOT NULL DEFAULT 0,
    http_only INTEGER NOT NULL DEFAULT 0,
    same_site TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(domain, path, name)
  )`);
  db.run(
    "INSERT INTO cookie_jar (domain, path, name, value) VALUES ('example.com', '/', 'sid', 'abc')",
  );

  runMigrations(db);

  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(cookie_jar)")
    .all()
    .map((r) => r.name);
  expect(cols).not.toContain("port");

  const row = db
    .query<
      { domain: string; name: string; value: string },
      []
    >("SELECT domain, name, value FROM cookie_jar")
    .get();
  expect(row).toEqual({ domain: "example.com", name: "sid", value: "abc" });

  expect(getAppliedMigrations(db)).toHaveLength(DB_MIGRATION_COUNT);
});

test("runMigrations dedupes cookie_jar rows with NULL port", () => {
  const db = openMemoryDb();
  runMigrationsBeforePortDrop(db);
  db.run("DROP INDEX IF EXISTS uq_cookie_jar_identity");
  db.run(
    "INSERT INTO cookie_jar (domain, port, path, name, value, updated_at) VALUES ('echo.kulala.app', NULL, '/', 'kulala', 'test', '2026-01-01T00:00:00.000Z')",
  );
  db.run(
    "INSERT INTO cookie_jar (domain, port, path, name, value, updated_at) VALUES ('echo.kulala.app', NULL, '/', 'kulala', 'test1', '2026-06-09T13:21:33.397Z')",
  );
  db.run(`DELETE FROM schema_migrations WHERE version = 4`);
  runMigrations(db);

  const rows = db
    .query<
      { port: number; value: string },
      []
    >("SELECT port, value FROM cookie_jar WHERE domain = 'echo.kulala.app' AND name = 'kulala'")
    .all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ port: 0, value: "test1" });
});

test("runMigrations normalizes legacy NULL port so subsequent upserts work", () => {
  const db = openMemoryDb();
  runMigrationsBeforePortDrop(db);
  db.run("DROP INDEX IF EXISTS uq_cookie_jar_identity");
  db.run(
    "INSERT INTO cookie_jar (domain, port, path, name, value, updated_at) VALUES ('echo.kulala.app', NULL, '/', 'kulala', 'old', '2026-01-01T00:00:00.000Z')",
  );
  db.run("DELETE FROM schema_migrations WHERE version = 4");
  runMigrations(db);

  db.run(
    `INSERT INTO cookie_jar (domain, port, path, name, value, updated_at)
     VALUES ('echo.kulala.app', 0, '/', 'kulala', 'new', datetime('now'))
     ON CONFLICT(domain, port, path, name) DO UPDATE SET value = excluded.value`,
  );

  const rows = db
    .query<
      { port: number; value: string },
      []
    >("SELECT port, value FROM cookie_jar WHERE domain = 'echo.kulala.app' AND name = 'kulala'")
    .all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ port: 0, value: "new" });
});

test("runMigrations dedupes port-0 and NULL duplicates from mixed migration state", () => {
  const db = openMemoryDb();
  runMigrationsBeforePortDrop(db);
  db.run("DROP INDEX IF EXISTS uq_cookie_jar_identity");
  db.run(
    "INSERT INTO cookie_jar (domain, port, path, name, value, updated_at) VALUES ('echo.kulala.app', 0, '/', 'kulala', 'test1', '2026-06-09T13:21:33.397Z')",
  );
  db.run(
    "INSERT INTO cookie_jar (domain, port, path, name, value, updated_at) VALUES ('echo.kulala.app', NULL, '/', 'kulala', 'test1', '2026-06-09T13:27:57.389Z')",
  );
  db.run("DELETE FROM schema_migrations WHERE version = 4");
  runMigrations(db);

  const rows = db
    .query<
      { port: number; value: string },
      []
    >("SELECT port, value FROM cookie_jar WHERE domain = 'echo.kulala.app' AND name = 'kulala'")
    .all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ port: 0, value: "test1" });
});

test("runMigrations drops cookie port and keeps the newest row", () => {
  const db = openMemoryDb();
  runMigrationsBeforePortDrop(db);
  db.run(
    "INSERT INTO cookie_jar (domain, port, path, name, value, updated_at) VALUES ('localhost', 3000, '/', 'sid', 'old', '2026-01-01T00:00:00.000Z')",
  );
  db.run(
    "INSERT INTO cookie_jar (domain, port, path, name, value, updated_at) VALUES ('localhost', 4000, '/', 'sid', 'new', '2026-06-09T13:21:33.397Z')",
  );
  db.run("DELETE FROM schema_migrations WHERE version = 6");
  runMigrations(db);

  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(cookie_jar)")
    .all()
    .map((r) => r.name);
  expect(cols).not.toContain("port");

  const rows = db
    .query<
      { name: string; value: string },
      []
    >("SELECT name, value FROM cookie_jar WHERE domain = 'localhost' AND name = 'sid'")
    .all();
  expect(rows).toEqual([{ name: "sid", value: "new" }]);
});

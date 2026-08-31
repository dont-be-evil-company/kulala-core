import type { Database } from "bun:sqlite";

function cookieJarHasPortColumn(db: Database): boolean {
  const rows = db
    .query<{ name: string }, []>("PRAGMA table_info(cookie_jar)")
    .all();
  return rows.some((r) => r.name === "port");
}

/**
 * RFC 6265 does not scope cookies by port. Rebuild cookie_jar without `port`
 * and UNIQUE(domain, path, name). Rows that differ only by port collapse to the
 * newest updated_at. ALTER TABLE DROP COLUMN cannot remove `port` while it is
 * part of the table unique constraint and cookie indexes.
 */
function dropCookieJarPort(db: Database): void {
  const table = db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cookie_jar'")
    .get();
  if (!table) return;
  if (!cookieJarHasPortColumn(db)) return;

  db.run(`CREATE TABLE cookie_jar_new (
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

  db.run(`INSERT INTO cookie_jar_new (
    id, domain, path, name, value, expires_at, secure, http_only, same_site, updated_at
  )
  SELECT
    id, domain, path, name, value, expires_at, secure, http_only, same_site, updated_at
  FROM (
    SELECT
      id, domain, path, name, value, expires_at, secure, http_only, same_site, updated_at,
      ROW_NUMBER() OVER (
        PARTITION BY domain, path, name
        ORDER BY updated_at DESC, id DESC
      ) AS rn
    FROM cookie_jar
  )
  WHERE rn = 1`);

  db.run("DROP TABLE cookie_jar");
  db.run("ALTER TABLE cookie_jar_new RENAME TO cookie_jar");
}

export const migration000006CookieJarDropPort = {
  version: 6,
  name: "cookie_jar_drop_port",
  statements: [
    `CREATE INDEX IF NOT EXISTS idx_cookie_jar_domain_path ON cookie_jar(domain, path)`,
  ] as const,
  apply(db: Database): void {
    dropCookieJarPort(db);
  },
} as const;

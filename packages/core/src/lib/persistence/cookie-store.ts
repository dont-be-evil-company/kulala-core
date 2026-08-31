import { getDb } from "./db";

export type CookieRecord = {
  domain: string;
  path: string;
  name: string;
  value: string;
  expiresAt?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export type NormalizedSetCookie = {
  domain: string;
  path: string;
  name: string;
  value: string;
  secure: boolean;
  expiresAt?: string;
};

function parseSetCookieHeader(header: string): {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expiresAt?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  maxAgeSeconds?: number;
} | null {
  const parts = header
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const [nv, ...attrs] = parts;
  const eq = nv.indexOf("=");
  if (eq === -1) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  if (!name) return null;

  const out: ReturnType<typeof parseSetCookieHeader> = {
    name,
    value,
  };

  for (const a of attrs) {
    const [kRaw, ...rest] = a.split("=");
    const k = (kRaw ?? "").trim().toLowerCase();
    const v = rest.join("=").trim();
    if (k === "domain" && v) out.domain = v.replace(/^\./, "").toLowerCase();
    else if (k === "path" && v) out.path = v;
    else if (k === "expires" && v) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) out.expiresAt = d.toISOString();
    } else if (k === "max-age" && v) {
      const n = Number(v);
      if (Number.isFinite(n)) out.maxAgeSeconds = Math.trunc(n);
    } else if (k === "samesite" && v) out.sameSite = v;
    else if (k === "secure") out.secure = true;
    else if (k === "httponly") out.httpOnly = true;
  }

  if (out.maxAgeSeconds !== undefined) {
    out.expiresAt = new Date(
      Date.now() + out.maxAgeSeconds * 1000,
    ).toISOString();
  }

  return out;
}

function defaultPathForUrl(url: URL): string {
  const p = url.pathname || "/";
  if (!p.startsWith("/")) return "/";
  if (p === "/") return "/";
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

export function domainMatches(host: string, cookieDomain: string): boolean {
  const h = host.toLowerCase();
  const d = cookieDomain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (!requestPath.startsWith("/")) return false;
  if (!cookiePath.startsWith("/")) return false;
  return (
    requestPath === cookiePath ||
    requestPath.startsWith(
      cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`,
    )
  );
}

/**
 * Parse a single Set-Cookie header line and resolve Domain/Path the same way as
 * storeCookiesFromResponse (host-only default domain when Domain is omitted).
 */
export function normalizeSetCookieFromLine(
  setCookieLine: string,
  responseUrlStr: string,
): NormalizedSetCookie | null {
  const parsed = parseSetCookieHeader(setCookieLine);
  if (!parsed) return null;
  const url = new URL(responseUrlStr);
  const host = url.hostname.toLowerCase();
  const domain = (parsed.domain ?? host).toLowerCase();
  const path = parsed.path ?? defaultPathForUrl(url);
  const now = nowIso();
  if (parsed.expiresAt && parsed.expiresAt <= now) return null;
  return {
    domain,
    path,
    name: parsed.name,
    value: parsed.value,
    secure: !!parsed.secure,
    expiresAt: parsed.expiresAt,
  };
}

/** Whether a cookie normalized from Set-Cookie should be sent on a request to requestUrlStr. */
export function cookieAppliesToRequest(
  c: NormalizedSetCookie,
  requestUrlStr: string,
): boolean {
  const url = new URL(requestUrlStr);
  const hostname = url.hostname.toLowerCase();
  const reqPath = url.pathname || "/";
  if (!domainMatches(hostname, c.domain)) return false;
  if (!pathMatches(reqPath, c.path)) return false;
  if (c.secure && url.protocol !== "https:" && hostname !== "localhost") {
    return false;
  }
  const now = nowIso();
  if (c.expiresAt && c.expiresAt <= now) return false;
  return true;
}

export function storeCookiesFromResponse(
  urlStr: string,
  setCookieHeaders: string[],
): void {
  const url = new URL(urlStr);
  const hostname = url.hostname.toLowerCase();
  const db = getDb();
  const now = nowIso();

  for (const h of setCookieHeaders) {
    const parsed = parseSetCookieHeader(h);
    if (!parsed) continue;

    const domain = (parsed.domain ?? hostname).toLowerCase();
    const path = parsed.path ?? defaultPathForUrl(url);
    const expiresAt = parsed.expiresAt ?? null;
    const secure = parsed.secure ? 1 : 0;
    const httpOnly = parsed.httpOnly ? 1 : 0;
    const sameSite = parsed.sameSite ?? null;

    // Expired -> delete
    if (expiresAt && expiresAt <= now) {
      db.run(
        "DELETE FROM cookie_jar WHERE domain = ? AND path = ? AND name = ?",
        [domain, path, parsed.name],
      );
      continue;
    }

    db.run(
      `INSERT INTO cookie_jar (domain, path, name, value, expires_at, secure, http_only, same_site, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain, path, name) DO UPDATE SET
         value = excluded.value,
         expires_at = excluded.expires_at,
         secure = excluded.secure,
         http_only = excluded.http_only,
         same_site = excluded.same_site,
         updated_at = excluded.updated_at`,
      [
        domain,
        path,
        parsed.name,
        parsed.value,
        expiresAt,
        secure,
        httpOnly,
        sameSite,
        now,
      ],
    );
  }
}

export type CookiePairForRequest = {
  name: string;
  value: string;
  path: string;
};

/** Parse a request `Cookie` header value into name/value pairs (last duplicate name wins). */
export function parseCookieHeaderValue(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Format name/value pairs as a single RFC 6265 Cookie header value. */
export function formatCookieHeaderValue(
  pairs: Record<string, string>,
): string | undefined {
  const names = Object.keys(pairs).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return undefined;
  return names.map((k) => `${k}=${pairs[k]}`).join("; ");
}

/**
 * Merge multiple Cookie header values left-to-right; later values win for the same name.
 */
export function mergeCookieHeaderValues(
  ...values: (string | undefined)[]
): string | undefined {
  const merged: Record<string, string> = {};
  for (const raw of values) {
    if (!raw?.trim()) continue;
    Object.assign(merged, parseCookieHeaderValue(raw));
  }
  return formatCookieHeaderValue(merged);
}

export type CookieHeaderCandidate = {
  name: string;
  value: string;
  path: string;
  /** Higher tier wins (jar < explicit request header < redirect Set-Cookie). */
  tier: number;
  /** Later within the same tier wins when path length is equal. */
  seq: number;
};

function compareCookieHeaderCandidates(
  a: CookieHeaderCandidate,
  b: CookieHeaderCandidate,
): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.seq - b.seq;
}

/** Pick one value per cookie name for an outgoing request. */
export function selectCookieHeaderCandidates(
  candidates: CookieHeaderCandidate[],
): string | undefined {
  const byName = new Map<string, CookieHeaderCandidate>();
  for (const c of candidates) {
    const cur = byName.get(c.name);
    if (!cur || compareCookieHeaderCandidates(c, cur) > 0) {
      byName.set(c.name, c);
    }
  }
  const pairs: Record<string, string> = {};
  for (const c of byName.values()) pairs[c.name] = c.value;
  return formatCookieHeaderValue(pairs);
}

export function getCookiePairsForRequest(
  urlStr: string,
): CookiePairForRequest[] {
  const url = new URL(urlStr);
  const hostname = url.hostname.toLowerCase();
  const reqPath = url.pathname || "/";
  const isHttps = url.protocol === "https:";
  const now = nowIso();
  const db = getDb();

  const rows = db
    .query<
      {
        domain: string;
        path: string;
        name: string;
        value: string;
        expires_at: string | null;
        secure: number;
      },
      []
    >(
      `SELECT domain, path, name, value, expires_at, secure
       FROM cookie_jar`,
    )
    .all();

  const byName = new Map<string, CookiePairForRequest>();
  for (const r of rows) {
    if (!domainMatches(hostname, r.domain)) continue;
    if (!pathMatches(reqPath, r.path)) continue;
    if (r.secure === 1 && !isHttps && r.domain !== "localhost") continue;
    if (r.expires_at && r.expires_at <= now) continue;
    const existing = byName.get(r.name);
    if (!existing || r.path.length > existing.path.length) {
      byName.set(r.name, { name: r.name, value: r.value, path: r.path });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getCookieHeaderForRequest(urlStr: string): string | undefined {
  const pairs = getCookiePairsForRequest(urlStr);
  if (pairs.length === 0) return undefined;
  return formatCookieHeaderValue(
    Object.fromEntries(pairs.map((c) => [c.name, c.value])),
  );
}

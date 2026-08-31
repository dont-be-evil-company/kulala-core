import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeDb, getDb, getDbInMemory, setDbForTesting } from "./db";
import {
  getCookieHeaderForRequest,
  mergeCookieHeaderValues,
  parseCookieHeaderValue,
  selectCookieHeaderCandidates,
  storeCookiesFromResponse,
} from "./cookie-store";

beforeEach(() => {
  setDbForTesting(getDbInMemory());
});

afterEach(() => {
  closeDb();
});

test("parseCookieHeaderValue: last duplicate name wins", () => {
  expect(parseCookieHeaderValue("a=1; b=2; a=3")).toEqual({ a: "3", b: "2" });
});

test("mergeCookieHeaderValues: later header wins for same name", () => {
  expect(mergeCookieHeaderValues("a=1; b=1", "a=2; c=3")).toBe("a=2; b=1; c=3");
});

test("storeCookiesFromResponse: upserts cookies instead of duplicating", () => {
  storeCookiesFromResponse("http://echo.kulala.app/", ["kulala=test; Path=/"]);
  storeCookiesFromResponse("http://echo.kulala.app/", ["kulala=test1; Path=/"]);

  const rows = getDb()
    .query<
      { name: string; value: string },
      []
    >("SELECT name, value FROM cookie_jar WHERE domain = 'echo.kulala.app'")
    .all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ name: "kulala", value: "test1" });
  expect(getCookieHeaderForRequest("http://echo.kulala.app/")).toBe(
    "kulala=test1",
  );
});

test("getCookieHeaderForRequest: sends cookies when the host matches and the port does not", () => {
  storeCookiesFromResponse("http://localhost:3000/", ["sid=abc; Path=/"]);

  expect(getCookieHeaderForRequest("http://localhost:4000/")).toBe("sid=abc");
  expect(getCookieHeaderForRequest("http://localhost/")).toBe("sid=abc");
});

test("storeCookiesFromResponse: Set-Cookie on another port replaces the same cookie", () => {
  storeCookiesFromResponse("http://localhost:3000/", ["sid=old; Path=/"]);
  storeCookiesFromResponse("http://localhost:4000/", ["sid=new; Path=/"]);

  const rows = getDb()
    .query<
      { name: string; value: string },
      []
    >("SELECT name, value FROM cookie_jar WHERE domain = 'localhost' AND name = 'sid'")
    .all();
  expect(rows).toEqual([{ name: "sid", value: "new" }]);
  expect(getCookieHeaderForRequest("http://localhost:3000/")).toBe("sid=new");
  expect(getCookieHeaderForRequest("http://localhost:4000/")).toBe("sid=new");
});

test("getCookieHeaderForRequest: same name at different paths keeps most specific", () => {
  storeCookiesFromResponse("http://example.com/", ["sid=root; Path=/"]);
  storeCookiesFromResponse("http://example.com/api/foo", [
    "sid=api; Path=/api",
  ]);

  expect(getCookieHeaderForRequest("http://example.com/api/foo")).toBe(
    "sid=api",
  );
  expect(getCookieHeaderForRequest("http://example.com/other")).toBe(
    "sid=root",
  );
});

test("selectCookieHeaderCandidates: redirect Set-Cookie beats jar; longer path wins within tier", () => {
  const header = selectCookieHeaderCandidates([
    { name: "sid", value: "root", path: "/", tier: 0, seq: 0 },
    { name: "sid", value: "api", path: "/api", tier: 0, seq: 1 },
    { name: "sid", value: "explicit", path: "", tier: 1, seq: 2 },
    { name: "sid", value: "redirect", path: "/", tier: 2, seq: 3 },
  ]);
  expect(header).toBe("sid=redirect");
});

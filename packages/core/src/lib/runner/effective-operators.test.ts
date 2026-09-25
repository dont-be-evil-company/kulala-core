import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { KulalaDocument } from "../parser/types";
import type { KulalaBlock } from "../parser/types/block";
import type { KulalaOperator } from "../parser/types/operator";
import {
  getEffectiveCurlArgv,
  getEffectiveJqFilter,
  jetbrainsOperatorsToCurlArgv,
  parseDurationToSec,
  stripInheritedMaxTime,
} from "./effective-operators";

function block(operators: KulalaBlock["operators"]): KulalaBlock {
  return {
    name: "TEST",
    operators,
    request: { method: "GET", url: "https://example.com" },
    scripts: { preRequest: [], postRequest: [] },
  } as unknown as KulalaBlock;
}

function op(name: KulalaOperator["name"], args?: string): KulalaOperator {
  return { name, args, lineNumber: 0 };
}

function envDirWithDefaults(defaults: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kulala-curl-ops-"));
  writeFileSync(
    join(dir, "http-client.env.json"),
    JSON.stringify({
      $kulalaShared: { $kulalaDefaultCurlOptions: defaults },
      default: { env_name: "default" },
    }),
    "utf-8",
  );
  return dir;
}

describe("parseDurationToSec", () => {
  test("parses ms, s, and m units", () => {
    expect(parseDurationToSec("10 ms")).toBe(0.01);
    expect(parseDurationToSec("5 s")).toBe(5);
    expect(parseDurationToSec("2 m")).toBe(120);
    expect(parseDurationToSec("3")).toBe(3);
  });
});

describe("jetbrainsOperatorsToCurlArgv", () => {
  test("maps timeout tags to curl flags", () => {
    expect(
      jetbrainsOperatorsToCurlArgv([
        op("timeout", "10 ms"),
        op("connection-timeout", "500 ms"),
      ]),
    ).toEqual(["--max-time", "0.01", "--connect-timeout", "0.5"]);
  });
});

describe("getEffectiveCurlArgv", () => {
  test("# @timeout overrides env default --max-time", () => {
    const dir = envDirWithDefaults(["--max-time 2"]);
    const b = block([op("timeout", "10 ms")]);
    expect(getEffectiveCurlArgv(undefined, b, "default", dir)).toEqual([
      "--max-time",
      "0.01",
    ]);
  });

  test("# @connection-timeout overrides env default --connect-timeout", () => {
    const dir = envDirWithDefaults(["--connect-timeout 5"]);
    const b = block([op("connection-timeout", "500 ms")]);
    expect(getEffectiveCurlArgv(undefined, b, "default", dir)).toEqual([
      "--connect-timeout",
      "0.5",
    ]);
  });

  test("# @kulala-curl--max-time overrides env default", () => {
    const dir = envDirWithDefaults(["--max-time 2"]);
    const b = block([op("kulala-curl--max-time", "5")]);
    expect(getEffectiveCurlArgv(undefined, b, "default", dir)).toEqual([
      "--max-time",
      "5",
    ]);
  });

  test("passthrough curl operator wins over # @timeout on same flag", () => {
    const dir = envDirWithDefaults(["--max-time 2"]);
    const b = block([op("timeout", "10 ms"), op("kulala-curl--max-time", "5")]);
    expect(getEffectiveCurlArgv(undefined, b, "default", dir)).toEqual([
      "--max-time",
      "5",
    ]);
  });

  test("block operator overrides file-header operator", () => {
    const dir = envDirWithDefaults(["--max-time 2"]);
    const doc = {
      fileHeaderOperators: [op("timeout", "1 s")],
    } as KulalaDocument;
    const b = block([op("timeout", "50 ms")]);
    expect(getEffectiveCurlArgv(doc, b, "default", dir)).toEqual([
      "--max-time",
      "0.05",
    ]);
  });
});

describe("stripInheritedMaxTime", () => {
  test("drops env --max-time when the stream operator has no explicit cap", () => {
    const argv = stripInheritedMaxTime(
      ["--max-time", "2", "--insecure"],
      [op("kulala-keep-alive-stream")],
    );
    expect(argv).toEqual(["--insecure"]);
  });

  test("keeps # @timeout", () => {
    const argv = stripInheritedMaxTime(
      ["--max-time", "0.05"],
      [op("kulala-keep-alive-stream"), op("timeout", "50 ms")],
    );
    expect(argv).toEqual(["--max-time", "0.05"]);
  });

  test("keeps # @kulala-curl--max-time", () => {
    const argv = stripInheritedMaxTime(
      ["--max-time", "5"],
      [op("kulala-keep-alive-stream"), op("kulala-curl--max-time", "5")],
    );
    expect(argv).toEqual(["--max-time", "5"]);
  });
});

describe("getEffectiveJqFilter", () => {
  test("block operator overrides file header", () => {
    const doc = {
      fileHeaderOperators: [{ name: "kulala-jq", args: ".a", lineNumber: 0 }],
    } as KulalaDocument;
    const b = block([{ name: "kulala-jq", args: ".b", lineNumber: 1 }]);
    expect(getEffectiveJqFilter(doc, b)).toBe(".b");
  });

  test("uses file header when block has no jq operator", () => {
    const doc = {
      fileHeaderOperators: [
        { name: "kulala-jq", args: ".header", lineNumber: 0 },
      ],
    } as KulalaDocument;
    const b = block([]);
    expect(getEffectiveJqFilter(doc, b)).toBe(".header");
  });

  test("run-time filter applies when no operator is set", () => {
    const b = block([]);
    expect(getEffectiveJqFilter(undefined, b, ".runtime")).toBe(".runtime");
  });

  test("block operator wins over run-time filter", () => {
    const withBlock = block([
      { name: "kulala-jq", args: ".block", lineNumber: 1 },
    ]);
    expect(getEffectiveJqFilter(undefined, withBlock, ".runtime")).toBe(
      ".block",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { splitWebSocketMessages } from "./messages";

describe("splitWebSocketMessages", () => {
  test("sends a single body immediately", () => {
    expect(splitWebSocketMessages('{"message":"hi"}')).toEqual([
      { waitForServer: 0, data: '{"message":"hi"}' },
    ]);
  });

  test("plain === sends the next message immediately", () => {
    const body = [
      '{ "message": "First message sent on connection" }',
      "===",
      '{ "message": "Second message" }',
      "===",
      '{ "message": "Third message" }',
    ].join("\n");
    expect(splitWebSocketMessages(body)).toEqual([
      {
        waitForServer: 0,
        data: '{ "message": "First message sent on connection" }',
      },
      { waitForServer: 0, data: '{ "message": "Second message" }' },
      { waitForServer: 0, data: '{ "message": "Third message" }' },
    ]);
  });

  test("=== wait-for-server waits for one server message", () => {
    const body = [
      '{ "message": "First" }',
      "===  // message separator",
      '{ "message": "Second" }',
      "=== wait-for-server // keyword used to wait",
      '{ "message": "Send this after the server response" }',
    ].join("\n");
    expect(splitWebSocketMessages(body)).toEqual([
      { waitForServer: 0, data: '{ "message": "First" }' },
      { waitForServer: 0, data: '{ "message": "Second" }' },
      {
        waitForServer: 1,
        data: '{ "message": "Send this after the server response" }',
      },
    ]);
  });

  test("repeated wait-for-server lines accumulate onto the next payload", () => {
    const body = [
      "=== wait-for-server",
      "=== wait-for-server",
      "=== wait-for-server",
      '{ "message": "This message is sent after 3 server responses" }',
    ].join("\n");
    expect(splitWebSocketMessages(body)).toEqual([
      {
        waitForServer: 3,
        data: '{ "message": "This message is sent after 3 server responses" }',
      },
    ]);
  });

  test("keeps // comments inside a payload and ignores === with other words", () => {
    const body = ["not a separator ===", "=== hello", "// keep me", "==="].join(
      "\n",
    );
    expect(splitWebSocketMessages(body)).toEqual([
      { waitForServer: 0, data: "not a separator ===\n=== hello\n// keep me" },
    ]);
  });

  test("drops blank regions around separators", () => {
    expect(splitWebSocketMessages('\n===\n\n{"a":1}\n\n')).toEqual([
      { waitForServer: 0, data: '{"a":1}' },
    ]);
  });

  test("returns no frames for an empty body", () => {
    expect(splitWebSocketMessages("  \n")).toEqual([]);
  });
});

import { kulalaCore } from "@kulala/core";
import { existsSync, readFileSync } from "node:fs";

async function getInputPayload(): Promise<string> {
  const args = process.argv.slice(2);

  let inputFile: string | undefined;
  const inputFileIndex = args.findIndex(
    (arg) => arg === "--input-file" || arg === "-i",
  );
  if (inputFileIndex !== -1 && args[inputFileIndex + 1]) {
    inputFile = args[inputFileIndex + 1];
  }

  if (!inputFile && process.env.KULALA_CORE_INPUT_FILE) {
    inputFile = process.env.KULALA_CORE_INPUT_FILE;
  }

  if (inputFile) {
    if (!existsSync(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`);
    }
    return readFileSync(inputFile, "utf8");
  }

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let content = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return content;
}

const inputPayload = await getInputPayload();
const stdIn = JSON.parse(inputPayload);

// Consumers can call the API directly without stdout/stderr IO,
// but this example keeps parity with the standalone CLI input payload format.
const { response } =
  stdIn.action === "run"
    ? await kulalaCore.run({
        content: stdIn.content,
        filepath: stdIn.filepath,
        env: stdIn.env,
        limit: stdIn.limit,
      })
    : {
        response: {
          type: "error",
          data: [
            { success: false, error: `Unsupported action: ${stdIn.action}` },
          ],
        },
      };

process.stdout.write(JSON.stringify(response));

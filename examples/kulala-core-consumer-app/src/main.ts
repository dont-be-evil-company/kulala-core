import { kulalaCore } from "@kulala/core";

const content = `### Example request
GET https://echo.kulala.app/get
Accept: application/json
`;

const brokenContent = `### BROKEN_REQUEST
FOO /
Accept application/json
`;

const parsedBrokenDoc = await kulalaCore.parse({
  content: brokenContent,
  filepath: undefined,
});

if (parsedBrokenDoc.hasErrors) {
  console.error("Parse errors detected in broken document.");
  console.log(parsedBrokenDoc.blocks[0].errors);
}

const { doc, response } = await kulalaCore.run({
  content,
  filepath: undefined,
  env: "default",
});

if (doc.hasErrors) {
  // Consumers can inspect parse errors via the document structure.
  // See the above example for the broken document.
  console.error("Parse errors detected in document.");
}

if (response.type === "responses") {
  response.data.forEach((item) => {
    if (item.success) {
      console.log("Request successful!");
      console.log("Response body:");
      console.log(item.body);
    }
  });
}

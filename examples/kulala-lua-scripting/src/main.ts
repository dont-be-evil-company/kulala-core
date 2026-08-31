import { kulalaCore } from "@dont-be-evil-company/kulala-core";

const http = `### LUA_SCRIPTED
< {% lang=lua
  request.variables.set("NAME", "kulala")
  client.global.set("GLOBAL_FOO", "bar")
%}
GET https://echo.kulala.app/anything?name={{NAME}}
Accept: application/json

> {% lang=lua
  request.variables.set("STATUS", tostring(response.status))
  request.variables.set("DATE", response.headers.valueOf("Date") or "")
%}
`;

const { response } = await kulalaCore.run({ content: http, env: "default" });
console.log(JSON.stringify(response, null, 2));

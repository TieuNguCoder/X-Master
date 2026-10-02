import { writeFileSync } from "node:fs";
import { renderChildWorkerSource } from "../master-router/src/child-template.js";
import { renderAccountRouterSource } from "../master-router/src/account-router-template.js";

const source = renderChildWorkerSource();
if (!source.includes("export default")) throw new Error("child worker export missing");
if (!source.includes("/internal/child/login")) throw new Error("child login proxy missing");
if (!source.includes("Gemini API Key")) throw new Error("child Gemini UI missing");
if (!source.includes("Buffer API Key")) throw new Error("child Buffer UI missing");
writeFileSync(".tmp-child-worker.mjs", source);
console.log("Rendered child worker:", source.length, "bytes");

const routerSource = renderAccountRouterSource();
if (!routerSource.includes("export default")) throw new Error("account router export missing");
if (!routerSource.includes("/internal/router/process")) throw new Error("account router process proxy missing");
if (!routerSource.includes("/internal/router/publish")) throw new Error("account router publish proxy missing");
writeFileSync(".tmp-account-router.mjs", routerSource);
console.log("Rendered account router:", routerSource.length, "bytes");

import { writeFileSync } from "node:fs";
import { renderChildWorkerSource } from "../master-router/src/child-template.js";

const source = renderChildWorkerSource();
if (!source.includes("export default")) throw new Error("child worker export missing");
if (!source.includes("/internal/child/login")) throw new Error("child login proxy missing");
if (!source.includes("Gemini API Key")) throw new Error("child Gemini UI missing");
if (!source.includes("Buffer API Key")) throw new Error("child Buffer UI missing");
writeFileSync(".tmp-child-worker.mjs", source);
console.log("Rendered child worker:", source.length, "bytes");

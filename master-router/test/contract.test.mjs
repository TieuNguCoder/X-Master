import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const childTemplate = readFileSync(new URL("../src/child-template.js", import.meta.url), "utf8");

for (const label of ["Child Webs", "Telegram Catalog", "Logs", "Cloudflare", "Cloudinary"]) {
  assert.ok(html.includes(label), "Master UI missing " + label);
}
assert.ok(js.includes("/api/admin/children/preflight"));
assert.ok(js.includes("/api/admin/children"));
assert.ok(html.includes("Copy URL + Password"));
assert.ok(!html.includes("Thêm Telegram Source"), "manual Source form must be removed");

for (const table of [
  "sources","children","child_infra","admin_sessions","child_sessions","deployment_jobs","audit_logs",
  "x_accounts","x_account_sources","ingest_events","ingest_account_routes"
]) {
  assert.ok(schema.includes("CREATE TABLE IF NOT EXISTS " + table), "schema missing " + table);
}

assert.equal((routerSource.match(/datetime\(expires_at\) > CURRENT_TIMESTAMP/g) || []).length, 2);
assert.ok(routerSource.includes("if (uploaded) await deleteChildWorker"));
assert.ok(routerSource.includes('new Error("password_too_short")'));
assert.ok(routerSource.includes('new Error("x_account_limit_reached")'));
assert.ok(routerSource.includes('path === "/collector/catalog"'));
assert.ok(routerSource.includes('path === "/internal/child/accounts"'));
assert.ok(routerSource.includes('routed_accounts'));
assert.ok(childTemplate.includes("Mỗi web con tối đa 5 tài khoản"));
assert.ok(childTemplate.includes("/api/accounts"));
assert.ok(childTemplate.includes("source_catalog"));

console.log("contract.test: PASS");

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

for (const label of ["Child Webs", "Sources", "Logs", "Cloudflare", "Cloudinary"]) {
  assert.ok(html.includes(label), "Master UI missing " + label);
}
assert.ok(js.includes("/api/admin/children/preflight"));
assert.ok(js.includes("/api/admin/children"));
assert.ok(html.includes("Copy URL + Password"));

for (const table of ["sources","children","child_infra","child_sources","child_settings","admin_sessions","child_sessions","deployment_jobs","audit_logs"]) {
  assert.ok(schema.includes("CREATE TABLE IF NOT EXISTS " + table), "schema missing " + table);
}
console.log("contract.test: PASS");


assert.equal((routerSource.match(/datetime\(expires_at\) > CURRENT_TIMESTAMP/g) || []).length, 2);
assert.ok(routerSource.includes("settings_decrypt_failed"));
assert.ok(routerSource.includes("if (uploaded) await deleteChildWorker"));
console.log("session/crypto/rollback hardening contract: PASS");

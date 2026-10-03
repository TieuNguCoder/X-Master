import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import master, { __test } from "../src/index.js";
import { encryptJson, decryptJson, hmacHex } from "../src/security.js";

import { fixture, cfError, response } from "./lifecycle-fixture.mjs";

test("pause disables actual Workers and resume restores original triggers without changing private data", async t => {
  const f = await fixture(t);
  const original = f.managed().map(s => structuredClone(s));
  const paused = await __test.childWorkers.changeStatus(f.env, f.admin, f.childId, "paused");
  assert.equal(paused.verified, true);
  assert.equal(paused.worker_count, 6);
  for (const script of f.managed()) {
    assert.equal(script.enabled, false);
    assert.equal(script.previews_enabled, false);
    assert.deepEqual(script.schedules, []);
  }
  assert.equal(f.row("SELECT status FROM children").status, "paused");
  assert.equal(f.row("SELECT status FROM ingest_account_routes").status, "failed");
  assert.equal(f.row("SELECT encrypted_json FROM child_infra").encrypted_json, f.savedInfra);
  assert.equal(f.row("SELECT encrypted_json FROM x_accounts").encrypted_json, f.savedAccount);
  assert.equal(f.count("child_sessions"), 1);
  await __test.childWorkers.changeStatus(f.env, f.admin, f.childId, "ready");
  assert.deepEqual(f.managed(), original);
  assert.equal(f.row("SELECT verified_status FROM child_lifecycle").verified_status, "ready");
  assert.equal(f.row("SELECT snapshots_json FROM child_lifecycle").snapshots_json, "{}");
});

test("a failed pause remains visible and a retry keeps the first trigger snapshot", async t => {
  const f = await fixture(t);
  const original = f.managed().map(s => structuredClone(s));
  f.http.hook = c => c.name?.includes("-r2-") && c.suffix === "/schedules" && c.method === "PUT"
    ? cfError(403, 10000) : null;
  await assert.rejects(__test.childWorkers.changeStatus(f.env, f.admin, f.childId, "paused"), /cloudflare/);
  assert.equal(f.row("SELECT status FROM children").status, "paused");
  assert.ok(f.row("SELECT last_error FROM children").last_error);
  assert.equal(f.row("SELECT verified_status FROM child_lifecycle").verified_status, null);
  f.http.hook = null;
  await __test.childWorkers.changeStatus(f.env, f.admin, f.childId, "paused");
  await __test.childWorkers.changeStatus(f.env, f.admin, f.childId, "ready");
  assert.deepEqual(f.managed(), original);
});

test("verified deletion removes six scripts and cascades only the selected User's private data", async t => {
  const f = await fixture(t);
  f.insert("INSERT INTO children(id,name,slug,status,password_hash,child_secret_hash) VALUES('ch_other','Other','other','ready','hash','secret')");
  f.insert("INSERT INTO child_sources(child_id,source_id) VALUES('ch_other','s_shared')");
  const result = await __test.childWorkers.remove(f.env, f.admin, f.childId);
  assert.equal(result.verified, true);
  assert.equal(result.workers.filter(w => w.deleted).length, 6);
  assert.equal(f.managed().length, 0);
  for (const table of ["child_infra", "child_settings", "child_sessions", "x_accounts", "child_router_slots", "x_account_sources", "ingest_account_routes", "child_lifecycle"]) {
    assert.equal(f.count(table), 0, table + " must be physically cleared");
  }
  assert.equal(f.count("sources"), 1);
  assert.equal(f.count("ingest_events"), 1);
  assert.equal(f.count("child_sources"), 1);
  assert.equal(f.row("SELECT id FROM children").id, "ch_other");
  assert.equal(f.row("SELECT child_id FROM deployment_jobs").child_id, null);
  assert.equal(f.count("audit_logs"), 1);
  assert.equal(f.scripts.size, 2);
  assert.ok(f.scripts.has(f.env.CF_ACCOUNT_ID + "/x-master-router"));
  assert.ok(f.scripts.has(f.env.CF_ACCOUNT_ID + "/tieungummo-demo"));
  assert.ok(f.calls.filter(c => c.method === "DELETE").every(c => !c.url.includes("force")));
  f.insert("INSERT INTO children(id,name,slug,status,password_hash,child_secret_hash) VALUES('ch_new','Fresh','tester','provisioning','hash','secret')");
});

test("permission failure after a partial deletion retains data and supports verified retry", async t => {
  const f = await fixture(t);
  f.http.hook = c => c.method === "DELETE" && c.name?.includes("-r2-") ? cfError(403, 10000) : null;
  await assert.rejects(__test.childWorkers.remove(f.env, f.admin, f.childId), /cloudflare/);
  assert.equal(f.count("children"), 1);
  assert.equal(f.count("x_accounts"), 1);
  assert.equal(f.count("child_router_slots"), 5);
  assert.equal(f.row("SELECT status FROM children").status, "paused");
  assert.ok(f.row("SELECT last_error FROM children").last_error);
  assert.equal(f.row("SELECT action FROM audit_logs").action, "child.delete_failed");
  f.http.hook = null;
  const result = await __test.childWorkers.remove(f.env, f.admin, f.childId);
  assert.equal(result.workers.filter(w => w.already_missing).length, 1);
  assert.equal(f.count("children"), 0);
  assert.equal(f.managed().length, 0);
});

for (const [label, status, code] of [["generic 404", 404, 99999], ["access denied with a misleading code", 403, 10007], ["server error", 503, 10007]]) {
  test(label + " never counts as proof of deletion", async t => {
    const f = await fixture(t);
    f.http.hook = c => c.suffix === "/settings" && c.name?.includes("-r3-") ? cfError(status, code) : null;
    await assert.rejects(__test.childWorkers.remove(f.env, f.admin, f.childId), /cloudflare/);
    assert.equal(f.count("children"), 1);
    assert.equal(f.calls.filter(c => c.method === "DELETE").length, 0);
    assert.equal(f.row("SELECT verified_status FROM child_lifecycle").verified_status, null);
  });
}

test("a successful DELETE response is insufficient if the script still exists", async t => {
  const f = await fixture(t);
  f.http.hook = c => c.method === "DELETE" ? new Response(null, { status: 204 }) : null;
  await assert.rejects(__test.childWorkers.remove(f.env, f.admin, f.childId), /worker_delete_unverified/);
  assert.equal(f.managed().length, 6);
  assert.equal(f.count("child_infra"), 1);
  assert.equal(f.count("children"), 1);
});

test("ownership of every script is checked before the first deletion", async t => {
  const f = await fixture(t);
  f.scripts.get(f.rootAccount + "/" + f.root).bindings[0].text = "ch_someone_else";
  await assert.rejects(__test.childWorkers.remove(f.env, f.admin, f.childId), /worker_ownership_mismatch/);
  assert.equal(f.calls.filter(c => c.method === "DELETE").length, 0);
  assert.equal(f.count("children"), 1);
});

test("legacy User Web credentials and URL-derived names are used alongside Master's router credentials", async t => {
  const f = await fixture(t, { legacy: true });
  f.insert("UPDATE children SET worker_name=NULL WHERE id=?", f.childId);
  await __test.childWorkers.remove(f.env, f.admin, f.childId);
  const deletes = f.calls.filter(c => c.method === "DELETE");
  assert.equal(deletes.find(c => c.name === f.root).account, f.rootAccount);
  assert.equal(deletes.filter(c => c.account === f.env.CF_ACCOUNT_ID).length, 5);
  assert.equal(f.count("children"), 0);
});

test("a wrong Cloudflare account cannot be mistaken for already deleted Workers", async t => {
  const f = await fixture(t, { legacy: true });
  f.insert("UPDATE children SET web_url=? WHERE id=?", "https://" + f.root + ".wrong-sub.workers.dev", f.childId);
  await assert.rejects(__test.childWorkers.remove(f.env, f.admin, f.childId), /worker_cloudflare_account_mismatch/);
  assert.equal(f.calls.filter(c => c.method === "DELETE").length, 0);
  assert.equal(f.count("child_infra"), 1);
});

test("old records with confirmed missing scripts can be cleaned up idempotently", async t => {
  const f = await fixture(t, { status: "paused" });
  f.scripts.delete(f.rootAccount + "/" + f.root);
  f.scripts.delete(f.env.CF_ACCOUNT_ID + "/xmr-tester-r2-000001");
  const inspect = await __test.childWorkers.inspect(f.env, f.childId);
  assert.equal(inspect.workers.filter(w => !w.exists).length, 2);
  await assert.rejects(__test.childWorkers.changeStatus(f.env, f.admin, f.childId, "ready"), /worker_missing/);
  const result = await __test.childWorkers.remove(f.env, f.admin, f.childId);
  assert.equal(result.workers.filter(w => w.already_missing).length, 2);
  assert.equal(f.count("children"), 0);
});

test("concurrent pause, delete and update are serialized for the same User", async t => {
  const f = await fixture(t);
  let entered, unblock;
  const pending = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  f.http.hook = async c => { if (c.method === "DELETE") { entered(); await gate; } };
  const deleting = __test.childWorkers.remove(f.env, f.admin, f.childId);
  await pending;
  try {
    await assert.rejects(__test.childWorkers.changeStatus(f.env, f.admin, f.childId, "ready"), /child_operation_in_progress/);
    await assert.rejects(__test.childWorkers.remove(f.env, f.admin, f.childId), /child_operation_in_progress/);
    await assert.rejects(__test.updateChildWorkerCode(f.env, new Request("https://master.example"), f.admin, f.childId), /child_operation_in_progress/);
  } finally { unblock(); }
  await deleting;
  assert.equal(f.calls.filter(c => c.method === "DELETE").length, 6);
});

test("an operation that loses its lease cannot change the new operation's state", async t => {
  const f = await fixture(t);
  f.http.hook = c => {
    if (c.name?.includes("-r2-") && c.method === "POST") {
      f.insert("UPDATE child_lifecycle SET operation_id='new-operation',lease_expires_at='2099-01-01'");
      f.insert("UPDATE children SET status='ready'");
    }
  };
  await assert.rejects(__test.childWorkers.changeStatus(f.env, f.admin, f.childId, "paused"), /child_operation_lease_lost/);
  assert.equal(f.row("SELECT status FROM children").status, "ready");
  assert.equal(f.row("SELECT operation_id FROM child_lifecycle").operation_id, "new-operation");
});

test("upgrading a paused legacy User preserves its account, private keys and paused state", async t => {
  const f = await fixture(t, { legacy: true });
  await __test.childWorkers.changeStatus(f.env, f.admin, f.childId, "paused");
  const result = await __test.updateChildWorkerCode(f.env, new Request("https://master.example/api/admin/children/" + f.childId + "/update-code"), f.admin, f.childId);
  assert.equal(result.child.status, "paused");
  assert.equal(result.verified, true);
  for (const script of f.managed()) {
    assert.equal(script.enabled, false);
    assert.equal(script.previews_enabled, false);
    assert.deepEqual(script.schedules, []);
  }
  assert.equal(f.calls.find(c => c.name === f.root && c.method === "PUT").account, f.rootAccount);
  const infra = await decryptJson(f.env.MASTER_KEY, f.row("SELECT encrypted_json FROM child_infra").encrypted_json);
  assert.equal(infra.cloudflare_account_id, f.rootAccount);
  assert.equal(infra.child_secret, "child-secret");
  assert.equal(f.row("SELECT encrypted_json FROM x_accounts").encrypted_json, f.savedAccount);
  assert.equal(f.scripts.get(f.rootAccount + "/" + f.root).bindings.some(b => b.name === "MASTER"), false,
    "service bindings must not point to a Worker in another Cloudflare account");
});

test("upgrading a ready User restores its original Cron and intentionally disabled router", async t => {
  const f = await fixture(t);
  const original = f.managed().map(s => ({ name: s.name, enabled: s.enabled, schedules: s.schedules }));
  await __test.updateChildWorkerCode(f.env, new Request("https://master.example/update"), f.admin, f.childId);
  assert.equal(f.row("SELECT status FROM children").status, "ready");
  assert.deepEqual(f.managed().map(s => ({ name: s.name, enabled: s.enabled, schedules: s.schedules })), original);
});

test("an update failure blocks posting and cleans up newly enabled triggers", async t => {
  const f = await fixture(t);
  f.http.hook = c => c.name?.includes("-r3-") && c.method === "PUT" && !c.suffix ? cfError(503, 10000) : null;
  await assert.rejects(__test.updateChildWorkerCode(f.env, new Request("https://master.example/update"), f.admin, f.childId), /cloudflare/);
  assert.equal(f.row("SELECT status FROM children").status, "paused");
  assert.ok(f.row("SELECT last_error FROM children").last_error);
  assert.ok(f.managed().every(s => !s.enabled && !s.previews_enabled && !s.schedules.length));
});

test("Collector jobs and admin test posts cannot publish for a paused User", async t => {
  const f = await fixture(t, { status: "paused" });
  await assert.rejects(__test.internalRouterProcess(f.env, f.routerRequest("process", { text: "News" })), /x_account_or_child_paused/);
  f.insert("UPDATE ingest_account_routes SET status='local_ai_pending'");
  await assert.rejects(__test.internalRouterPublish(f.env, f.routerRequest("publish", { output: "News" })), /x_account_or_child_paused/);
  await assert.rejects(__test.adminTestFullPipeline(f.env, f.admin, f.accountId), /x_account_or_child_paused/);
  await assert.rejects(__test.adminTestXAccount(f.env, f.admin, f.accountId), /x_account_or_child_paused/);
  assert.equal(f.calls.length, 0);
});

test("pausing during AI generation prevents the subsequent Buffer request", async t => {
  const f = await fixture(t);
  f.http.hook = c => { if (c.url.includes("api.deepseek.com")) f.insert("UPDATE children SET status='paused'"); };
  const result = await __test.internalRouterProcess(f.env, f.routerRequest("process", { text: "A news update" }));
  assert.equal(result.posted, false);
  assert.match(result.error, /x_account_or_child_paused/);
  assert.equal(f.calls.filter(c => c.url.includes("api.buffer.com")).length, 0);
  assert.equal(f.row("SELECT status FROM ingest_account_routes").status, "failed");
});

test("a ready User can still process and post through its account router", async t => {
  const f = await fixture(t);
  const result = await __test.internalRouterProcess(f.env, f.routerRequest("process", { text: "A news update" }));
  assert.equal(result.posted, true);
  assert.equal(f.calls.filter(c => c.url.includes("api.buffer.com")).length, 1);
  assert.equal(f.row("SELECT status FROM ingest_account_routes").status, "posted");
});

test("network timeout retains the User and credentials for retry", async t => {
  const f = await fixture(t);
  f.http.hook = c => { if (c.method === "DELETE") throw new DOMException("Timed out", "TimeoutError"); };
  await assert.rejects(__test.childWorkers.remove(f.env, f.admin, f.childId), /Timed out/);
  assert.equal(f.count("children"), 1);
  assert.equal(f.count("child_infra"), 1);
  assert.equal(f.row("SELECT verified_status FROM child_lifecycle").verified_status, null);
});

test("database cleanup failure keeps private data and never writes a success audit", async t => {
  const f = await fixture(t);
  f.env.DB.failDelete = true;
  await assert.rejects(__test.childWorkers.remove(f.env, f.admin, f.childId), /simulated_d1_failure/);
  assert.equal(f.managed().length, 0);
  assert.equal(f.count("children"), 1);
  assert.equal(f.count("x_accounts"), 1);
  assert.equal(f.row("SELECT action FROM audit_logs").action, "child.delete_failed");
  f.env.DB.failDelete = false;
  const result = await __test.childWorkers.remove(f.env, f.admin, f.childId);
  assert.equal(result.workers.filter(w => w.already_missing).length, 6);
  assert.equal(f.count("children"), 0);
});

test("the Cloudflare inspection endpoint requires an Owner session and returns no secrets", async t => {
  const f = await fixture(t);
  const url = "https://master.example/api/admin/children/" + f.childId + "/cloudflare-status";
  const unauthorized = await master.fetch(new Request(url), f.env, {});
  assert.equal(unauthorized.status, 401);
  f.insert("INSERT INTO admin_sessions(id,token_hash,expires_at) VALUES(?,?,?)",
    "as_owner", await hmacHex(f.env.SESSION_PEPPER, "admin-cookie"), "2099-01-01");
  const authorized = await master.fetch(new Request(url, { headers: { cookie: "xm_admin=admin-cookie" } }), f.env, {});
  assert.equal(authorized.status, 200);
  const body = await authorized.text();
  assert.equal(JSON.parse(body).workers.length, 6);
  assert.ok(!body.includes("secret") && !body.includes("api_token") && !body.includes("bindings"));
});

test("missing preview state cannot be reported as a verified Cloudflare pause", async t => {
  const f = await fixture(t);
  f.http.hook = c => c.method === "GET" && c.suffix === "/subdomain" ? response({ enabled: true }) : null;
  await assert.rejects(__test.childWorkers.changeStatus(f.env, f.admin, f.childId, "paused"), /worker_state_unverifiable/);
  assert.equal(f.row("SELECT verified_status FROM child_lifecycle").verified_status, null);
  assert.equal(f.calls.filter(c => c.method === "POST" || c.method === "PUT").length, 0);
});

test("an upgrade cannot overwrite data or resume a User after losing its operation lease", async t => {
  const f = await fixture(t);
  f.http.hook = c => {
    if (c.name === f.root && c.method === "PUT" && !c.suffix) {
      f.insert("UPDATE child_lifecycle SET operation_id='new-operation',lease_expires_at='2099-01-01'");
    }
  };
  await assert.rejects(__test.updateChildWorkerCode(f.env, new Request("https://master.example/update"), f.admin, f.childId), /child_operation_lease_lost/);
  assert.equal(f.row("SELECT operation_id FROM child_lifecycle").operation_id, "new-operation");
  assert.equal(f.row("SELECT encrypted_json FROM child_infra").encrypted_json, f.savedInfra);
  assert.equal(f.calls.filter(c => c.name === f.root && c.method === "POST").length, 1,
    "only the earlier pause may change the public subdomain");
});

function dashboard(child, deleteResponse) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: "", innerHTML: "", classList: { add() {}, remove() {}, toggle() {} }
    });
    return elements.get(selector);
  };
  const context = createContext({
    document: { querySelector: element, querySelectorAll: () => [] },
    setTimeout: () => 0, clearTimeout() {}, confirm: () => true, URL,
    fetch: async (url, init) => init?.method === "DELETE"
      ? deleteResponse
      : new Response(JSON.stringify({ children: [child], sources: [] }), { status: 200 })
  });
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8")
    .replace(/\nhealth\(\);refresh\(\)\.catch\(\(\)=>showLogin\(\)\);\s*$/, "");
  runInContext(source, context);
  runInContext("state.children=" + JSON.stringify([child]) + ";renderChildren();", context);
  return { context, element };
}

test("dashboard shows inherited pauses and keeps the User visible when Cloudflare deletion fails", async () => {
  const child = { id: "ch_ui", name: "Tester", slug: "tester", status: "paused",
    last_error: "Cloudflare <permission denied>", router_slots: [],
    accounts: [{ id: "xa_ui", display_name: "Test X", enabled: 1 }] };
  const ui = dashboard(child, new Response(JSON.stringify({ error: "cloudflare:permission denied" }), { status: 502 }));
  const before = ui.element("#childrenList").innerHTML;
  assert.ok(before.includes("PAUSED") && !before.includes("RUNNING"));
  assert.ok(before.includes("Dừng trên Cloudflare"));
  assert.ok(before.includes("&lt;permission denied&gt;"));
  await runInContext("deleteChild('ch_ui')", ui.context);
  assert.ok(ui.element("#childrenList").innerHTML.includes("Tester"));
  assert.match(ui.element("#toast").textContent, /Xóa chưa hoàn tất/);
  assert.match(ui.element("#toast").textContent, /permission denied/);
});

test("dashboard rejects an unverified deletion response", async () => {
  const ui = dashboard({ id: "ch_ui", name: "Tester", slug: "tester", status: "paused", router_slots: [] },
    new Response(JSON.stringify({ deleted: true }), { status: 200 }));
  await runInContext("deleteChild('ch_ui')", ui.context);
  assert.match(ui.element("#toast").textContent, /Chưa xác minh/);
});


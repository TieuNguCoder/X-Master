import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { encryptJson, hmacHex } from "../src/security.js";
// Execute the actual schema and lifecycle queries, including foreign-key
// cascades and atomic batches. Only Cloudflare/AI/Buffer HTTP is simulated.
function d1(sqlite) {
  return {
    failDelete: false,
    prepare(sql) {
      const db = this;
      function bound(values = []) {
        const statement = sqlite.prepare(sql);
        const runSync = () => {
          if (db.failDelete && sql.startsWith("DELETE FROM children")) throw new Error("simulated_d1_failure");
          const result = statement.run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        };
        return {
          bind: (...next) => bound(next), runSync,
          run: async () => runSync(),
          first: async () => statement.get(...values) || null,
          all: async () => ({ results: statement.all(...values) })
        };
      }
      return bound();
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = statements.map(s => s.runSync());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

export function response(result, status = 200) {
  return new Response(JSON.stringify({ success: true, result }), { status });
}
export function cfError(status, code, message = "Cloudflare denied operation") {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status });
}

export async function fixture(t, { legacy = false, status = "ready" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = {
    DB: d1(sqlite), MASTER_KEY: "test-master-key", SESSION_PEPPER: "test-pepper",
    CF_ACCOUNT_ID: "master-account-123456", CF_API_TOKEN: "master-token-12345678901234567890",
    ADMIN_PASSWORD_HASH: "unused-hash", COLLECTOR_SECRET: "collector-test"
  };
  const childId = "ch_000001";
  const root = "xm-tester-000001";
  const accountId = "xa_1";
  const rootAccount = legacy ? "legacy-account-123456" : env.CF_ACCOUNT_ID;
  const accounts = new Map([
    [env.CF_ACCOUNT_ID, { subdomain: "master-sub", token: env.CF_API_TOKEN }],
    ["legacy-account-123456", { subdomain: "legacy-sub", token: "legacy-token-12345678901234567890" }]
  ]);
  const rootUrl = "https://" + root + "." + accounts.get(rootAccount).subdomain + ".workers.dev";
  const savedInfra = await encryptJson(env.MASTER_KEY, {
    cloudinary_cloud_name: "test-cloud", cloudinary_api_key: "test-cloud-key",
    cloudinary_api_secret: "test-cloud-secret", child_secret: "child-secret",
    ...(legacy ? { cloudflare_account_id: rootAccount, cloudflare_api_token: accounts.get(rootAccount).token } : {})
  });
  const savedAccount = await encryptJson(env.MASTER_KEY, {
    ai_provider: "deepseek_paid", deepseek_api_key: "test-deepseek-key", buffer_api_key: "test-buffer-key"
  });
  const insert = (sql, ...values) => sqlite.prepare(sql).run(...values);
  insert("INSERT INTO children(id,name,slug,status,password_hash,child_secret_hash,worker_name,web_url) VALUES(?,?,?,?,?,?,?,?)",
    childId, "Tester", "tester", status, "password-hash", await hmacHex(env.SESSION_PEPPER, "child-secret"), root, rootUrl);
  insert("INSERT INTO child_infra(child_id,encrypted_json) VALUES(?,?)", childId, savedInfra);
  insert("INSERT INTO sources(id,title,username) VALUES('s_shared','Shared channel','shared')");
  insert("INSERT INTO child_sources(child_id,source_id) VALUES(?,'s_shared')", childId);
  insert("INSERT INTO child_settings(child_id,encrypted_json) VALUES(?,?)", childId, savedAccount);
  insert("INSERT INTO child_sessions(id,child_id,token_hash,expires_at) VALUES('cs_1',?,'session-hash','2099-01-01')", childId);
  insert("INSERT INTO x_accounts(id,child_id,display_name,encrypted_json,buffer_channel_id) VALUES(?,?,?,?,?)",
    accountId, childId, "Test X", savedAccount, "buffer-channel");
  insert("INSERT INTO x_account_sources(account_id,source_id) VALUES(?,'s_shared')", accountId);
  insert("INSERT INTO ingest_events(id,source_id,external_id,text_content,routed_children_json) VALUES('ev_1','s_shared','telegram-1','Shared event',?)",
    JSON.stringify([childId]));
  insert("INSERT INTO ingest_account_routes(event_id,account_id,status) VALUES('ev_1',?,'router_pending')", accountId);
  insert("INSERT INTO deployment_jobs(id,child_id,action,status) VALUES('dj_1',?,'create','success')", childId);

  const scripts = new Map();
  const addScript = (account, name, bindings, enabled = true) => {
    const script = { account, name, bindings, enabled, previews_enabled: true, schedules: [{ cron: "*/10 * * * *" }] };
    scripts.set(account + "/" + name, script);
    return script;
  };
  addScript(rootAccount, root, [{ type: "plain_text", name: "CHILD_ID", text: childId }]);
  for (let i = 1; i <= 5; i++) {
    const slotId = "rs_" + i;
    const name = "xmr-tester-r" + i + "-000001";
    insert("INSERT INTO child_router_slots(id,child_id,slot_index,account_id,worker_name,web_url,router_secret_hash,encrypted_json,status) VALUES(?,?,?,?,?,?,?,?,?)",
      slotId, childId, i, i === 1 ? accountId : null, name,
      "https://" + name + ".master-sub.workers.dev", await hmacHex(env.SESSION_PEPPER, "router-secret"),
      await encryptJson(env.MASTER_KEY, { router_secret: "router-secret" }), i === 1 ? "assigned" : "ready");
    addScript(env.CF_ACCOUNT_ID, name, [
      { type: "plain_text", name: "CHILD_ID", text: childId },
      { type: "plain_text", name: "ROUTER_SLOT_ID", text: slotId }
    ], i !== 5);
  }
  // Unrelated Cloudflare resources must never be touched.
  addScript(env.CF_ACCOUNT_ID, "x-master-router", []);
  addScript(env.CF_ACCOUNT_ID, "tieungummo-demo", []);
  const domains = new Map();
  let domainSequence = 0;
  const calls = [];
  const http = { hook: null };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    const match = url.pathname.match(/^\/client\/v4\/accounts\/([^/]+)(\/.*)$/);
    const scriptMatch = match?.[2].match(/^\/workers\/scripts\/([^/]+)(\/.*)?$/);
    const call = { url: url.href, method, account: match?.[1], path: match?.[2], name: scriptMatch?.[1], suffix: scriptMatch?.[2] || "", init };
    calls.push(call);
    const custom = await http.hook?.(call);
    if (custom) return custom;
    if (url.hostname === "api.deepseek.com") return new Response(JSON.stringify({ choices: [{message:{content:"A rewritten news update #News #Update"}}] }));
    if (url.hostname === "api.cloudinary.com") return new Response(JSON.stringify({status:"ok"}));
    if (url.hostname === "api.buffer.com") {
      return new Response(JSON.stringify({ data: { createPost: { post: { id: "post-1", status: "sent" } } } }));
    }
    assert.equal(url.hostname, "api.cloudflare.com", "no live/external requests permitted");
    if (url.pathname === "/client/v4/zones") return response([{id:"zone-blog",name:"bemail2017.com",status:"active",account:{id:env.CF_ACCOUNT_ID}}]);
    assert.equal(init.headers.Authorization, "Bearer " + accounts.get(call.account)?.token);
    if (call.path === "/workers/subdomain") return response({ subdomain: accounts.get(call.account).subdomain });
    if (call.path === "/workers/domains") {
      if (method === "GET") return response([...domains.values()].filter(d => !url.searchParams.get("hostname") || d.hostname === url.searchParams.get("hostname")));
      if (method === "PUT") {
        const body=JSON.parse(init.body);
        const domain={...body,id:"domain-"+(++domainSequence),environment:"production"};
        domains.set(body.hostname,domain);return response(domain);
      }
    }
    if (call.path.startsWith("/workers/domains/") && method === "DELETE") {
      const id=call.path.split("/").at(-1);
      for(const [hostname,d] of domains)if(d.id===id)domains.delete(hostname);
      return response({});
    }
    if (call.path === "/workers/scripts" && method === "GET") return response([...scripts.values()].map(s=>({id:s.name})));
    if (!scriptMatch) throw new Error("unexpected API path: " + call.path);
    const key = call.account + "/" + call.name;
    if (method === "PUT" && !call.suffix) {
      const metadata = JSON.parse(await init.body.get("metadata").text());
      const script = scripts.get(key) || addScript(call.account, call.name, []);
      script.bindings = metadata.bindings;
      return response({});
    }
    const script = scripts.get(key);
    if (!script) return cfError(404, 10007, "This Worker does not exist on your account.");
    if (method === "DELETE" && !call.suffix) {
      scripts.delete(key);
      return new Response(null, { status: 204 });
    }
    if (call.suffix === "/settings" && method === "GET") return response({ bindings: script.bindings });
    if (call.suffix === "/subdomain") {
      if (method === "POST") Object.assign(script, JSON.parse(init.body));
      return response({ enabled: script.enabled, previews_enabled: script.previews_enabled });
    }
    if (call.suffix === "/schedules") {
      if (method === "PUT") script.schedules = JSON.parse(init.body);
      return response({ schedules: script.schedules });
    }
    throw new Error("unexpected request: " + call.path + " " + method);
  };
  t.after(() => { globalThis.fetch = originalFetch; sqlite.close(); });
  const row = sql => sqlite.prepare(sql).get();
  const count = table => Number(row("SELECT COUNT(*) AS n FROM " + table).n);
  const managed = () => [...scripts.values()].filter(s => s.bindings.some(b => b.name === "CHILD_ID" && b.text === childId));
  const routerRequest = (suffix, body) => new Request("https://master.example/internal/router/" + suffix, {
    method: "POST", headers: { "content-type": "application/json", "x-router-slot": "rs_1", "x-router-secret": "router-secret" },
    body: JSON.stringify({ event_id: "ev_1", account_id: accountId, ...body })
  });
  return { sqlite, env, childId, accountId, root, rootAccount, scripts, domains, calls, http, row, count, insert,
    managed, savedInfra, savedAccount, routerRequest, admin: { id: "as_owner" } };
}


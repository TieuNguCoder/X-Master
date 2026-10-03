import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import master, { __test } from "../src/index.js";
import { domainLabel } from "../src/child-domains.js";
import { decryptJson, hmacHex } from "../src/security.js";
import { fixture, cfError, response } from "./lifecycle-fixture.mjs";

async function setup(t, options) {
  const f = await fixture(t, options);
  await __test.domains.saveConfig(f.env, f.admin, { enabled: true, base_domain: "bemail2017.com" });
  f.assign = label => __test.childWorkers.withLock(f.env, f.childId, "domain", requestCF => __test.domains.assign(f.env, f.admin, f.childId, label, requestCF));
  f.patch = body => __test.updateChild(f.env, new Request("https://master.example/api/admin/children/" + f.childId, { method: "PATCH", body: JSON.stringify(body) }), f.admin, f.childId);
  return f;
}

test("only direct non-reserved DNS labels are accepted", () => {
  assert.equal(domainLabel(" Tester-01 "), "tester-01");
  for (const bad of ["", "www", "admin", "router", "admeo", "a.b", "*.abc", "https://a", "-bad", "bad-", "a".repeat(64), "a/b", "@", "tên"]) assert.throws(() => domainLabel(bad));
});

test("idempotent schema upgrade preserves old records and encrypted keys", async t => {
  const f = await fixture(t);
  const before = f.row("SELECT * FROM children");
  f.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  assert.deepEqual(f.row("SELECT * FROM children"), before);
  assert.equal(f.row("SELECT encrypted_json FROM child_infra").encrypted_json, f.savedInfra);
  assert.equal(f.count("x_accounts"), 1);
});

test("existing web gets a canonical domain idempotently without changing Worker or accounts", async t => {
  const f = await setup(t);
  await f.assign("tester01"); await f.assign("tester01");
  assert.equal(f.domains.get("tester01.bemail2017.com").service, f.root);
  assert.equal(f.row("SELECT web_url FROM children").web_url, "https://tester01.bemail2017.com");
  assert.equal(f.calls.filter(c => c.path === "/workers/domains" && c.method === "PUT").length, 1);
  assert.equal(f.row("SELECT encrypted_json FROM child_infra").encrypted_json, f.savedInfra);
  assert.equal(f.row("SELECT encrypted_json FROM x_accounts").encrypted_json, f.savedAccount);
  assert.equal(f.count("child_router_slots"), 5);
});

test("rename attaches replacement first and removes the old hostname", async t => {
  const f = await setup(t); await f.assign("old-name"); f.calls.length = 0;
  await f.assign("new-name");
  assert.equal(f.domains.has("old-name.bemail2017.com"), false);
  assert.equal(f.domains.has("new-name.bemail2017.com"), true);
  const put = f.calls.findIndex(c => c.method === "PUT");
  const del = f.calls.findIndex(c => c.method === "DELETE");
  assert.ok(put >= 0 && del > put);
  assert.equal(f.count("child_domains"), 1);
});

test("foreign Worker hostname collision is never overwritten", async t => {
  const f = await setup(t);
  f.domains.set("taken.bemail2017.com", { id: "foreign", hostname: "taken.bemail2017.com", service: "tieungummo-demo", zone_id: "zone-blog" });
  await assert.rejects(f.assign("taken"), /domain_ownership_conflict/);
  assert.equal(f.calls.some(c => ["PUT", "DELETE"].includes(c.method)), false);
  assert.equal(f.domains.get("taken.bemail2017.com").service, "tieungummo-demo");
  assert.equal(f.row("SELECT state FROM child_domains").state, "error");
});

test("a reservation owned by another child cannot be reused", async t => {
  const f = await setup(t);
  f.insert("INSERT INTO children(id,name,slug,status,password_hash,child_secret_hash) VALUES('ch_other','Other','other','ready','p','s')");
  f.insert("INSERT INTO child_domains(hostname,child_id,account_id,zone_id,worker_name,workers_dev_url) VALUES('taken.bemail2017.com','ch_other',?,'zone-blog','other-worker','https://other.sub.workers.dev')", f.env.CF_ACCOUNT_ID);
  await assert.rejects(f.assign("taken"), /subdomain_already_reserved/);
  assert.equal(f.calls.some(c => c.method === "PUT"), false);
});

test("an uncertain attach keeps its journal and retry adopts only the same Worker", async t => {
  const f = await setup(t);
  f.http.hook = c => {
    if(c.path === "/workers/domains" && c.method === "PUT") {
      const body=JSON.parse(c.init.body);f.domains.set(body.hostname,{...body,id:"partial-domain"});
      throw new Error("network response lost");
    }
  };
  await assert.rejects(f.assign("retry"), /response lost/);
  assert.equal(f.count("child_domains"), 1);
  f.http.hook=null;await f.assign("retry");
  assert.equal(f.row("SELECT domain_id FROM child_domains").domain_id,"partial-domain");
  assert.equal(f.count("children"),1);
});

test("rename cleanup failure is journaled and a retry removes the stale hostname", async t => {
  const f = await setup(t);await f.assign("old");
  f.http.hook=c=>c.method === "DELETE" ? cfError(403,10000) : null;
  await assert.rejects(f.assign("new"), /cloudflare/);
  assert.equal(f.count("child_domains"),2);
  assert.equal(f.row("SELECT web_url FROM children").web_url,"https://new.bemail2017.com");
  f.http.hook=null;await f.assign("new");assert.equal(f.count("child_domains"),1);
});

test("pause detaches custom domain, resume recreates it with a new ID, code upgrade keeps URL", async t => {
  const f=await setup(t);await f.assign("tester");const oldId=f.domains.get("tester.bemail2017.com").id;
  await __test.childWorkers.changeStatus(f.env,f.admin,f.childId,"paused");
  assert.equal(f.domains.size,0);assert.equal(f.row("SELECT state FROM child_domains").state,"suspended");
  await __test.childWorkers.changeStatus(f.env,f.admin,f.childId,"ready");
  assert.notEqual(f.domains.get("tester.bemail2017.com").id,oldId);
  const updated=await __test.updateChildWorkerCode(f.env,new Request("https://master.example/update"),f.admin,f.childId);
  assert.equal(updated.child.web_url,"https://tester.bemail2017.com");
  assert.equal(f.count("x_accounts"),1);
});

test("assigning a domain to a paused web does not expose it", async t => {
  const f=await setup(t);await __test.childWorkers.changeStatus(f.env,f.admin,f.childId,"paused");
  await f.assign("paused");assert.equal(f.domains.size,0);
  await __test.childWorkers.changeStatus(f.env,f.admin,f.childId,"ready");
  assert.equal(f.domains.has("paused.bemail2017.com"),true);
});

test("delete detaches domains before deleting scripts and cascading private data", async t => {
  const f=await setup(t);await f.assign("remove");f.calls.length=0;
  await __test.childWorkers.remove(f.env,f.admin,f.childId);
  const deletes=f.calls.filter(c=>c.method === "DELETE");
  assert.match(deletes[0].path,/\/workers\/domains\//);
  assert.equal(f.domains.size,0);assert.equal(f.managed().length,0);
  assert.equal(f.count("child_domains"),0);assert.equal(f.count("children"),0);
  assert.equal(f.count("sources"),1);
  assert.ok(f.scripts.has(f.env.CF_ACCOUNT_ID+"/tieungummo-demo"));
});

for(const mode of ["denied","false-success"]) test("domain detach "+mode+" prevents Worker and DB deletion",async t=>{
  const f=await setup(t);await f.assign("keep");
  f.http.hook=c=>c.path.startsWith("/workers/domains/") && c.method === "DELETE" ? mode === "denied"?cfError(403,10000):response({}) : null;
  await assert.rejects(__test.childWorkers.remove(f.env,f.admin,f.childId),/cloudflare|domain_delete_not_verified/);
  assert.equal(f.count("children"),1);assert.equal(f.count("x_accounts"),1);assert.equal(f.managed().length,6);
  f.http.hook=null;await __test.childWorkers.remove(f.env,f.admin,f.childId);assert.equal(f.count("children"),0);
});

test("changed domain ownership or immutable ID blocks deletion",async t=>{
  const f=await setup(t);await f.assign("keep");f.domains.get("keep.bemail2017.com").id="replacement-id";
  await assert.rejects(__test.childWorkers.remove(f.env,f.admin,f.childId),/domain_ownership_conflict/);
  assert.equal(f.calls.some(c=>c.method === "DELETE"),false);
  assert.equal(f.count("children"),1);
});

test("database failure after external cleanup preserves journal for idempotent retry",async t=>{
  const f=await setup(t);await f.assign("remove");f.env.DB.failDelete=true;
  await assert.rejects(__test.childWorkers.remove(f.env,f.admin,f.childId),/simulated_d1_failure/);
  assert.equal(f.domains.size,0);assert.equal(f.count("child_domains"),1);
  f.env.DB.failDelete=false;await __test.childWorkers.remove(f.env,f.admin,f.childId);assert.equal(f.count("children"),0);
});

test("legacy web in another Cloudflare account is preserved with an actionable domain error",async t=>{
  const f=await setup(t,{legacy:true});await assert.rejects(f.assign("legacy"),/legacy_worker_in_other_account/);
  assert.equal(f.calls.some(c=>["PUT","DELETE"].includes(c.method)),false);
  assert.equal(f.row("SELECT encrypted_json FROM child_infra").encrypted_json,f.savedInfra);
});

test("master edits existing profile and credentials without replacing user data or Worker",async t=>{
  const f=await setup(t,{legacy:true});
  await f.patch({name:"New name",cloudinary:{cloudinary_cloud_name:"new-cloud",cloudinary_api_key:"new-cloud-key",cloudinary_api_secret:"new-cloud-secret"},deepseek_api_key:"new-deepseek-key"});
  const stored=await decryptJson(f.env.MASTER_KEY,f.row("SELECT encrypted_json FROM child_infra").encrypted_json);
  assert.equal(stored.child_secret,"child-secret");assert.equal(stored.cloudflare_account_id,"legacy-account-123456");
  assert.equal(stored.cloudinary_cloud_name,"new-cloud");assert.equal(f.row("SELECT name FROM children").name,"New name");
  assert.equal(f.row("SELECT worker_name FROM children").worker_name,f.root);
  assert.equal(f.row("SELECT encrypted_json FROM x_accounts").encrypted_json,f.savedAccount);
  const ai=await decryptJson(f.env.MASTER_KEY,f.row("SELECT encrypted_json FROM child_settings").encrypted_json);
  assert.equal(ai.deepseek_api_key,"new-deepseek-key");
  assert.ok(!JSON.stringify(f.sqlite.prepare("SELECT * FROM audit_logs").all()).includes("new-deepseek-key"));
});

test("disabled auto-domain configuration leaves existing domains intact",async t=>{
  const f=await setup(t);await f.assign("existing");
  await __test.domains.saveConfig(f.env,f.admin,{enabled:false,base_domain:"bemail2017.com"});
  assert.equal(f.domains.size,1);await assert.rejects(f.assign("next"),/automatic_domains_disabled/);
  await __test.childWorkers.remove(f.env,f.admin,f.childId);assert.equal(f.domains.size,0);
});

test("domain and profile mutations require Owner auth and same-origin requests",async t=>{
  const f=await setup(t);
  for(const [path,method] of [["/api/admin/domain-settings","PUT"],["/api/admin/children/"+f.childId,"PATCH"],["/api/admin/children/"+f.childId+"/sync-domain","POST"]]){
    const result=await master.fetch(new Request("https://master.example"+path,{method,headers:{origin:"https://master.example","content-type":"application/json"},body:"{}"}),f.env,{});
    assert.equal(result.status,401);
  }
  const hash=await hmacHex(f.env.SESSION_PEPPER,"owner-token");
  f.insert("INSERT INTO admin_sessions(id,token_hash,expires_at) VALUES('admin-test',?,'2099-01-01')",hash);
  const result=await master.fetch(new Request("https://master.example/api/admin/domain-settings",{method:"PUT",headers:{cookie:"xm_admin=owner-token",origin:"https://evil.example"},body:JSON.stringify({enabled:false,base_domain:"bemail2017.com"})}),f.env,{});
  assert.equal(result.status,403);
});

test("new child provisions six Workers and auto domain in one request",async t=>{
  const f=await setup(t);
  const request=new Request("https://master.example/api/admin/children",{method:"POST",body:JSON.stringify({name:"New user",password:"test-password",subdomain:"new-user",cloudinary_cloud_name:"cloud",cloudinary_api_key:"cloud-key",cloudinary_api_secret:"cloud-secret"})});
  const result=await __test.createChild(f.env,request,f.admin);
  assert.equal(result.warning,null);assert.equal(result.child.web_url,"https://new-user.bemail2017.com");
  assert.equal(result.child.router_slots.length,5);assert.equal(f.count("children"),2);
  assert.equal(f.domains.get("new-user.bemail2017.com").service,result.child.worker_name);
});

test("failed new domain creation keeps the functional child and exposes a retry warning",async t=>{
  const f=await setup(t);f.http.hook=c=>c.path === "/workers/domains" && c.method === "PUT"?cfError(403,10000):null;
  const request=new Request("https://master.example/api/admin/children",{method:"POST",body:JSON.stringify({name:"New user",password:"test-password",cloudinary_cloud_name:"cloud",cloudinary_api_key:"cloud-key",cloudinary_api_secret:"cloud-secret"})});
  const result=await __test.createChild(f.env,request,f.admin);
  assert.match(result.warning,/cloudflare/);assert.match(result.child.web_url,/\.workers.dev$/);
  assert.equal(f.count("children"),2);assert.equal(f.count("child_domains"),1);
});

test("partial provisioning keeps every Worker name and credential recoverable",async t=>{
  const f=await setup(t);f.http.hook=c=>c.name?.includes("-r3-") && c.method === "PUT"?cfError(403,10000):null;
  const request=new Request("https://master.example/api/admin/children",{method:"POST",body:JSON.stringify({name:"Partial",password:"test-password",cloudinary_cloud_name:"cloud",cloudinary_api_key:"cloud-key",cloudinary_api_secret:"cloud-secret"})});
  await assert.rejects(__test.createChild(f.env,request,f.admin),/cloudflare/);
  const partial=f.row("SELECT * FROM children WHERE name='Partial'");
  assert.equal(partial.status,"error");assert.ok(partial.worker_name);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM child_router_slots WHERE child_id=?").get(partial.id).n,3);
  assert.equal(f.calls.some(c=>c.method === "DELETE"),false);
});

test("Owner can edit an X account through Master without exposing or losing its Buffer key",async t=>{
  const f=await setup(t);
  const hash=await hmacHex(f.env.SESSION_PEPPER,"owner-token");
  f.insert("INSERT INTO admin_sessions(id,token_hash,expires_at) VALUES('admin-test',?,'2099-01-01')",hash);
  const call=(childId,accountId,body)=>master.fetch(new Request("https://master.example/api/admin/children/"+childId+"/accounts/"+accountId,{method:"PATCH",headers:{cookie:"xm_admin=owner-token",origin:"https://master.example","content-type":"application/json"},body:JSON.stringify(body)}),f.env,{});
  const result=await call(f.childId,f.accountId,{display_name:"Edited by Owner",enabled:false,content_mode:"airdrop",source_ids:[]});
  assert.equal(result.status,200);const body=await result.json();assert.equal(body.account.enabled,false);
  assert.equal(body.account.content_mode,"airdrop");assert.equal(body.account.source_ids.length,0);
  assert.ok(!JSON.stringify(body).includes("test-buffer-key"));
  const stored=await decryptJson(f.env.MASTER_KEY,f.row("SELECT encrypted_json FROM x_accounts").encrypted_json);
  assert.equal(stored.buffer_api_key,"test-buffer-key");
  assert.equal(f.row("SELECT actor_type FROM audit_logs WHERE action='x_account.updated'").actor_type,"admin");
  const foreign=await call(f.childId,"other-account",{display_name:"Wrong"});assert.equal(foreign.status,404);
});

test("old web with missing worker_name upgrades its URL-derived Worker in place",async t=>{
  const f=await setup(t,{legacy:true});f.insert("UPDATE children SET worker_name=NULL");
  await __test.updateChildWorkerCode(f.env,new Request("https://master.example/update"),f.admin,f.childId);
  assert.equal(f.row("SELECT worker_name FROM children").worker_name,f.root);
  assert.equal(f.managed().length,6);
});

test("failed zone verification does not overwrite the previous valid domain configuration",async t=>{
  const f=await setup(t);f.http.hook=c=>c.url.includes("/client/v4/zones?")?cfError(403,10000):null;
  await assert.rejects(__test.domains.saveConfig(f.env,f.admin,{enabled:true,base_domain:"other.com"}),/domain_zone_read_failed/);
  assert.equal((await __test.domains.config(f.env)).base_domain,"bemail2017.com");
});

test("a domain operation and deletion cannot run concurrently for the same child",async t=>{
  const f=await setup(t);let entered,unblock;const started=new Promise(r=>entered=r),barrier=new Promise(r=>unblock=r);
  f.http.hook=async c=>{if(c.path === "/workers/domains" && c.method === "PUT"){entered();await barrier;}};
  const attaching=f.assign("locked");await started;
  try{await assert.rejects(__test.childWorkers.remove(f.env,f.admin,f.childId),/child_operation_in_progress/);}
  finally{unblock();await attaching;}
  assert.equal(f.count("children"),1);assert.equal(f.domains.size,1);
});

test("retry preserves a requested subdomain after a create warning and clears the stale error",async t=>{
  const f=await setup(t);f.http.hook=c=>c.path === "/workers/domains" && c.method === "PUT"?cfError(403,10000):null;
  const request=new Request("https://master.example/api/admin/children",{method:"POST",body:JSON.stringify({name:"New user",password:"test-password",subdomain:"chosen-name",cloudinary_cloud_name:"cloud",cloudinary_api_key:"cloud-key",cloudinary_api_secret:"cloud-secret"})});
  const created=await __test.createChild(f.env,request,f.admin);assert.match(created.warning,/cloudflare/);f.http.hook=null;
  f.insert("INSERT INTO admin_sessions(id,token_hash,expires_at) VALUES('owner-retry',?,'2099-01-01')",await hmacHex(f.env.SESSION_PEPPER,"owner-token"));
  const result=await master.fetch(new Request("https://master.example/api/admin/children/"+created.child.id+"/sync-domain",{method:"POST",headers:{cookie:"xm_admin=owner-token",origin:"https://master.example","content-type":"application/json"},body:"{}"}),f.env,{});
  assert.equal(result.status,200);
  const row=f.sqlite.prepare("SELECT web_url,last_error FROM children WHERE id=?").get(created.child.id);
  assert.equal(row.web_url,"https://chosen-name.bemail2017.com");assert.equal(row.last_error,null);
});

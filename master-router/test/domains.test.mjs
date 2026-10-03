import assert from 'node:assert/strict';
import test from 'node:test';
import master, {__test} from '../src/index.js';
import {hmacHex} from '../src/security.js';
import {fixture,cfError,response} from './domain-fixture.mjs';

async function setup(t,options) {
 const f=await fixture(t,options);
 await __test.domains.saveConfig(f.env,f.admin,{enabled:true,base_domain:'bemail2017.com'});
 f.assign=(target=f.childId,label)=>__test.domains.assign(f.env,f.admin,target,label);
 f.snapshot=()=>JSON.stringify(Object.fromEntries(['children','child_infra','child_settings','x_accounts','child_router_slots','child_sources','x_account_sources','child_sessions','ingest_account_routes'].map(table=>[table,f.sqlite.prepare('SELECT * FROM '+table).all()])));
 f.onlyDomainMutations=()=>assert.equal(f.calls.some(c=>c.method !== 'GET' && !c.path?.startsWith('/workers/domains')),false,'domain attachment must never upload, pause or resume scripts');
 return f;
}

test('Master Router attaches to router.bemail2017.com with no Worker redeploy',async t=>{
 const f=await setup(t),before=f.snapshot();
 const result=await f.assign('master','router');
 assert.equal(result.url,'https://router.bemail2017.com');
 assert.equal(f.domains.get('router.bemail2017.com').service,'x-master-router');
 assert.equal(f.snapshot(),before);f.onlyDomainMutations();
});

test('existing user gets a domain without changing ANY user data or the workers.dev URL',async t=>{
 const f=await setup(t),before=f.snapshot();
 await f.assign(f.childId,'hydra');await f.assign(f.childId,'hydra');
 assert.equal(f.snapshot(),before);assert.equal(f.domains.get('hydra.bemail2017.com').service,f.root);
 assert.equal(f.calls.filter(c=>c.method === 'PUT').length,1);f.onlyDomainMutations();
 assert.ok(f.calls.length < 20,'domain calls stay well below a 50-subrequest request budget');
});

test('assigning to paused user does not resume or update that user',async t=>{
 const f=await setup(t,{status:'paused'}),before=f.snapshot();
 const result=await f.assign(f.childId,'paused');assert.equal(result.state,'suspended');
 assert.equal(f.domains.size,0);assert.equal(f.snapshot(),before);f.onlyDomainMutations();
});

test('domain failure leaves running user, credentials, Buffer and Worker unchanged',async t=>{
 const f=await setup(t),before=f.snapshot();
 f.http.hook=c=>c.method === 'PUT'?cfError(403,10000):null;
 await assert.rejects(f.assign(f.childId,'retry'),/cloudflare/);
 assert.equal(f.snapshot(),before);assert.equal(f.managed().length,6);f.onlyDomainMutations();
 f.http.hook=null;await f.assign(f.childId,'retry');assert.equal(f.snapshot(),before);
});

test('refuses blog, master labels on child, malformed hostnames and foreign Worker ownership',async t=>{
 const f=await setup(t);
 for(const name of ['www','admeo','router','master','*.x','a.b','https://bad','-bad','bad-','a'.repeat(64)])await assert.rejects(f.assign(f.childId,name),/invalid_or_reserved/);
 f.domains.set('occupied.bemail2017.com',{id:'foreign',hostname:'occupied.bemail2017.com',service:'tieungummo-demo',zone_id:'zone-blog'});
 await assert.rejects(f.assign(f.childId,'occupied'),/domain_ownership_conflict/);
 assert.equal(f.calls.some(c=>c.method === 'PUT'),false);
});

test('master cannot take a hostname already reserved by a child',async t=>{
 const f=await setup(t);await f.assign(f.childId,'hydra');
 await assert.rejects(f.assign('master','hydra'),/hostname_reserved_by_another_web/);
 assert.equal(f.domains.get('hydra.bemail2017.com').service,f.root);
});

test('rename verifies the replacement then retires only the previous managed domain',async t=>{
 const f=await setup(t);await f.assign(f.childId,'old');f.calls.length=0;
 await f.assign(f.childId,'new');
 assert.equal(f.domains.has('old.bemail2017.com'),false);assert.equal(f.domains.has('new.bemail2017.com'),true);
 assert.ok(f.calls.findIndex(c=>c.method === 'DELETE')>f.calls.findIndex(c=>c.method === 'PUT'));
});

test('lost attach response is recoverable without duplicate Worker provisioning',async t=>{
 const f=await setup(t);
 f.http.hook=c=>{if(c.method === 'PUT'){const body=JSON.parse(c.init.body);f.domains.set(body.hostname,{...body,id:'uncertain'});throw new Error('response lost');}};
 await assert.rejects(f.assign(f.childId,'recover'),/response lost/);
 f.http.hook=null;await f.assign(f.childId,'recover');
 assert.equal(f.domains.get('recover.bemail2017.com').id,'uncertain');f.onlyDomainMutations();
});

test('delete removes managed domain first; a failed detach prevents the original delete action',async t=>{
 const f=await setup(t);await f.assign(f.childId,'remove');let originalCalled=false;
 f.http.hook=c=>c.method === 'DELETE'?cfError(403,10000):null;
 await assert.rejects(__test.domains.mutation(f.env,f.childId,'delete',async()=>{originalCalled=true;}),/cloudflare/);
 assert.equal(originalCalled,false);assert.equal(f.count('children'),1);
 f.http.hook=null;
 await __test.domains.mutation(f.env,f.childId,'delete',async()=>{originalCalled=true;assert.equal(f.domains.size,0);f.insert('DELETE FROM children WHERE id=?',f.childId);return {deleted:true};});
 assert.equal(originalCalled,true);assert.equal(f.count('child_domains'),0);
});

test('false-success detach and changed immutable domain ID never count as deleted',async t=>{
 const f=await setup(t);await f.assign(f.childId,'keep');
 f.http.hook=c=>c.method === 'DELETE'?response({}):null;
 await assert.rejects(__test.domains.mutation(f.env,f.childId,'delete',async()=>assert.fail('must not delete user')),/domain_detach_not_verified/);
 f.http.hook=null;f.domains.get('keep.bemail2017.com').id='reassigned';
 await assert.rejects(__test.domains.mutation(f.env,f.childId,'delete',async()=>assert.fail('must not delete user')),/domain_ownership_conflict/);
});

test('pause/resume domain hooks leave the original v0.4 action in charge of status',async t=>{
 const f=await setup(t);await f.assign(f.childId,'web');const before=f.snapshot();
 await __test.domains.mutation(f.env,f.childId,'paused',async()=>({status:'paused'}));
 assert.equal(f.domains.size,0);assert.equal(f.snapshot(),before);
 await __test.domains.mutation(f.env,f.childId,'ready',async()=>({status:'ready'}));
 assert.equal(f.domains.size,1);assert.equal(f.snapshot(),before);f.onlyDomainMutations();
});

test('new-child domain failure returns a warning and never rolls back a successfully provisioned user',async t=>{
 const f=await setup(t),before=f.snapshot();f.http.hook=c=>c.method === 'PUT'?cfError(403,10000):null;
 const result=await __test.domains.afterCreate(f.env,f.admin,{child:{id:f.childId,web_url:'https://existing.workers.dev'}});
 assert.match(result.domain_warning,/cloudflare/);assert.equal(result.child.web_url,'https://existing.workers.dev');
 assert.equal(f.snapshot(),before);f.onlyDomainMutations();
});

test('disabled auto-domain setting skips new-child attachment while manual Master domain remains usable',async t=>{
 const f=await setup(t);await __test.domains.saveConfig(f.env,f.admin,{enabled:false,base_domain:'bemail2017.com'});
 await __test.domains.afterCreate(f.env,f.admin,{child:{id:f.childId}});assert.equal(f.domains.size,0);
 await f.assign('master','router');assert.equal(f.domains.size,1);
});

test('legacy child on another account is not migrated or redeployed',async t=>{
 const f=await setup(t,{legacy:true}),before=f.snapshot();
 await assert.rejects(f.assign(f.childId,'legacy'),/different_accounts/);assert.equal(f.snapshot(),before);f.onlyDomainMutations();
});

test('domain attachment is serialized and never hijacks an old v0.5 update still running',async t=>{
 const f=await setup(t);let entered,unblock;const start=new Promise(r=>entered=r),barrier=new Promise(r=>unblock=r);
 f.http.hook=async c=>{if(c.method === 'PUT'){entered();await barrier;}};
 const pending=f.assign(f.childId,'locked');await start;
 try{await assert.rejects(f.assign(f.childId,'other'),/domain_operation_in_progress/);}finally{unblock();await pending;}
 f.sqlite.exec('CREATE TABLE child_lifecycle(child_id TEXT,operation_id TEXT,lease_expires_at TEXT)');
 f.insert("INSERT INTO child_lifecycle VALUES(?,'previous',datetime('now','+10 minutes'))",f.childId);
 await assert.rejects(f.assign(f.childId,'wait'),/previous_update_still_running/);
});

test('Owner auth, same-origin and correct target ownership are required',async t=>{
 const f=await setup(t);
 const call=(token,origin,target)=>master.fetch(new Request('https://master.example/api/admin/domains/attach',{method:'POST',headers:{cookie:token?'xm_admin='+token:'',origin,'content-type':'application/json'},body:JSON.stringify({target,label:'hydra'})}),f.env,{});
 assert.equal((await call('','https://master.example',f.childId)).status,401);
 f.insert("INSERT INTO admin_sessions(id,token_hash,expires_at) VALUES('owner',?,'2099-01-01')",await hmacHex(f.env.SESSION_PEPPER,'test-token'));
 assert.equal((await call('test-token','https://evil.example',f.childId)).status,403);
 assert.equal((await call('test-token','https://master.example','nonexistent')).status,404);
 assert.equal((await call('test-token','https://master.example',f.childId)).status,200);
 const list=await master.fetch(new Request('https://master.example/api/admin/domains',{headers:{cookie:'xm_admin=test-token'}}),f.env,{});
 const text=await list.text();assert.ok(!text.includes('test-buffer-key'));assert.ok(!text.includes('test-cloud-secret'));
});

test('cross-target reservation is atomic even if both start before either attaches',async t=>{
 const f=await setup(t);let entered,unblock;const start=new Promise(r=>entered=r),barrier=new Promise(r=>unblock=r);
 f.http.hook=async c=>{if(c.method === 'PUT'){entered();await barrier;}};
 const pending=f.assign('master','shared');await start;
 try{await assert.rejects(f.assign(f.childId,'shared'),/hostname_reserved_by_another_web/);}finally{unblock();await pending;}
 assert.equal(f.domains.get('shared.bemail2017.com').service,'x-master-router');
});

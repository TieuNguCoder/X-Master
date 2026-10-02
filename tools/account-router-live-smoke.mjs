import assert from "node:assert/strict";

const root = process.env.ACCOUNT_ROUTER_TEST_ROOT || "http://127.0.0.1:8802";

let r = await fetch(root + "/health");
assert.equal(r.status, 200);
let body = await r.json();
assert.equal(body.ok, true);
assert.equal(body.slot_id, "rs_smoke");
assert.equal(body.child_id, "ch_smoke");
assert.equal(body.account_id, "xa_smoke");

r = await fetch(root + "/process", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-master-router-secret": "wrong"
  },
  body: JSON.stringify({ event_id: "evt_bad", account_id: "xa_smoke", text: "bad" })
});
assert.equal(r.status, 401);

r = await fetch(root + "/process", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-master-router-secret": "router-secret"
  },
  body: JSON.stringify({ event_id: "evt_smoke", account_id: "xa_smoke", text: "hello" })
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.posted, true);
assert.equal(body.routed, "process");
assert.equal(body.event_id, "evt_smoke");

r = await fetch(root + "/publish", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-master-router-secret": "router-secret"
  },
  body: JSON.stringify({ event_id: "evt_smoke", account_id: "xa_smoke", output: "rewritten" })
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.posted, true);
assert.equal(body.post.id, "post-router-smoke");

console.log("account-router-live-smoke: PASS");

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const root = process.env.ACCOUNT_ROUTER_TEST_ROOT || "http://127.0.0.1:8802";
const slotId = "rs_smoke";
const secret = "router-secret";

function signedHeaders(eventId, accountId, action, issuedAt = Math.floor(Date.now() / 1000)) {
  const material = [slotId, eventId, accountId, action, String(issuedAt)].join("|");
  const signature = createHmac("sha256", secret).update(material).digest("hex");
  return {
    "content-type": "application/json",
    "x-router-issued": String(issuedAt),
    "x-router-signature": signature
  };
}

let r = await fetch(root + "/health");
assert.equal(r.status, 200);
let body = await r.json();
assert.equal(body.ok, true);
assert.equal(body.slot_id, slotId);
assert.equal(body.child_id, "ch_smoke");
assert.equal(body.account_id, "xa_smoke");

r = await fetch(root + "/process", {
  method: "POST",
  headers: signedHeaders("evt_bad", "xa_smoke", "process", Math.floor(Date.now() / 1000) - 999),
  body: JSON.stringify({ event_id: "evt_bad", account_id: "xa_smoke", text: "bad" })
});
assert.equal(r.status, 401);

const processEvent = "evt_smoke";
r = await fetch(root + "/process", {
  method: "POST",
  headers: signedHeaders(processEvent, "xa_smoke", "process"),
  body: JSON.stringify({ event_id: processEvent, account_id: "xa_smoke", text: "hello" })
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.posted, true);
assert.equal(body.routed, "process");
assert.equal(body.event_id, processEvent);

const publishEvent = "evt_publish";
r = await fetch(root + "/publish", {
  method: "POST",
  headers: signedHeaders(publishEvent, "xa_smoke", "publish"),
  body: JSON.stringify({ event_id: publishEvent, account_id: "xa_smoke", output: "rewritten" })
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.posted, true);
assert.equal(body.post.id, "post-router-smoke");

console.log("account-router-live-smoke: PASS");

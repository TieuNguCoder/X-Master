import assert from "node:assert/strict";

const root = process.env.CHILD_TEST_ROOT || "http://127.0.0.1:8801";

let r = await fetch(root + "/health");
assert.equal(r.status, 200);
let body = await r.json();
assert.equal(body.ok, true);
assert.equal(body.child_id, "ch_smoke");

r = await fetch(root + "/");
assert.equal(r.status, 200);
const html = await r.text();
assert.ok(html.includes("Nhập mật khẩu"));
assert.ok(html.includes("Gemini API Key"));
assert.ok(html.includes("Buffer API Key"));

r = await fetch(root + "/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "tester-password" })
});
assert.equal(r.status, 200);
const setCookie = r.headers.get("set-cookie");
assert.ok(setCookie?.includes("xm_child="));
const cookie = setCookie.split(";")[0];

r = await fetch(root + "/api/me", { headers: { cookie } });
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.child.name, "Tester Smoke");
assert.equal(body.sources.length, 1);

r = await fetch(root + "/api/settings", {
  method: "PUT",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({
    gemini_api_key: "gemini-smoke",
    buffer_api_key: "buffer-smoke",
    content_mode: "airdrop",
    x_premium: true
  })
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.saved, true);

console.log("child-live-smoke: PASS");

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
assert.ok(html.includes("Thêm tài khoản X"));
assert.ok(html.includes("Gemini Free")); 
assert.ok(html.includes("Gemini Paid")); 
assert.ok(html.includes("DeepSeek Paid"));
assert.ok(html.includes("Buffer API Key"));
assert.ok(html.includes("Ngôn ngữ bài đăng"));
assert.ok(html.includes("English (US) — mặc định"));
assert.ok(html.includes("Custom language / BCP-47"));
assert.ok(html.includes("Kênh Telegram cho tài khoản này"));

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
assert.equal(body.source_catalog.length, 2);
assert.equal(body.accounts.length, 0);
assert.equal(body.router_slots.length, 5);
assert.equal(body.limits.max_accounts, 5);
assert.equal(body.limits.router_slots, 5);

r = await fetch(root + "/api/buffer/channels", {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ buffer_api_key: "buffer-smoke" })
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.channels.length, 1);
assert.equal(body.channels[0].id, "buffer-channel-1");

r = await fetch(root + "/api/accounts", {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({
    display_name: "Holly",
    x_handle: "@holly",
    ai_provider: "gemini_free",
    ai_api_key: "gemini-smoke",
    buffer_api_key: "buffer-smoke",
    buffer_channel_id: "buffer-channel-1",
    post_language: "en-US",
    content_mode: "news",
    x_premium: false,
    enabled: true,
    source_ids: ["src_smoke"]
  })
});
assert.equal(r.status, 201);
body = await r.json();
assert.equal(body.account.display_name, "Holly");
assert.equal(body.account.ai_provider, "gemini_free");
assert.equal(body.account.ai_configured, true);
assert.equal(body.account.post_language, "en-US");
assert.equal(body.account.router_slot_index, 1);
assert.equal(body.account.router_status, "assigned");
assert.equal(body.account.sources.length, 1);

const createdAccountId = body.account.id;

r = await fetch(root + "/api/accounts/" + createdAccountId + "/test-post", {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: "{}"
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.posted, true);
assert.equal(body.post.id, "post-test-smoke");

r = await fetch(root + "/api/accounts/" + createdAccountId, {
  method: "PATCH",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({
    display_name: "Holly Updated",
    x_handle: "holly2",
    ai_provider: "deepseek_paid",
    ai_api_key: "deepseek-smoke",
    buffer_channel_id: "buffer-channel-2",
    post_language: "vi-VN",
    content_mode: "airdrop",
    x_premium: true,
    enabled: false,
    source_ids: ["src_smoke", "src_second"]
  })
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.account.display_name, "Holly Updated");
assert.equal(body.account.ai_provider, "deepseek_paid");
assert.equal(body.account.ai_configured, true);
assert.equal(body.account.post_language, "vi-VN");
assert.equal(body.account.sources.length, 2);
assert.equal(body.account.enabled, false);

r = await fetch(root + "/api/me", { headers: { cookie } });
body = await r.json();
assert.equal(body.accounts.length, 1);
assert.equal(body.accounts[0].source_ids.length, 2);

r = await fetch(root + "/api/accounts/" + body.accounts[0].id, {
  method: "DELETE",
  headers: { cookie }
});
assert.equal(r.status, 200);
body = await r.json();
assert.equal(body.deleted, true);

r = await fetch(root + "/api/me", { headers: { cookie } });
body = await r.json();
assert.equal(body.accounts.length, 0);
assert.equal(body.router_slots.filter((x) => x.status === "ready").length, 5);

console.log("child-live-smoke: PASS");

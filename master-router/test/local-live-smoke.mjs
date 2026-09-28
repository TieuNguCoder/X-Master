import assert from "node:assert/strict";

const root = process.env.X_MASTER_TEST_ROOT || "http://127.0.0.1:8799";
let cookie = "";

async function call(path, options = {}) {
  const response = await fetch(root + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {})
    }
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

let r = await call("/api/health");
assert.equal(r.response.status, 200);
assert.equal(r.body.ok, true);
assert.equal(r.body.collector_ready, true);

r = await call("/api/admin/login", {
  method: "POST",
  body: JSON.stringify({ password: "master-test-password" })
});
assert.equal(r.response.status, 200);
assert.ok(cookie.startsWith("xm_admin="));

r = await call("/collector/catalog", {
  method: "POST",
  headers: { "x-collector-secret": "collector-smoke-secret" },
  body: JSON.stringify({
    sources: [
      { title: "Smoke Source", username: "smoke_source", channel_id: "-1001234567890" },
      { title: "Second Source", username: "second_source", channel_id: "-1009876543210" }
    ]
  })
});
assert.equal(r.response.status, 200);
assert.equal(r.body.synced, 2);

r = await call("/api/admin/dashboard");
assert.equal(r.response.status, 200);
assert.equal(r.body.sources.length, 2);
assert.equal(r.body.children.length, 0);

r = await call("/collector/sources", {
  headers: { "x-collector-secret": "collector-smoke-secret" }
});
assert.equal(r.response.status, 200);
assert.equal(r.body.sources.length, 0, "no X account has selected a source yet");

const ingestBody = {
  source: { channel_id: "-1001234567890", username: "smoke_source" },
  external_id: "42",
  text: "Smoke test post",
  media: []
};
r = await call("/ingest", {
  method: "POST",
  headers: { "x-collector-secret": "collector-smoke-secret" },
  body: JSON.stringify(ingestBody)
});
assert.equal(r.response.status, 202);
assert.equal(r.body.accepted, true);
assert.equal(r.body.routed_children, 0);
assert.equal(r.body.routed_accounts.length, 0);

r = await call("/ingest", {
  method: "POST",
  headers: { "x-collector-secret": "collector-smoke-secret" },
  body: JSON.stringify(ingestBody)
});
assert.equal(r.response.status, 202);
assert.equal(r.body.accepted, false);
assert.equal(r.body.duplicate, true);

r = await call("/api/admin/logout", { method: "POST", body: "{}" });
assert.equal(r.response.status, 200);

console.log("local-live-smoke: PASS");

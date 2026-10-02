import http from "node:http";

const port = Number(process.env.FAKE_MASTER_PORT || 8800);
const sourceCatalog = [
  { id: "src_smoke", title: "Smoke Source", username: "smoke_source", channel_id: "-100123" },
  { id: "src_second", title: "Second Source", username: "second_source", channel_id: "-100456" }
];
let accounts = [];
const routerSlots = Array.from({ length: 5 }, (_, i) => ({
  id: "rs_" + (i + 1),
  child_id: "ch_smoke",
  slot_index: i + 1,
  account_id: null,
  worker_name: "xmr-smoke-r" + (i + 1),
  web_url: "https://xmr-smoke-r" + (i + 1) + ".workers.dev",
  status: "ready",
  assigned: false
}));

function json(res, body, status = 200, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");

  if (req.url?.startsWith("/internal/router/")) {
    if (req.headers["x-router-slot"] !== "rs_smoke" || req.headers["x-router-secret"] !== "router-secret") {
      return json(res, { error: "unauthorized" }, 401);
    }
    if (req.url === "/internal/router/health" && req.method === "GET") {
      return json(res, { ok: true, slot_id: "rs_smoke", child_id: "ch_smoke", slot_index: 1, account_id: "xa_smoke", status: "assigned" });
    }
    if (req.url === "/internal/router/process" && req.method === "POST") {
      const body = JSON.parse(raw || "{}");
      return json(res, { posted: true, routed: "process", event_id: body.event_id || null, account_id: body.account_id || null });
    }
    if (req.url === "/internal/router/publish" && req.method === "POST") {
      return json(res, { posted: true, post: { id: "post-router-smoke", status: "sent" } });
    }
    return json(res, { error: "not_found" }, 404);
  }

  if (req.headers["x-child-id"] !== "ch_smoke" || req.headers["x-child-secret"] !== "child-secret") {
    return json(res, { error: "unauthorized" }, 401);
  }

  if (req.url === "/internal/child/health" && req.method === "GET") {
    return json(res, { ok: true, child_id: "ch_smoke", status: "ready" });
  }

  if (req.url === "/internal/child/login" && req.method === "POST") {
    const body = JSON.parse(raw || "{}");
    if (body.password !== "tester-password") return json(res, { error: "invalid_credentials" }, 401);
    return json(res, { ok: true }, 200, { "x-child-session": "session-smoke" });
  }

  if (req.headers["x-child-session"] !== "session-smoke") {
    return json(res, { error: "unauthorized" }, 401);
  }

  if (req.url === "/internal/child/me" && req.method === "GET") {
    return json(res, {
      child: { id: "ch_smoke", name: "Tester Smoke", status: "ready" },
      source_catalog: sourceCatalog,
      router_slots: routerSlots.map((r) => ({ ...r, assigned: Boolean(r.account_id) })),
      accounts,
      limits: { max_accounts: 5, router_slots: 5 }
    });
  }

  if (req.url === "/internal/child/buffer/channels" && req.method === "POST") {
    const body = JSON.parse(raw || "{}");
    if (body.buffer_api_key !== "buffer-smoke") return json(res, { error: "buffer:invalid_api_key" }, 502);
    return json(res, {
      channels: [{
        id: "buffer-channel-1",
        name: "Holly on X",
        display_name: "Holly on X",
        service: "twitter",
        organization_id: "org-smoke",
        organization_name: "Smoke Org",
        queue_paused: false
      }]
    });
  }

  if (req.url === "/internal/child/accounts" && req.method === "POST") {
    const body = JSON.parse(raw || "{}");
    if (accounts.length >= 5) return json(res, { error: "x_account_limit_reached" }, 409);
    const selected = sourceCatalog.filter((s) => (body.source_ids || []).includes(s.id));
    const slot = routerSlots.find((r) => !r.account_id);
    if (!slot) return json(res, { error: "router_slot_unavailable" }, 409);
    const account = {
      id: "xa_" + (accounts.length + 1),
      display_name: body.display_name,
      x_handle: String(body.x_handle || "").replace(/^@/, ""),
      buffer_channel_id: body.buffer_channel_id || null,
      buffer_channel_name: body.buffer_channel_name || null,
      content_mode: body.content_mode || "news",
      post_language: body.post_language || "en-US",
      x_premium: Boolean(body.x_premium),
      enabled: body.enabled !== false,
      ai_provider: body.ai_provider || "gemini_paid",
      ai_configured: Boolean(body.ai_api_key),
      gemini_configured: (body.ai_provider || "gemini_paid") !== "deepseek_paid" && Boolean(body.ai_api_key),
      deepseek_configured: body.ai_provider === "deepseek_paid" && Boolean(body.ai_api_key),
      buffer_configured: Boolean(body.buffer_api_key),
      router_slot_id: slot.id,
      router_slot_index: slot.slot_index,
      router_worker_name: slot.worker_name,
      router_url: slot.web_url,
      router_status: "assigned",
      source_ids: selected.map((s) => s.id),
      sources: selected
    };
    slot.account_id = account.id;
    slot.status = "assigned";
    accounts.push(account);
    return json(res, { account }, 201);
  }

  const testPost = req.url.match(/^\/internal\/child\/accounts\/([^/]+)\/test-post$/);
  if (testPost && req.method === "POST") {
    const account = accounts.find((a) => a.id === testPost[1]);
    if (!account) return json(res, { error: "x_account_not_found" }, 404);
    return json(res, { posted: true, post: { id: "post-test-smoke", status: "sent" } });
  }

  const match = req.url.match(/^\/internal\/child\/accounts\/([^/]+)$/);
  if (match && req.method === "PATCH") {
    const body = JSON.parse(raw || "{}");
    const index = accounts.findIndex((a) => a.id === match[1]);
    if (index < 0) return json(res, { error: "x_account_not_found" }, 404);
    const old = accounts[index];
    const selected = sourceCatalog.filter((s) => (body.source_ids || []).includes(s.id));
    accounts[index] = {
      ...old,
      display_name: body.display_name,
      x_handle: String(body.x_handle || "").replace(/^@/, ""),
      buffer_channel_id: body.buffer_channel_id || null,
      buffer_channel_name: body.buffer_channel_name || null,
      content_mode: body.content_mode || "news",
      post_language: body.post_language || old.post_language || "en-US",
      x_premium: Boolean(body.x_premium),
      enabled: body.enabled !== false,
      ai_provider: body.ai_provider || old.ai_provider || "gemini_paid",
      ai_configured: Boolean(body.ai_api_key) || old.ai_configured,
      gemini_configured: ((body.ai_provider || old.ai_provider || "gemini_paid") !== "deepseek_paid" && (Boolean(body.ai_api_key) || old.gemini_configured)),
      deepseek_configured: ((body.ai_provider || old.ai_provider) === "deepseek_paid" && (Boolean(body.ai_api_key) || old.deepseek_configured)),
      buffer_configured: Boolean(body.buffer_api_key) || old.buffer_configured,
      source_ids: selected.map((s) => s.id),
      sources: selected
    };
    return json(res, { account: accounts[index] });
  }

  if (match && req.method === "DELETE") {
    const before = accounts.length;
    const slot = routerSlots.find((r) => r.account_id === match[1]);
    if (slot) { slot.account_id = null; slot.status = "ready"; }
    accounts = accounts.filter((a) => a.id !== match[1]);
    if (accounts.length === before) return json(res, { error: "x_account_not_found" }, 404);
    return json(res, { deleted: true });
  }

  return json(res, { error: "not_found" }, 404);
});

server.listen(port, "127.0.0.1", () => {
  console.log("fake child master ready on", port);
});

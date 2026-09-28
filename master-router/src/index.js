import {
  cookieValue,
  createPasswordHash,
  decryptJson,
  encryptJson,
  hmacHex,
  randomHex,
  slugify,
  timingSafeEqual,
  verifyPassword
} from "./security.js";
import { renderChildWorkerSource } from "./child-template.js";

const ADMIN_COOKIE = "xm_admin";
const CHILD_COOKIE = "xm_child";
const ADMIN_TTL_SECONDS = 12 * 60 * 60;
const CHILD_TTL_SECONDS = 7 * 24 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

function id(prefix) {
  return prefix + "_" + crypto.randomUUID().replaceAll("-", "");
}

function isoAfter(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function safeError(error) {
  return String(error?.message || error || "internal_error").slice(0, 1500);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

async function audit(env, actorType, actorId, action, targetType = null, targetId = null, details = null) {
  await env.DB.prepare(
    "INSERT INTO audit_logs(actor_type,actor_id,action,target_type,target_id,details_json) VALUES(?,?,?,?,?,?)"
  ).bind(
    actorType,
    actorId || null,
    action,
    targetType,
    targetId,
    details ? JSON.stringify(details) : null
  ).run();
}

async function requireBindings(env) {
  const missing = [];
  for (const key of ["DB", "MASTER_KEY", "SESSION_PEPPER", "ADMIN_PASSWORD_HASH", "COLLECTOR_SECRET"]) {
    if (!env[key]) missing.push(key);
  }
  if (missing.length) throw Object.assign(new Error("missing_bindings:" + missing.join(",")), { status: 503 });
}

async function createAdminSession(env) {
  const raw = randomHex(32);
  const hash = await hmacHex(env.SESSION_PEPPER, raw);
  await env.DB.prepare(
    "INSERT INTO admin_sessions(id,token_hash,expires_at) VALUES(?,?,?)"
  ).bind(id("as"), hash, isoAfter(ADMIN_TTL_SECONDS)).run();
  return raw;
}

async function adminSession(env, request) {
  const raw = cookieValue(request, ADMIN_COOKIE);
  if (!raw) return null;
  const hash = await hmacHex(env.SESSION_PEPPER, raw);
  return env.DB.prepare(
    "SELECT id,expires_at FROM admin_sessions WHERE token_hash=? AND revoked_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP"
  ).bind(hash).first();
}

async function requireAdmin(env, request) {
  const session = await adminSession(env, request);
  if (!session) throw Object.assign(new Error("unauthorized"), { status: 401 });
  return session;
}

async function createChildSession(env, childId) {
  const raw = randomHex(32);
  const hash = await hmacHex(env.SESSION_PEPPER, raw);
  await env.DB.prepare(
    "INSERT INTO child_sessions(id,child_id,token_hash,expires_at) VALUES(?,?,?,?)"
  ).bind(id("cs"), childId, hash, isoAfter(CHILD_TTL_SECONDS)).run();
  return raw;
}

async function requireChildSession(env, childId, raw) {
  if (!raw) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const hash = await hmacHex(env.SESSION_PEPPER, raw);
  const row = await env.DB.prepare(
    "SELECT id FROM child_sessions WHERE child_id=? AND token_hash=? AND revoked_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP"
  ).bind(childId, hash).first();
  if (!row) throw Object.assign(new Error("unauthorized"), { status: 401 });
  return row;
}

async function verifyChildCaller(env, request) {
  const childId = request.headers.get("x-child-id") || "";
  const secret = request.headers.get("x-child-secret") || "";
  if (!childId || !secret) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const child = await env.DB.prepare(
    "SELECT id,name,slug,status,password_hash,child_secret_hash,web_url FROM children WHERE id=?"
  ).bind(childId).first();
  if (!child) throw Object.assign(new Error("child_not_found"), { status: 404 });
  const provided = await hmacHex(env.SESSION_PEPPER, secret);
  if (!timingSafeEqual(provided, child.child_secret_hash)) {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  return child;
}

function normalizeSource(body) {
  const title = String(body.title || "").trim();
  const username = String(body.username || "").trim().replace(/^@/, "") || null;
  const channelId = String(body.channel_id || "").trim() || null;
  if (title.length < 2) throw Object.assign(new Error("source_title_required"), { status: 400 });
  if (!username && !channelId) throw Object.assign(new Error("source_identity_required"), { status: 400 });
  return { title, username, channelId };
}

function normalizeInfra(body) {
  const infra = {
    cloudflare_account_id: String(body.cloudflare_account_id || "").trim(),
    cloudflare_api_token: String(body.cloudflare_api_token || "").trim(),
    cloudinary_cloud_name: String(body.cloudinary_cloud_name || "").trim(),
    cloudinary_api_key: String(body.cloudinary_api_key || "").trim(),
    cloudinary_api_secret: String(body.cloudinary_api_secret || "").trim()
  };
  if (infra.cloudflare_account_id.length < 8) throw Object.assign(new Error("cloudflare_account_id_required"), { status: 400 });
  if (infra.cloudflare_api_token.length < 16) throw Object.assign(new Error("cloudflare_api_token_required"), { status: 400 });
  if (!infra.cloudinary_cloud_name || !infra.cloudinary_api_key || !infra.cloudinary_api_secret) {
    throw Object.assign(new Error("cloudinary_credentials_required"), { status: 400 });
  }
  return infra;
}

async function cloudflareRequest(infra, path, init = {}) {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + infra.cloudflare_account_id + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + infra.cloudflare_api_token,
      ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text || "{}"); } catch { body = { raw: text }; }
  if (!response.ok || body.success === false) {
    const detail = (body.errors || []).map((e) => e.message || String(e)).join("; ") || body.raw || ("HTTP " + response.status);
    throw Object.assign(new Error("cloudflare:" + detail), { status: 502, expose: true });
  }
  return body;
}

async function bufferGraphql(apiKey, query) {
  const response = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer " + apiKey
    },
    body: JSON.stringify({ query })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || Array.isArray(body.errors)) {
    const detail = (body.errors || []).map((x) => x.message || String(x)).join("; ") || ("HTTP " + response.status);
    throw Object.assign(new Error("buffer:" + detail), { status: 502, expose: true });
  }
  return body.data || {};
}

async function bufferXChannels(apiKey) {
  const key = String(apiKey || "").trim();
  if (key.length < 10) throw Object.assign(new Error("buffer_api_key_required"), { status: 400 });

  const orgData = await bufferGraphql(key, `query {
    account {
      organizations { id name }
    }
  }`);
  const organizations = orgData?.account?.organizations || [];
  const channels = [];

  for (const org of organizations) {
    const orgId = String(org.id || "").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const channelData = await bufferGraphql(key, `query {
      channels(input: { organizationId: "${orgId}" }) {
        id
        name
        displayName
        service
        isQueuePaused
      }
    }`);
    for (const channel of (channelData.channels || [])) {
      const service = String(channel.service || "").toLowerCase();
      if (service === "twitter" || service === "x") {
        channels.push({
          id: channel.id,
          name: channel.name || channel.displayName || channel.id,
          display_name: channel.displayName || channel.name || null,
          service: channel.service,
          organization_id: org.id,
          organization_name: org.name || null,
          queue_paused: Boolean(channel.isQueuePaused)
        });
      }
    }
  }
  return channels;
}

function rewritePrompt(text, account) {
  const sourceText = String(text || "").trim();
  if (!sourceText) throw Object.assign(new Error("empty_source_text"), { status: 400 });
  const maxChars = account.x_premium ? 1800 : 260;
  const modeGuide = account.content_mode === "airdrop"
    ? "Style: concise crypto/airdrop update. Keep only facts present in the source. Never invent eligibility, rewards, dates, links, prices, or guarantees."
    : "Style: concise news update. Keep only facts present in the source. Never invent facts, numbers, names, dates, links, quotes, or conclusions.";
  return {
    maxChars,
    prompt: [
      "Rewrite the Telegram post below as a standalone X post.",
      modeGuide,
      "Preserve the source language unless a natural translation is necessary.",
      "Do not mention Telegram or that this is a rewrite.",
      "Do not add markdown fences or commentary.",
      "Make the wording distinct rather than copying sentences.",
      "Maximum " + maxChars + " characters.",
      "",
      "SOURCE:",
      sourceText
    ].join("\n")
  };
}

function cleanAiOutput(output, maxChars) {
  let text = String(output || "").trim().replace(/^\s*[`"'“”]+|[`"'“”]+\s*$/g, "").trim();
  if (!text) throw Object.assign(new Error("ai:empty_response"), { status: 502, expose: true });
  if (text.length > maxChars) text = text.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…";
  return text;
}

async function geminiRewrite(apiKey, text, account, model = "gemini-3.5-flash") {
  const key = String(apiKey || "").trim();
  if (!key) throw Object.assign(new Error("gemini_api_key_missing"), { status: 400 });
  const { prompt, maxChars } = rewritePrompt(text, account);

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: account.x_premium ? 900 : 220
        }
      })
    }
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || ("HTTP " + response.status);
    throw Object.assign(new Error("gemini:" + detail), { status: 502, expose: true });
  }

  const output = (body?.candidates?.[0]?.content?.parts || [])
    .map((part) => String(part?.text || ""))
    .join("");
  return cleanAiOutput(output, maxChars);
}

async function deepseekRewrite(apiKey, text, account) {
  const key = String(apiKey || "").trim();
  if (!key) throw Object.assign(new Error("deepseek_api_key_missing"), { status: 400 });
  const { prompt, maxChars } = rewritePrompt(text, account);

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify({
      model: "deepseek-flash",
      messages: [{ role: "user", content: prompt }],
      thinking: { type: "disabled" },
      temperature: 0.8,
      max_tokens: account.x_premium ? 900 : 220
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || ("HTTP " + response.status);
    throw Object.assign(new Error("deepseek:" + detail), { status: 502, expose: true });
  }
  return cleanAiOutput(body?.choices?.[0]?.message?.content, maxChars);
}

function accountAiProvider(secrets) {
  const provider = String(secrets?.ai_provider || "gemini_paid");
  return ["gemini_free", "gemini_paid", "deepseek_paid"].includes(provider) ? provider : "gemini_paid";
}

async function rewriteWithProvider(provider, secrets, text, account) {
  if (provider === "gemini_paid") {
    return geminiRewrite(secrets.gemini_api_key, text, account, "gemini-3.5-flash");
  }
  if (provider === "deepseek_paid") {
    return deepseekRewrite(secrets.deepseek_api_key, text, account);
  }
  throw Object.assign(new Error("gemini_free_requires_collector"), { status: 409, expose: true });
}

async function bufferCreateNow(apiKey, channelId, text) {
  const key = String(apiKey || "").trim();
  const channel = String(channelId || "").trim();
  if (!key) throw new Error("buffer_api_key_missing");
  if (!channel) throw new Error("buffer_channel_id_missing");

  const query = `mutation CreatePost {
    createPost(input: {
      text: ${JSON.stringify(String(text || ""))}
      channelId: ${JSON.stringify(channel)}
      schedulingType: automatic
      mode: shareNow
      aiAssisted: true
    }) {
      __typename
      ... on PostActionSuccess {
        post { id text status dueAt }
      }
      ... on MutationError {
        message
      }
    }
  }`;

  const data = await bufferGraphql(key, query);
  const result = data?.createPost;
  if (!result?.post?.id) {
    throw new Error("buffer:" + (result?.message || result?.__typename || "create_post_failed"));
  }
  return result.post;
}

async function processAccountRoute(env, eventId, account, sourceText) {
  try {
    let secrets = {};
    if (account.encrypted_json) {
      secrets = await decryptJson(env.MASTER_KEY, account.encrypted_json);
    }
    const provider = accountAiProvider(secrets);
    const rewritten = await rewriteWithProvider(provider, secrets, sourceText, account);
    const post = await bufferCreateNow(secrets.buffer_api_key, account.buffer_channel_id, rewritten);

    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='posted',error=NULL WHERE event_id=? AND account_id=?"
    ).bind(eventId, account.id).run();

    await audit(env, "system", "router", "x_account.posted", "x_account", account.id, {
      event_id: eventId,
      buffer_post_id: post.id,
      buffer_status: post.status || null,
      child_id: account.child_id,
      source_length: String(sourceText || "").length,
      output_length: rewritten.length
    });
  } catch (error) {
    const detail = safeError(error);
    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='failed',error=? WHERE event_id=? AND account_id=?"
    ).bind(detail, eventId, account.id).run().catch(() => {});
    await audit(env, "system", "router", "x_account.post_failed", "x_account", account.id, {
      event_id: eventId,
      child_id: account.child_id,
      error: detail
    }).catch(() => {});
  }
}

async function processEventRoutes(env, eventId, routed, sourceText) {
  await Promise.all(routed.map((account) => processAccountRoute(env, eventId, account, sourceText)));
}

async function preflightInfra(infra) {
  const checks = [];

  await cloudflareRequest(infra, "/workers/scripts");
  checks.push("workers");

  const auth = btoa(infra.cloudinary_api_key + ":" + infra.cloudinary_api_secret);
  const cloudinary = await fetch(
    "https://api.cloudinary.com/v1_1/" + encodeURIComponent(infra.cloudinary_cloud_name) + "/usage",
    { headers: { Authorization: "Basic " + auth, Accept: "application/json" } }
  );
  if (!cloudinary.ok) {
    const detail = (await cloudinary.text()).slice(0, 600);
    throw Object.assign(
      new Error("cloudinary:" + (detail || ("HTTP " + cloudinary.status))),
      { status: 502, expose: true }
    );
  }
  checks.push("cloudinary");

  return checks;
}

async function ensureWorkersSubdomain(infra) {
  try {
    const current = await cloudflareRequest(infra, "/workers/subdomain");
    if (current?.result?.subdomain) return current.result.subdomain;
  } catch {
    // A new Cloudflare account may not have a workers.dev subdomain yet.
  }

  const tail = infra.cloudflare_account_id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-10);
  let lastError = null;
  for (let i = 0; i < 5; i++) {
    const candidate = "xmaster-" + tail + (i ? "-" + i : "");
    try {
      const created = await cloudflareRequest(infra, "/workers/subdomain", {
        method: "PUT",
        body: JSON.stringify({ subdomain: candidate })
      });
      if (created?.result?.subdomain) return created.result.subdomain;
    } catch (error) {
      lastError = error;
    }
  }
  throw Object.assign(
    new Error("cloudflare:workers_subdomain_unavailable" + (lastError ? ":" + safeError(lastError) : "")),
    { status: 502, expose: true }
  );
}

async function deployChildWorker(infra, child, childSecret, masterRoot) {
  const source = renderChildWorkerSource();
  const workerName = ("xm-" + child.slug + "-" + child.id.slice(-6)).slice(0, 62);
  let uploaded = false;

  try {
    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2026-09-18",
      bindings: [
        { type: "plain_text", name: "CHILD_ID", text: child.id },
        { type: "plain_text", name: "MASTER_ROOT", text: masterRoot },
        { type: "secret_text", name: "CHILD_SECRET", text: childSecret }
      ]
    };

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
    form.append("worker.js", new Blob([source], { type: "application/javascript+module" }), "worker.js");

    await cloudflareRequest(infra, "/workers/scripts/" + encodeURIComponent(workerName), {
      method: "PUT",
      body: form
    });
    uploaded = true;

    await cloudflareRequest(infra, "/workers/scripts/" + encodeURIComponent(workerName) + "/subdomain", {
      method: "POST",
      body: JSON.stringify({ enabled: true })
    });

    const subdomain = await ensureWorkersSubdomain(infra);
    const webUrl = "https://" + workerName + "." + subdomain + ".workers.dev";

    let healthy = false;
    let last = "";
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const response = await fetch(webUrl + "/health", { headers: { "cache-control": "no-cache" } });
        last = await response.text();
        if (response.ok) {
          const parsed = JSON.parse(last);
          if (parsed.ok && parsed.child_id === child.id) {
            healthy = true;
            break;
          }
        }
      } catch (error) {
        last = safeError(error);
      }
    }
    if (!healthy) {
      throw Object.assign(
        new Error("child_health_failed:" + last.slice(0, 400)),
        { status: 502, expose: true }
      );
    }

    return { workerName, webUrl };
  } catch (error) {
    if (uploaded) await deleteChildWorker(infra, workerName, true);
    throw error;
  }
}
async function deleteChildWorker(infra, workerName, bestEffort = false) {
  if (!workerName) return;
  try {
    await cloudflareRequest(infra, "/workers/scripts/" + encodeURIComponent(workerName), { method: "DELETE" });
  } catch (error) {
    if (!bestEffort) throw error;
  }
}

async function listSources(env) {
  const result = await env.DB.prepare(
    "SELECT id,title,username,channel_id,enabled,created_at,updated_at FROM sources WHERE enabled=1 ORDER BY lower(title),id"
  ).all();
  return result.results || [];
}

async function accountSources(env, accountId) {
  const result = await env.DB.prepare(
    `SELECT s.id,s.title,s.username,s.channel_id,s.enabled
     FROM sources s
     JOIN x_account_sources xs ON xs.source_id=s.id
     WHERE xs.account_id=?
     ORDER BY lower(s.title),s.id`
  ).bind(accountId).all();
  return result.results || [];
}

async function listXAccounts(env, childId) {
  const result = await env.DB.prepare(
    `SELECT id,child_id,display_name,x_handle,encrypted_json,buffer_channel_id,buffer_channel_name,
            content_mode,x_premium,enabled,created_at,updated_at
     FROM x_accounts WHERE child_id=? ORDER BY created_at,id`
  ).bind(childId).all();

  const accounts = [];
  for (const row of (result.results || [])) {
    let geminiConfigured = false;
    let deepseekConfigured = false;
    let bufferConfigured = false;
    let aiProvider = "gemini_paid";
    let settingsCorrupt = false;
    if (row.encrypted_json) {
      try {
        const secrets = await decryptJson(env.MASTER_KEY, row.encrypted_json);
        geminiConfigured = Boolean(secrets.gemini_api_key);
        deepseekConfigured = Boolean(secrets.deepseek_api_key);
        bufferConfigured = Boolean(secrets.buffer_api_key);
        aiProvider = accountAiProvider(secrets);
      } catch {
        settingsCorrupt = true;
      }
    }
    const sources = await accountSources(env, row.id);
    const lastRoute = await env.DB.prepare(
      "SELECT status,error,created_at FROM ingest_account_routes WHERE account_id=? ORDER BY created_at DESC LIMIT 1"
    ).bind(row.id).first();
    accounts.push({
      id: row.id,
      child_id: row.child_id,
      display_name: row.display_name,
      x_handle: row.x_handle || null,
      buffer_channel_id: row.buffer_channel_id || null,
      buffer_channel_name: row.buffer_channel_name || null,
      content_mode: row.content_mode || "news",
      x_premium: Boolean(row.x_premium),
      enabled: Boolean(row.enabled),
      ai_provider: aiProvider,
      ai_configured: aiProvider === "deepseek_paid" ? deepseekConfigured : geminiConfigured,
      gemini_configured: geminiConfigured,
      deepseek_configured: deepseekConfigured,
      buffer_configured: bufferConfigured,
      settings_corrupt: settingsCorrupt,
      last_post_status: lastRoute?.status || null,
      last_post_error: lastRoute?.error || null,
      last_post_at: lastRoute?.created_at || null,
      sources,
      source_ids: sources.map((s) => s.id),
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }
  return accounts;
}

async function listChildren(env) {
  const result = await env.DB.prepare(
    `SELECT c.id,c.name,c.slug,c.status,c.worker_name,c.web_url,c.last_health_at,c.last_error,c.created_at,c.updated_at,
       (SELECT COUNT(*) FROM x_accounts a WHERE a.child_id=c.id) AS account_count,
       (SELECT COUNT(DISTINCT xs.source_id)
          FROM x_accounts a JOIN x_account_sources xs ON xs.account_id=a.id
         WHERE a.child_id=c.id) AS source_count
     FROM children c ORDER BY c.created_at DESC`
  ).all();

  const children = [];
  for (const child of (result.results || [])) {
    children.push({ ...child, accounts: await listXAccounts(env, child.id) });
  }
  return children;
}

async function assignedSources(env, childId) {
  const result = await env.DB.prepare(
    `SELECT DISTINCT s.id,s.title,s.username,s.channel_id,s.enabled
     FROM sources s
     JOIN x_account_sources xs ON xs.source_id=s.id
     JOIN x_accounts a ON a.id=xs.account_id
     WHERE a.child_id=? ORDER BY lower(s.title),s.id`
  ).bind(childId).all();
  return result.results || [];
}

async function validateSourceIds(env, sourceIds) {
  const ids = [...new Set((Array.isArray(sourceIds) ? sourceIds : []).map(String).filter(Boolean))];
  if (!ids.length) return ids;
  const placeholders = ids.map(() => "?").join(",");
  const found = await env.DB.prepare(
    "SELECT id FROM sources WHERE id IN (" + placeholders + ")"
  ).bind(...ids).all();
  if ((found.results || []).length !== ids.length) {
    throw Object.assign(new Error("invalid_source_id"), { status: 400 });
  }
  return ids;
}

async function childMe(env, child) {
  return {
    child: { id: child.id, name: child.name, status: child.status },
    source_catalog: await listSources(env),
    accounts: await listXAccounts(env, child.id),
    limits: { max_accounts: 5 }
  };
}

async function saveXAccount(env, child, body, accountId = null) {
  const displayName = String(body.display_name || "").trim();
  const xHandle = String(body.x_handle || "").trim().replace(/^@/, "") || null;
  if (displayName.length < 2) throw Object.assign(new Error("account_name_required"), { status: 400 });

  const sourceIds = await validateSourceIds(env, body.source_ids);
  const mode = body.content_mode === "airdrop" ? "airdrop" : "news";
  const premium = body.x_premium ? 1 : 0;
  const enabled = body.enabled === false ? 0 : 1;
  const bufferChannelId = String(body.buffer_channel_id || "").trim() || null;
  const bufferChannelName = String(body.buffer_channel_name || "").trim() || null;

  let existing = null;
  if (accountId) {
    existing = await env.DB.prepare(
      "SELECT * FROM x_accounts WHERE id=? AND child_id=?"
    ).bind(accountId, child.id).first();
    if (!existing) throw Object.assign(new Error("x_account_not_found"), { status: 404 });
  } else {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM x_accounts WHERE child_id=?"
    ).bind(child.id).first();
    if (Number(count?.n || 0) >= 5) {
      throw Object.assign(new Error("x_account_limit_reached"), { status: 409 });
    }
  }

  let secrets = {};
  if (existing?.encrypted_json) {
    try {
      secrets = await decryptJson(env.MASTER_KEY, existing.encrypted_json);
    } catch {
      throw Object.assign(new Error("account_settings_decrypt_failed"), { status: 500 });
    }
  }
  const providerRaw = String(body.ai_provider || secrets.ai_provider || "gemini_paid");
  const aiProvider = ["gemini_free", "gemini_paid", "deepseek_paid"].includes(providerRaw) ? providerRaw : "gemini_paid";
  const aiKey = String(body.ai_api_key || body.gemini_api_key || "").trim();
  const buffer = String(body.buffer_api_key || "").trim();
  secrets.ai_provider = aiProvider;
  if (aiKey) {
    if (aiProvider === "deepseek_paid") secrets.deepseek_api_key = aiKey;
    else secrets.gemini_api_key = aiKey;
  }
  if (buffer) secrets.buffer_api_key = buffer;
  const encrypted = Object.keys(secrets).length ? await encryptJson(env.MASTER_KEY, secrets) : null;

  const finalId = accountId || id("xa");
  if (existing) {
    await env.DB.prepare(
      `UPDATE x_accounts
       SET display_name=?,x_handle=?,encrypted_json=?,buffer_channel_id=?,buffer_channel_name=?,
           content_mode=?,x_premium=?,enabled=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND child_id=?`
    ).bind(
      displayName,xHandle,encrypted,bufferChannelId,bufferChannelName,
      mode,premium,enabled,finalId,child.id
    ).run();
    await env.DB.prepare("DELETE FROM x_account_sources WHERE account_id=?").bind(finalId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO x_accounts(
        id,child_id,display_name,x_handle,encrypted_json,buffer_channel_id,buffer_channel_name,
        content_mode,x_premium,enabled
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      finalId,child.id,displayName,xHandle,encrypted,bufferChannelId,bufferChannelName,
      mode,premium,enabled
    ).run();
  }

  for (const sourceId of sourceIds) {
    await env.DB.prepare(
      "INSERT INTO x_account_sources(account_id,source_id) VALUES(?,?)"
    ).bind(finalId, sourceId).run();
  }

  await audit(env, "child", child.id, existing ? "x_account.updated" : "x_account.created", "x_account", finalId, {
    display_name: displayName,
    x_handle: xHandle,
    source_count: sourceIds.length,
    ai_provider: aiProvider,
    ai_updated: Boolean(aiKey),
    buffer_updated: Boolean(buffer),
    buffer_channel_id: bufferChannelId,
    content_mode: mode,
    x_premium: Boolean(premium),
    enabled: Boolean(enabled)
  });

  return {
    account: (await listXAccounts(env, child.id)).find((a) => a.id === finalId)
  };
}

async function testXAccount(env, child, accountId) {
  const account = await env.DB.prepare(
    "SELECT * FROM x_accounts WHERE id=? AND child_id=?"
  ).bind(accountId, child.id).first();
  if (!account) throw Object.assign(new Error("x_account_not_found"), { status: 404 });

  let secrets = {};
  if (account.encrypted_json) {
    secrets = await decryptJson(env.MASTER_KEY, account.encrypted_json);
  }
  const text = "X-Master connection test " + new Date().toISOString();
  const post = await bufferCreateNow(secrets.buffer_api_key, account.buffer_channel_id, text);
  await audit(env, "child", child.id, "x_account.test_posted", "x_account", account.id, {
    buffer_post_id: post.id,
    buffer_status: post.status || null
  });
  return { posted: true, post: { id: post.id, status: post.status || null } };
}

async function deleteXAccount(env, child, accountId) {
  const account = await env.DB.prepare(
    "SELECT id,display_name FROM x_accounts WHERE id=? AND child_id=?"
  ).bind(accountId, child.id).first();
  if (!account) throw Object.assign(new Error("x_account_not_found"), { status: 404 });
  await env.DB.prepare("DELETE FROM x_accounts WHERE id=? AND child_id=?").bind(accountId, child.id).run();
  await audit(env, "child", child.id, "x_account.deleted", "x_account", accountId, { display_name: account.display_name });
  return { deleted: true };
}

async function createChild(env, request, admin) {
  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const password = String(body.password || "");
  if (name.length < 2) throw Object.assign(new Error("child_name_required"), { status: 400 });
  if (password.length < 8) throw Object.assign(new Error("password_too_short"), { status: 400 });

  const infra = normalizeInfra(body);

  const jobId = id("job");
  await env.DB.prepare(
    "INSERT INTO deployment_jobs(id,action,status,step) VALUES(?,?,?,?)"
  ).bind(jobId, "create_child", "running", "preflight").run();

  let childId = null;
  let workerName = null;
  let deployed = false;

  try {
    await preflightInfra(infra);

    childId = id("ch");
    const slugBase = slugify(name);
    const slug = (slugBase + "-" + childId.slice(-5)).slice(0, 48);
    const passwordHash = await createPasswordHash(password);
    const childSecret = randomHex(32);
    const childSecretHash = await hmacHex(env.SESSION_PEPPER, childSecret);
    const encryptedInfra = await encryptJson(env.MASTER_KEY, infra);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO children(id,name,slug,status,password_hash,child_secret_hash) VALUES(?,?,?,?,?,?)"
      ).bind(childId, name, slug, "provisioning", passwordHash, childSecretHash),
      env.DB.prepare(
        "INSERT INTO child_infra(child_id,encrypted_json) VALUES(?,?)"
      ).bind(childId, encryptedInfra),
      env.DB.prepare(
        "INSERT INTO child_settings(child_id) VALUES(?)"
      ).bind(childId)
    ]);

    await env.DB.prepare(
      "UPDATE deployment_jobs SET child_id=?,step=? WHERE id=?"
    ).bind(childId, "deploy_worker", jobId).run();

    const masterRoot = new URL(request.url).origin;
    const child = { id: childId, name, slug };
    const deployedResult = await deployChildWorker(infra, child, childSecret, masterRoot);
    workerName = deployedResult.workerName;
    deployed = true;

    await env.DB.prepare(
      "UPDATE children SET status='ready',worker_name=?,web_url=?,last_health_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(workerName, deployedResult.webUrl, childId).run();

    await env.DB.prepare(
      "UPDATE deployment_jobs SET status='success',step='ready',finished_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(jobId).run();

    await audit(env, "admin", admin.id, "child.created", "child", childId, {
      name,
      worker_name: workerName,
      account_count: 0
    });

    return {
      child: {
        id: childId,
        name,
        slug,
        status: "ready",
        worker_name: workerName,
        web_url: deployedResult.webUrl,
        account_count: 0
      }
    };
  } catch (error) {
    if (deployed && workerName) await deleteChildWorker(infra, workerName, true);
    if (childId) {
      await env.DB.prepare("DELETE FROM children WHERE id=?").bind(childId).run().catch(() => {});
    }
    await env.DB.prepare(
      "UPDATE deployment_jobs SET status='rolled_back',step='failed',error=?,finished_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(safeError(error), jobId).run().catch(() => {});
    throw error;
  }
}

async function updateChild(env, request, admin, childId) {
  const child = await env.DB.prepare("SELECT * FROM children WHERE id=?").bind(childId).first();
  if (!child) throw Object.assign(new Error("child_not_found"), { status: 404 });
  const body = await readJson(request);

  if (body.password !== undefined) {
    const password = String(body.password || "");
    if (password.length < 8) throw Object.assign(new Error("password_too_short"), { status: 400 });
    const passwordHash = await createPasswordHash(password);
    await env.DB.prepare(
      "UPDATE children SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(passwordHash, childId).run();
    await env.DB.prepare(
      "UPDATE child_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE child_id=? AND revoked_at IS NULL"
    ).bind(childId).run();
    await audit(env, "admin", admin.id, "child.password_reset", "child", childId);
  }

  if (Array.isArray(body.source_ids)) {
    const sourceIds = [...new Set(body.source_ids.map(String))];
    if (sourceIds.length) {
      const placeholders = sourceIds.map(() => "?").join(",");
      const found = await env.DB.prepare("SELECT id FROM sources WHERE id IN (" + placeholders + ")").bind(...sourceIds).all();
      if ((found.results || []).length !== sourceIds.length) {
        throw Object.assign(new Error("invalid_source_id"), { status: 400 });
      }
    }
    await env.DB.prepare("DELETE FROM child_sources WHERE child_id=?").bind(childId).run();
    for (const sourceId of sourceIds) {
      await env.DB.prepare("INSERT INTO child_sources(child_id,source_id) VALUES(?,?)").bind(childId, sourceId).run();
    }
    await audit(env, "admin", admin.id, "child.sources_updated", "child", childId, { source_count: sourceIds.length });
  }

  if (body.status === "ready" || body.status === "paused") {
    await env.DB.prepare("UPDATE children SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(body.status, childId).run();
    await audit(env, "admin", admin.id, "child.status_changed", "child", childId, { status: body.status });
  }

  return { child: await env.DB.prepare("SELECT id,name,slug,status,web_url,worker_name FROM children WHERE id=?").bind(childId).first() };
}

async function deleteChild(env, admin, childId) {
  const child = await env.DB.prepare(
    "SELECT c.*,i.encrypted_json FROM children c LEFT JOIN child_infra i ON i.child_id=c.id WHERE c.id=?"
  ).bind(childId).first();
  if (!child) throw Object.assign(new Error("child_not_found"), { status: 404 });

  if (child.encrypted_json && child.worker_name) {
    const infra = await decryptJson(env.MASTER_KEY, child.encrypted_json);
    await deleteChildWorker(infra, child.worker_name);
  }

  await audit(env, "admin", admin.id, "child.deleted", "child", childId, { name: child.name, worker_name: child.worker_name });
  await env.DB.prepare("DELETE FROM children WHERE id=?").bind(childId).run();
  return { deleted: true };
}

async function loadAccountSecrets(env, accountId) {
  const account = await env.DB.prepare(
    "SELECT a.*,c.id AS child_id,c.name AS child_name FROM x_accounts a JOIN children c ON c.id=a.child_id WHERE a.id=?"
  ).bind(accountId).first();
  if (!account) throw Object.assign(new Error("x_account_not_found"), { status: 404 });

  let secrets = {};
  if (account.encrypted_json) {
    secrets = await decryptJson(env.MASTER_KEY, account.encrypted_json);
  }
  return { account, secrets };
}

async function adminTestGemini(env, admin, accountId) {
  const { account, secrets } = await loadAccountSecrets(env, accountId);
  const provider = accountAiProvider(secrets);
  if (provider === "gemini_free") {
    throw Object.assign(new Error("gemini_free_runs_on_collector_test_with_a_real_telegram_post"), { status: 409 });
  }
  const output = await rewriteWithProvider(
    provider,
    secrets,
    "X-Master AI connection test. Rewrite this into a short X post.",
    account
  );
  await audit(env, "admin", admin.id, "x_account.ai_test_ok", "x_account", account.id, {
    child_id: account.child_id,
    ai_provider: provider,
    output
  });
  return { ok: true, provider, output };
}

async function adminTestFullPipeline(env, admin, accountId) {
  const { account, secrets } = await loadAccountSecrets(env, accountId);
  const provider = accountAiProvider(secrets);
  if (provider === "gemini_free") {
    throw Object.assign(new Error("gemini_free_runs_on_collector_test_with_a_real_telegram_post"), { status: 409 });
  }
  const output = await rewriteWithProvider(
    provider,
    secrets,
    "X-Master full pipeline test. Rewrite this into a short X post confirming the automation connection.",
    account
  );
  const post = await bufferCreateNow(secrets.buffer_api_key, account.buffer_channel_id, output);
  await audit(env, "admin", admin.id, "x_account.pipeline_test_posted", "x_account", account.id, {
    child_id: account.child_id,
    ai_provider: provider,
    buffer_post_id: post.id,
    buffer_status: post.status || null,
    output
  });
  return { ok: true, provider, output, post: { id: post.id, status: post.status || null } };
}

async function adminTestXAccount(env, admin, accountId) {
  const { account, secrets } = await loadAccountSecrets(env, accountId);

  const text = "X-Master connection test " + new Date().toISOString();
  const post = await bufferCreateNow(secrets.buffer_api_key, account.buffer_channel_id, text);
  await audit(env, "admin", admin.id, "x_account.test_posted", "x_account", account.id, {
    buffer_post_id: post.id,
    buffer_status: post.status || null,
    child_id: account.child_id
  });

  return {
    posted: true,
    account: { id: account.id, display_name: account.display_name, child_id: account.child_id, child_name: account.child_name },
    post: { id: post.id, status: post.status || null }
  };
}

async function completeLocalAiResult(env, request) {
  await requireCollector(env, request);
  const body = await readJson(request);
  const eventId = String(body.event_id || "").trim();
  const accountId = String(body.account_id || "").trim();
  if (!eventId || !accountId) throw Object.assign(new Error("local_ai_result_ids_required"), { status: 400 });

  const route = await env.DB.prepare(
    `SELECT r.status,a.* FROM ingest_account_routes r
       JOIN x_accounts a ON a.id=r.account_id
      WHERE r.event_id=? AND r.account_id=?`
  ).bind(eventId, accountId).first();
  if (!route) throw Object.assign(new Error("local_ai_route_not_found"), { status: 404 });

  let secrets = {};
  if (route.encrypted_json) secrets = await decryptJson(env.MASTER_KEY, route.encrypted_json);
  if (accountAiProvider(secrets) !== "gemini_free") {
    throw Object.assign(new Error("local_ai_provider_mismatch"), { status: 409 });
  }

  const localError = String(body.error || "").trim();
  if (localError) {
    const detail = ("gemini_free:" + localError).slice(0, 1500);
    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='failed',error=? WHERE event_id=? AND account_id=?"
    ).bind(detail, eventId, accountId).run();
    await audit(env, "collector", "local", "x_account.post_failed", "x_account", accountId, {
      event_id: eventId,
      child_id: route.child_id,
      ai_provider: "gemini_free",
      error: detail
    });
    return { accepted: true, posted: false, error: detail };
  }

  const output = String(body.output || "").trim();
  if (!output) throw Object.assign(new Error("local_ai_output_required"), { status: 400 });

  try {
    const post = await bufferCreateNow(secrets.buffer_api_key, route.buffer_channel_id, output);
    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='posted',error=NULL WHERE event_id=? AND account_id=?"
    ).bind(eventId, accountId).run();
    await audit(env, "collector", "local", "x_account.posted", "x_account", accountId, {
      event_id: eventId,
      child_id: route.child_id,
      ai_provider: "gemini_free",
      buffer_post_id: post.id,
      buffer_status: post.status || null,
      output_length: output.length
    });
    return { accepted: true, posted: true, post: { id: post.id, status: post.status || null } };
  } catch (error) {
    const detail = safeError(error);
    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='failed',error=? WHERE event_id=? AND account_id=?"
    ).bind(detail, eventId, accountId).run().catch(() => {});
    await audit(env, "collector", "local", "x_account.post_failed", "x_account", accountId, {
      event_id: eventId,
      child_id: route.child_id,
      ai_provider: "gemini_free",
      error: detail
    }).catch(() => {});
    throw error;
  }
}

async function requireCollector(env, request) {
  const provided = request.headers.get("x-collector-secret") || "";
  if (!provided || !timingSafeEqual(provided, env.COLLECTOR_SECRET)) {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
}

async function syncCollectorCatalog(env, request) {
  await requireCollector(env, request);
  const body = await readJson(request);
  const incoming = Array.isArray(body.sources) ? body.sources.slice(0, 2000) : [];
  let synced = 0;

  await env.DB.prepare("UPDATE sources SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE enabled<>0").run();

  for (const raw of incoming) {
    const title = String(raw.title || raw.name || "").trim().slice(0, 300);
    const username = String(raw.username || "").trim().replace(/^@/, "").slice(0, 200) || null;
    const channelId = String(raw.channel_id || "").trim().slice(0, 100) || null;
    if (!title || (!username && !channelId)) continue;

    let existing = null;
    if (channelId) {
      existing = await env.DB.prepare("SELECT id FROM sources WHERE channel_id=? LIMIT 1").bind(channelId).first();
    }
    if (!existing && username) {
      existing = await env.DB.prepare("SELECT id FROM sources WHERE lower(username)=lower(?) LIMIT 1").bind(username).first();
    }

    if (existing) {
      await env.DB.prepare(
        "UPDATE sources SET title=?,username=?,channel_id=?,enabled=1,updated_at=CURRENT_TIMESTAMP WHERE id=?"
      ).bind(title, username, channelId, existing.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO sources(id,title,username,channel_id,enabled) VALUES(?,?,?,?,1)"
      ).bind(id("src"), title, username, channelId).run();
    }
    synced += 1;
  }

  await audit(env, "collector", "local", "collector.catalog_synced", "source", null, { count: synced });
  return { synced };
}

async function collectorSources(env) {
  const result = await env.DB.prepare(
    `SELECT DISTINCT s.id,s.title,s.username,s.channel_id
       FROM sources s
       JOIN x_account_sources xs ON xs.source_id=s.id
       JOIN x_accounts a ON a.id=xs.account_id
       JOIN children c ON c.id=a.child_id
      WHERE s.enabled=1 AND a.enabled=1 AND c.status='ready'
      ORDER BY lower(s.title),s.id`
  ).all();
  return result.results || [];
}

async function ingestEvent(env, request, ctx) {
  await requireCollector(env, request);
  const body = await readJson(request);
  const source = body.source || {};
  const username = String(source.username || "").trim().replace(/^@/, "");
  const channelId = String(source.channel_id || "").trim();

  const matched = await env.DB.prepare(
    `SELECT id,title,username,channel_id FROM sources
     WHERE enabled=1
       AND ((? <> '' AND channel_id=?) OR (? <> '' AND lower(username)=lower(?)))
     LIMIT 1`
  ).bind(channelId, channelId, username, username).first();

  if (!matched) throw Object.assign(new Error("source_not_registered"), { status: 404 });

  const routedResult = await env.DB.prepare(
    `SELECT a.id,a.display_name,a.x_handle,a.child_id,a.encrypted_json,a.buffer_channel_id,
            a.content_mode,a.x_premium,c.name AS child_name,c.web_url
       FROM x_accounts a
       JOIN x_account_sources xs ON xs.account_id=a.id
       JOIN children c ON c.id=a.child_id
      WHERE xs.source_id=? AND a.enabled=1 AND c.status='ready'
      ORDER BY c.created_at,a.created_at`
  ).bind(matched.id).all();

  const routed = routedResult.results || [];
  const uniqueChildren = [...new Set(routed.map((x) => x.child_id))];
  const externalId = String(body.external_id || "").trim() || null;
  const eventId = id("evt");

  try {
    await env.DB.prepare(
      `INSERT INTO ingest_events(id,source_id,external_id,text_content,media_json,routed_children_json,status)
       VALUES(?,?,?,?,?,?,?)`
    ).bind(
      eventId,
      matched.id,
      externalId,
      String(body.text || "").slice(0, 20000),
      JSON.stringify(Array.isArray(body.media) ? body.media : []),
      JSON.stringify(uniqueChildren),
      "accepted"
    ).run();
  } catch (error) {
    if (externalId && String(error).toLowerCase().includes("unique")) {
      return { accepted: false, duplicate: true, source: matched, routed_accounts: routed.length };
    }
    throw error;
  }

  const paidRoutes = [];
  const localAiJobs = [];
  const sourceText = String(body.text || "");

  for (const account of routed) {
    let secrets = {};
    if (account.encrypted_json) secrets = await decryptJson(env.MASTER_KEY, account.encrypted_json);
    const provider = accountAiProvider(secrets);
    const status = provider === "gemini_free" ? "local_ai_pending" : "queued";

    await env.DB.prepare(
      "INSERT OR IGNORE INTO ingest_account_routes(event_id,account_id,status) VALUES(?,?,?)"
    ).bind(eventId, account.id, status).run();

    if (provider === "gemini_free") {
      if (!secrets.gemini_api_key) {
        const detail = "gemini_free:gemini_api_key_missing";
        await env.DB.prepare(
          "UPDATE ingest_account_routes SET status='failed',error=? WHERE event_id=? AND account_id=?"
        ).bind(detail, eventId, account.id).run();
        await audit(env, "system", "router", "x_account.post_failed", "x_account", account.id, {
          event_id: eventId,
          child_id: account.child_id,
          ai_provider: provider,
          error: detail
        });
      } else {
        localAiJobs.push({
          event_id: eventId,
          account_id: account.id,
          display_name: account.display_name,
          api_key: secrets.gemini_api_key,
          model: "gemini-3.1-flash-lite",
          text: sourceText,
          content_mode: account.content_mode || "news",
          x_premium: Boolean(account.x_premium)
        });
      }
    } else {
      paidRoutes.push(account);
    }
  }

  const processing = processEventRoutes(env, eventId, paidRoutes, sourceText);
  if (ctx?.waitUntil) ctx.waitUntil(processing);
  else await processing;

  await audit(env, "collector", "local", "ingest.accepted", "source", matched.id, {
    event_id: eventId,
    routed_accounts: routed.length,
    routed_children: uniqueChildren.length,
    external_id: externalId
  });

  return {
    accepted: true,
    event_id: eventId,
    source: matched,
    routed_children: uniqueChildren.length,
    local_ai_jobs: localAiJobs,
    routed_accounts: routed.map((x) => ({
      id: x.id,
      display_name: x.display_name,
      x_handle: x.x_handle,
      child_id: x.child_id,
      child_name: x.child_name
    }))
  };
}

async function handleApi(request, env, ctx) {
  await requireBindings(env);
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/collector/sources" && request.method === "GET") {
    await requireCollector(env, request);
    return json({ sources: await collectorSources(env) });
  }

  if (path === "/collector/catalog" && request.method === "POST") {
    return json(await syncCollectorCatalog(env, request));
  }

  if (path === "/collector/local-ai-result" && request.method === "POST") {
    return json(await completeLocalAiResult(env, request));
  }

  if (path === "/ingest" && request.method === "POST") {
    return json(await ingestEvent(env, request, ctx), 202);
  }

  if (path === "/api/health" && request.method === "GET") {
    let database = false;
    try {
      const row = await env.DB.prepare("SELECT 1 ok").first();
      database = Number(row?.ok || 0) === 1;
    } catch {}
    return json({
      ok: database,
      service: "x-master-router",
      version: "0.2.3",
      database,
      architecture: "master-router-child-web",
      collector_ready: Boolean(env.COLLECTOR_SECRET)
    }, database ? 200 : 503);
  }

  if (path === "/api/admin/login" && request.method === "POST") {
    const body = await readJson(request);
    const valid = await verifyPassword(String(body.password || ""), env.ADMIN_PASSWORD_HASH);
    if (!valid) throw Object.assign(new Error("invalid_credentials"), { status: 401 });
    const token = await createAdminSession(env);
    await audit(env, "admin", "owner", "admin.login");
    return json({ ok: true }, 200, {
      "set-cookie": ADMIN_COOKIE + "=" + encodeURIComponent(token) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + ADMIN_TTL_SECONDS
    });
  }

  if (path === "/api/admin/logout" && request.method === "POST") {
    const raw = cookieValue(request, ADMIN_COOKIE);
    if (raw) {
      const hash = await hmacHex(env.SESSION_PEPPER, raw);
      await env.DB.prepare("UPDATE admin_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=?").bind(hash).run();
    }
    return json({ ok: true }, 200, {
      "set-cookie": ADMIN_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
    });
  }

  if (path.startsWith("/api/admin/")) {
    const admin = await requireAdmin(env, request);

    if (path === "/api/admin/dashboard" && request.method === "GET") {
      return json({
        ok: true,
        sources: await listSources(env),
        children: await listChildren(env)
      });
    }

    if (path === "/api/admin/sources" && request.method === "GET") {
      return json({ sources: await listSources(env) });
    }

    if (path === "/api/admin/sources" && request.method === "POST") {
      const source = normalizeSource(await readJson(request));
      const sourceId = id("src");
      await env.DB.prepare(
        "INSERT INTO sources(id,title,username,channel_id) VALUES(?,?,?,?)"
      ).bind(sourceId, source.title, source.username, source.channelId).run();
      await audit(env, "admin", admin.id, "source.created", "source", sourceId, source);
      return json({ source: { id: sourceId, ...source } }, 201);
    }

    const sourceMatch = path.match(/^\/api\/admin\/sources\/([^/]+)$/);
    if (sourceMatch && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM sources WHERE id=?").bind(sourceMatch[1]).run();
      await audit(env, "admin", admin.id, "source.deleted", "source", sourceMatch[1]);
      return json({ deleted: true });
    }

    if (path === "/api/admin/children/preflight" && request.method === "POST") {
      const infra = normalizeInfra(await readJson(request));
      const checks = await preflightInfra(infra);
      return json({ ok: true, checks });
    }

    if (path === "/api/admin/children" && request.method === "POST") {
      const result = await createChild(env, request, admin);
      return json(result, 201);
    }

    if (path === "/api/admin/children" && request.method === "GET") {
      return json({ children: await listChildren(env) });
    }

    const childMatch = path.match(/^\/api\/admin\/children\/([^/]+)$/);
    if (childMatch && request.method === "PATCH") {
      return json(await updateChild(env, request, admin, childMatch[1]));
    }
    if (childMatch && request.method === "DELETE") {
      return json(await deleteChild(env, admin, childMatch[1]));
    }

    const adminGeminiMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/test-gemini$/);
    if (adminGeminiMatch && request.method === "POST") {
      return json(await adminTestGemini(env, admin, adminGeminiMatch[1]));
    }

    const adminPipelineMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/test-pipeline$/);
    if (adminPipelineMatch && request.method === "POST") {
      return json(await adminTestFullPipeline(env, admin, adminPipelineMatch[1]));
    }

    const adminTestMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/test-post$/);
    if (adminTestMatch && request.method === "POST") {
      return json(await adminTestXAccount(env, admin, adminTestMatch[1]));
    }

    if (path === "/api/admin/audit" && request.method === "GET") {
      const result = await env.DB.prepare(
        "SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200"
      ).all();
      return json({ audit_logs: result.results || [] });
    }
  }

  if (path.startsWith("/internal/child/")) {
    const child = await verifyChildCaller(env, request);

    if (path === "/internal/child/health" && request.method === "GET") {
      return json({ ok: true, child_id: child.id, status: child.status });
    }

    if (child.status === "paused") throw Object.assign(new Error("child_paused"), { status: 403 });

    if (path === "/internal/child/login" && request.method === "POST") {
      const body = await readJson(request);
      const valid = await verifyPassword(String(body.password || ""), child.password_hash);
      if (!valid) throw Object.assign(new Error("invalid_credentials"), { status: 401 });
      const token = await createChildSession(env, child.id);
      await audit(env, "child", child.id, "child.login", "child", child.id);
      return json({ ok: true }, 200, { "x-child-session": token });
    }

    const sessionRaw = request.headers.get("x-child-session") || "";
    await requireChildSession(env, child.id, sessionRaw);

    if (path === "/internal/child/me" && request.method === "GET") {
      return json(await childMe(env, child));
    }

    if (path === "/internal/child/buffer/channels" && request.method === "POST") {
      const body = await readJson(request);
      return json({ channels: await bufferXChannels(body.buffer_api_key) });
    }

    if (path === "/internal/child/accounts" && request.method === "POST") {
      return json(await saveXAccount(env, child, await readJson(request)), 201);
    }

    const testPostMatch = path.match(/^\/internal\/child\/accounts\/([^/]+)\/test-post$/);
    if (testPostMatch && request.method === "POST") {
      return json(await testXAccount(env, child, testPostMatch[1]));
    }

    const accountMatch = path.match(/^\/internal\/child\/accounts\/([^/]+)$/);
    if (accountMatch && request.method === "PATCH") {
      return json(await saveXAccount(env, child, await readJson(request), accountMatch[1]));
    }
    if (accountMatch && request.method === "DELETE") {
      return json(await deleteXAccount(env, child, accountMatch[1]));
    }
  }

  throw Object.assign(new Error("not_found"), { status: 404 });
}

export const __test = {
  ensureWorkersSubdomain,
  deployChildWorker,
  geminiRewrite,
  bufferCreateNow
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/") || url.pathname === "/ingest" || url.pathname.startsWith("/collector/")) {
        return await handleApi(request, env, ctx);
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("X-Master Router", { status: 200 });
    } catch (error) {
      const status = Number(error?.status || 500);
      return json({
        ok: false,
        error: error?.expose ? safeError(error) : (status >= 500 ? "internal_error" : safeError(error))
      }, status);
    }
  }
};

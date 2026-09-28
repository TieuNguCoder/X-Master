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
    "SELECT id,title,username,channel_id,enabled,created_at,updated_at FROM sources ORDER BY created_at DESC"
  ).all();
  return result.results || [];
}

async function listChildren(env) {
  const result = await env.DB.prepare(
    `SELECT c.id,c.name,c.slug,c.status,c.worker_name,c.web_url,c.last_health_at,c.last_error,c.created_at,c.updated_at,
       (SELECT COUNT(*) FROM child_sources cs WHERE cs.child_id=c.id) AS source_count
     FROM children c ORDER BY c.created_at DESC`
  ).all();
  return result.results || [];
}

async function assignedSources(env, childId) {
  const result = await env.DB.prepare(
    `SELECT s.id,s.title,s.username,s.channel_id,s.enabled
     FROM sources s JOIN child_sources cs ON cs.source_id=s.id
     WHERE cs.child_id=? ORDER BY s.title`
  ).bind(childId).all();
  return result.results || [];
}

async function createChild(env, request, admin) {
  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const password = String(body.password || "");
  if (name.length < 2) throw Object.assign(new Error("child_name_required"), { status: 400 });
  if (password.length < 8) throw Object.assign(new Error("password_too_short"), { status: 400 });

  const infra = normalizeInfra(body);
  const sourceIds = [...new Set((Array.isArray(body.source_ids) ? body.source_ids : []).map(String))];

  if (sourceIds.length) {
    const placeholders = sourceIds.map(() => "?").join(",");
    const found = await env.DB.prepare("SELECT id FROM sources WHERE id IN (" + placeholders + ")").bind(...sourceIds).all();
    if ((found.results || []).length !== sourceIds.length) {
      throw Object.assign(new Error("invalid_source_id"), { status: 400 });
    }
  }

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

    for (const sourceId of sourceIds) {
      await env.DB.prepare("INSERT INTO child_sources(child_id,source_id) VALUES(?,?)").bind(childId, sourceId).run();
    }

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
      source_count: sourceIds.length
    });

    return {
      child: {
        id: childId,
        name,
        slug,
        status: "ready",
        worker_name: workerName,
        web_url: deployedResult.webUrl,
        source_count: sourceIds.length
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
    const passwordHash = await createPasswordHash(String(body.password || ""));
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

async function childMe(env, child) {
  const settings = await env.DB.prepare(
    "SELECT content_mode,x_premium,enabled,buffer_channel_id,buffer_channel_name,encrypted_json FROM child_settings WHERE child_id=?"
  ).bind(child.id).first();

  let secretState = { gemini_configured: false, buffer_configured: false };
  if (settings?.encrypted_json) {
    try {
      const secrets = await decryptJson(env.MASTER_KEY, settings.encrypted_json);
      secretState = {
        gemini_configured: Boolean(secrets.gemini_api_key),
        buffer_configured: Boolean(secrets.buffer_api_key)
      };
    } catch {}
  }

  return {
    child: { id: child.id, name: child.name, status: child.status },
    sources: await assignedSources(env, child.id),
    settings: {
      content_mode: settings?.content_mode || "news",
      x_premium: Boolean(settings?.x_premium),
      enabled: settings ? Boolean(settings.enabled) : true,
      buffer_channel_id: settings?.buffer_channel_id || null,
      buffer_channel_name: settings?.buffer_channel_name || null,
      ...secretState
    }
  };
}

async function saveChildSettings(env, child, body) {
  const current = await env.DB.prepare("SELECT * FROM child_settings WHERE child_id=?").bind(child.id).first();
  let secrets = {};
  if (current?.encrypted_json) {
    try {
      secrets = await decryptJson(env.MASTER_KEY, current.encrypted_json);
    } catch {
      throw Object.assign(new Error("settings_decrypt_failed"), { status: 500 });
    }
  }

  const gemini = String(body.gemini_api_key || "").trim();
  const buffer = String(body.buffer_api_key || "").trim();
  if (gemini) secrets.gemini_api_key = gemini;
  if (buffer) secrets.buffer_api_key = buffer;

  const encrypted = Object.keys(secrets).length ? await encryptJson(env.MASTER_KEY, secrets) : null;
  const mode = body.content_mode === "airdrop" ? "airdrop" : "news";
  const premium = body.x_premium ? 1 : 0;

  await env.DB.prepare(
    `UPDATE child_settings
     SET encrypted_json=?,content_mode=?,x_premium=?,updated_at=CURRENT_TIMESTAMP
     WHERE child_id=?`
  ).bind(encrypted, mode, premium, child.id).run();

  await audit(env, "child", child.id, "child.settings_updated", "child", child.id, {
    gemini_updated: Boolean(gemini),
    buffer_updated: Boolean(buffer),
    content_mode: mode,
    x_premium: Boolean(premium)
  });

  return { saved: true };
}

async function requireCollector(env, request) {
  const provided = request.headers.get("x-collector-secret") || "";
  if (!provided || !timingSafeEqual(provided, env.COLLECTOR_SECRET)) {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
}

async function collectorSources(env) {
  const result = await env.DB.prepare(
    "SELECT id,title,username,channel_id FROM sources WHERE enabled=1 ORDER BY title"
  ).all();
  return result.results || [];
}

async function ingestEvent(env, request) {
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

  const children = await env.DB.prepare(
    `SELECT c.id,c.name,c.web_url
     FROM children c
     JOIN child_sources cs ON cs.child_id=c.id
     JOIN child_settings st ON st.child_id=c.id
     WHERE cs.source_id=? AND c.status='ready' AND st.enabled=1
     ORDER BY c.created_at`
  ).bind(matched.id).all();

  const routed = children.results || [];
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
      JSON.stringify(routed.map((x) => x.id)),
      "accepted"
    ).run();
  } catch (error) {
    if (externalId && String(error).toLowerCase().includes("unique")) {
      return { accepted: false, duplicate: true, source: matched, routed_children: routed.length };
    }
    throw error;
  }

  await audit(env, "collector", "local", "ingest.accepted", "source", matched.id, {
    event_id: eventId,
    routed_children: routed.length,
    external_id: externalId
  });

  return {
    accepted: true,
    event_id: eventId,
    source: matched,
    routed_children: routed.map((x) => ({ id: x.id, name: x.name }))
  };
}

async function handleApi(request, env) {
  await requireBindings(env);
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/collector/sources" && request.method === "GET") {
    await requireCollector(env, request);
    return json({ sources: await collectorSources(env) });
  }

  if (path === "/ingest" && request.method === "POST") {
    return json(await ingestEvent(env, request), 202);
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
      version: "0.1.1",
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

    if (path === "/api/admin/audit" && request.method === "GET") {
      const result = await env.DB.prepare(
        "SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200"
      ).all();
      return json({ audit_logs: result.results || [] });
    }
  }

  if (path.startsWith("/internal/child/")) {
    const child = await verifyChildCaller(env, request);
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

    if (path === "/internal/child/settings" && request.method === "PUT") {
      return json(await saveChildSettings(env, child, await readJson(request)));
    }
  }

  throw Object.assign(new Error("not_found"), { status: 404 });
}

export const __test = {
  ensureWorkersSubdomain,
  deployChildWorker
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/") || url.pathname === "/ingest" || url.pathname.startsWith("/collector/")) {
        return await handleApi(request, env);
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

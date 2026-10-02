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
import { renderAccountRouterSource } from "./account-router-template.js";

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
  for (const key of ["DB", "MASTER_KEY", "SESSION_PEPPER", "ADMIN_PASSWORD_HASH", "COLLECTOR_SECRET", "CF_ACCOUNT_ID", "CF_API_TOKEN"]) {
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

function normalizeChildInfra(body) {
  const infra = {
    cloudinary_cloud_name: String(body.cloudinary_cloud_name || "").trim(),
    cloudinary_api_key: String(body.cloudinary_api_key || "").trim(),
    cloudinary_api_secret: String(body.cloudinary_api_secret || "").trim()
  };
  if (!infra.cloudinary_cloud_name || !infra.cloudinary_api_key || !infra.cloudinary_api_secret) {
    throw Object.assign(new Error("cloudinary_credentials_required"), { status: 400 });
  }
  return infra;
}

function masterCloudflareInfra(env) {
  const infra = {
    cloudflare_account_id: String(env.CF_ACCOUNT_ID || "").trim(),
    cloudflare_api_token: String(env.CF_API_TOKEN || "").trim()
  };
  if (infra.cloudflare_account_id.length < 8 || infra.cloudflare_api_token.length < 16) {
    throw Object.assign(new Error("master_cloudflare_credentials_missing"), { status: 503 });
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


async function cloudflareUsageSummary(env) {
  const infra = masterCloudflareInfra(env);

  let workerCount = null;
  let workerNames = [];
  try {
    const scripts = await cloudflareRequest(infra, "/workers/scripts?per_page=1000", { method: "GET" });
    const rows = Array.isArray(scripts?.result) ? scripts.result : [];
    workerNames = rows.map((x) => String(x?.id || x?.name || "")).filter(Boolean);
    workerCount = workerNames.length;
  } catch (error) {
    workerCount = null;
  }

  const billingUrl =
    "https://api.cloudflare.com/client/v4/accounts/" + infra.cloudflare_account_id + "/billable/usage";
  const response = await fetch(billingUrl, {
    method: "GET",
    headers: { Authorization: "Bearer " + infra.cloudflare_api_token }
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text || "{}"); } catch { body = { raw: text }; }

  if (!response.ok || body.success === false) {
    const detail = (body.errors || []).map((e) => e.message || String(e)).join("; ") ||
      body.raw || ("HTTP " + response.status);
    const billingPermissionRequired = response.status === 401 || response.status === 403 ||
      /permission|authorization|authentication|access/i.test(detail);
    return {
      ok: true,
      account_id_masked: infra.cloudflare_account_id.slice(0, 6) + "…" + infra.cloudflare_account_id.slice(-4),
      worker_count: workerCount,
      worker_limit_reference: 500,
      worker_names: workerNames,
      billing: {
        available: false,
        permission_required: billingPermissionRequired,
        status: response.status,
        error: detail
      }
    };
  }

  const rows = Array.isArray(body.result) ? body.result : [];
  const grouped = new Map();
  let totalCost = 0;
  let costAvailable = false;
  let currency = null;
  let periodStart = null;
  let periodEnd = null;

  for (const row of rows) {
    const metricId = String(row.x_BillableMetricId || row.x_BillableMetricName || row.ChargeDescription || "unknown");
    const metricName = String(row.x_BillableMetricName || row.ChargeDescription || metricId);
    const product = String(row.x_ProductFamilyName || row.ServiceFamilyName || row.x_ProductCategoryName || "Other");
    const unit = String(row.ConsumedUnit || row.PricingUnit || "units");
    const key = product + "\u0000" + metricId + "\u0000" + unit;
    const quantity = Number(row.ConsumedQuantity || 0);
    const rawCost = row.BilledCost ?? row.EffectiveCost ?? row.ContractedCost;
    const numericCost = rawCost == null ? null : Number(rawCost);

    if (!grouped.has(key)) {
      grouped.set(key, {
        product,
        metric_id: metricId,
        metric_name: metricName,
        unit,
        quantity: 0,
        billed_cost: 0,
        cost_available: false
      });
    }
    const item = grouped.get(key);
    item.quantity += Number.isFinite(quantity) ? quantity : 0;
    if (numericCost != null && Number.isFinite(numericCost)) {
      item.billed_cost += numericCost;
      item.cost_available = true;
      totalCost += numericCost;
      costAvailable = true;
    }

    currency = currency || row.BillingCurrency || null;
    const rowStart = row.BillingPeriodStart || row.ChargePeriodStart || null;
    const rowEnd = row.BillingPeriodEnd || row.ChargePeriodEnd || null;
    if (rowStart && (!periodStart || rowStart < periodStart)) periodStart = rowStart;
    if (rowEnd && (!periodEnd || rowEnd > periodEnd)) periodEnd = rowEnd;
  }

  const metrics = [...grouped.values()].sort((a, b) =>
    a.product.localeCompare(b.product) || a.metric_name.localeCompare(b.metric_name)
  );
  const products = {};
  for (const metric of metrics) {
    if (!products[metric.product]) products[metric.product] = { metrics: 0, billed_cost: 0, cost_available: false };
    products[metric.product].metrics += 1;
    if (metric.cost_available) {
      products[metric.product].billed_cost += metric.billed_cost;
      products[metric.product].cost_available = true;
    }
  }

  return {
    ok: true,
    account_id_masked: infra.cloudflare_account_id.slice(0, 6) + "…" + infra.cloudflare_account_id.slice(-4),
    worker_count: workerCount,
    worker_limit_reference: 500,
    worker_names: workerNames,
    billing: {
      available: true,
      permission_required: false,
      period_start: periodStart,
      period_end: periodEnd,
      currency,
      total_billed_cost: totalCost,
      cost_available: costAvailable,
      records: rows.length,
      products,
      metrics
    }
  };
}

async function cloudflareWorkerProbe(infra, workerName) {
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + infra.cloudflare_account_id +
      "/workers/scripts/" + encodeURIComponent(workerName),
    { headers: { Authorization: "Bearer " + infra.cloudflare_api_token } }
  );
  if (response.status === 404) return { exists: false, status: 404 };
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text || "{}"); } catch { body = { raw: text }; }
  if (!response.ok || body.success === false) {
    const detail = (body.errors || []).map((e) => e.message || String(e)).join("; ") || body.raw || ("HTTP " + response.status);
    throw Object.assign(new Error("cloudflare:" + detail), { status: 502, expose: true });
  }
  return { exists: true, status: response.status };
}

async function setCloudflareWorkerEnabled(infra, workerName, enabled) {
  const probe = await cloudflareWorkerProbe(infra, workerName);
  if (!probe.exists) return { worker_name: workerName, exists: false, enabled: false };

  const path = "/workers/scripts/" + encodeURIComponent(workerName) + "/subdomain";
  if (enabled) {
    await cloudflareRequest(infra, path, {
      method: "POST",
      body: JSON.stringify({ enabled: true, previews_enabled: false })
    });
  } else {
    await cloudflareRequest(infra, path, { method: "DELETE" });
  }

  const state = await cloudflareRequest(infra, path, { method: "GET" });
  const actual = Boolean(state?.result?.enabled);
  if (actual !== Boolean(enabled)) {
    throw Object.assign(new Error("cloudflare_worker_state_verification_failed:" + workerName), { status: 502, expose: true });
  }
  return { worker_name: workerName, exists: true, enabled: actual };
}

async function deleteCloudflareWorkerVerified(infra, workerName) {
  const before = await cloudflareWorkerProbe(infra, workerName);
  if (!before.exists) {
    return { worker_name: workerName, existed: false, deleted: false, verified_absent: true };
  }

  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + infra.cloudflare_account_id +
      "/workers/scripts/" + encodeURIComponent(workerName) + "?force=true",
    {
      method: "DELETE",
      headers: { Authorization: "Bearer " + infra.cloudflare_api_token }
    }
  );
  const text = await response.text();
  if (!response.ok) {
    let body = {};
    try { body = JSON.parse(text || "{}"); } catch { body = { raw: text }; }
    const detail = (body.errors || []).map((e) => e.message || String(e)).join("; ") || body.raw || ("HTTP " + response.status);
    throw Object.assign(new Error("cloudflare:" + detail), { status: 502, expose: true });
  }

  const after = await cloudflareWorkerProbe(infra, workerName);
  if (after.exists) {
    throw Object.assign(new Error("cloudflare_worker_delete_verification_failed:" + workerName), { status: 502, expose: true });
  }
  return { worker_name: workerName, existed: true, deleted: true, verified_absent: true };
}

function sameCloudflareInfra(a, b) {
  return Boolean(a && b &&
    String(a.cloudflare_account_id || "") === String(b.cloudflare_account_id || "") &&
    String(a.cloudflare_api_token || "") === String(b.cloudflare_api_token || ""));
}

async function childCloudflareCandidates(env, child) {
  const candidates = [{ kind: "master", infra: masterCloudflareInfra(env) }];
  if (!child?.encrypted_json) return candidates;

  try {
    const stored = await decryptJson(env.MASTER_KEY, child.encrypted_json);
    const legacy = {
      cloudflare_account_id: String(stored.cloudflare_account_id || "").trim(),
      cloudflare_api_token: String(stored.cloudflare_api_token || "").trim()
    };
    if (legacy.cloudflare_account_id.length >= 8 && legacy.cloudflare_api_token.length >= 16 &&
        !candidates.some((x) => sameCloudflareInfra(x.infra, legacy))) {
      candidates.push({ kind: "legacy", infra: legacy });
    }
  } catch {}
  return candidates;
}

async function locateWorkerCandidates(env, child, workerName) {
  const found = [];
  const candidates = await childCloudflareCandidates(env, child);
  for (const candidate of candidates) {
    const probe = await cloudflareWorkerProbe(candidate.infra, workerName);
    if (probe.exists) found.push(candidate);
  }
  return { found, candidates };
}

async function currentWorkersDevSubdomain(env) {
  try {
    const infra = masterCloudflareInfra(env);
    const body = await cloudflareRequest(infra, "/workers/subdomain", { method: "GET" });
    return String(body?.result?.subdomain || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function workersDevSubdomainFromUrl(url) {
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    const suffix = ".workers.dev";
    if (!host.endsWith(suffix)) return "";
    const left = host.slice(0, -suffix.length);
    const parts = left.split(".");
    return parts.length >= 2 ? parts[parts.length - 1] : "";
  } catch {
    return "";
  }
}

async function manageChildWorkers(env, child, action) {
  const slots = await listRouterSlots(env, child.id);
  const targets = [
    ...(child.worker_name ? [{ kind: "user", worker_name: child.worker_name, web_url: child.web_url || "" }] : []),
    ...slots.filter((x) => x.worker_name).map((x) => ({
      kind: "router",
      worker_name: x.worker_name,
      web_url: x.web_url || "",
      slot_index: Number(x.slot_index)
    }))
  ];

  const currentSubdomain = await currentWorkersDevSubdomain(env);
  const results = [];
  const unresolved = [];

  for (const target of targets) {
    const located = await locateWorkerCandidates(env, child, target.worker_name);
    if (!located.found.length) {
      const targetSubdomain = workersDevSubdomainFromUrl(target.web_url);
      const looksLegacyUnknown = Boolean(targetSubdomain && currentSubdomain && targetSubdomain !== currentSubdomain);
      if (looksLegacyUnknown || action === "resume") {
        unresolved.push({
          worker_name: target.worker_name,
          workers_dev_subdomain: targetSubdomain || null,
          reason: looksLegacyUnknown ? "legacy_worker_credentials_unavailable" : "worker_missing_cannot_resume"
        });
        continue;
      }
      results.push({
        ...target,
        already_absent: true,
        verified_on_known_accounts: true
      });
      continue;
    }

    for (const locatedCandidate of located.found) {
      if (action === "delete") {
        results.push({
          ...target,
          account_kind: locatedCandidate.kind,
          ...(await deleteCloudflareWorkerVerified(locatedCandidate.infra, target.worker_name))
        });
      } else {
        results.push({
          ...target,
          account_kind: locatedCandidate.kind,
          ...(await setCloudflareWorkerEnabled(locatedCandidate.infra, target.worker_name, action === "resume"))
        });
      }
    }
  }

  if (unresolved.length) {
    const error = Object.assign(new Error(
      "legacy_worker_credentials_required:" + unresolved.map((x) => x.worker_name).join(",")
    ), { status: 409, expose: true });
    error.unresolved = unresolved;
    throw error;
  }
  return { action, results, targets: targets.length };
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
        serviceId
        externalLink
        avatar
        isQueuePaused
        isDisconnected
        isLocked
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
          service_id: channel.serviceId || null,
          external_link: channel.externalLink || null,
          avatar: channel.avatar || null,
          x_handle: (() => {
            try {
              const u = new URL(String(channel.externalLink || ""));
              const part = u.pathname.split("/").filter(Boolean).pop();
              return String(part || channel.name || "").replace(/^@/, "") || null;
            } catch {
              return String(channel.name || "").replace(/^@/, "") || null;
            }
          })(),
          organization_id: org.id,
          organization_name: org.name || null,
          queue_paused: Boolean(channel.isQueuePaused),
          disconnected: Boolean(channel.isDisconnected),
          locked: Boolean(channel.isLocked)
        });
      }
    }
  }
  return channels;
}

function extractSourceUrls(text) {
  return String(text || "").match(/https?:\/\/[^\s<>()]+/g) || [];
}

function accountPostLanguage(secrets) {
  const value = String(secrets?.post_language || "en-US").trim();
  return value.slice(0, 80) || "en-US";
}

function languageInstruction(value) {
  const code = String(value || "en-US").trim() || "en-US";
  const names = {
    "en-US": "English (United States)",
    "en-GB": "English (United Kingdom)",
    "vi-VN": "Vietnamese",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
    "es-ES": "Spanish",
    "pt-BR": "Portuguese (Brazil)",
    "fr-FR": "French",
    "de-DE": "German",
    "id-ID": "Indonesian",
    "th-TH": "Thai",
    "ru-RU": "Russian",
    "tr-TR": "Turkish",
    "hi-IN": "Hindi",
    "ar-SA": "Arabic"
  };
  const name = names[code] || code;
  return {
    code,
    name,
    rule: "TARGET LANGUAGE: " + name + " (" + code + "). Write the entire post naturally for readers of this language. Translate SOURCE content as needed. Keep URLs, @usernames, ticker symbols, brand/project names, and proper nouns unchanged when translation would be unnatural. Hashtags should suit the target audience/language, though universal topic hashtags may remain in English."
  };
}

function rewritePrompt(text, account) {
  const sourceText = String(text || "").trim();
  if (!sourceText) throw Object.assign(new Error("empty_source_text"), { status: 400 });

  const premium = Boolean(account.x_premium);
  const mode = account.content_mode === "airdrop" ? "airdrop" : account.content_mode === "both" ? "both" : "news";
  const maxChars = premium ? 1600 : 275;
  const urls = extractSourceUrls(sourceText);
  const language = languageInstruction(account.post_language || "en-US");

  const universal = [
    "You are rewriting a Telegram source post into a ready-to-publish X post.",
    "Use ONLY facts present in SOURCE. Never invent rewards, amounts, token prices, dates, deadlines, eligibility, partnerships, quotes, statistics, links, or guarantees.",
    language.rule,
    "Do not mention Telegram, rewriting, AI, or the source.",
    "Do not use markdown tables or code fences.",
    "Keep every important URL from SOURCE exactly unchanged.",
    "If SOURCE contains a URL, the final post MUST contain that URL.",
    "End with 2 to 4 relevant hashtags. Hashtags must be natural and based on facts/topics actually present in SOURCE.",
    "Avoid generic spam hashtags such as #FollowBack, #Giveaway, #FreeMoney unless SOURCE explicitly supports them.",
    "Return ONLY the final X post, with no explanation.",
    "Maximum " + maxChars + " characters."
  ];

  let formatRules = [];
  if (mode === "airdrop" && !premium) {
    formatRules = [
      "CONTENT MODE: AIRDROP — STANDARD X ACCOUNT.",
      "The result MUST visibly look like an airdrop/opportunity post, not a news sentence.",
      "Use this compact structure whenever the SOURCE provides the needed facts:",
      "1) First line: one strong emoji + project/opportunity name + short hook.",
      "2) Second line: reward/benefit in a compact form ONLY if SOURCE states one.",
      "3) Put the main URL on its own line or directly after a short label such as 🔗 Link:.",
      "4) Then 1 to 3 very short action steps, each starting with •, →, or ✅.",
      "5) Final line: 2 to 4 hashtags.",
      "Use light crypto-style emojis such as 🎁 🚀 ✅ 🔗 🪂 only where natural.",
      "Do not add a fake reward, fake deadline, fake eligibility, or fake token symbol.",
      "Prefer useful density over prose. Make it easy to scan in under five seconds."
    ];
  } else if (mode === "airdrop" && premium) {
    formatRules = [
      "CONTENT MODE: AIRDROP — PREMIUM/BLUE X ACCOUNT.",
      "Create a polished, structured opportunity post with stronger editorial quality.",
      "Use this structure when facts exist:",
      "1) Headline/hook with project name and opportunity.",
      "2) A compact summary of what users can get or why the opportunity matters.",
      "3) A clear block for Reward / Eligibility / Deadline ONLY for fields explicitly present in SOURCE.",
      "4) Main URL clearly visible.",
      "5) 2 to 5 numbered or bullet action steps.",
      "6) One short CTA such as 'Check the details before joining' or an equivalent natural closing.",
      "7) Final line: 2 to 4 relevant hashtags.",
      "Use spacing and emojis to improve readability, but keep it professional rather than spammy."
    ];
  } else if (mode === "both") {
    formatRules = premium ? [
      "CONTENT MODE: AUTO — AIRDROP OR NEWS — PREMIUM/BLUE X ACCOUNT.",
      "First classify SOURCE as AIRDROP/OPPORTUNITY or NEWS using only the source facts.",
      "If AIRDROP/OPPORTUNITY: use a polished opportunity layout with headline, reward/eligibility/deadline only when explicitly present, visible link, 2 to 5 clear steps when applicable, a short CTA, and 2 to 4 relevant hashtags.",
      "If NEWS: use a polished mini news brief with factual headline, concise summary, useful supported context/why-it-matters, important URL, and 2 to 4 relevant hashtags.",
      "Do not mention the classification. Return only the finished post."
    ] : [
      "CONTENT MODE: AUTO — AIRDROP OR NEWS — STANDARD X ACCOUNT.",
      "First classify SOURCE as AIRDROP/OPPORTUNITY or NEWS using only the source facts.",
      "If AIRDROP/OPPORTUNITY: use a compact scan-friendly layout with emoji hook, reward only if explicitly stated, visible link, 1 to 3 short action steps when applicable, and 2 to 4 relevant hashtags.",
      "If NEWS: use a short headline/hook, 1 to 2 useful factual sentences, important URL, and 2 to 4 relevant hashtags.",
      "Do not mention the classification. Return only the finished post."
    ];
  } else if (mode === "news" && !premium) {
    formatRules = [
      "CONTENT MODE: NEWS — STANDARD X ACCOUNT.",
      "Do NOT write a dry one-sentence rewrite.",
      "Use this compact structure:",
      "1) First line: short headline/hook that states the key development.",
      "2) Next 1 to 2 sentences: what happened and the most useful context available in SOURCE.",
      "3) If SOURCE has an important URL, include it clearly.",
      "4) Final line: 2 to 4 relevant hashtags.",
      "Write in a natural social-news voice: clear, energetic, factual, not sensational."
    ];
  } else {
    formatRules = [
      "CONTENT MODE: NEWS — PREMIUM/BLUE X ACCOUNT.",
      "Write a polished mini news brief suitable for a serious X account.",
      "Use this structure:",
      "1) Strong but factual headline/hook.",
      "2) A concise summary of the development.",
      "3) Add useful context, implication, or why-it-matters ONLY when it can be directly inferred from facts stated in SOURCE; do not speculate.",
      "4) Preserve any important URL.",
      "5) Finish with 2 to 4 relevant hashtags.",
      "Use clean paragraph spacing. The tone should feel editorially finished, not robotic or overly promotional."
    ];
  }

  if (urls.length) {
    formatRules.push("SOURCE URLs that must remain unchanged: " + urls.join(" | "));
  }

  return {
    maxChars,
    prompt: [...universal, ...formatRules, "", "SOURCE:", sourceText].join("\n")
  };
}

function fallbackHashtags(sourceText, account) {
  const sourceTags = String(sourceText || "").match(/#[\p{L}\p{N}_]+/gu) || [];
  const picked = [];
  for (const tag of sourceTags) {
    if (!picked.some((x) => x.toLowerCase() === tag.toLowerCase())) picked.push(tag);
    if (picked.length >= 4) break;
  }

  const lower = String(sourceText || "").toLowerCase();
  const likelyAirdrop = account.content_mode === "airdrop" ||
    (account.content_mode === "both" && /airdrop|waitlist|reward|claim|quest|task|whitelist|presale|giveaway/i.test(lower));
  const candidates = likelyAirdrop
    ? ["#Airdrop", "#Web3"]
    : [
        ...(lower.includes("bitcoin") || /\bbtc\b/.test(lower) ? ["#Bitcoin"] : []),
        ...(lower.includes("ethereum") || /\beth\b/.test(lower) ? ["#Ethereum"] : []),
        ...(lower.includes("crypto") ? ["#Crypto"] : []),
        ...(lower.includes("web3") ? ["#Web3"] : []),
        ...(lower.includes("artificial intelligence") || /\bai\b/.test(lower) ? ["#AI"] : []),
        "#News",
        "#Update"
      ];

  for (const tag of candidates) {
    if (!picked.some((x) => x.toLowerCase() === tag.toLowerCase())) picked.push(tag);
    if (picked.length >= 2) break;
  }
  return picked.slice(0, 4);
}

function xWeightedLength(text) {
  const source = String(text || "");
  const urls = extractSourceUrls(source);
  let working = source;
  let urlWeight = 0;
  for (const url of urls) {
    const idx = working.indexOf(url);
    if (idx >= 0) {
      working = working.slice(0, idx) + working.slice(idx + url.length);
      urlWeight += 23;
    }
  }
  let weight = urlWeight;
  for (const ch of working) {
    const cp = ch.codePointAt(0);
    weight += (cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)) ? 1 : 2;
  }
  return weight;
}

function fitStandardX(text, maxWeight = 270) {
  let original = String(text || "").trim();
  if (xWeightedLength(original) <= maxWeight) return original;

  const tagMatch = original.match(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/gu);
  let tags = tagMatch?.[0]?.trim().split(/\s+/).filter(Boolean).slice(0, 2) || [];
  let urls = [...new Set(extractSourceUrls(original))];

  let body = tagMatch ? original.slice(0, tagMatch.index).trim() : original;
  for (const url of urls) body = body.replaceAll("🔗 " + url, "").replaceAll(url, "");
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  const compose = (bodyText, currentUrls, currentTags) => {
    const suffixParts = [];
    if (currentUrls.length) suffixParts.push(currentUrls.map((url) => "🔗 " + url).join("\n"));
    if (currentTags.length) suffixParts.push(currentTags.join(" "));
    const suffix = suffixParts.join("\n\n");
    return bodyText + (suffix ? (bodyText ? "\n\n" : "") + suffix : "");
  };

  while (xWeightedLength(compose("", urls, tags)) > maxWeight && tags.length) tags.pop();
  while (xWeightedLength(compose("", urls, tags)) > maxWeight && urls.length > 1) urls.pop();

  const chars = [...body];
  while (chars.length && xWeightedLength(compose(chars.join(""), urls, tags)) > maxWeight) chars.pop();

  let compact = chars.join("").trimEnd();
  if (compact && compact.length < body.length) {
    const lastSpace = compact.lastIndexOf(" ");
    if (lastSpace > compact.length * 0.75) compact = compact.slice(0, lastSpace);
    compact = compact.replace(/[,:;\-–—]+$/u, "").trimEnd();
    if (compact) compact += "…";
  }

  let result = compose(compact, urls, tags);
  while (result && xWeightedLength(result) > maxWeight) {
    if (tags.length) {
      tags.pop();
    } else if (compact) {
      const bodyChars = [...compact];
      bodyChars.pop();
      compact = bodyChars.join("").trimEnd();
    } else if (urls.length > 1) {
      urls.pop();
    } else {
      break;
    }
    result = compose(compact, urls, tags);
  }
  return result.trim();
}

function cleanAiOutput(output, maxChars, sourceText, account) {
  let text = String(output || "").trim().replace(/^\s*[`"'“”]+|[`"'“”]+\s*$/g, "").trim();
  if (!text) throw Object.assign(new Error("ai:empty_response"), { status: 502, expose: true });

  const sourceUrls = extractSourceUrls(sourceText);
  const existingTags = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  if (existingTags.length < 2) {
    const extra = fallbackHashtags(sourceText, account)
      .filter((tag) => !existingTags.some((x) => x.toLowerCase() === tag.toLowerCase()))
      .slice(0, Math.max(0, 2 - existingTags.length));
    if (extra.length) text = text.replace(/\s+$/g, "") + "\n\n" + extra.join(" ");
  }

  for (const url of sourceUrls) {
    if (!text.includes(url)) {
      const tagMatch = text.match(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/gu);
      const tagLine = tagMatch?.[0]?.trim() || "";
      const body = tagLine ? text.slice(0, text.length - tagMatch[0].length).trimEnd() : text;
      text = body + "\n\n🔗 " + url + (tagLine ? "\n\n" + tagLine : "");
    }
  }

  if (text.length > maxChars) {
    const tags = text.match(/#[\p{L}\p{N}_]+/gu) || fallbackHashtags(sourceText, account);
    const tagLine = tags.slice(-4).join(" ");
    const urls = sourceUrls.filter((url) => text.includes(url));
    const urlBlock = urls.length ? urls.map((url) => "🔗 " + url).join("\n") : "";
    const suffix = [urlBlock, tagLine].filter(Boolean).join("\n\n");
    const room = Math.max(40, maxChars - suffix.length - (suffix ? 2 : 0));

    let body = text;
    for (const url of urls) body = body.replaceAll("🔗 " + url, "").replaceAll(url, "");
    body = body.replace(/(?:\s*#[\p{L}\p{N}_]+)+\s*$/gu, "").replace(/\n{3,}/g, "\n\n").trim();

    if (body.length > room) {
      body = body.slice(0, Math.max(1, room - 1)).trimEnd();
      const lastSpace = body.lastIndexOf(" ");
      if (lastSpace > room * 0.72) body = body.slice(0, lastSpace);
      body += "…";
    }
    text = body + (suffix ? "\n\n" + suffix : "");
  }
  if (!account.x_premium) text = fitStandardX(text, 270);
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
  return cleanAiOutput(output, maxChars, text, account);
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
  return cleanAiOutput(body?.choices?.[0]?.message?.content, maxChars, text, account);
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

async function bufferCreateNow(apiKey, channelId, text, assets = []) {
  const key = String(apiKey || "").trim();
  const channel = String(channelId || "").trim();
  if (!key) throw new Error("buffer_api_key_missing");
  if (!channel) throw new Error("buffer_channel_id_missing");

  const normalizedAssets = (Array.isArray(assets) ? assets : [])
    .filter((a) => a && a.kind === "image" && /^https:\/\//i.test(String(a.url || "")))
    .slice(0, 4);

  const assetsGraphql = normalizedAssets.length
    ? "\n      assets: [" + normalizedAssets.map((a) =>
        "{ image: { url: " + JSON.stringify(String(a.url)) + " } }"
      ).join(",") + "]"
    : "";

  const query = `mutation CreatePost {
    createPost(input: {
      text: ${JSON.stringify(String(text || ""))}
      channelId: ${JSON.stringify(channel)}
      schedulingType: automatic
      mode: shareNow
      aiAssisted: true${assetsGraphql}
    }) {
      __typename
      ... on PostActionSuccess {
        post { id text status dueAt assets { id mimeType } }
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


async function processAccountRoute(env, eventId, account, sourceText, assets = []) {
  try {
    let secrets = {};
    if (account.encrypted_json) {
      secrets = await decryptJson(env.MASTER_KEY, account.encrypted_json);
    }

    const ai = await childAiSettings(env, account.child_id, true);
    if (!ai.deepseek_api_key) {
      throw Object.assign(new Error("deepseek_api_key_missing_for_user"), { status: 400, expose: true });
    }

    const accountWithSettings = {
      ...account,
      content_mode: ["news","airdrop","both"].includes(String(secrets.content_mode || ""))
        ? String(secrets.content_mode)
        : (account.content_mode || "both"),
      post_language: accountPostLanguage(secrets)
    };

    const rewritten = String(sourceText || "").trim()
      ? await deepseekRewrite(ai.deepseek_api_key, sourceText, accountWithSettings)
      : "";

    const post = await bufferCreateNow(
      secrets.buffer_api_key,
      account.buffer_channel_id,
      rewritten,
      assets
    );

    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='posted',error=NULL WHERE event_id=? AND account_id=?"
    ).bind(eventId, account.id).run();

    await audit(env, "system", "router", "x_account.posted", "x_account", account.id, {
      event_id: eventId,
      buffer_post_id: post.id,
      buffer_status: post.status || null,
      child_id: account.child_id,
      ai_provider: "deepseek_paid",
      source_length: String(sourceText || "").length,
      output_length: rewritten.length,
      asset_count: Array.isArray(assets) ? assets.length : 0
    });
    return {
      posted: true,
      post: { id: post.id, status: post.status || null },
      output: rewritten,
      asset_count: Array.isArray(assets) ? assets.length : 0
    };
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
    return { posted: false, error: detail };
  }
}

async function childCloudinarySecrets(env, childId) {
  const row = await env.DB.prepare(
    "SELECT encrypted_json FROM child_infra WHERE child_id=?"
  ).bind(childId).first();
  if (!row?.encrypted_json) throw Object.assign(new Error("child_infra_missing"), { status: 409 });

  const stored = await decryptJson(env.MASTER_KEY, row.encrypted_json);
  const result = {
    cloudinary_cloud_name: String(stored.cloudinary_cloud_name || "").trim(),
    cloudinary_api_key: String(stored.cloudinary_api_key || "").trim(),
    cloudinary_api_secret: String(stored.cloudinary_api_secret || "").trim()
  };
  if (!result.cloudinary_cloud_name || !result.cloudinary_api_key || !result.cloudinary_api_secret) {
    throw Object.assign(new Error("cloudinary_credentials_required"), { status: 400 });
  }
  return result;
}

async function uploadCloudinaryImage(cloudinary, item) {
  const mime = String(item?.mime_type || "image/jpeg").slice(0, 100);
  const encoded = String(item?.data_base64 || "");
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded) || encoded.length > 16_000_000) {
    throw Object.assign(new Error("telegram_image_payload_invalid_or_too_large"), { status: 413, expose: true });
  }

  const auth = btoa(cloudinary.cloudinary_api_key + ":" + cloudinary.cloudinary_api_secret);
  const form = new FormData();
  form.append("file", "data:" + mime + ";base64," + encoded);

  const response = await fetch(
    "https://api.cloudinary.com/v1_1/" + encodeURIComponent(cloudinary.cloudinary_cloud_name) + "/image/upload",
    {
      method: "POST",
      headers: { Authorization: "Basic " + auth },
      body: form
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.secure_url) {
    const detail = body?.error?.message || body?.message || ("HTTP " + response.status);
    throw Object.assign(new Error("cloudinary_upload:" + detail), { status: 502, expose: true });
  }
  return {
    kind: "image",
    url: String(body.secure_url),
    public_id: body.public_id || null,
    width: body.width || null,
    height: body.height || null
  };
}

async function uploadChildImages(env, childId, incomingMedia) {
  const images = (Array.isArray(incomingMedia) ? incomingMedia : [])
    .filter((item) => item && item.kind === "image" && item.data_base64)
    .slice(0, 4);
  if (!images.length) return [];

  const cloudinary = await childCloudinarySecrets(env, childId);
  return Promise.all(images.map((item) => uploadCloudinaryImage(cloudinary, item)));
}

async function preflightInfra(env, childInfra) {
  const checks = [];
  const cloudflare = masterCloudflareInfra(env);

  await cloudflareRequest(cloudflare, "/workers/scripts");
  checks.push("master-cloudflare");

  const auth = btoa(childInfra.cloudinary_api_key + ":" + childInfra.cloudinary_api_secret);
  const cloudinary = await fetch(
    "https://api.cloudinary.com/v1_1/" + encodeURIComponent(childInfra.cloudinary_cloud_name) + "/usage",
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
        { type: "secret_text", name: "CHILD_SECRET", text: childSecret },
        { type: "service", name: "MASTER", service: "x-master-router" }
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

function accountRouterWorkerName(child, slotIndex) {
  const base = slugify(child.slug || child.name || "user").slice(0, 34) || "user";
  return ("xmr-" + base + "-r" + slotIndex + "-" + child.id.slice(-5)).slice(0, 62);
}

async function deployAccountRouterWorker(env, child, slotId, slotIndex, routerSecret, masterRoot, deleteOnFailure = true) {
  const infra = masterCloudflareInfra(env);
  const source = renderAccountRouterSource();
  const workerName = accountRouterWorkerName(child, slotIndex);
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2026-09-18",
    bindings: [
      { type: "plain_text", name: "ROUTER_SLOT_ID", text: slotId },
      { type: "plain_text", name: "CHILD_ID", text: child.id },
      { type: "plain_text", name: "MASTER_ROOT", text: masterRoot },
      { type: "secret_text", name: "ROUTER_SECRET", text: routerSecret },
      { type: "service", name: "MASTER", service: "x-master-router" }
    ]
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.append("worker.js", new Blob([source], { type: "application/javascript+module" }), "worker.js");

  await cloudflareRequest(infra, "/workers/scripts/" + encodeURIComponent(workerName), {
    method: "PUT",
    body: form
  });
  await cloudflareRequest(infra, "/workers/scripts/" + encodeURIComponent(workerName) + "/subdomain", {
    method: "POST",
    body: JSON.stringify({ enabled: true })
  });

  const subdomain = await ensureWorkersSubdomain(infra);
  const webUrl = "https://" + workerName + "." + subdomain + ".workers.dev";

  return { workerName, webUrl };
}

async function listRouterSlots(env, childId) {
  const result = await env.DB.prepare(
    `SELECT id,child_id,slot_index,account_id,worker_name,web_url,status,last_health_at,last_error,created_at,updated_at
       FROM child_router_slots WHERE child_id=? ORDER BY slot_index`
  ).bind(childId).all();
  return (result.results || []).map((row) => ({
    ...row,
    assigned: Boolean(row.account_id)
  }));
}

async function ensureChildRouterSlots(env, child, masterRoot, forceUpdate = false) {
  const existing = await listRouterSlots(env, child.id);
  const byIndex = new Map(existing.map((row) => [Number(row.slot_index), row]));
  const created = [];

  try {
    for (let slotIndex = 1; slotIndex <= 5; slotIndex++) {
      const current = byIndex.get(slotIndex);
      if (!forceUpdate && current && current.web_url && (current.status === "ready" || current.status === "assigned")) continue;

      const slotId = current?.id || id("rs");
      let routerSecret = "";
      let routerSecretHash = "";
      let encryptedJson = "";

      if (!current) {
        routerSecret = randomHex(32);
        routerSecretHash = await hmacHex(env.SESSION_PEPPER, routerSecret);
        encryptedJson = await encryptJson(env.MASTER_KEY, { router_secret: routerSecret });
        await env.DB.prepare(
          `INSERT INTO child_router_slots(
             id,child_id,slot_index,worker_name,router_secret_hash,encrypted_json,status
           ) VALUES(?,?,?,?,?,?,?)`
        ).bind(slotId, child.id, slotIndex, accountRouterWorkerName(child, slotIndex), routerSecretHash, encryptedJson, "provisioning").run();
      } else {
        const secretRow = await env.DB.prepare(
          "SELECT encrypted_json FROM child_router_slots WHERE id=?"
        ).bind(slotId).first();
        const stored = await decryptJson(env.MASTER_KEY, secretRow?.encrypted_json);
        routerSecret = String(stored.router_secret || "");
        if (!routerSecret) throw Object.assign(new Error("router_secret_missing"), { status: 500 });
      }

      let deployed;
      try {
        deployed = await deployAccountRouterWorker(
          env, child, slotId, slotIndex, routerSecret, masterRoot, !current
        );
      } catch (error) {
        if (current) {
          await env.DB.prepare(
            "UPDATE child_router_slots SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
          ).bind(safeError(error), slotId).run().catch(() => {});
        } else {
          await env.DB.prepare(
            "UPDATE child_router_slots SET status='error',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
          ).bind(safeError(error), slotId).run().catch(() => {});
        }
        throw error;
      }
      await env.DB.prepare(
        `UPDATE child_router_slots
            SET worker_name=?,web_url=?,status=CASE WHEN account_id IS NULL THEN 'ready' ELSE 'assigned' END,
                last_error=NULL,updated_at=CURRENT_TIMESTAMP
          WHERE id=?`
      ).bind(deployed.workerName, deployed.webUrl, slotId).run();
      created.push({ id: slotId, worker_name: deployed.workerName, was_existing: Boolean(current) });
    }
  } catch (error) {
    const infra = masterCloudflareInfra(env);
    for (const item of created) {
      if (item.was_existing) continue;
      await deleteChildWorker(infra, item.worker_name, true);
      await env.DB.prepare("DELETE FROM child_router_slots WHERE id=?").bind(item.id).run().catch(() => {});
    }
    throw error;
  }

  const unboundAccounts = await env.DB.prepare(
    `SELECT a.id FROM x_accounts a
       LEFT JOIN child_router_slots rs ON rs.account_id=a.id
      WHERE a.child_id=? AND rs.id IS NULL
      ORDER BY a.created_at,a.id`
  ).bind(child.id).all();
  const freeSlots = await env.DB.prepare(
    "SELECT id FROM child_router_slots WHERE child_id=? AND account_id IS NULL AND status='ready' ORDER BY slot_index"
  ).bind(child.id).all();

  const pendingAccounts = unboundAccounts.results || [];
  const availableSlots = freeSlots.results || [];
  for (let i = 0; i < Math.min(pendingAccounts.length, availableSlots.length); i++) {
    await env.DB.prepare(
      "UPDATE child_router_slots SET account_id=?,status='assigned',updated_at=CURRENT_TIMESTAMP WHERE id=? AND account_id IS NULL"
    ).bind(pendingAccounts[i].id, availableSlots[i].id).run();
  }

  return listRouterSlots(env, child.id);
}

async function verifyRouterCaller(env, request) {
  const slotId = request.headers.get("x-router-slot") || "";
  const secret = request.headers.get("x-router-secret") || "";
  if (!slotId || !secret) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const slot = await env.DB.prepare(
    "SELECT * FROM child_router_slots WHERE id=?"
  ).bind(slotId).first();
  if (!slot) throw Object.assign(new Error("router_slot_not_found"), { status: 404 });
  const provided = await hmacHex(env.SESSION_PEPPER, secret);
  if (!timingSafeEqual(provided, slot.router_secret_hash)) {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  return slot;
}

async function routerCallSecret(env, slot) {
  if (!slot?.encrypted_json) throw Object.assign(new Error("router_secret_missing"), { status: 500 });
  const stored = await decryptJson(env.MASTER_KEY, slot.encrypted_json);
  const secret = String(stored.router_secret || "");
  if (!secret) throw Object.assign(new Error("router_secret_missing"), { status: 500 });
  return secret;
}

async function accountRouterAssignment(env, accountId) {
  return env.DB.prepare(
    `SELECT id AS router_slot_id,web_url AS router_url,status AS router_status,encrypted_json
       FROM child_router_slots WHERE account_id=? LIMIT 1`
  ).bind(accountId).first();
}

async function makeRouterDispatch(env, account, action, eventId) {
  if (!account.router_slot_id || !account.router_url) {
    throw Object.assign(new Error("router_slot_missing"), { status: 409 });
  }
  if (account.router_status !== "assigned" && account.router_status !== "ready") {
    throw Object.assign(new Error("router_slot_not_ready"), { status: 409 });
  }
  const slot = account.router_encrypted_json
    ? { encrypted_json: account.router_encrypted_json }
    : await env.DB.prepare(
        "SELECT encrypted_json FROM child_router_slots WHERE id=?"
      ).bind(account.router_slot_id).first();
  const secret = await routerCallSecret(env, slot);
  const issuedAt = Math.floor(Date.now() / 1000);
  const material = [
    account.router_slot_id,
    String(eventId),
    String(account.id),
    String(action),
    String(issuedAt)
  ].join("|");
  return {
    router_url: account.router_url,
    router_slot_id: account.router_slot_id,
    issued_at: issuedAt,
    signature: await hmacHex(secret, material)
  };
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
  const globalAi = await childAiSettings(env, childId);
  const result = await env.DB.prepare(
    `SELECT a.id,a.child_id,a.display_name,a.x_handle,a.encrypted_json,a.buffer_channel_id,a.buffer_channel_name,
            a.content_mode,a.x_premium,a.enabled,a.created_at,a.updated_at,
            rs.id AS router_slot_id,rs.slot_index AS router_slot_index,rs.worker_name AS router_worker_name,
            rs.web_url AS router_url,rs.status AS router_status
       FROM x_accounts a
       LEFT JOIN child_router_slots rs ON rs.account_id=a.id
      WHERE a.child_id=? ORDER BY COALESCE(rs.slot_index,99),a.created_at,a.id`
  ).bind(childId).all();

  const accounts = [];
  for (const row of (result.results || [])) {
    let bufferConfigured = false;
    let postLanguage = "en-US";
    let contentMode = row.content_mode || "news";
    let settingsCorrupt = false;
    if (row.encrypted_json) {
      try {
        const secrets = await decryptJson(env.MASTER_KEY, row.encrypted_json);
        bufferConfigured = Boolean(secrets.buffer_api_key);
        postLanguage = accountPostLanguage(secrets);
        if (["news","airdrop","both"].includes(String(secrets.content_mode || ""))) {
          contentMode = String(secrets.content_mode);
        }
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
      content_mode: contentMode,
      x_premium: Boolean(row.x_premium),
      enabled: Boolean(row.enabled),
      ai_provider: "deepseek_paid",
      post_language: postLanguage,
      ai_configured: globalAi.deepseek_configured,
      gemini_configured: false,
      deepseek_configured: globalAi.deepseek_configured,
      buffer_configured: bufferConfigured,
      settings_corrupt: settingsCorrupt,
      router_slot_id: row.router_slot_id || null,
      router_slot_index: row.router_slot_index == null ? null : Number(row.router_slot_index),
      router_worker_name: row.router_worker_name || null,
      router_url: row.router_url || null,
      router_status: row.router_status || "missing",
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
    children.push({ ...child, router_slots: await listRouterSlots(env, child.id), accounts: await listXAccounts(env, child.id) });
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

async function childAiSettings(env, childId, includeSecret = false) {
  await env.DB.prepare("INSERT OR IGNORE INTO child_settings(child_id) VALUES(?)").bind(childId).run();
  const row = await env.DB.prepare(
    "SELECT encrypted_json FROM child_settings WHERE child_id=?"
  ).bind(childId).first();

  let stored = {};
  if (row?.encrypted_json) {
    try {
      stored = await decryptJson(env.MASTER_KEY, row.encrypted_json);
    } catch {
      throw Object.assign(new Error("child_ai_settings_decrypt_failed"), { status: 500 });
    }
  }

  const result = {
    provider: "deepseek_paid",
    deepseek_configured: Boolean(stored.deepseek_api_key)
  };
  if (includeSecret) result.deepseek_api_key = String(stored.deepseek_api_key || "");
  return result;
}

async function saveChildAiSettings(env, child, body) {
  const key = String(body.deepseek_api_key || "").trim();
  if (key.length < 8) throw Object.assign(new Error("deepseek_api_key_required"), { status: 400 });

  const encrypted = await encryptJson(env.MASTER_KEY, { deepseek_api_key: key });
  await env.DB.prepare(
    `INSERT INTO child_settings(child_id,encrypted_json,updated_at)
     VALUES(?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(child_id) DO UPDATE SET encrypted_json=excluded.encrypted_json,updated_at=CURRENT_TIMESTAMP`
  ).bind(child.id, encrypted).run();

  await audit(env, "child", child.id, "child.deepseek_updated", "child", child.id, {
    provider: "deepseek_paid"
  });
  return { provider: "deepseek_paid", deepseek_configured: true };
}

async function testChildDeepseek(env, child) {
  const settings = await childAiSettings(env, child.id, true);
  if (!settings.deepseek_api_key) throw Object.assign(new Error("deepseek_api_key_missing"), { status: 400 });
  const output = await deepseekRewrite(
    settings.deepseek_api_key,
    "X-Master connection test. Confirm the AI connection in one short sentence.",
    { content_mode: "news", x_premium: 0, post_language: "en-US" }
  );
  await audit(env, "child", child.id, "child.deepseek_test_ok", "child", child.id, { output });
  return { ok: true, provider: "deepseek_paid", output };
}

async function childMe(env, child) {
  return {
    child: { id: child.id, name: child.name, status: child.status },
    ai_settings: await childAiSettings(env, child.id),
    source_catalog: await listSources(env),
    router_slots: await listRouterSlots(env, child.id),
    accounts: await listXAccounts(env, child.id),
    limits: { max_accounts: 5, router_slots: 5 }
  };
}

async function saveXAccount(env, child, body, accountId = null) {
  const bufferChannelNameRaw = String(body.buffer_channel_name || "").trim();
  const displayName = String(body.display_name || bufferChannelNameRaw || "").trim();
  const xHandle = String(body.x_handle || "").trim().replace(/^@/, "") || null;
  if (displayName.length < 2) throw Object.assign(new Error("account_name_required"), { status: 400 });

  const sourceIds = await validateSourceIds(env, body.source_ids);
  const requestedMode = ["news","airdrop","both"].includes(String(body.content_mode || "")) ? String(body.content_mode) : "both";
  const mode = requestedMode === "both" ? "news" : requestedMode;
  const premium = body.x_premium ? 1 : 0;
  const enabled = body.enabled === false ? 0 : 1;
  const bufferChannelId = String(body.buffer_channel_id || "").trim() || null;
  const bufferChannelName = bufferChannelNameRaw || null;

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
    const freeSlot = await env.DB.prepare(
      "SELECT id FROM child_router_slots WHERE child_id=? AND account_id IS NULL AND status='ready' ORDER BY slot_index LIMIT 1"
    ).bind(child.id).first();
    if (!freeSlot) {
      throw Object.assign(new Error("router_slot_unavailable"), { status: 409 });
    }
    body.__router_slot_id = freeSlot.id;
  }

  let secrets = {};
  if (existing?.encrypted_json) {
    try {
      secrets = await decryptJson(env.MASTER_KEY, existing.encrypted_json);
    } catch {
      throw Object.assign(new Error("account_settings_decrypt_failed"), { status: 500 });
    }
  }
  const buffer = String(body.buffer_api_key || "").trim();
  const requestedLanguage = String(body.post_language || secrets.post_language || "en-US").trim().slice(0, 80) || "en-US";
  secrets.post_language = requestedLanguage;
  secrets.content_mode = requestedMode;
  delete secrets.ai_provider;
  delete secrets.deepseek_api_key;
  delete secrets.gemini_api_key;
  if (buffer) secrets.buffer_api_key = buffer;
  if (!existing && !secrets.buffer_api_key) throw Object.assign(new Error("buffer_api_key_required"), { status: 400 });
  if (!bufferChannelId) throw Object.assign(new Error("buffer_channel_id_required"), { status: 400 });
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

    const slotId = String(body.__router_slot_id || "");
    const assigned = await env.DB.prepare(
      "UPDATE child_router_slots SET account_id=?,status='assigned',updated_at=CURRENT_TIMESTAMP WHERE id=? AND child_id=? AND account_id IS NULL AND status='ready'"
    ).bind(finalId, slotId, child.id).run();
    if (!assigned?.meta?.changes) {
      await env.DB.prepare("DELETE FROM x_accounts WHERE id=?").bind(finalId).run().catch(() => {});
      throw Object.assign(new Error("router_slot_assignment_failed"), { status: 409 });
    }
  }

  for (const sourceId of sourceIds) {
    await env.DB.prepare(
      "INSERT INTO x_account_sources(account_id,source_id) VALUES(?,?)"
    ).bind(finalId, sourceId).run();
  }

  const currentSlot = await env.DB.prepare(
    "SELECT id FROM child_router_slots WHERE child_id=? AND account_id=? LIMIT 1"
  ).bind(child.id, finalId).first();
  if (!currentSlot) {
    const freeSlot = await env.DB.prepare(
      "SELECT id FROM child_router_slots WHERE child_id=? AND account_id IS NULL AND status='ready' ORDER BY slot_index LIMIT 1"
    ).bind(child.id).first();
    if (!freeSlot) throw Object.assign(new Error("router_slot_unavailable"), { status: 409 });
    await env.DB.prepare(
      "UPDATE child_router_slots SET account_id=?,status='assigned',updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(finalId, freeSlot.id).run();
  }

  await audit(env, "child", child.id, existing ? "x_account.updated" : "x_account.created", "x_account", finalId, {
    display_name: displayName,
    x_handle: xHandle,
    source_count: sourceIds.length,
    ai_provider: "deepseek_paid",
    post_language: requestedLanguage,
    ai_updated: false,
    buffer_updated: Boolean(buffer),
    buffer_channel_id: bufferChannelId,
    content_mode: requestedMode,
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
  await env.DB.prepare(
    "UPDATE child_router_slots SET account_id=NULL,status='ready',updated_at=CURRENT_TIMESTAMP WHERE child_id=? AND account_id=?"
  ).bind(child.id, accountId).run();
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

  const childInfra = normalizeChildInfra(body);
  const cloudflare = masterCloudflareInfra(env);

  const jobId = id("job");
  await env.DB.prepare(
    "INSERT INTO deployment_jobs(id,action,status,step) VALUES(?,?,?,?)"
  ).bind(jobId, "create_child", "running", "preflight").run();

  let childId = null;
  let workerName = null;
  let deployed = false;

  try {
    await preflightInfra(env, childInfra);

    childId = id("ch");
    const slugBase = slugify(name);
    const slug = (slugBase + "-" + childId.slice(-5)).slice(0, 48);
    const passwordHash = await createPasswordHash(password);
    const childSecret = randomHex(32);
    const childSecretHash = await hmacHex(env.SESSION_PEPPER, childSecret);
    const encryptedInfra = await encryptJson(env.MASTER_KEY, { ...childInfra, child_secret: childSecret });

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
    const deployedResult = await deployChildWorker(cloudflare, child, childSecret, masterRoot);
    workerName = deployedResult.workerName;
    deployed = true;

    await env.DB.prepare(
      "UPDATE children SET worker_name=?,web_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(workerName, deployedResult.webUrl, childId).run();

    await env.DB.prepare(
      "UPDATE deployment_jobs SET step=? WHERE id=?"
    ).bind("deploy_5_router_slots", jobId).run();

    const routerSlots = await ensureChildRouterSlots(env, { ...child, worker_name: workerName, web_url: deployedResult.webUrl }, masterRoot);

    await env.DB.prepare(
      "UPDATE children SET status='ready',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(childId).run();

    await env.DB.prepare(
      "UPDATE deployment_jobs SET status='success',step='ready',finished_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(jobId).run();

    await audit(env, "admin", admin.id, "child.created", "child", childId, {
      name,
      worker_name: workerName,
      router_slots: 5,
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
        router_slots: await listRouterSlots(env, childId),
        account_count: 0
      }
    };
  } catch (error) {
    if (childId) {
      const slots = await listRouterSlots(env, childId).catch(() => []);
      for (const slot of slots) await deleteChildWorker(cloudflare, slot.worker_name, true);
    }
    if (deployed && workerName) await deleteChildWorker(cloudflare, workerName, true);
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
    const action = body.status === "paused" ? "stop" : "resume";
    const managedChild = await env.DB.prepare(
      "SELECT c.*,i.encrypted_json FROM children c LEFT JOIN child_infra i ON i.child_id=c.id WHERE c.id=?"
    ).bind(childId).first();
    const cloudflare = await manageChildWorkers(env, managedChild, action);
    await env.DB.prepare("UPDATE children SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(body.status, childId).run();
    await audit(env, "admin", admin.id, body.status === "paused" ? "child.workers_stopped" : "child.workers_resumed", "child", childId, {
      status: body.status,
      cloudflare
    });
  }

  return { child: await env.DB.prepare("SELECT id,name,slug,status,web_url,worker_name FROM children WHERE id=?").bind(childId).first() };
}

async function updateChildWorkerCode(env, request, admin, childId) {
  const child = await env.DB.prepare(
    "SELECT c.*,i.encrypted_json FROM children c LEFT JOIN child_infra i ON i.child_id=c.id WHERE c.id=?"
  ).bind(childId).first();
  if (!child) throw Object.assign(new Error("child_not_found"), { status: 404 });
  if (!child.encrypted_json) throw Object.assign(new Error("child_infra_missing"), { status: 409 });

  const stored = await decryptJson(env.MASTER_KEY, child.encrypted_json);
  const infra = masterCloudflareInfra(env);
  const childInfra = {
    cloudinary_cloud_name: stored.cloudinary_cloud_name,
    cloudinary_api_key: stored.cloudinary_api_key,
    cloudinary_api_secret: stored.cloudinary_api_secret
  };
  const childSecret = String(stored.child_secret || randomHex(32));
  const workerName = child.worker_name || ("xm-" + child.slug + "-" + child.id.slice(-6)).slice(0, 62);
  const masterRoot = new URL(request.url).origin;
  const source = renderChildWorkerSource();
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2026-09-18",
    bindings: [
      { type: "plain_text", name: "CHILD_ID", text: child.id },
      { type: "plain_text", name: "MASTER_ROOT", text: masterRoot },
      { type: "secret_text", name: "CHILD_SECRET", text: childSecret },
      { type: "service", name: "MASTER", service: "x-master-router" }
    ]
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.append("worker.js", new Blob([source], { type: "application/javascript+module" }), "worker.js");

  await cloudflareRequest(infra, "/workers/scripts/" + encodeURIComponent(workerName), {
    method: "PUT",
    body: form
  });
  await cloudflareRequest(infra, "/workers/scripts/" + encodeURIComponent(workerName) + "/subdomain", {
    method: "POST",
    body: JSON.stringify({ enabled: true })
  });

  const subdomain = await ensureWorkersSubdomain(infra);
  const webUrl = "https://" + workerName + "." + subdomain + ".workers.dev";
  const secretHash = await hmacHex(env.SESSION_PEPPER, childSecret);
  const legacyCloudflare = (
    stored.cloudflare_account_id && stored.cloudflare_api_token
      ? {
          cloudflare_account_id: stored.cloudflare_account_id,
          cloudflare_api_token: stored.cloudflare_api_token
        }
      : {}
  );
  const updatedInfra = await encryptJson(env.MASTER_KEY, { ...childInfra, ...legacyCloudflare, child_secret: childSecret });

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE children SET child_secret_hash=?,worker_name=?,web_url=?,status='ready',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(secretHash, workerName, webUrl, childId),
    env.DB.prepare(
      "UPDATE child_infra SET encrypted_json=?,updated_at=CURRENT_TIMESTAMP WHERE child_id=?"
    ).bind(updatedInfra, childId)
  ]);

  await env.DB.prepare(
    "UPDATE children SET status='ready',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(childId).run();
  const routerSlots = await ensureChildRouterSlots(env, { id: childId, name: child.name, slug: child.slug }, masterRoot, true);
  await audit(env, "admin", admin.id, "child.code_updated", "child", childId, {
    worker_name: workerName,
    web_url: webUrl,
    router_slots: routerSlots.length
  });
  return { updated: true, child: { id: childId, name: child.name, status: "ready", worker_name: workerName, web_url: webUrl, router_slots: routerSlots } };
}

async function deleteChild(env, admin, childId) {
  const child = await env.DB.prepare(
    "SELECT c.*,i.encrypted_json FROM children c LEFT JOIN child_infra i ON i.child_id=c.id WHERE c.id=?"
  ).bind(childId).first();
  if (!child) throw Object.assign(new Error("child_not_found"), { status: 404 });

  const cloudflare = await manageChildWorkers(env, child, "delete");

  await audit(env, "admin", admin.id, "child.workers_deleted_verified", "child", childId, {
    name: child.name,
    worker_name: child.worker_name,
    cloudflare
  });

  await env.DB.prepare("DELETE FROM children WHERE id=?").bind(childId).run();

  await audit(env, "admin", admin.id, "child.data_deleted", "child", childId, {
    name: child.name,
    worker_name: child.worker_name,
    cloudflare_verified: true
  }).catch(() => {});

  return {
    deleted: true,
    cloudflare_verified: true,
    workers: cloudflare.results
  };
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
  const { account } = await loadAccountSecrets(env, accountId);
  const ai = await childAiSettings(env, account.child_id, true);
  if (!ai.deepseek_api_key) throw Object.assign(new Error("deepseek_api_key_missing_for_user"), { status: 400 });

  const output = await deepseekRewrite(
    ai.deepseek_api_key,
    "X-Master AI connection test. Rewrite this into a short X post.",
    { ...account, content_mode: "news", post_language: "en-US" }
  );
  await audit(env, "admin", admin.id, "x_account.ai_test_ok", "x_account", account.id, {
    child_id: account.child_id,
    ai_provider: "deepseek_paid",
    output
  });
  return { ok: true, provider: "deepseek_paid", output };
}

async function adminTestFullPipeline(env, admin, accountId) {
  const { account, secrets } = await loadAccountSecrets(env, accountId);
  const ai = await childAiSettings(env, account.child_id, true);
  if (!ai.deepseek_api_key) throw Object.assign(new Error("deepseek_api_key_missing_for_user"), { status: 400 });

  const mode = ["news","airdrop","both"].includes(String(secrets.content_mode || ""))
    ? String(secrets.content_mode)
    : (account.content_mode || "both");
  const output = await deepseekRewrite(
    ai.deepseek_api_key,
    "X-Master full pipeline test. Rewrite this into a short X post confirming the automation connection.",
    { ...account, content_mode: mode, post_language: accountPostLanguage(secrets) }
  );
  const post = await bufferCreateNow(secrets.buffer_api_key, account.buffer_channel_id, output, []);
  await audit(env, "admin", admin.id, "x_account.pipeline_test_posted", "x_account", account.id, {
    child_id: account.child_id,
    ai_provider: "deepseek_paid",
    buffer_post_id: post.id,
    buffer_status: post.status || null,
    output
  });
  return { ok: true, provider: "deepseek_paid", output, post: { id: post.id, status: post.status || null } };
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
    `SELECT r.status,a.child_id,a.encrypted_json FROM ingest_account_routes r
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
  if (!localError) {
    return { accepted: true, posted: false, dispatch_via_router: true };
  }

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

async function reportRouterTransportResult(env, request) {
  await requireCollector(env, request);
  const body = await readJson(request);
  const eventId = String(body.event_id || "").trim();
  const accountId = String(body.account_id || "").trim();
  const errorText = String(body.error || "").trim();
  if (!eventId || !accountId) throw Object.assign(new Error("router_result_ids_required"), { status: 400 });

  if (!errorText) return { accepted: true };

  const route = await env.DB.prepare(
    `SELECT a.child_id,rs.id AS router_slot_id
       FROM ingest_account_routes r
       JOIN x_accounts a ON a.id=r.account_id
       LEFT JOIN child_router_slots rs ON rs.account_id=a.id
      WHERE r.event_id=? AND r.account_id=?`
  ).bind(eventId, accountId).first();
  if (!route) throw Object.assign(new Error("router_route_not_found"), { status: 404 });

  const detail = ("router_transport:" + errorText).slice(0, 1500);
  await env.DB.prepare(
    "UPDATE ingest_account_routes SET status='failed',error=? WHERE event_id=? AND account_id=?"
  ).bind(detail, eventId, accountId).run();
  await audit(env, "collector", "local", "x_account.router_failed", "x_account", accountId, {
    event_id: eventId,
    child_id: route.child_id,
    router_slot_id: route.router_slot_id || null,
    error: detail
  });
  return { accepted: true, failed: true };
}

async function claimRoute(env, eventId, accountId, expectedStatus, nextStatus) {
  const current = await env.DB.prepare(
    "SELECT status,error FROM ingest_account_routes WHERE event_id=? AND account_id=?"
  ).bind(eventId, accountId).first();
  if (!current) throw Object.assign(new Error("ingest_route_not_found"), { status: 404 });
  if (current.status === "posted") return { already_posted: true };
  if (current.status !== expectedStatus) {
    throw Object.assign(new Error("route_not_claimable:" + String(current.status || "unknown")), { status: 409, expose: true });
  }
  const result = await env.DB.prepare(
    "UPDATE ingest_account_routes SET status=? WHERE event_id=? AND account_id=? AND status=?"
  ).bind(nextStatus, eventId, accountId, expectedStatus).run();
  if (!result?.meta?.changes) {
    throw Object.assign(new Error("route_claim_race"), { status: 409, expose: true });
  }
  return { already_posted: false };
}

async function internalRouterHealth(env, request) {
  const slot = await verifyRouterCaller(env, request);
  return {
    ok: ["provisioning","ready","assigned"].includes(slot.status),
    slot_id: slot.id,
    child_id: slot.child_id,
    slot_index: Number(slot.slot_index),
    account_id: slot.account_id || null,
    status: slot.status
  };
}

async function internalRouterProcess(env, request) {
  const slot = await verifyRouterCaller(env, request);
  if (!slot.account_id) throw Object.assign(new Error("router_slot_unassigned"), { status: 409 });
  const body = await readJson(request);
  const eventId = String(body.event_id || "").trim();
  const accountId = String(body.account_id || "").trim();
  if (!eventId || accountId !== slot.account_id) {
    throw Object.assign(new Error("router_account_mismatch"), { status: 409 });
  }

  const claim = await claimRoute(env, eventId, accountId, "router_pending", "processing");
  if (claim.already_posted) return { posted: true, duplicate: true };

  const account = await env.DB.prepare(
    "SELECT * FROM x_accounts WHERE id=? AND child_id=? AND enabled=1"
  ).bind(slot.account_id, slot.child_id).first();
  if (!account) {
    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='failed',error='x_account_not_found_or_paused' WHERE event_id=? AND account_id=?"
    ).bind(eventId, accountId).run().catch(() => {});
    throw Object.assign(new Error("x_account_not_found_or_paused"), { status: 404 });
  }

  return processAccountRoute(
    env,
    eventId,
    account,
    String(body.text || ""),
    Array.isArray(body.assets) ? body.assets : []
  );
}

async function internalRouterPublish(env, request) {
  const slot = await verifyRouterCaller(env, request);
  if (!slot.account_id) throw Object.assign(new Error("router_slot_unassigned"), { status: 409 });
  const body = await readJson(request);
  const eventId = String(body.event_id || "").trim();
  const accountId = String(body.account_id || "").trim();
  const output = String(body.output || "").trim();
  if (!eventId || accountId !== slot.account_id || !output) {
    throw Object.assign(new Error("router_publish_payload_invalid"), { status: 400 });
  }

  const claim = await claimRoute(env, eventId, accountId, "local_ai_pending", "publishing");
  if (claim.already_posted) return { posted: true, duplicate: true };

  const account = await env.DB.prepare(
    "SELECT * FROM x_accounts WHERE id=? AND child_id=? AND enabled=1"
  ).bind(slot.account_id, slot.child_id).first();
  if (!account) {
    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='failed',error='x_account_not_found_or_paused' WHERE event_id=? AND account_id=?"
    ).bind(eventId, accountId).run().catch(() => {});
    throw Object.assign(new Error("x_account_not_found_or_paused"), { status: 404 });
  }

  let secrets = {};
  if (account.encrypted_json) secrets = await decryptJson(env.MASTER_KEY, account.encrypted_json);

  try {
    const post = await bufferCreateNow(secrets.buffer_api_key, account.buffer_channel_id, output);
    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='posted',error=NULL WHERE event_id=? AND account_id=?"
    ).bind(eventId, account.id).run();
    await audit(env, "router", slot.id, "x_account.posted", "x_account", account.id, {
      event_id: eventId,
      child_id: account.child_id,
      router_slot_id: slot.id,
      buffer_post_id: post.id,
      buffer_status: post.status || null,
      output_length: output.length
    });
    return { posted: true, post: { id: post.id, status: post.status || null } };
  } catch (error) {
    const detail = safeError(error);
    await env.DB.prepare(
      "UPDATE ingest_account_routes SET status='failed',error=? WHERE event_id=? AND account_id=?"
    ).bind(detail, eventId, account.id).run().catch(() => {});
    await audit(env, "router", slot.id, "x_account.post_failed", "x_account", account.id, {
      event_id: eventId,
      child_id: account.child_id,
      router_slot_id: slot.id,
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
            a.content_mode,a.x_premium,c.name AS child_name,c.web_url,
            rs.id AS router_slot_id,rs.web_url AS router_url,rs.status AS router_status
       FROM x_accounts a
       JOIN x_account_sources xs ON xs.account_id=a.id
       JOIN children c ON c.id=a.child_id
       LEFT JOIN child_router_slots rs ON rs.account_id=a.id
      WHERE xs.source_id=? AND a.enabled=1 AND c.status='ready'
      ORDER BY c.created_at,COALESCE(rs.slot_index,99),a.created_at`
  ).bind(matched.id).all();

  const routed = routedResult.results || [];
  const uniqueChildren = [...new Set(routed.map((x) => x.child_id))];
  const externalId = String(body.external_id || "").trim() || null;
  const eventId = id("evt");
  const incomingMedia = Array.isArray(body.media) ? body.media.slice(0, 4) : [];
  const storedMedia = incomingMedia.map((item) => ({
    kind: String(item?.kind || ""),
    mime_type: String(item?.mime_type || ""),
    filename: String(item?.filename || ""),
    bytes: Number(item?.bytes || 0)
  }));

  try {
    await env.DB.prepare(
      `INSERT INTO ingest_events(id,source_id,external_id,text_content,media_json,routed_children_json,status)
       VALUES(?,?,?,?,?,?,?)`
    ).bind(
      eventId,
      matched.id,
      externalId,
      String(body.text || "").slice(0, 20000),
      JSON.stringify(storedMedia),
      JSON.stringify(uniqueChildren),
      "accepted"
    ).run();
  } catch (error) {
    if (externalId && String(error).toLowerCase().includes("unique")) {
      return { accepted: false, duplicate: true, source: matched, routed_accounts: routed.length };
    }
    throw error;
  }

  const assetsByChild = new Map();
  const mediaErrors = new Map();
  if (incomingMedia.some((item) => item?.kind === "image" && item?.data_base64)) {
    await Promise.all(uniqueChildren.map(async (childId) => {
      try {
        const assets = await uploadChildImages(env, childId, incomingMedia);
        assetsByChild.set(childId, assets);
        await audit(env, "system", "media", "media.cloudinary_uploaded", "child", childId, {
          event_id: eventId,
          asset_count: assets.length
        });
      } catch (error) {
        const detail = safeError(error);
        mediaErrors.set(childId, detail);
        await audit(env, "system", "media", "media.cloudinary_failed", "child", childId, {
          event_id: eventId,
          error: detail
        }).catch(() => {});
      }
    }));
  }

  const routerJobs = [];
  const sourceText = String(body.text || "");

  for (const account of routed) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO ingest_account_routes(event_id,account_id,status) VALUES(?,?,?)"
    ).bind(eventId, account.id, "router_pending").run();

    if (!account.router_slot_id || !account.router_url || account.router_status !== "assigned") {
      const detail = "router_slot_missing_or_not_assigned";
      await env.DB.prepare(
        "UPDATE ingest_account_routes SET status='failed',error=? WHERE event_id=? AND account_id=?"
      ).bind(detail, eventId, account.id).run();
      await audit(env, "system", "router", "x_account.router_failed", "x_account", account.id, {
        event_id: eventId,
        child_id: account.child_id,
        router_slot_id: account.router_slot_id || null,
        error: detail
      });
      continue;
    }

    if (mediaErrors.has(account.child_id)) {
      const detail = "media:" + mediaErrors.get(account.child_id);
      await env.DB.prepare(
        "UPDATE ingest_account_routes SET status='failed',error=? WHERE event_id=? AND account_id=?"
      ).bind(detail.slice(0, 1500), eventId, account.id).run();
      await audit(env, "system", "media", "x_account.post_failed", "x_account", account.id, {
        event_id: eventId,
        child_id: account.child_id,
        error: detail
      });
      continue;
    }

    const dispatch = await makeRouterDispatch(env, account, "process", eventId);
    routerJobs.push({
      event_id: eventId,
      account_id: account.id,
      display_name: account.display_name,
      ai_provider: "deepseek_paid",
      text: sourceText,
      assets: assetsByChild.get(account.child_id) || [],
      router_url: dispatch.router_url,
      router_slot_id: dispatch.router_slot_id,
      router_issued_at: dispatch.issued_at,
      router_signature: dispatch.signature
    });
  }
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
    router_jobs: routerJobs,
    local_ai_jobs: [],
    media_count: incomingMedia.length,
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

  if (path === "/collector/router-result" && request.method === "POST") {
    return json(await reportRouterTransportResult(env, request));
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
      version: "0.3.2",
      database,
      architecture: "master-user-web-five-account-routers",
      collector_ready: Boolean(env.COLLECTOR_SECRET),
      cloudflare_ready: Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN)
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

    if (path === "/api/admin/cloudflare-usage" && request.method === "GET") {
      return json(await cloudflareUsageSummary(env));
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
      const childInfra = normalizeChildInfra(await readJson(request));
      const checks = await preflightInfra(env, childInfra);
      return json({ ok: true, checks });
    }

    if (path === "/api/admin/children" && request.method === "POST") {
      const result = await createChild(env, request, admin);
      return json(result, 201);
    }

    if (path === "/api/admin/children" && request.method === "GET") {
      return json({ children: await listChildren(env) });
    }

    const childRoutersMatch = path.match(/^\/api\/admin\/children\/([^/]+)\/ensure-routers$/);
    if (childRoutersMatch && request.method === "POST") {
      const child = await env.DB.prepare("SELECT id,name,slug FROM children WHERE id=?").bind(childRoutersMatch[1]).first();
      if (!child) throw Object.assign(new Error("child_not_found"), { status: 404 });
      const slots = await ensureChildRouterSlots(env, child, new URL(request.url).origin);
      await audit(env, "admin", admin.id, "child.routers_ensured", "child", child.id, { router_slots: slots.length });
      return json({ ok: true, router_slots: slots });
    }

    const childCodeMatch = path.match(/^\/api\/admin\/children\/([^/]+)\/update-code$/);
    if (childCodeMatch && request.method === "POST") {
      return json(await updateChildWorkerCode(env, request, admin, childCodeMatch[1]));
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

  if (path.startsWith("/internal/router/")) {
    if (path === "/internal/router/health" && request.method === "GET") {
      return json(await internalRouterHealth(env, request));
    }
    if (path === "/internal/router/process" && request.method === "POST") {
      return json(await internalRouterProcess(env, request));
    }
    if (path === "/internal/router/publish" && request.method === "POST") {
      return json(await internalRouterPublish(env, request));
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

    if (path === "/internal/child/settings/ai" && request.method === "POST") {
      return json(await saveChildAiSettings(env, child, await readJson(request)));
    }

    if (path === "/internal/child/settings/ai/test" && request.method === "POST") {
      return json(await testChildDeepseek(env, child));
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
  accountRouterWorkerName,
  deployAccountRouterWorker,
  cloudflareUsageSummary,
  cloudflareWorkerProbe,
  setCloudflareWorkerEnabled,
  deleteCloudflareWorkerVerified,
  rewritePrompt,
  cleanAiOutput,
  xWeightedLength,
  fitStandardX,
  geminiRewrite,
  deepseekRewrite,
  bufferCreateNow,
  uploadCloudinaryImage
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

import { decryptJson } from "./security.js";
import { workerLifecycle } from "./worker-lifecycle.js";

const fail = (message, status = 409) => Object.assign(new Error(message), { status, expose: true });
const reserved = new Set(["www", "admin", "admeo", "api", "mail", "smtp", "ftp", "router", "master", "x-master", "autodiscover"]);
export function domainLabel(value) {
  const label = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) || reserved.has(label)) throw fail("invalid_or_reserved_subdomain", 400);
  return label;
}

async function lookupZone(infra, name) {
  const params = new URLSearchParams({ name, "account.id": infra.cloudflare_account_id });
  const response = await fetch("https://api.cloudflare.com/client/v4/zones?" + params, {
    headers: { Authorization: "Bearer " + infra.cloudflare_api_token }, signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  if (!response.ok || body.success !== true) throw fail("domain_zone_read_failed: cần quyền Zone Read trên miền này", 502);
  const zone = (body.result || []).find(z => z.name === name && z.account?.id === infra.cloudflare_account_id && z.status === "active");
  if (!zone) throw fail("active_zone_not_found_in_master_account");
  return zone;
}

export function childDomains(cfRequest, masterInfra, audit, findZone = lookupZone) {
  async function config(env) {
    return await env.DB.prepare("SELECT enabled,base_domain,zone_id,account_id FROM domain_settings WHERE id=1").first()
      || { enabled: 0, base_domain: "bemail2017.com", zone_id: null, account_id: null };
  }
  async function saveConfig(env, admin, body) {
    if (typeof body.enabled !== "boolean") throw fail("enabled_boolean_required", 400);
    const name = String(body.base_domain || "").trim().toLowerCase();
    if (name.length > 190 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw fail("invalid_base_domain", 400);
    const infra = masterInfra(env);
    const zone = body.enabled ? await findZone(infra, name) : null;
    await env.DB.prepare(`INSERT INTO domain_settings(id,enabled,base_domain,zone_id,account_id) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,base_domain=excluded.base_domain,zone_id=excluded.zone_id,account_id=excluded.account_id,updated_at=CURRENT_TIMESTAMP`)
      .bind(body.enabled ? 1 : 0, name, zone?.id || null, infra.cloudflare_account_id).run();
    await audit(env, "admin", admin.id, "domains.settings_updated", "domain", name, { enabled: body.enabled });
    return config(env);
  }
  async function rows(env, childId) {
    return (await env.DB.prepare("SELECT * FROM child_domains WHERE child_id=? ORDER BY desired DESC,hostname").bind(childId).all()).results || [];
  }
  async function context(env, childId) {
    const child = await env.DB.prepare("SELECT c.*,i.encrypted_json FROM children c LEFT JOIN child_infra i ON i.child_id=c.id WHERE c.id=?").bind(childId).first();
    if (!child) throw fail("child_not_found", 404);
    const stored = child.encrypted_json ? await decryptJson(env.MASTER_KEY, child.encrypted_json) : {};
    const infra = stored.cloudflare_account_id && stored.cloudflare_api_token ? stored : masterInfra(env);
    if (!child.worker_name || [env.CF_MASTER_WORKER || "x-master-router", "tieungummo-demo"].includes(child.worker_name)) throw fail("child_worker_missing_or_protected");
    return { child, infra };
  }
  async function actual(infra, hostname, requestCF) {
    const result = await requestCF(infra, "/workers/domains?hostname=" + encodeURIComponent(hostname));
    if (!Array.isArray(result.result)) throw fail("invalid_cloudflare_domains_response", 502);
    const matches = result.result.filter(d => d.hostname === hostname);
    if (matches.length > 1) throw fail("ambiguous_cloudflare_domain:" + hostname);
    return matches[0] || null;
  }
  function ownership(row, live, infra) {
    if (row.account_id !== infra.cloudflare_account_id) throw fail("domain_account_changed:" + row.hostname);
    if (live && (live.service !== row.worker_name || live.zone_id !== row.zone_id || (row.domain_id && live.id !== row.domain_id))) {
      throw fail("domain_ownership_conflict:" + row.hostname);
    }
  }
  async function stamp(env, row, state, domainId = undefined, error = null) {
    if (domainId === undefined) {
      await env.DB.prepare("UPDATE child_domains SET state=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE hostname=? AND child_id=?")
        .bind(state, error, row.hostname, row.child_id).run();
    } else {
      await env.DB.prepare("UPDATE child_domains SET state=?,domain_id=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE hostname=? AND child_id=?")
        .bind(state, domainId || null, error, row.hostname, row.child_id).run();
    }
  }
  async function attach(env, row, infra, requestCF) {
    try {
      let live = await actual(infra, row.hostname, requestCF);
      ownership(row, live, infra);
      if (!live) {
        await stamp(env, row, "attaching", null);
        await requestCF(infra, "/workers/domains", { method: "PUT", body: JSON.stringify({ hostname: row.hostname, service: row.worker_name, zone_id: row.zone_id }) });
        live = await actual(infra, row.hostname, requestCF);
        // A detached domain receives a new immutable ID on reattachment.
        ownership({ ...row, domain_id: null }, live, infra);
      }
      if (!live?.id) throw fail("domain_attach_not_verified:" + row.hostname, 502);
      await stamp(env, row, "attached", live.id);
    } catch (error) {
      await stamp(env, row, "error", undefined, String(error.message).slice(0, 1000));
      throw error;
    }
  }
  async function detach(env, row, infra, requestCF) {
    try {
      const live = await actual(infra, row.hostname, requestCF);
      ownership(row, live, infra);
      if (live) {
        await stamp(env, row, "detaching", live.id);
        await requestCF(infra, "/workers/domains/" + encodeURIComponent(live.id), { method: "DELETE" });
        if (await actual(infra, row.hostname, requestCF)) throw fail("domain_delete_not_verified:" + row.hostname, 502);
      }
      await stamp(env, row, "suspended", null);
    } catch (error) {
      await stamp(env, row, "error", undefined, String(error.message).slice(0, 1000));
      throw error;
    }
  }
  async function validate(env, label) {
    const cfg = await config(env);
    if (!cfg.enabled || !cfg.zone_id) throw fail("automatic_domains_disabled");
    if (cfg.account_id !== masterInfra(env).cloudflare_account_id) throw fail("domain_settings_account_changed");
    return { cfg, hostname: domainLabel(label) + "." + cfg.base_domain };
  }
  // Caller holds the per-child lifecycle lease; hostname PK arbitrates competing children.
  async function assign(env, admin, childId, label, requestCF = cfRequest) {
    const { cfg, hostname } = await validate(env, label);
    const { child, infra } = await context(env, childId);
    if (infra.cloudflare_account_id !== cfg.account_id) throw fail("legacy_worker_in_other_account: migrate Worker before assigning this domain");
    const worker = await workerLifecycle(requestCF).read({ infra, child_id: childId, worker_name: child.worker_name });
    if (!worker.exists) throw fail("child_worker_missing");
    const existing = await rows(env, childId);
    const fallback = existing.find(r => r.workers_dev_url)?.workers_dev_url || child.web_url;
    if (!fallback || !new URL(fallback).hostname.endsWith(".workers.dev")) throw fail("workers_dev_fallback_missing");
    await env.DB.prepare(`INSERT OR IGNORE INTO child_domains(hostname,child_id,account_id,zone_id,worker_name,workers_dev_url,state,desired)
      VALUES(?,?,?,?,?,?,'pending',0)`).bind(hostname, childId, cfg.account_id, cfg.zone_id, child.worker_name, fallback).run();
    const row = await env.DB.prepare("SELECT * FROM child_domains WHERE hostname=?").bind(hostname).first();
    if (row.child_id !== childId) throw fail("subdomain_already_reserved:" + hostname);
    if (child.status === "ready") await attach(env, row, infra, requestCF);
    else await detach(env, row, infra, requestCF);
    await env.DB.batch([
      env.DB.prepare("UPDATE child_domains SET desired=0 WHERE child_id=?").bind(childId),
      env.DB.prepare("UPDATE child_domains SET desired=1 WHERE hostname=? AND child_id=?").bind(hostname, childId),
      env.DB.prepare("UPDATE children SET web_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind("https://" + hostname, childId)
    ]);
    // Switch to the verified replacement before retiring the previous hostname.
    for (const old of await rows(env, childId)) if (!old.desired) {
      await detach(env, old, infra, requestCF);
      await env.DB.prepare("DELETE FROM child_domains WHERE hostname=? AND child_id=? AND desired=0").bind(old.hostname, childId).run();
    }
    await audit(env, "admin", admin.id, "child.domain_updated", "child", childId, { hostname, active: child.status === "ready" });
    return { hostname, state: child.status === "ready" ? "attached" : "suspended" };
  }
  async function sync(env, childId, status, requestCF = cfRequest) {
    const records = await rows(env, childId);
    if (!records.length) return;
    const { infra } = await context(env, childId);
    for (const row of records) ownership(row, await actual(infra, row.hostname, requestCF), infra);
    for (const row of records) {
      if (status === "ready" && row.desired) await attach(env, row, infra, requestCF);
      else await detach(env, row, infra, requestCF);
    }
    const canonical = records.find(r => r.desired);
    if (canonical) await env.DB.prepare("UPDATE children SET web_url=? WHERE id=?").bind("https://" + canonical.hostname, childId).run();
  }
  async function remove(env, childId, requestCF = cfRequest) {
    const records = await rows(env, childId);
    if (!records.length) return;
    const { infra } = await context(env, childId);
    // All ownership checks happen before the first detach; never remove someone else's hostname.
    for (const row of records) ownership(row, await actual(infra, row.hostname, requestCF), infra);
    for (const row of records) await detach(env, row, infra, requestCF);
    // Keep the journal until Worker deletion and the final D1 cascade succeed.
  }
  return { config, saveConfig, rows, validate, assign, sync, remove };
}

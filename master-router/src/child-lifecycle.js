import { decryptJson, randomHex } from "./security.js";
import { workerLifecycle } from "./worker-lifecycle.js";

const LOCK_SECONDS = 600;
const message = error => String(error?.message || error).slice(0, 1500);

export function childLifecycle(cfRequest, masterInfra, audit, domains = null) {
  const workers = workerLifecycle(cfRequest);

  async function targets(env, childId) {
    const child = await env.DB.prepare(
      "SELECT c.*,i.encrypted_json FROM children c LEFT JOIN child_infra i ON i.child_id=c.id WHERE c.id=?"
    ).bind(childId).first();
    if (!child) throw Object.assign(new Error("child_not_found"), { status: 404 });
    const infra = masterInfra(env);
    const stored = child.encrypted_json ? await decryptJson(env.MASTER_KEY, child.encrypted_json) : {};
    // Pre-v0.3 User Webs may still live on the original user's Cloudflare
    // account. Account routers introduced in v0.3 live on Master's account.
    const legacy = stored.cloudflare_account_id && stored.cloudflare_api_token ? {
      cloudflare_account_id: stored.cloudflare_account_id,
      cloudflare_api_token: stored.cloudflare_api_token
    } : infra;
    const slots = await env.DB.prepare(
      "SELECT id,worker_name,web_url FROM child_router_slots WHERE child_id=? ORDER BY slot_index"
    ).bind(childId).all();
    const items = (slots.results || []).map(s => ({
      infra, child_id: childId, slot_id: s.id, worker_name: s.worker_name, web_url: s.web_url, kind: "router"
    }));
    const workerName = child.worker_name || (child.web_url ? new URL(child.web_url).hostname.split(".")[0] : null);
    if (workerName) items.push({ infra: legacy, child_id: childId, worker_name: workerName, web_url: child.web_url, kind: "user_web" });
    const reserved = env.CF_MASTER_WORKER || "x-master-router";
    if (items.some(t => t.worker_name === reserved || t.worker_name === "tieungummo-demo")) {
      throw Object.assign(new Error("protected_worker"), { status: 409 });
    }
    for (const target of items) await workers.checkAccount(target);
    return { child, items };
  }

  async function lock(env, childId, action) {
    const child = await env.DB.prepare("SELECT id FROM children WHERE id=?").bind(childId).first();
    if (!child) throw Object.assign(new Error("child_not_found"), { status: 404 });
    await env.DB.prepare("INSERT OR IGNORE INTO child_lifecycle(child_id) VALUES(?)").bind(childId).run();
    const operationId = randomHex(16);
    const acquired = await env.DB.prepare(
      `UPDATE child_lifecycle SET operation_id=?,action=?,lease_expires_at=datetime('now','+${LOCK_SECONDS} seconds')
        WHERE child_id=? AND (operation_id IS NULL OR datetime(lease_expires_at)<=CURRENT_TIMESTAMP)`
    ).bind(operationId, action, childId).run();
    if (!acquired.meta?.changes) throw Object.assign(new Error("child_operation_in_progress"), { status: 409 });
    return operationId;
  }

  async function release(env, childId, operationId, error = null) {
    await env.DB.prepare(
      "UPDATE child_lifecycle SET operation_id=NULL,lease_expires_at=NULL,last_error=? WHERE child_id=? AND operation_id=?"
    ).bind(error, childId, operationId).run();
  }

  async function renew(env, childId, operationId) {
    const result = await env.DB.prepare(
      `UPDATE child_lifecycle SET lease_expires_at=datetime('now','+${LOCK_SECONDS} seconds')
        WHERE child_id=? AND operation_id=? AND datetime(lease_expires_at)>CURRENT_TIMESTAMP`
    ).bind(childId, operationId).run();
    if (!result.meta?.changes) throw Object.assign(new Error("child_operation_lease_lost"), { status: 409 });
  }

  function guardedWorkers(env, childId, operationId) {
    return workerLifecycle(async (...args) => {
      await renew(env, childId, operationId);
      return cfRequest(...args);
    });
  }

  async function failed(env, childId, operationId, error) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE children SET status='paused',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND EXISTS(SELECT 1 FROM child_lifecycle WHERE child_id=? AND operation_id=?)"
      ).bind(message(error), childId, childId, operationId),
      env.DB.prepare("UPDATE child_lifecycle SET verified_status=NULL WHERE child_id=? AND operation_id=?").bind(childId, operationId)
    ]);
    await release(env, childId, operationId, message(error));
  }

  async function stopDispatch(env, childId) {
    // Block new dispatch first, then cancel Collector jobs that have not started.
    await env.DB.batch([
      env.DB.prepare("UPDATE children SET status='paused',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(childId),
      env.DB.prepare("UPDATE child_lifecycle SET verified_status=NULL WHERE child_id=?").bind(childId),
      env.DB.prepare(
        `UPDATE ingest_account_routes SET status='failed',error='child_paused'
          WHERE account_id IN (SELECT id FROM x_accounts WHERE child_id=?)
            AND status IN ('accepted','router_pending','local_ai_pending')`
      ).bind(childId)
    ]);
  }

  async function inspect(env, childId) {
    const { child, items } = await targets(env, childId);
    const states = [];
    for (const target of items) states.push({ kind: target.kind, ...(await workers.read(target)) });
    return { child_id: childId, status: child.status, workers: states, verified: true };
  }

  async function changeStatusLocked(env, admin, childId, status, operationId, recordAudit = true) {
    const controlled = guardedWorkers(env, childId, operationId);
    await renew(env, childId, operationId);
    await stopDispatch(env, childId);
    const { items } = await targets(env, childId);
    const row = await env.DB.prepare("SELECT snapshots_json FROM child_lifecycle WHERE child_id=?").bind(childId).first();
    let snapshots = JSON.parse(row?.snapshots_json || "{}");
    const states = [];
    // Read every target before changing triggers. Keep the first snapshot
    // across retries, including a failure halfway through a pause or resume.
    for (const target of items) {
      const actual = await controlled.read(target);
      const key = target.infra.cloudflare_account_id + "/" + target.worker_name;
      if (actual.exists && !snapshots[key]) snapshots[key] = actual;
      if (status === "ready" && !actual.exists) {
        throw Object.assign(new Error("worker_missing:" + target.worker_name), { status: 409, expose: true });
      }
      states.push({ target, actual, key });
    }
    await renew(env, childId, operationId);
    await env.DB.prepare("UPDATE child_lifecycle SET snapshots_json=?,verified_status=NULL WHERE child_id=?").bind(JSON.stringify(snapshots), childId).run();
    for (const { target, actual, key } of states) {
      if (!actual.exists) continue;
      const desired = status === "paused" ? { enabled: false, previews_enabled: false, schedules: [] } : snapshots[key];
      await controlled.setTriggers(target, desired);
    }
    if (domains) await domains.sync(env, childId, status, async (...args) => {
      await renew(env, childId, operationId);
      return cfRequest(...args);
    });
    await renew(env, childId, operationId);
    await env.DB.batch([
      env.DB.prepare("UPDATE children SET status=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, childId),
      env.DB.prepare("UPDATE child_lifecycle SET verified_status=?,snapshots_json=? WHERE child_id=?").bind(status, status === "ready" ? "{}" : JSON.stringify(snapshots), childId)
    ]);
    if (recordAudit) await audit(env, "admin", admin.id, "child." + (status === "paused" ? "cloudflare_paused" : "cloudflare_resumed"), "child", childId, {
      verified: true, workers: states.map(s => ({ worker_name: s.target.worker_name, exists: s.actual.exists }))
    });
    return { verified: true, status, worker_count: states.length, missing_workers: states.filter(s => !s.actual.exists).map(s => s.target.worker_name) };
  }

  async function changeStatus(env, admin, childId, status) {
    const operationId = await lock(env, childId, status === "paused" ? "pause" : "resume");
    try {
      const result = await changeStatusLocked(env, admin, childId, status, operationId);
      await release(env, childId, operationId);
      return result;
    } catch (error) {
      await failed(env, childId, operationId, error);
      throw error;
    }
  }

  async function withDeployment(env, admin, childId, action, deploy) {
    const operationId = await lock(env, childId, action);
    let deploymentStarted = false;
    try {
      const child = await env.DB.prepare("SELECT status FROM children WHERE id=?").bind(childId).first();
      const desiredStatus = child.status === "ready" ? "ready" : "paused";
      // Preserve the original triggers before a code upload can replace them.
      await changeStatusLocked(env, admin, childId, "paused", operationId, false);
      deploymentStarted = true;
      const requestCF = async (...args) => {
        await renew(env, childId, operationId);
        return cfRequest(...args);
      };
      requestCF.assertLease = () => renew(env, childId, operationId);
      const result = await deploy(requestCF);
      const lifecycle = await changeStatusLocked(env, admin, childId, desiredStatus, operationId, false);
      await release(env, childId, operationId);
      const current = await env.DB.prepare("SELECT web_url FROM children WHERE id=?").bind(childId).first();
      return { ...result, verified: true, status: lifecycle.status,
        ...(result.child ? { child: { ...result.child, web_url: current.web_url, status: lifecycle.status } } : {}) };
    } catch (error) {
      if (deploymentStarted) {
        try { await changeStatusLocked(env, admin, childId, "paused", operationId, false); }
        catch (cleanupError) { error.message += "; pause_cleanup:" + message(cleanupError); }
      }
      await failed(env, childId, operationId, error);
      throw error;
    }
  }

  async function remove(env, admin, childId) {
    const operationId = await lock(env, childId, "delete");
    try {
      const controlled = guardedWorkers(env, childId, operationId);
      await renew(env, childId, operationId);
      await stopDispatch(env, childId);
      const { child, items } = await targets(env, childId);
      // Preflight ownership for the whole group before any destructive call.
      for (const target of items) await controlled.read(target);
      if (domains) await domains.remove(env, childId, async (...args) => {
        await renew(env, childId, operationId);
        return cfRequest(...args);
      });
      const deleted = [];
      for (const target of items) deleted.push(await controlled.remove(target));
      await renew(env, childId, operationId);
      // Foreign-key cascades clear private settings, X accounts, Source links,
      // sessions, router secrets and account routes only after all CF checks.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM children WHERE id=?").bind(childId),
        env.DB.prepare(
          "INSERT INTO audit_logs(actor_type,actor_id,action,target_type,target_id,details_json) VALUES('admin',?,'child.deleted','child',?,?)"
        ).bind(admin.id, childId, JSON.stringify({ name: child.name, verified: true, workers: deleted }))
      ]);
      return { deleted: true, verified: true, workers: deleted };
    } catch (error) {
      await failed(env, childId, operationId, error);
      await audit(env, "admin", admin.id, "child.delete_failed", "child", childId, { error: message(error) });
      throw error;
    }
  }

  async function withLock(env, childId, action, work) {
    const operationId = await lock(env, childId, action);
    try {
      const requestCF = async (...args) => {
        await renew(env, childId, operationId);
        return cfRequest(...args);
      };
      requestCF.assertLease = () => renew(env, childId, operationId);
      const result = await work(requestCF);
      await release(env, childId, operationId);
      return result;
    } catch (error) {
      await release(env, childId, operationId, message(error));
      throw error;
    }
  }

  return { inspect, changeStatus, remove, withDeployment, withLock };
}

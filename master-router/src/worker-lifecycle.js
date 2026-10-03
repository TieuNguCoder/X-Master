// Cloudflare control-plane operations. A failed/ambiguous API response never
// counts as proof that a Worker was stopped or deleted.
function failure(message) {
  return Object.assign(new Error(message), { status: 409, expose: true });
}

function missingWorker(error) {
  return error?.cloudflareStatus === 404 && error?.cloudflareCodes?.includes(10007);
}

function pathFor(target) {
  if (!target.worker_name || !/^[\w-]+$/.test(target.worker_name)) {
    throw failure("worker_identity_missing");
  }
  return "/workers/scripts/" + encodeURIComponent(target.worker_name);
}

export function workerLifecycle(cfRequest) {
  async function checkAccount(target) {
    const url = target.web_url ? new URL(target.web_url) : null;
    if (!url?.hostname.endsWith(".workers.dev")) return;
    const expected = url.hostname.split(".").slice(1, -2).join(".");
    const response = await cfRequest(target.infra, "/workers/subdomain");
    if (!expected || response.result?.subdomain !== expected) {
      throw failure("worker_cloudflare_account_mismatch:" + target.worker_name);
    }
  }

  async function read(target) {
    let settings;
    try {
      settings = await cfRequest(target.infra, pathFor(target) + "/settings");
    } catch (error) {
      if (missingWorker(error)) return { exists: false, worker_name: target.worker_name };
      throw error;
    }
    const bindings = settings.result?.bindings;
    if (!Array.isArray(bindings) ||
        !bindings.some(b => b.name === "CHILD_ID" && b.text === target.child_id) ||
        (target.slot_id && !bindings.some(b => b.name === "ROUTER_SLOT_ID" && b.text === target.slot_id))) {
      throw failure("worker_ownership_mismatch:" + target.worker_name);
    }
    const subdomain = await cfRequest(target.infra, pathFor(target) + "/subdomain");
    const schedules = await cfRequest(target.infra, pathFor(target) + "/schedules");
    if (typeof subdomain.result?.enabled !== "boolean" || typeof subdomain.result?.previews_enabled !== "boolean" ||
        !Array.isArray(schedules.result?.schedules) || schedules.result.schedules.some(s => typeof s.cron !== "string" || !s.cron)) {
      throw failure("worker_state_unverifiable:" + target.worker_name);
    }
    return {
      exists: true,
      worker_name: target.worker_name,
      enabled: subdomain.result.enabled,
      previews_enabled: subdomain.result.previews_enabled === true,
      schedules: schedules.result.schedules.map(s => ({ cron: s.cron }))
    };
  }

  async function setTriggers(target, desired) {
    await cfRequest(target.infra, pathFor(target) + "/subdomain", {
      method: "POST",
      body: JSON.stringify({ enabled: desired.enabled, previews_enabled: desired.previews_enabled })
    });
    await cfRequest(target.infra, pathFor(target) + "/schedules", {
      method: "PUT", body: JSON.stringify(desired.schedules)
    });
    const actual = await read(target);
    const cronKey = rows => rows.map(s => s.cron).sort().join("|");
    if (!actual.exists || actual.enabled !== desired.enabled ||
        actual.previews_enabled !== desired.previews_enabled ||
        cronKey(actual.schedules) !== cronKey(desired.schedules)) {
      throw failure("worker_trigger_change_unverified:" + target.worker_name);
    }
    return actual;
  }

  async function remove(target) {
    // Confirm ownership before DELETE and check the script endpoint afterwards.
    // Do not use force: references belonging to another service must not break.
    const before = await read(target);
    if (before.exists) {
      try {
        await cfRequest(target.infra, pathFor(target), { method: "DELETE" });
      } catch (error) {
        if (!missingWorker(error)) throw error;
      }
    }
    const after = await read(target);
    if (after.exists) throw failure("worker_delete_unverified:" + target.worker_name);
    return { worker_name: target.worker_name, deleted: before.exists, already_missing: !before.exists };
  }

  return { checkAccount, read, setTriggers, remove };
}


// Domain-only extension. Never uploads scripts, changes triggers, or writes user settings.
import { decryptJson, randomHex } from './security.js';
const fail = (message, status = 409) => Object.assign(new Error(message), { status, expose: true });
const protectedLabels = new Set(['www','mail','smtp','ftp','api','admin','admeo','autodiscover']);
function label(value, master = false) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(text) || protectedLabels.has(text) || (!master && ['router','master','x-master'].includes(text))) throw fail('invalid_or_reserved_subdomain', 400);
  return text;
}
export function domainManager(requestCF, masterInfra, audit) {
  const cf = (infra, path, init = {}) => requestCF(infra, path, { ...init, signal: AbortSignal.timeout(15000) });
  const table = target => target === 'master' ? 'master_domains' : 'child_domains';
  async function records(env, target) {
    return (await env.DB.prepare('SELECT * FROM ' + table(target) + ' WHERE child_id=? ORDER BY desired DESC,hostname').bind(target).all()).results || [];
  }
  async function config(env) {
    return await env.DB.prepare('SELECT enabled,base_domain,zone_id,account_id FROM domain_settings WHERE id=1').first() || { enabled: 0, base_domain: 'bemail2017.com' };
  }
  async function saveConfig(env, admin, body) {
    if (typeof body.enabled !== 'boolean') throw fail('enabled_boolean_required', 400);
    const name = String(body.base_domain || '').trim().toLowerCase();
    if (name.length > 190 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw fail('invalid_base_domain', 400);
    const infra = masterInfra(env);
    const params = new URLSearchParams({name, 'account.id': infra.cloudflare_account_id});
    const response = await fetch('https://api.cloudflare.com/client/v4/zones?' + params, { headers: { Authorization: 'Bearer ' + infra.cloudflare_api_token }, signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || result.success !== true) throw fail('zone_read_failed: token cần Zone Read cho miền này', 502);
    const zone = (result.result || []).find(z => z.name === name && z.status === 'active' && z.account?.id === infra.cloudflare_account_id);
    if (!zone) throw fail('active_zone_not_found_in_master_account');
    await env.DB.prepare(`INSERT INTO domain_settings(id,enabled,base_domain,zone_id,account_id) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,base_domain=excluded.base_domain,zone_id=excluded.zone_id,account_id=excluded.account_id,updated_at=CURRENT_TIMESTAMP`)
      .bind(body.enabled ? 1 : 0, name, zone.id, infra.cloudflare_account_id).run();
    await audit(env,'admin',admin.id,'domain.settings','domain',name,{enabled:body.enabled});
    return config(env);
  }
  async function context(env, target) {
    if (target === 'master') return { infra: masterInfra(env), worker: env.CF_MASTER_WORKER || 'x-master-router', fallback: '', status: 'ready' };
    const child = await env.DB.prepare('SELECT c.*,i.encrypted_json FROM children c LEFT JOIN child_infra i ON i.child_id=c.id WHERE c.id=?').bind(target).first();
    if (!child) throw fail('child_not_found',404);
    const stored = child.encrypted_json ? await decryptJson(env.MASTER_KEY,child.encrypted_json) : {};
    const infra = stored.cloudflare_account_id && stored.cloudflare_api_token ? stored : masterInfra(env);
    const host = child.web_url ? new URL(child.web_url).hostname : '';
    const worker = child.worker_name || (host.endsWith('.workers.dev') ? host.split('.')[0] : null);
    if (!worker || ['tieungummo-demo', env.CF_MASTER_WORKER || 'x-master-router'].includes(worker)) throw fail('child_worker_identity_missing_or_protected');
    return { infra, worker, fallback: child.web_url || '', status: child.status, slug: child.slug };
  }
  async function lock(env, target, work) {
    // Respect an operation left running by the old v0.5 preview; never resume it automatically.
    const oldTable = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='child_lifecycle'").first();
    if (target !== 'master' && oldTable) {
      const active = await env.DB.prepare("SELECT operation_id FROM child_lifecycle WHERE child_id=? AND operation_id IS NOT NULL AND datetime(lease_expires_at)>CURRENT_TIMESTAMP").bind(target).first();
      if (active) throw fail('previous_update_still_running: đợi thao tác cũ kết thúc rồi gắn miền');
    }
    await env.DB.prepare('INSERT OR IGNORE INTO domain_operations(target) VALUES(?)').bind(target).run();
    const operation = randomHex(16);
    const acquired = await env.DB.prepare("UPDATE domain_operations SET operation_id=?,expires_at=datetime('now','+180 seconds') WHERE target=? AND (operation_id IS NULL OR datetime(expires_at)<=CURRENT_TIMESTAMP)").bind(operation,target).run();
    if (!acquired.meta?.changes) throw fail('domain_operation_in_progress');
    const guard = async () => {
      const renewed = await env.DB.prepare("UPDATE domain_operations SET expires_at=datetime('now','+180 seconds') WHERE target=? AND operation_id=? AND datetime(expires_at)>CURRENT_TIMESTAMP").bind(target,operation).run();
      if (!renewed.meta?.changes) throw fail('domain_operation_lease_lost');
    };
    try { return await work(guard); }
    finally { await env.DB.prepare('UPDATE domain_operations SET operation_id=NULL,expires_at=NULL WHERE target=? AND operation_id=?').bind(target,operation).run(); }
  }
  async function live(infra, hostname, guard) {
    await guard();
    const result = await cf(infra,'/workers/domains?hostname=' + encodeURIComponent(hostname));
    await guard();
    if (!Array.isArray(result.result)) throw fail('invalid_domain_list_response',502);
    const found = result.result.filter(d => d.hostname === hostname);
    if (found.length > 1) throw fail('ambiguous_domain');
    return found[0] || null;
  }
  function owns(row, actual, infra) {
    if (row.account_id !== infra.cloudflare_account_id || (actual && (actual.service !== row.worker_name || actual.zone_id !== row.zone_id || (row.domain_id && actual.id !== row.domain_id)))) throw fail('domain_ownership_conflict:' + row.hostname);
  }
  async function stamp(env,target,row,state,domainId = undefined,error = null) {
    const columns = domainId === undefined ? '' : ',domain_id=?';
    const values = domainId === undefined ? [] : [domainId];
    await env.DB.prepare('UPDATE ' + table(target) + ' SET state=?,last_error=?,updated_at=CURRENT_TIMESTAMP' + columns + ' WHERE hostname=? AND child_id=?').bind(state,error,...values,row.hostname,target).run();
  }
  async function attach(env,target,row,ctx,guard) {
    try {
      let actual = await live(ctx.infra,row.hostname,guard);
      owns(row,actual,ctx.infra);
      if (!actual) {
        await stamp(env,target,row,'attaching',null);
        await guard();
        await cf(ctx.infra,'/workers/domains',{method:'PUT',body:JSON.stringify({hostname:row.hostname,service:row.worker_name,zone_id:row.zone_id})});
        actual = await live(ctx.infra,row.hostname,guard);
        owns({...row,domain_id:null},actual,ctx.infra);
      }
      if (!actual?.id) throw fail('domain_attach_not_verified',502);
      await stamp(env,target,row,'attached',actual.id);
    } catch(error) { await stamp(env,target,row,'error',undefined,String(error.message).slice(0,1000)); throw error; }
  }
  async function detach(env,target,row,ctx,guard) {
    try {
      const actual = await live(ctx.infra,row.hostname,guard);
      owns(row,actual,ctx.infra);
      if (actual) {
        await stamp(env,target,row,'detaching',actual.id);
        await guard();
        await cf(ctx.infra,'/workers/domains/' + encodeURIComponent(actual.id),{method:'DELETE'});
        if (await live(ctx.infra,row.hostname,guard)) throw fail('domain_detach_not_verified',502);
      }
      await stamp(env,target,row,'suspended',null);
    } catch(error) { await stamp(env,target,row,'error',undefined,String(error.message).slice(0,1000)); throw error; }
  }
  async function assign(env,admin,target,requestedLabel) {
    return lock(env,target,async guard => {
      const cfg = await config(env),ctx = await context(env,target),previous = await records(env,target);
      if (!cfg.zone_id) throw fail('save_domain_settings_first');
      if (ctx.infra.cloudflare_account_id !== cfg.account_id) throw fail('worker_and_zone_in_different_accounts');
      const preferred = previous.find(d => d.hostname.endsWith('.' + cfg.base_domain));
      const part = requestedLabel || (preferred ? preferred.hostname.slice(0,-(cfg.base_domain.length+1)) : target === 'master' ? 'router' : ctx.slug);
      const hostname = label(part,target === 'master') + '.' + cfg.base_domain;
      await guard();
      const settings = await cf(ctx.infra,'/workers/scripts/' + encodeURIComponent(ctx.worker) + '/settings');
      await guard();
      const bindings = settings.result?.bindings;
      if (!Array.isArray(bindings) || (target === 'master' ? bindings.some(b => b.name === 'CHILD_ID') : !bindings.some(b => b.name === 'CHILD_ID' && b.text === target))) throw fail('worker_ownership_mismatch');
      const other = target === 'master' ? 'child_domains' : 'master_domains';
      if (await env.DB.prepare('SELECT hostname FROM ' + other + ' WHERE hostname=?').bind(hostname).first()) throw fail('hostname_reserved_by_another_web');
      await env.DB.prepare('INSERT OR IGNORE INTO domain_hostnames(hostname,target) VALUES(?,?)').bind(hostname,target).run();
      const claim = await env.DB.prepare('SELECT target FROM domain_hostnames WHERE hostname=?').bind(hostname).first();
      if (claim.target !== target) throw fail('hostname_reserved_by_another_web');
      await env.DB.prepare('INSERT OR IGNORE INTO ' + table(target) + "(hostname,child_id,account_id,zone_id,worker_name,workers_dev_url,state,desired) VALUES(?,?,?,?,?,?,'pending',0)")
        .bind(hostname,target,cfg.account_id,cfg.zone_id,ctx.worker,ctx.fallback).run();
      const row = await env.DB.prepare('SELECT * FROM ' + table(target) + ' WHERE hostname=?').bind(hostname).first();
      if (row.child_id !== target) throw fail('hostname_reserved_by_another_web');
      // Domain changes never pause/resume a child. Paused children stay paused.
      if (ctx.status === 'ready') await attach(env,target,row,ctx,guard);
      else await detach(env,target,row,ctx,guard);
      await env.DB.batch([
        env.DB.prepare('UPDATE ' + table(target) + ' SET desired=0 WHERE child_id=?').bind(target),
        env.DB.prepare('UPDATE ' + table(target) + ' SET desired=1 WHERE hostname=? AND child_id=?').bind(hostname,target)
      ]);
      for (const old of await records(env,target)) if (!old.desired) {
        await detach(env,target,old,ctx,guard);
        await env.DB.prepare('DELETE FROM ' + table(target) + ' WHERE hostname=? AND child_id=? AND desired=0').bind(old.hostname,target).run();
        await env.DB.prepare('DELETE FROM domain_hostnames WHERE hostname=? AND target=?').bind(old.hostname,target).run();
      }
      await audit(env,'admin',admin.id,'domain.attached','domain',hostname,{target,worker:ctx.worker});
      return {url:'https://' + hostname,state:ctx.status === 'ready' ? 'attached' : 'suspended'};
    });
  }
  async function syncUnlocked(env,target,enabled,guard) {
    const list = await records(env,target);
    if (!list.length) return;
    const ctx = await context(env,target);
    // Verify every recorded domain before any mutation.
    for (const row of list) owns(row,await live(ctx.infra,row.hostname,guard),ctx.infra);
    for (const row of list) {
      if (enabled && row.desired) await attach(env,target,row,ctx,guard);
      else await detach(env,target,row,ctx,guard);
    }
  }
  async function mutation(env,target,body,originalAction) {
    return lock(env,target,async guard => {
      if (body === 'delete' || body === 'paused') await syncUnlocked(env,target,false,guard);
      const result = await originalAction();
      if (body === 'delete' && !await env.DB.prepare('SELECT id FROM children WHERE id=?').bind(target).first()) {
        await env.DB.prepare('DELETE FROM domain_hostnames WHERE target=?').bind(target).run();
      }
      if (body === 'ready') {
        try { await syncUnlocked(env,target,true,guard); }
        catch(error) { result.domain_warning = String(error.message); }
      }
      return result;
    });
  }
  async function afterCreate(env,admin,result) {
    // Outside the v0.4 provisioning transaction: domain failure never rolls back a working web.
    try {
      if ((await config(env)).enabled) {
        const assigned = await assign(env,admin,result.child.id);
        result.child.web_url = assigned.url;
      }
    } catch(error) { result.domain_warning = String(error.message); }
    return result;
  }
  async function overview(env) {
    return { config:await config(env),master:await records(env,'master'),
      children:(await env.DB.prepare('SELECT id,name,slug,status,web_url FROM children ORDER BY created_at DESC').all()).results || [],
      domains:(await env.DB.prepare('SELECT hostname,child_id,state,desired,last_error FROM child_domains ORDER BY desired DESC,hostname').all()).results || [] };
  }
  return {config,saveConfig,assign,mutation,afterCreate,overview};
}

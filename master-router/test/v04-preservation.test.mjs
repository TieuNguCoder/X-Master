import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(readFileSync(new URL('./v04-preservation.json',import.meta.url),'utf8'));
const root=new URL('../../',import.meta.url);
const digest=text=>createHash('sha256').update(text.replaceAll('0.4.1','0.4.0').replace(/\n*$/,'')+'\n').digest('hex');
for(const [file,expected] of Object.entries(manifest.files))assert.equal(digest(readFileSync(new URL(file,root),'utf8')),expected,'v0.4 protected file changed: '+file);
const source=readFileSync(new URL('master-router/src/index.js',root),'utf8');
const matches=[...source.matchAll(/^(?:async )?function (\w+)\(/gm)];
for(let i=0;i<matches.length;i++){
 const match=matches[i],name=match[1];if(name === 'handleApi')continue;
 const end=matches[i+1]?.index ?? source.indexOf('export const __test',match.index);
 assert.equal(digest(source.slice(match.index,end)),manifest.functions[name],'v0.4 function changed: '+name);
}
assert.equal(matches.length-1,Object.keys(manifest.functions).length,'removed/added core functions');
const domainsUI=readFileSync(new URL('master-router/web/domains.js',root),'utf8');
assert.ok(!/update-code|ensure-routers/.test(domainsUI),'domain UI must never redeploy User Workers');
const domains=readFileSync(new URL('master-router/src/domains.js',root),'utf8');
assert.ok(!/renderChildWorker|renderAccountRouter|\/schedules|\/subdomain|status='paused'|UPDATE children|UPDATE x_accounts|UPDATE child_settings|UPDATE child_infra/.test(domains),'domain extension may not write core data or Worker triggers');
console.log('v0.4 preservation: PASS ('+Object.keys(manifest.files).length+' files, '+Object.keys(manifest.functions).length+' functions unchanged except version/final newline)');

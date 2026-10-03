const dq = s => document.querySelector(s);
const escapeDomainText = s => String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let domainState = {children:[],domains:[],master:[]};
let domainBusy = false;
async function domainApi(path, body) {
  const response = await fetch('/api/admin/domains' + path,{credentials:'same-origin',...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
  return result;
}
async function loadDomains() {
  domainState = await domainApi('');
  dq('#domainBase').value = domainState.config.base_domain || 'bemail2017.com';
  dq('#domainAuto').checked = Boolean(domainState.config.enabled);
  const oldTarget = dq('#domainTarget').value;
  dq('#domainTarget').innerHTML = '<option value="master">Master Router — web mẹ</option>' + domainState.children.map(c=>'<option value="'+escapeDomainText(c.id)+'">'+escapeDomainText(c.name)+' · '+escapeDomainText(c.status)+'</option>').join('');
  if ([...dq('#domainTarget').options].some(o=>o.value === oldTarget)) dq('#domainTarget').value = oldTarget;
  const all = [...domainState.master,...domainState.domains];
  dq('#domainList').innerHTML = all.map(row=>'<div class="row"><div><strong>'+escapeDomainText(row.child_id === 'master'?'Master Router':domainState.children.find(c=>c.id === row.child_id)?.name || row.child_id)+'</strong><br><a target="_blank" rel="noopener" href="https://'+escapeDomainText(row.hostname)+'">'+escapeDomainText(row.hostname)+'</a> · '+escapeDomainText(row.state)+(row.last_error?'<br><small>'+escapeDomainText(row.last_error)+'</small>':'')+'</div></div>').join('') || '<p>Chưa gắn miền nào. Lưu cấu hình miền trước, sau đó chọn web cần gắn.</p>';
  suggestLabel();
}
function suggestLabel() {
  const target = dq('#domainTarget').value;
  const rows = target === 'master' ? domainState.master : domainState.domains.filter(r=>r.child_id === target);
  const current = rows.find(r=>r.desired) || rows[0];
  dq('#domainLabel').value = current?.hostname?.split('.')[0] || (target === 'master'?'router':domainState.children.find(c=>c.id === target)?.slug || '');
}
async function domainWork(work) {
  if (domainBusy) return;
  domainBusy = true;
  dq('#tab-domains').querySelectorAll('button').forEach(b=>b.disabled=true);
  try { await work(); }
  catch(error) { dq('#domainStatus').textContent = 'Chưa hoàn tất: ' + error.message; }
  finally { domainBusy=false;dq('#tab-domains').querySelectorAll('button').forEach(b=>b.disabled=false); }
}
dq('[data-tab="domains"]').addEventListener('click',()=>loadDomains().catch(e=>dq('#domainStatus').textContent=e.message));
dq('#domainRefresh').onclick=()=>domainWork(loadDomains);
dq('#domainTarget').onchange=suggestLabel;
dq('#domainSettings').onsubmit=e=>{e.preventDefault();domainWork(async()=>{
  dq('#domainStatus').textContent='Đang kiểm tra miền...';
  await domainApi('/settings',{base_domain:dq('#domainBase').value.trim(),enabled:dq('#domainAuto').checked});
  await loadDomains();dq('#domainStatus').textContent='Đã lưu cấu hình. Chọn Master Router để gắn miền web mẹ.';
});};
dq('#domainAttach').onsubmit=e=>{e.preventDefault();domainWork(async()=>{
  dq('#domainStatus').textContent='Đang gắn miền vào Worker hiện tại...';
  const result = await domainApi('/attach',{target:dq('#domainTarget').value,label:dq('#domainLabel').value.trim()});
  await loadDomains();dq('#domainStatus').textContent=result.state === 'attached'?'Đã gắn '+result.url+'. DNS/SSL có thể cần thời gian cập nhật.':'Đã lưu miền '+result.url+'. Web vẫn đang tạm dừng; trạng thái của web được giữ nguyên.';
});};
dq('#domainAll').onclick=()=>domainWork(async()=>{
  if(!confirm('Chỉ gắn miền cho Master và web con hiện có. Không cập nhật code, không dừng/resume Worker. Tiếp tục?'))return;
  await loadDomains();const results=[];
  for(const target of ['master',...domainState.children.map(c=>c.id)]) {
    const name=target === 'master'?'Master Router':domainState.children.find(c=>c.id===target).name;
    dq('#domainStatus').textContent=results.join('\n')+'\nĐang gắn miền: '+name;
    try {const result=await domainApi('/attach',{target});results.push(name+': '+result.url+' · '+result.state);}
    catch(error){results.push(name+': chưa hoàn tất — '+error.message);}
  }
  await loadDomains();dq('#domainStatus').textContent=results.join('\n');
});

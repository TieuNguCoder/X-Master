export function renderChildWorkerSource() {
  return `
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

function childPage() {
  return \`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>X-Master Child</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#08111f;color:#eef5ff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(145deg,#08111f,#101b30);padding:28px}
.shell{width:min(1120px,100%);margin:auto}.panel{border:1px solid #263955;border-radius:18px;padding:24px;background:#0d1727;box-shadow:0 18px 60px #0005}
h1,h2,h3{margin:0 0 8px}.muted{color:#8ea4c0}.hidden{display:none}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:18px}
.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:18px}.stack{display:grid;gap:12px}
label{display:grid;gap:6px;font-weight:700}input,select,button{font:inherit}input,select{width:100%;background:#08111f;border:1px solid #334967;color:#fff;border-radius:10px;padding:11px}
button{border:0;border-radius:10px;padding:11px 14px;background:#4f7fd4;color:#fff;font-weight:800;cursor:pointer}.secondary{background:#1a2b43}.danger{background:#7f2f3a}.ghost{background:#162238}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.status{margin-top:12px;font-family:ui-monospace,monospace;color:#9fc4ff}
.sources{max-height:250px;overflow:auto;border:1px solid #263955;border-radius:12px;padding:8px}.source{display:flex;gap:9px;align-items:flex-start;padding:8px;border-bottom:1px solid #1d2c42}.source:last-child{border-bottom:0}.source input{width:auto;margin-top:3px}
.account{border:1px solid #263955;border-radius:14px;padding:14px;margin-top:10px}.account-head{display:flex;justify-content:space-between;gap:12px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{font-size:12px;background:#17263a;border:1px solid #2c4261;border-radius:999px;padding:4px 8px}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}.badge{font-size:12px;border-radius:999px;padding:5px 9px;background:#173722;color:#8df0aa}.off{background:#392226;color:#f3a4ad}
@media(max-width:800px){.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr}body{padding:14px}}
</style>
</head>
<body>
<div class="shell">
  <section id="login" class="panel">
    <div class="muted">X-MASTER CHILD WEB</div>
    <h1>Đăng nhập</h1>
    <p class="muted">Nhập mật khẩu được Owner cung cấp.</p>
    <form id="loginForm" class="stack">
      <label>Password<input id="password" type="password" required autocomplete="current-password"></label>
      <button>Đăng nhập</button>
    </form>
    <div id="loginStatus" class="status"></div>
  </section>

  <section id="app" class="hidden">
    <div class="top">
      <div><div class="muted">X-MASTER CHILD WEB</div><h1 id="title">Dashboard</h1><div id="limitText" class="muted"></div></div>
      <button id="reloadBtn" class="ghost">Refresh</button>
    </div>

    <article class="panel" style="margin-bottom:18px">
      <h2>DeepSeek dùng chung cho User Web</h2>
      <p class="muted">Chỉ cấu hình 1 lần. Tất cả tài khoản X bên dưới dùng chung key này; từng account chỉ cần Buffer + Sources + chế độ bài.</p>
      <div class="row">
        <label>DeepSeek API Key<input id="globalDeepseek" type="password" autocomplete="off" placeholder="Nhập DeepSeek API key"></label>
        <div>
          <div id="globalAiState" class="muted" style="margin-top:4px">DeepSeek: chưa cấu hình</div>
          <div class="actions">
            <button id="saveGlobalAi" type="button">Lưu DeepSeek</button>
            <button id="testGlobalAi" type="button" class="secondary">Test DeepSeek</button>
          </div>
        </div>
      </div>
      <div id="globalAiStatus" class="status"></div>
    </article>

    <div class="grid">
      <article class="panel">
        <h2 id="formTitle">Thêm tài khoản X</h2>
        <p class="muted">Mỗi web con tối đa 5 tài khoản. Chỉ nhập Buffer API Key, kiểm tra Buffer để tự lấy tên/username X; sau đó chọn Sources và kiểu bài.</p>
        <form id="accountForm" class="stack">
          <div class="row">
            <label>Tên tài khoản<input id="displayName" placeholder="Tự lấy từ Buffer" required readonly></label>
            <label>X username<input id="xHandle" placeholder="Tự lấy từ Buffer" readonly></label>
          </div>
          <label>Buffer API Key<input id="buffer" type="password" autocomplete="off" placeholder="Nhập token"></label>
          <div class="actions">
            <button id="loadBufferBtn" type="button" class="secondary">Kiểm tra Buffer & lấy tài khoản X</button>
          </div>
          <label id="bufferChannelsWrap" class="hidden">Tài khoản X trong Buffer
            <select id="bufferChannels"></select>
          </label>
          <div class="row">
            <label>Buffer Channel ID<input id="bufferChannelId" placeholder="Tự điền sau khi kiểm tra Buffer" readonly></label>
            <label>Buffer Channel Name<input id="bufferChannelName" placeholder="Tự điền sau khi kiểm tra Buffer" readonly></label>
          </div>
          <div class="row">
            <label>Content mode<select id="mode"><option value="both">News + Airdrop (tự nhận diện)</option><option value="news">News</option><option value="airdrop">Airdrop</option></select></label>
            <label>X Premium<select id="premium"><option value="0">Standard</option><option value="1">Blue / Premium</option></select></label>
          </div>
          <div class="row">
            <label>Ngôn ngữ bài đăng
              <select id="postLanguage">
                <option value="en-US">English (US) — mặc định</option>
                <option value="en-GB">English (UK)</option>
                <option value="vi-VN">Tiếng Việt</option>
                <option value="ja-JP">日本語 — Japanese</option>
                <option value="ko-KR">한국어 — Korean</option>
                <option value="zh-CN">简体中文 — Chinese Simplified</option>
                <option value="zh-TW">繁體中文 — Chinese Traditional</option>
                <option value="es-ES">Español — Spanish</option>
                <option value="pt-BR">Português (Brasil)</option>
                <option value="fr-FR">Français — French</option>
                <option value="de-DE">Deutsch — German</option>
                <option value="id-ID">Bahasa Indonesia</option>
                <option value="th-TH">ไทย — Thai</option>
                <option value="ru-RU">Русский — Russian</option>
                <option value="tr-TR">Türkçe — Turkish</option>
                <option value="hi-IN">हिन्दी — Hindi</option>
                <option value="ar-SA">العربية — Arabic</option>
                <option value="__custom__">Khác / Custom language…</option>
              </select>
            </label>
            <label id="customLanguageWrap" class="hidden">Custom language / BCP-47
              <input id="customLanguage" placeholder="Ví dụ: it-IT, pl-PL, Filipino, Dutch">
            </label>
          </div>
          <label><span>Kênh Telegram cho tài khoản này</span><input id="sourceSearch" placeholder="Tìm tên hoặc @username"></label>
          <div id="sourceChecks" class="sources"></div>
          <label><span>Trạng thái</span><select id="enabled"><option value="1">Đang chạy</option><option value="0">Tạm dừng</option></select></label>
          <div class="actions">
            <button id="saveBtn" type="submit">+ Thêm tài khoản</button>
            <button id="cancelEdit" type="button" class="secondary hidden">Hủy sửa</button>
          </div>
        </form>
        <div id="status" class="status"></div>
      </article>

      <article class="panel">
        <h2>Tài khoản X đã thêm</h2>
        <div id="accounts"></div>
      </article>
    </div>
  </section>
</div>
<script>
const $=s=>document.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
let state={child:null,ai_settings:{provider:"deepseek_paid",deepseek_configured:false},source_catalog:[],accounts:[],router_slots:[],limits:{max_accounts:5,router_slots:5}};
let editingId=null;
let selectedSourceIds=new Set();

function showLogin(message=""){
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  if(message) $("#loginStatus").textContent=message;
}
function showApp(){
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#loginStatus").textContent="";
}
async function api(path,options={}){
  const r=await fetch(path,{credentials:"same-origin",headers:{"content-type":"application/json",...(options.headers||{})},...options});
  const b=await r.json().catch(()=>({}));
  if(!r.ok){
    if(r.status===401&&path!=="/api/login") showLogin("Phiên đăng nhập đã hết hạn. Nhập lại password.");
    throw new Error(b.error||("HTTP "+r.status));
  }
  return b;
}
function renderSources(){
  const q=$("#sourceSearch").value.trim().toLowerCase();
  const rows=(state.source_catalog||[]).filter(s=>{
    const hay=(String(s.title||"")+" "+String(s.username||"")+" "+String(s.channel_id||"")).toLowerCase();
    return !q||hay.includes(q);
  });
  $("#sourceChecks").innerHTML=rows.map(s=>'<label class="source"><input type="checkbox" value="'+esc(s.id)+'" '+(selectedSourceIds.has(String(s.id))?'checked':'')+'><span><strong>'+esc(s.title)+'</strong><br><span class="muted">'+(s.username?'@'+esc(s.username):esc(s.channel_id||""))+'</span></span></label>').join("")||'<div class="muted">Không có kênh phù hợp.</div>';
  document.querySelectorAll("#sourceChecks input[type=checkbox]").forEach(box=>{
    box.onchange=()=>{
      const id=String(box.value);
      if(box.checked)selectedSourceIds.add(id);else selectedSourceIds.delete(id);
    };
  });
}
function checkedSources(){return [...selectedSourceIds];}
function languageLabel(value){
  const names={"en-US":"English (US)","en-GB":"English (UK)","vi-VN":"Tiếng Việt","ja-JP":"Japanese","ko-KR":"Korean","zh-CN":"Chinese (Simplified)","zh-TW":"Chinese (Traditional)","es-ES":"Spanish","pt-BR":"Portuguese (Brazil)","fr-FR":"French","de-DE":"German","id-ID":"Indonesian","th-TH":"Thai","ru-RU":"Russian","tr-TR":"Turkish","hi-IN":"Hindi","ar-SA":"Arabic"};
  return names[value]||value||"English (US)";
}
function knownLanguage(value){
  return [...$("#postLanguage").options].some(o=>o.value===value&&o.value!=="__custom__");
}
function selectedPostLanguage(){
  return $("#postLanguage").value==="__custom__"?($("#customLanguage").value.trim()||"en-US"):$("#postLanguage").value;
}
function updateLanguageUi(){
  $("#customLanguageWrap").classList.toggle("hidden",$("#postLanguage").value!=="__custom__");
}
function renderAccounts(){
  const max=Number(state.limits?.max_accounts||5);
  const routers=state.router_slots||[];
  const readyRouters=routers.filter(r=>r.status==="ready"||r.status==="assigned").length;
  $("#limitText").textContent="X accounts "+state.accounts.length+"/"+max+" · Routers "+readyRouters+"/"+Number(state.limits?.router_slots||5);
  $("#accounts").innerHTML=(state.accounts||[]).map(a=>{
    const chips=(a.sources||[]).map(s=>'<span class="chip">'+esc(s.title)+'</span>').join("");
    return '<div class="account"><div class="account-head"><div><h3>'+esc(a.display_name)+'</h3><div class="muted">'+(a.x_handle?'@'+esc(a.x_handle):'Chưa ghi X username')+'</div></div><span class="badge '+(a.enabled?'':'off')+'">'+(a.enabled?'RUNNING':'PAUSED')+'</span></div>'+
      '<div class="chips">'+(chips||'<span class="muted">Chưa chọn kênh</span>')+'</div>'+
      '<div class="muted" style="margin-top:8px">Router: '+(a.router_slot_index?'R'+esc(a.router_slot_index)+' · '+esc(a.router_status||'missing'):'MISSING')+' · '+esc(a.router_worker_name||'-')+'</div>'+
      '<div class="muted" style="margin-top:5px">AI: DeepSeek dùng chung · '+(a.ai_configured?'configured':'CHƯA CÓ KEY')+' · Buffer: '+(a.buffer_configured?'configured':'chưa có')+' · Channel ID: '+esc(a.buffer_channel_id||'-')+'</div>'+
      '<div class="muted" style="margin-top:5px">Format: '+(a.content_mode==="both"?"News + Airdrop":(a.content_mode==="airdrop"?"Airdrop":"News"))+' · X: '+(a.x_premium?"Premium / Blue":"Standard")+' · Language: '+esc(languageLabel(a.post_language||"en-US"))+'</div>'+
      '<div class="muted" style="margin-top:6px">Bài gần nhất: '+esc(a.last_post_status||'chưa có')+(a.last_post_at?' · '+esc(a.last_post_at):'')+(a.last_post_error?' · '+esc(a.last_post_error):'')+'</div>'+
      '<div class="actions"><button class="test secondary" data-id="'+esc(a.id)+'">Test đăng X</button><button class="edit secondary" data-id="'+esc(a.id)+'">Sửa</button><button class="del danger" data-id="'+esc(a.id)+'">Xóa</button></div></div>';
  }).join("")||'<div class="muted">Chưa có tài khoản X.</div>';
  document.querySelectorAll(".test").forEach(b=>b.onclick=()=>testPost(b.dataset.id));
  document.querySelectorAll(".edit").forEach(b=>b.onclick=()=>beginEdit(b.dataset.id));
  document.querySelectorAll(".del").forEach(b=>b.onclick=()=>removeAccount(b.dataset.id));
  $("#saveBtn").disabled=!editingId&&state.accounts.length>=max;
}
function resetForm(){
  editingId=null;
  selectedSourceIds=new Set();
  $("#accountForm").reset();
  $("#mode").value="both";
  $("#premium").value="0";
  $("#postLanguage").value="en-US";
  $("#customLanguage").value="";
  $("#enabled").value="1";
  $("#displayName").value="";
  $("#xHandle").value="";
  $("#bufferChannelId").value="";
  $("#bufferChannelName").value="";
  $("#bufferChannelsWrap").classList.add("hidden");
  $("#formTitle").textContent="Thêm tài khoản X";
  $("#saveBtn").textContent="+ Thêm tài khoản";
  $("#cancelEdit").classList.add("hidden");
  $("#buffer").value="";
  $("#buffer").placeholder="Nhập Buffer API key";
  updateLanguageUi();
  renderSources();
}
function beginEdit(id){
  const a=state.accounts.find(x=>x.id===id);if(!a)return;
  editingId=id;
  selectedSourceIds=new Set((a.source_ids||[]).map(String));
  $("#formTitle").textContent="Sửa "+a.display_name;
  $("#saveBtn").textContent="Lưu thay đổi";
  $("#cancelEdit").classList.remove("hidden");
  $("#displayName").value=a.display_name||"";
  $("#xHandle").value=a.x_handle||"";
  $("#bufferChannelId").value=a.buffer_channel_id||"";
  $("#bufferChannelName").value=a.buffer_channel_name||"";
  $("#mode").value=a.content_mode||"both";
  $("#premium").value=a.x_premium?"1":"0";
  const lang=a.post_language||"en-US";
  if(knownLanguage(lang)){
    $("#postLanguage").value=lang;$("#customLanguage").value="";
  }else{
    $("#postLanguage").value="__custom__";$("#customLanguage").value=lang;
  }
  updateLanguageUi();
  $("#enabled").value=a.enabled?"1":"0";
  $("#buffer").value="";
  $("#buffer").placeholder=a.buffer_configured?"Đã lưu - nhập Buffer key mới nếu muốn thay":"Nhập Buffer API key";
  $("#sourceSearch").value="";
  renderSources();
  window.scrollTo({top:0,behavior:"smooth"});
}
function payload(){
  return {
    display_name:$("#displayName").value.trim(),
    x_handle:$("#xHandle").value.trim(),
    post_language:selectedPostLanguage(),
    buffer_api_key:$("#buffer").value.trim(),
    buffer_channel_id:$("#bufferChannelId").value.trim(),
    buffer_channel_name:$("#bufferChannelName").value.trim(),
    content_mode:$("#mode").value,
    x_premium:$("#premium").value==="1",
    enabled:$("#enabled").value==="1",
    source_ids:checkedSources()
  };
}
function applyBufferChannel(ch){
  if(!ch)return;
  $("#bufferChannelId").value=ch.id||"";
  $("#bufferChannelName").value=ch.display_name||ch.name||"";
  $("#displayName").value=ch.display_name||ch.name||"X Account";
  $("#xHandle").value=String(ch.x_handle||ch.name||"").replace(/^@/,"");
  if(ch.disconnected||ch.locked){
    $("#status").textContent="Buffer thấy account nhưng channel đang "+(ch.disconnected?"DISCONNECTED":"LOCKED")+". Hãy reconnect/unlock trong Buffer trước.";
  }else{
    $("#status").textContent="Buffer OK · đã tự lấy "+($("#displayName").value||"X account")+(($("#xHandle").value)?" · @"+$("#xHandle").value:"")+".";
  }
}
async function loadBufferChannels(){
  const key=$("#buffer").value.trim();
  if(!key){$("#status").textContent="Nhập Buffer API Key trước.";return;}
  $("#status").textContent="Đang kiểm tra Buffer...";
  $("#loadBufferBtn").disabled=true;
  try{
    const result=await api("/api/buffer/channels",{method:"POST",body:JSON.stringify({buffer_api_key:key})});
    const channels=result.channels||[];
    if(!channels.length){
      $("#bufferChannelsWrap").classList.add("hidden");
      $("#status").textContent="Buffer hợp lệ nhưng chưa thấy tài khoản X nào được kết nối.";
      return;
    }
    $("#bufferChannels").innerHTML=channels.map((ch,i)=>
      '<option value="'+esc(ch.id)+'" data-index="'+i+'">'+esc(ch.display_name||ch.name||ch.id)+(ch.x_handle?' · @'+esc(ch.x_handle):'')+'</option>'
    ).join("");
    $("#bufferChannels").dataset.channels=JSON.stringify(channels);
    $("#bufferChannelsWrap").classList.toggle("hidden",channels.length===1);
    applyBufferChannel(channels[0]);
    if(channels.length>1) $("#status").textContent+=" Có "+channels.length+" X channels; chọn đúng account trong danh sách.";
  }catch(err){
    $("#bufferChannelsWrap").classList.add("hidden");
    $("#status").textContent="Buffer lỗi: "+err.message;
  }finally{$("#loadBufferBtn").disabled=false;}
}
function renderGlobalAi(){
  const configured=Boolean(state.ai_settings?.deepseek_configured);
  $("#globalAiState").textContent=configured?"DeepSeek: configured ✓":"DeepSeek: CHƯA CẤU HÌNH";
  $("#globalDeepseek").placeholder=configured?"Đã lưu - nhập key mới để thay":"Nhập DeepSeek API key";
}
async function saveGlobalAi(){
  const key=$("#globalDeepseek").value.trim();
  if(!key){$("#globalAiStatus").textContent="Nhập DeepSeek API key.";return;}
  $("#saveGlobalAi").disabled=true;
  $("#globalAiStatus").textContent="Đang lưu DeepSeek...";
  try{
    await api("/api/settings/ai",{method:"POST",body:JSON.stringify({deepseek_api_key:key})});
    $("#globalDeepseek").value="";
    $("#globalAiStatus").textContent="Đã lưu DeepSeek dùng chung cho toàn bộ X account.";
    await load();
  }catch(err){$("#globalAiStatus").textContent="DeepSeek lỗi: "+err.message;}
  finally{$("#saveGlobalAi").disabled=false;}
}
async function testGlobalAi(){
  $("#testGlobalAi").disabled=true;
  $("#globalAiStatus").textContent="Đang test DeepSeek...";
  try{
    const result=await api("/api/settings/ai/test",{method:"POST",body:"{}"});
    $("#globalAiStatus").textContent="DeepSeek OK: "+String(result.output||"").slice(0,180);
  }catch(err){$("#globalAiStatus").textContent="DeepSeek test lỗi: "+err.message;}
  finally{$("#testGlobalAi").disabled=false;}
}
async function load(){
  const me=await api("/api/me");
  state=me;
  showApp();
  $("#title").textContent=me.child.name;
  renderGlobalAi();
  renderAccounts();
  if(!editingId)renderSources();
}
$("#loginForm").onsubmit=async e=>{
  e.preventDefault();
  $("#loginStatus").textContent="Đang đăng nhập...";
  try{
    await api("/api/login",{method:"POST",body:JSON.stringify({password:$("#password").value})});
    $("#password").value="";
    await load();
    resetForm();
  }catch(err){$("#loginStatus").textContent="Login failed: "+err.message;}
};
$("#accountForm").onsubmit=async e=>{
  e.preventDefault();
  if(!state.ai_settings?.deepseek_configured){
    $("#status").textContent="Hãy cấu hình DeepSeek dùng chung trước.";
    return;
  }
  if(!$("#bufferChannelId").value.trim()){
    $("#status").textContent="Hãy nhập Buffer key và bấm Kiểm tra Buffer trước.";
    return;
  }
  $("#status").textContent="Đang lưu...";
  try{
    const path=editingId?"/api/accounts/"+encodeURIComponent(editingId):"/api/accounts";
    const method=editingId?"PATCH":"POST";
    await api(path,{method,body:JSON.stringify(payload())});
    $("#status").textContent="Đã lưu.";
    resetForm();
    await load();
  }catch(err){$("#status").textContent="Lỗi: "+err.message;}
};
async function testPost(id){
  if(!confirm("Gửi 1 bài test ngay lên X qua Buffer?"))return;
  $("#status").textContent="Đang gửi bài test...";
  try{
    const result=await api("/api/accounts/"+encodeURIComponent(id)+"/test-post",{method:"POST",body:"{}"});
    $("#status").textContent="Đã gửi bài test qua Buffer. Post ID: "+(result.post?.id||"-");
    await load();
  }catch(err){$("#status").textContent="Test đăng X lỗi: "+err.message;}
}
async function removeAccount(id){
  if(!confirm("Xóa tài khoản X này?"))return;
  try{
    await api("/api/accounts/"+encodeURIComponent(id),{method:"DELETE"});
    if(editingId===id)resetForm();
    await load();
  }catch(err){$("#status").textContent="Lỗi: "+err.message;}
}
$("#cancelEdit").onclick=resetForm;
$("#reloadBtn").onclick=()=>load().catch(err=>$("#status").textContent="Lỗi: "+err.message);
$("#postLanguage").onchange=updateLanguageUi;
$("#loadBufferBtn").onclick=loadBufferChannels;
$("#bufferChannels").onchange=()=>{
  let channels=[];
  try{channels=JSON.parse($("#bufferChannels").dataset.channels||"[]");}catch{}
  const o=$("#bufferChannels").selectedOptions[0];
  if(!o)return;
  applyBufferChannel(channels[Number(o.dataset.index||0)]);
};
$("#sourceSearch").oninput=renderSources;
$("#saveGlobalAi").onclick=saveGlobalAi;
$("#testGlobalAi").onclick=testGlobalAi;
updateLanguageUi();
load().catch(()=>showLogin());
</script>
</body></html>\`;
}

async function masterFetch(env,path,init={}){
  const headers=new Headers(init.headers||{});
  headers.set("content-type","application/json");
  headers.set("x-child-id",env.CHILD_ID);
  headers.set("x-child-secret",env.CHILD_SECRET);
  const target=new Request("https://x-master.internal"+path,{...init,headers});
  if(env.MASTER&&typeof env.MASTER.fetch==="function"){
    return env.MASTER.fetch(target);
  }
  return fetch(env.MASTER_ROOT.replace(/\\\/$/,"")+path,{...init,headers});
}
function sessionFrom(request){
  const cookie=request.headers.get("cookie")||"";
  const token=cookie.split(";").map(v=>v.trim()).find(v=>v.startsWith("xm_child="));
  return token?decodeURIComponent(token.slice("xm_child=".length)):"";
}
async function proxyAuthed(request,env,mapped){
  const r=await masterFetch(env,mapped,{method:request.method,body:["GET","DELETE"].includes(request.method)?undefined:await request.text(),headers:{"x-child-session":sessionFrom(request)}});
  return new Response(await r.text(),{status:r.status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/health"){
      try{
        const r=await masterFetch(env,"/internal/child/health",{method:"GET"});
        const data=await r.json().catch(()=>({}));
        const ok=r.ok&&data.ok===true&&data.child_id===env.CHILD_ID;
        return json({ok,child_id:env.CHILD_ID,master:ok},ok?200:503);
      }catch{return json({ok:false,child_id:env.CHILD_ID,master:false},503);}
    }
    if(request.method==="GET"&&url.pathname==="/") return new Response(childPage(),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    if(url.pathname==="/api/login"&&request.method==="POST"){
      const r=await masterFetch(env,"/internal/child/login",{method:"POST",body:await request.text()});
      const data=await r.text();const headers={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
      const token=r.headers.get("x-child-session");if(token)headers["set-cookie"]="xm_child="+encodeURIComponent(token)+"; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800";
      return new Response(data,{status:r.status,headers});
    }
    if(url.pathname==="/api/me"&&request.method==="GET") return proxyAuthed(request,env,"/internal/child/me");
    if(url.pathname==="/api/settings/ai"&&request.method==="POST") return proxyAuthed(request,env,"/internal/child/settings/ai");
    if(url.pathname==="/api/settings/ai/test"&&request.method==="POST") return proxyAuthed(request,env,"/internal/child/settings/ai/test");
    if(url.pathname==="/api/buffer/channels"&&request.method==="POST") return proxyAuthed(request,env,"/internal/child/buffer/channels");
    if(url.pathname==="/api/accounts"&&request.method==="POST") return proxyAuthed(request,env,"/internal/child/accounts");
    const tm=url.pathname.match(/^\\/api\\/accounts\\/([^/]+)\\/test-post$/);
    if(tm&&request.method==="POST") return proxyAuthed(request,env,"/internal/child/accounts/"+encodeURIComponent(tm[1])+"/test-post");
    const m=url.pathname.match(/^\\/api\\/accounts\\/([^/]+)$/);
    if(m&&(request.method==="PATCH"||request.method==="DELETE")) return proxyAuthed(request,env,"/internal/child/accounts/"+encodeURIComponent(m[1]));
    return new Response("Not found",{status:404});
  }
};
`;
}

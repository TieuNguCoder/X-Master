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

    <div class="grid">
      <article class="panel">
        <h2 id="formTitle">Thêm tài khoản X</h2>
        <p class="muted">Mỗi web con tối đa 5 tài khoản. Mỗi tài khoản có key và danh sách kênh riêng.</p>
        <form id="accountForm" class="stack">
          <div class="row">
            <label>Tên tài khoản<input id="displayName" placeholder="Holly" required></label>
            <label>X username<input id="xHandle" placeholder="@username"></label>
          </div>
          <div class="row">
            <label>AI Provider
              <select id="aiProvider">
                <option value="gemini_free">Gemini Free — chạy trên Collector</option>
                <option value="gemini_paid">Gemini Paid — chạy trên Master</option>
                <option value="deepseek_paid">DeepSeek Paid — chạy trên Master</option>
              </select>
            </label>
            <label id="aiKeyLabel">Gemini API Key<input id="aiKey" type="password" autocomplete="off" placeholder="Nhập Gemini API key"></label>
          </div>
          <div id="aiHint" class="muted">Gemini Free được gọi từ Collector/PC để dùng IP máy của Owner.</div>
          <label>Buffer API Key<input id="buffer" type="password" autocomplete="off" placeholder="Nhập token"></label>
          <div class="actions">
            <button id="loadBufferBtn" type="button" class="secondary">Kiểm tra Buffer & lấy tài khoản X</button>
          </div>
          <label id="bufferChannelsWrap" class="hidden">Tài khoản X trong Buffer
            <select id="bufferChannels"></select>
          </label>
          <div class="row">
            <label>Buffer Channel ID<input id="bufferChannelId" placeholder="Tự điền sau khi chọn tài khoản X"></label>
            <label>Buffer Channel Name<input id="bufferChannelName" placeholder="Tự điền sau khi chọn tài khoản X"></label>
          </div>
          <div class="row">
            <label>Content mode<select id="mode"><option value="news">News</option><option value="airdrop">Airdrop</option></select></label>
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
let state={child:null,source_catalog:[],accounts:[],limits:{max_accounts:5}};
let editingId=null;

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
function renderSources(selected=[]){
  const q=$("#sourceSearch").value.trim().toLowerCase();
  const chosen=new Set(selected||[]);
  const rows=(state.source_catalog||[]).filter(s=>{
    const hay=(String(s.title||"")+" "+String(s.username||"")+" "+String(s.channel_id||"")).toLowerCase();
    return !q||hay.includes(q);
  });
  $("#sourceChecks").innerHTML=rows.map(s=>'<label class="source"><input type="checkbox" value="'+esc(s.id)+'" '+(chosen.has(s.id)?'checked':'')+'><span><strong>'+esc(s.title)+'</strong><br><span class="muted">'+(s.username?'@'+esc(s.username):esc(s.channel_id||""))+'</span></span></label>').join("")||'<div class="muted">Chưa có kênh. Hãy chạy Collector để đồng bộ danh sách Telegram đã join.</div>';
}
function checkedSources(){return [...document.querySelectorAll("#sourceChecks input:checked")].map(x=>x.value);}
function aiProviderLabel(provider){
  if(provider==="gemini_free") return "Gemini Free";
  if(provider==="deepseek_paid") return "DeepSeek Paid";
  return "Gemini Paid";
}
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
function updateAiUi(){
  const provider=$("#aiProvider").value;
  if(provider==="deepseek_paid"){
    $("#aiKeyLabel").childNodes[0].nodeValue="DeepSeek API Key";
    $("#aiKey").placeholder="Nhập DeepSeek API key";
    $("#aiHint").textContent="DeepSeek Paid chạy trên Master Router bằng model deepseek-flash.";
  }else if(provider==="gemini_free"){
    $("#aiKeyLabel").childNodes[0].nodeValue="Gemini Free API Key";
    $("#aiKey").placeholder="Nhập Gemini Free API key";
    $("#aiHint").textContent="Gemini Free chạy trên Collector/PC để tránh giới hạn location của Cloudflare.";
  }else{
    $("#aiKeyLabel").childNodes[0].nodeValue="Gemini Paid API Key";
    $("#aiKey").placeholder="Nhập Gemini Paid API key";
    $("#aiHint").textContent="Gemini Paid chạy trên Master Router.";
  }
}
function renderAccounts(){
  const max=Number(state.limits?.max_accounts||5);
  $("#limitText").textContent="Đang dùng "+state.accounts.length+"/"+max+" tài khoản";
  $("#accounts").innerHTML=(state.accounts||[]).map(a=>{
    const chips=(a.sources||[]).map(s=>'<span class="chip">'+esc(s.title)+'</span>').join("");
    return '<div class="account"><div class="account-head"><div><h3>'+esc(a.display_name)+'</h3><div class="muted">'+(a.x_handle?'@'+esc(a.x_handle):'Chưa ghi X username')+'</div></div><span class="badge '+(a.enabled?'':'off')+'">'+(a.enabled?'RUNNING':'PAUSED')+'</span></div>'+
      '<div class="chips">'+(chips||'<span class="muted">Chưa chọn kênh</span>')+'</div>'+
      '<div class="muted" style="margin-top:8px">AI: '+esc(aiProviderLabel(a.ai_provider))+' · '+(a.ai_configured?'configured':'chưa có key')+' · Buffer: '+(a.buffer_configured?'configured':'chưa có')+' · Channel ID: '+esc(a.buffer_channel_id||'-')+'</div>'+
      '<div class="muted" style="margin-top:5px">Format: '+(a.content_mode==="airdrop"?"Airdrop":"News")+' · X: '+(a.x_premium?"Premium / Blue":"Standard")+' · Language: '+esc(languageLabel(a.post_language||"en-US"))+'</div>'+
      '<div class="muted" style="margin-top:6px">Bài gần nhất: '+esc(a.last_post_status||'chưa có')+(a.last_post_at?' · '+esc(a.last_post_at):'')+(a.last_post_error?' · '+esc(a.last_post_error):'')+'</div>'+
      '<div class="actions"><button class="test secondary" data-id="'+esc(a.id)+'">Test đăng X</button><button class="edit secondary" data-id="'+esc(a.id)+'">Sửa</button><button class="del danger" data-id="'+esc(a.id)+'">Xóa</button></div></div>';
  }).join("")||'<div class="muted">Chưa có tài khoản X.</div>';
  document.querySelectorAll(".test").forEach(b=>b.onclick=()=>testPost(b.dataset.id));
  document.querySelectorAll(".edit").forEach(b=>b.onclick=()=>beginEdit(b.dataset.id));
  document.querySelectorAll(".del").forEach(b=>b.onclick=()=>removeAccount(b.dataset.id));
  $("#saveBtn").disabled=!editingId&&state.accounts.length>=max;
}
function resetForm(){
  editingId=null;$("#accountForm").reset();$("#aiProvider").value="gemini_free";$("#mode").value="news";$("#premium").value="0";$("#postLanguage").value="en-US";$("#customLanguage").value="";$("#enabled").value="1";
  $("#formTitle").textContent="Thêm tài khoản X";$("#saveBtn").textContent="+ Thêm tài khoản";$("#cancelEdit").classList.add("hidden");
  $("#aiKey").value="";$("#buffer").value="";$("#buffer").placeholder="Nhập token";updateAiUi();updateLanguageUi();renderSources([]);
}
function beginEdit(id){
  const a=state.accounts.find(x=>x.id===id);if(!a)return;
  editingId=id;$("#formTitle").textContent="Sửa "+a.display_name;$("#saveBtn").textContent="Lưu thay đổi";$("#cancelEdit").classList.remove("hidden");
  $("#displayName").value=a.display_name||"";$("#xHandle").value=a.x_handle||"";$("#bufferChannelId").value=a.buffer_channel_id||"";$("#bufferChannelName").value=a.buffer_channel_name||"";
  $("#aiProvider").value=a.ai_provider||"gemini_paid";$("#mode").value=a.content_mode||"news";$("#premium").value=a.x_premium?"1":"0";
  const lang=a.post_language||"en-US";if(knownLanguage(lang)){ $("#postLanguage").value=lang;$("#customLanguage").value=""; }else{ $("#postLanguage").value="__custom__";$("#customLanguage").value=lang; }updateLanguageUi();$("#enabled").value=a.enabled?"1":"0";
  $("#aiKey").value="";$("#buffer").value="";updateAiUi();$("#aiKey").placeholder=a.ai_configured?"Đã lưu - nhập key mới để thay":$("#aiKey").placeholder;$("#buffer").placeholder=a.buffer_configured?"Đã lưu - nhập token mới để thay":"Nhập token";
  $("#sourceSearch").value="";renderSources(a.source_ids||[]);window.scrollTo({top:0,behavior:"smooth"});
}
function payload(){
  return {display_name:$("#displayName").value.trim(),x_handle:$("#xHandle").value.trim(),ai_provider:$("#aiProvider").value,ai_api_key:$("#aiKey").value.trim(),post_language:selectedPostLanguage(),buffer_api_key:$("#buffer").value.trim(),buffer_channel_id:$("#bufferChannelId").value.trim(),buffer_channel_name:$("#bufferChannelName").value.trim(),content_mode:$("#mode").value,x_premium:$("#premium").value==="1",enabled:$("#enabled").value==="1",source_ids:checkedSources()};
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
    $("#bufferChannels").innerHTML=channels.map(ch=>'<option value="'+esc(ch.id)+'" data-name="'+esc(ch.display_name||ch.name||"")+'">'+esc(ch.display_name||ch.name||ch.id)+'</option>').join("");
    $("#bufferChannelsWrap").classList.remove("hidden");
    const first=channels[0];
    $("#bufferChannelId").value=first.id||"";
    $("#bufferChannelName").value=first.display_name||first.name||"";
    $("#status").textContent="Đã tìm thấy "+channels.length+" tài khoản X trong Buffer.";
  }catch(err){
    $("#bufferChannelsWrap").classList.add("hidden");
    $("#status").textContent="Buffer lỗi: "+err.message;
  }finally{$("#loadBufferBtn").disabled=false;}
}
async function load(){
  const me=await api("/api/me");state=me;showApp();$("#title").textContent=me.child.name;renderAccounts();if(!editingId)renderSources([]);
}
$("#loginForm").onsubmit=async e=>{e.preventDefault();$("#loginStatus").textContent="Đang đăng nhập...";try{await api("/api/login",{method:"POST",body:JSON.stringify({password:$("#password").value})});$("#password").value="";await load();resetForm();}catch(err){$("#loginStatus").textContent="Login failed: "+err.message;}};
$("#accountForm").onsubmit=async e=>{e.preventDefault();$("#status").textContent="Đang lưu...";try{const path=editingId?"/api/accounts/"+encodeURIComponent(editingId):"/api/accounts";const method=editingId?"PATCH":"POST";await api(path,{method,body:JSON.stringify(payload())});$("#status").textContent="Đã lưu.";resetForm();await load();}catch(err){$("#status").textContent="Lỗi: "+err.message;}};
async function testPost(id){
  if(!confirm("Gửi 1 bài test ngay lên X qua Buffer?"))return;
  $("#status").textContent="Đang gửi bài test...";
  try{
    const result=await api("/api/accounts/"+encodeURIComponent(id)+"/test-post",{method:"POST",body:"{}"});
    $("#status").textContent="Đã gửi bài test qua Buffer. Post ID: "+(result.post?.id||"-");
    await load();
  }catch(err){$("#status").textContent="Test đăng X lỗi: "+err.message;}
}
async function removeAccount(id){if(!confirm("Xóa tài khoản X này?"))return;try{await api("/api/accounts/"+encodeURIComponent(id),{method:"DELETE"});if(editingId===id)resetForm();await load();}catch(err){$("#status").textContent="Lỗi: "+err.message;}}
$("#cancelEdit").onclick=resetForm;$("#reloadBtn").onclick=()=>load().catch(err=>$("#status").textContent="Lỗi: "+err.message);
$("#aiProvider").onchange=updateAiUi;
$("#postLanguage").onchange=updateLanguageUi;
$("#loadBufferBtn").onclick=loadBufferChannels;
$("#bufferChannels").onchange=()=>{const o=$("#bufferChannels").selectedOptions[0];if(!o)return;$("#bufferChannelId").value=o.value;$("#bufferChannelName").value=o.dataset.name||o.textContent||"";};
$("#sourceSearch").oninput=()=>{const selected=checkedSources();renderSources(selected);};
updateAiUi();
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

const $=(s)=>document.querySelector(s);
let state={sources:[],children:[]};

async function api(path,options={}){
  const response=await fetch(path,{credentials:"same-origin",headers:{"content-type":"application/json",...(options.headers||{})},...options});
  const body=await response.json().catch(()=>({}));
  if(!response.ok){
    if(response.status===401&&path!=="/api/admin/login"){showLogin("Phiên Owner đã hết hạn. Đăng nhập lại.");throw new Error("__SESSION_EXPIRED__");}
    throw new Error(body.error||("HTTP "+response.status));
  }
  return body;
}
function esc(value){return String(value??"").replace(/[&<>"']/g,(ch)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}
function toast(message){if(String(message).includes("__SESSION_EXPIRED__"))return;$("#toast").textContent=message;$("#toast").classList.remove("hidden");setTimeout(()=>$("#toast").classList.add("hidden"),3500);}
function showLogin(reason=""){$("#loginCard").classList.remove("hidden");$("#app").classList.add("hidden");$("#logoutBtn").classList.add("hidden");if(reason)$("#loginStatus").textContent=reason;}
function showApp(){$("#loginCard").classList.add("hidden");$("#app").classList.remove("hidden");$("#logoutBtn").classList.remove("hidden");}

async function health(){
  try{const h=await api("/api/health");$("#healthBadge").textContent=h.ok?"MASTER ONLINE":"DEGRADED";$("#healthBadge").className="badge "+(h.ok?"":"error");}
  catch{$("#healthBadge").textContent="OFFLINE";$("#healthBadge").className="badge error";}
}
async function refresh(){
  const data=await api("/api/admin/dashboard");state.sources=data.sources||[];state.children=data.children||[];showApp();renderSources();renderChildren();
}
function renderSources(){
  $("#sourcesList").innerHTML=state.sources.map((s)=>
    '<div class="row"><div class="row-main"><strong>'+esc(s.title)+'</strong><br><small>'+
    (s.username?'@'+esc(s.username):'')+(s.channel_id?' · '+esc(s.channel_id):'')+
    '</small></div></div>'
  ).join("")||'<div class="muted">Chưa có kênh. Hãy chạy Collector để đồng bộ danh sách Telegram đã join.</div>';
}
function aiProviderLabel(provider){
  if(provider==="gemini_free") return "Gemini Free";
  if(provider==="deepseek_paid") return "DeepSeek Paid";
  return "Gemini Paid";
}
function postLanguageLabel(value){
  const names={"en-US":"English (US)","en-GB":"English (UK)","vi-VN":"Tiếng Việt","ja-JP":"Japanese","ko-KR":"Korean","zh-CN":"Chinese (Simplified)","zh-TW":"Chinese (Traditional)","es-ES":"Spanish","pt-BR":"Portuguese (Brazil)","fr-FR":"French","de-DE":"German","id-ID":"Indonesian","th-TH":"Thai","ru-RU":"Russian","tr-TR":"Turkish","hi-IN":"Hindi","ar-SA":"Arabic"};
  return names[value]||value||"English (US)";
}
function renderChildren(){
  $("#childrenList").innerHTML=state.children.map((c)=>{
    const statusClass=c.status==="ready"?"":c.status==="paused"?"paused":"error";
    const accounts=(c.accounts||[]).map((a)=>{
      const channels=(a.sources||[]).map((s)=>'<span class="chip">'+esc(s.title)+'</span>').join("");
      return '<div class="row" style="align-items:flex-start"><div class="row-main"><strong>'+esc(a.display_name)+'</strong>'+
        (a.x_handle?' · @'+esc(a.x_handle):'')+'<br><small>'+(a.enabled?'RUNNING':'PAUSED')+' · Buffer '+(a.buffer_configured?'OK':'-')+
        ' · AI '+esc(aiProviderLabel(a.ai_provider))+' '+(a.ai_configured?'configured':'NO KEY')+'</small><div style="margin-top:4px"><small>Format: '+(a.content_mode==="airdrop"?"Airdrop":"News")+' · X: '+(a.x_premium?"Premium / Blue":"Standard")+' · Language: '+esc(postLanguageLabel(a.post_language||"en-US"))+'</small></div><div style="margin-top:4px"><small>Last post: '+esc(a.last_post_status||'none')+(a.last_post_error?' · '+esc(a.last_post_error):'')+'</small></div><div style="margin-top:6px">'+(channels||'<span class="muted">Chưa chọn kênh</span>')+'</div>'+
        '<div class="actions" style="margin-top:8px"><button class="test-gemini secondary" data-id="'+esc(a.id)+'">Test AI</button><button class="test-pipeline secondary" data-id="'+esc(a.id)+'">Test full pipeline</button><button class="test-account secondary" data-id="'+esc(a.id)+'">Test đăng X</button></div></div></div>';
    }).join("");
    return '<div class="child-card"><div class="child-head"><div><h3>'+esc(c.name)+'</h3><small>'+esc(c.slug)+'</small></div><span class="badge '+statusClass+'">'+esc(c.status.toUpperCase())+'</span></div>'+
      '<div class="meta"><span>X accounts: '+Number(c.account_count||0)+'/5</span><span>Telegram channels: '+Number(c.source_count||0)+'</span><span>Web: '+(c.web_url?'<a href="'+esc(c.web_url)+'" target="_blank" rel="noreferrer">'+esc(c.web_url)+'</a>':'-')+'</span></div>'+
      '<div class="rows" style="margin-top:12px">'+(accounts||'<div class="muted">Chưa có tài khoản X.</div>')+'</div>'+
      '<div class="actions">'+(c.web_url?'<button class="open-child" data-url="'+esc(c.web_url)+'">Open Child</button>':'')+
      '<button class="update-child secondary" data-id="'+esc(c.id)+'">Update Child Web</button>'+
      '<button class="reset-pass secondary" data-id="'+esc(c.id)+'">Reset password</button>'+
      '<button class="toggle-child warn" data-id="'+esc(c.id)+'" data-status="'+esc(c.status)+'">'+(c.status==="paused"?"Resume":"Pause")+'</button>'+
      '<button class="delete-child danger" data-id="'+esc(c.id)+'">Delete</button></div></div>';
  }).join("")||'<div class="muted">Chưa có Child Web.</div>';
  document.querySelectorAll(".test-gemini").forEach((b)=>b.onclick=()=>testGemini(b.dataset.id));
  document.querySelectorAll(".test-pipeline").forEach((b)=>b.onclick=()=>testPipeline(b.dataset.id));
  document.querySelectorAll(".test-account").forEach((b)=>b.onclick=()=>testAccountPost(b.dataset.id));
  document.querySelectorAll(".update-child").forEach((b)=>b.onclick=()=>updateChildCode(b.dataset.id));
  document.querySelectorAll(".open-child").forEach((b)=>b.onclick=()=>window.open(b.dataset.url,"_blank"));
  document.querySelectorAll(".reset-pass").forEach((b)=>b.onclick=()=>resetPassword(b.dataset.id));
  document.querySelectorAll(".toggle-child").forEach((b)=>b.onclick=()=>toggleChild(b.dataset.id,b.dataset.status));
  document.querySelectorAll(".delete-child").forEach((b)=>b.onclick=()=>deleteChild(b.dataset.id));
}
function childPayload(includePassword=true){
  return {
    name:$("#childName").value.trim(),
    ...(includePassword?{password:$("#childPassword").value}:{}),
    cloudflare_account_id:$("#cfAccount").value.trim(),
    cloudflare_api_token:$("#cfToken").value.trim(),
    cloudinary_cloud_name:$("#cloudName").value.trim(),
    cloudinary_api_key:$("#cloudKey").value.trim(),
    cloudinary_api_secret:$("#cloudSecret").value.trim()
  };
}

$("#loginForm").onsubmit=async(e)=>{e.preventDefault();$("#loginStatus").textContent="Đang đăng nhập...";try{await api("/api/admin/login",{method:"POST",body:JSON.stringify({password:$("#adminPassword").value})});$("#adminPassword").value="";$("#loginStatus").textContent="";await refresh();}catch(error){$("#loginStatus").textContent="Login failed: "+error.message;}};
$("#logoutBtn").onclick=async()=>{try{await api("/api/admin/logout",{method:"POST"});}catch{}showLogin("Đã đăng xuất.");};
$("#refreshBtn").onclick=()=>refresh().catch((e)=>toast(e.message));
$("#sourceRefreshBtn").onclick=()=>refresh().catch((e)=>toast(e.message));
$("#auditRefreshBtn").onclick=loadAudit;

document.querySelectorAll(".tab").forEach((tab)=>{tab.onclick=()=>{document.querySelectorAll(".tab").forEach((x)=>x.classList.toggle("active",x===tab));document.querySelectorAll(".tabpage").forEach((p)=>p.classList.add("hidden"));$("#tab-"+tab.dataset.tab).classList.remove("hidden");if(tab.dataset.tab==="audit")loadAudit();};});

$("#preflightBtn").onclick=async()=>{$("#deployStatus").textContent="Đang test Cloudflare + Cloudinary...";$("#preflightBtn").disabled=true;try{const result=await api("/api/admin/children/preflight",{method:"POST",body:JSON.stringify(childPayload(false))});$("#deployStatus").textContent="API READY: "+result.checks.join(", ");}catch(error){$("#deployStatus").textContent="PRECHECK FAILED: "+error.message;}finally{$("#preflightBtn").disabled=false;}};
$("#childForm").onsubmit=async(e)=>{e.preventDefault();const password=$("#childPassword").value;if(password.length<8)return toast("Password tối thiểu 8 ký tự.");$("#deployStatus").textContent="Đang validate → deploy → health check...";[...e.target.querySelectorAll("button")].forEach((b)=>b.disabled=true);try{const result=await api("/api/admin/children",{method:"POST",body:JSON.stringify(childPayload(true))});$("#deployStatus").textContent="READY: "+result.child.web_url;$("#shareText").value="Web: "+result.child.web_url+"\nPassword: "+password;$("#shareCard").classList.remove("hidden");$("#childPassword").value="";$("#cfToken").value="";$("#cloudSecret").value="";await refresh();}catch(error){$("#deployStatus").textContent="DEPLOY FAILED (đã rollback): "+error.message;}finally{[...e.target.querySelectorAll("button")].forEach((b)=>b.disabled=false);}};
$("#copyShareBtn").onclick=async()=>{await navigator.clipboard.writeText($("#shareText").value);toast("Đã copy thông tin tester.");};

async function testGemini(id){
  try{
    const result=await api("/api/admin/accounts/"+encodeURIComponent(id)+"/test-gemini",{method:"POST",body:"{}"});
    toast("AI OK ("+(result.provider||"-")+"): "+(result.output||"").slice(0,140));
  }catch(error){toast("AI lỗi: "+error.message);}
}
async function testPipeline(id){
  if(!confirm("Test Gemini → Buffer → X và đăng một bài test thật?"))return;
  try{
    const result=await api("/api/admin/accounts/"+encodeURIComponent(id)+"/test-pipeline",{method:"POST",body:"{}"});
    toast("Full pipeline OK · Buffer post: "+(result.post?.id||"-")+" · "+(result.post?.status||"-"));
    await refresh();
  }catch(error){toast("Full pipeline lỗi: "+error.message);}
}
async function testAccountPost(id){
  if(!confirm("Gửi 1 bài test ngay lên X qua Buffer?"))return;
  try{
    const result=await api("/api/admin/accounts/"+encodeURIComponent(id)+"/test-post",{method:"POST",body:"{}"});
    toast("Đã gửi bài test. Buffer post: "+(result.post?.id||"-")+" · status="+(result.post?.status||"-"));
    await refresh();
  }catch(error){toast("Test đăng X lỗi: "+error.message);}
}
async function updateChildCode(id){
  if(!confirm("Update code Web con tại chỗ? URL, password và dữ liệu account sẽ được giữ nguyên."))return;
  try{
    toast("Đang update Child Web...");
    await api("/api/admin/children/"+encodeURIComponent(id)+"/update-code",{method:"POST",body:"{}"});
    toast("Child Web đã update.");
    await refresh();
  }catch(error){toast("Update Child lỗi: "+error.message);}
}
async function resetPassword(id){const password=prompt("Password mới (tối thiểu 8 ký tự):");if(!password)return;try{await api("/api/admin/children/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({password})});toast("Đã đổi password. Session tester cũ đã bị revoke.");}catch(error){toast(error.message);}}
async function toggleChild(id,status){const next=status==="paused"?"ready":"paused";try{await api("/api/admin/children/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({status:next})});await refresh();}catch(error){toast(error.message);}}
async function deleteChild(id){if(!confirm("Xóa Child Web này khỏi Cloudflare và X-Master?"))return;try{await api("/api/admin/children/"+encodeURIComponent(id),{method:"DELETE"});await refresh();}catch(error){toast(error.message);}}
async function loadAudit(){
  try{
    const result=await api("/api/admin/audit");
    $("#auditList").innerHTML=(result.audit_logs||[]).map((a)=>{
      let details="";
      if(a.details_json){
        try{
          const d=JSON.parse(a.details_json);
          const important=d.error||d.output||d.buffer_status||d.buffer_post_id;
          details=important?'<div style="margin-top:6px"><small>'+esc(String(important))+'</small></div>':'<div style="margin-top:6px"><small>'+esc(JSON.stringify(d))+'</small></div>';
        }catch{details='<div style="margin-top:6px"><small>'+esc(a.details_json)+'</small></div>';}
      }
      return '<div class="row"><div class="row-main"><strong>'+esc(a.action)+'</strong><br><small>'+esc(a.created_at)+' · '+esc(a.actor_type)+(a.target_id?' · '+esc(a.target_id):'')+'</small>'+details+'</div></div>';
    }).join("")||'<div class="muted">Chưa có log.</div>';
  }catch(error){toast(error.message);}
}

health();refresh().catch(()=>showLogin());

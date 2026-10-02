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
function formatNumber(value){
  const n=Number(value||0);
  if(!Number.isFinite(n))return "-";
  if(Math.abs(n)>=1e9)return (n/1e9).toFixed(n>=1e10?1:2).replace(/\.0+$/,"")+"B";
  if(Math.abs(n)>=1e6)return (n/1e6).toFixed(n>=1e7?1:2).replace(/\.0+$/,"")+"M";
  if(Math.abs(n)>=1e3)return (n/1e3).toFixed(n>=1e4?1:2).replace(/\.0+$/,"")+"K";
  return new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(n);
}
function formatMoney(value,currency="USD"){
  const n=Number(value||0);
  if(!Number.isFinite(n))return "-";
  try{return new Intl.NumberFormat("en-US",{style:"currency",currency:currency||"USD",minimumFractionDigits:2,maximumFractionDigits:4}).format(n);}
  catch{return "$"+n.toFixed(4);}
}
function formatDate(value){
  if(!value)return "-";
  const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);
  return d.toLocaleDateString("vi-VN");
}
function renderChildren(){
  $("#childrenList").innerHTML=state.children.map((c)=>{
    const statusClass=c.status==="ready"?"":c.status==="paused"?"paused":"error";
    const accounts=(c.accounts||[]).map((a)=>{
      const channels=(a.sources||[]).map((s)=>'<span class="chip">'+esc(s.title)+'</span>').join("");
      return '<div class="row" style="align-items:flex-start"><div class="row-main"><strong>'+esc(a.display_name)+'</strong>'+
        (a.x_handle?' · @'+esc(a.x_handle):'')+'<br><small>'+(a.enabled?'RUNNING':'PAUSED')+' · Buffer '+(a.buffer_configured?'OK':'-')+
        ' · AI '+esc(aiProviderLabel(a.ai_provider))+' '+(a.ai_configured?'configured':'NO KEY')+'</small><div style="margin-top:4px"><small>Router: '+(a.router_slot_index?'R'+esc(a.router_slot_index)+' · '+esc(a.router_status||'missing'):'MISSING')+'</small></div><div style="margin-top:4px"><small>Format: '+(a.content_mode==="airdrop"?"Airdrop":"News")+' · X: '+(a.x_premium?"Premium / Blue":"Standard")+' · Language: '+esc(postLanguageLabel(a.post_language||"en-US"))+'</small></div><div style="margin-top:4px"><small>Last post: '+esc(a.last_post_status||'none')+(a.last_post_error?' · '+esc(a.last_post_error):'')+'</small></div><div style="margin-top:6px">'+(channels||'<span class="muted">Chưa chọn kênh</span>')+'</div>'+
        '<div class="actions" style="margin-top:8px"><button class="test-gemini secondary" data-id="'+esc(a.id)+'">Test AI</button><button class="test-pipeline secondary" data-id="'+esc(a.id)+'">Test full pipeline</button><button class="test-account secondary" data-id="'+esc(a.id)+'">Test đăng X</button></div></div></div>';
    }).join("");
    const routers=(c.router_slots||[]).map(r=>'<span class="chip">R'+esc(r.slot_index)+' · '+esc(r.status)+(r.account_id?' · assigned':' · free')+' · '+esc(r.worker_name||'-')+'</span>').join("");
    return '<div class="child-card"><div class="child-head"><div><h3>'+esc(c.name)+'</h3><small>'+esc(c.slug)+'</small></div><span class="badge '+statusClass+'">'+esc(c.status.toUpperCase())+'</span></div>'+
      '<div class="meta"><span>X accounts: '+Number(c.account_count||0)+'/5</span><span>Routers: '+Number((c.router_slots||[]).length)+'/5</span><span>Telegram channels: '+Number(c.source_count||0)+'</span><span>Web: '+(c.web_url?'<a href="'+esc(c.web_url)+'" target="_blank" rel="noreferrer">'+esc(c.web_url)+'</a>':'-')+'</span></div>'+
      '<div style="margin-top:8px">'+(routers||'<span class="muted">Chưa có Router slots.</span>')+'</div>'+
      '<div class="rows" style="margin-top:12px">'+(accounts||'<div class="muted">Chưa có tài khoản X.</div>')+'</div>'+
      '<div class="actions">'+(c.web_url?'<button class="open-child" data-url="'+esc(c.web_url)+'">Open Child</button>':'')+
      ((c.router_slots||[]).length<5?'<button class="ensure-routers secondary" data-id="'+esc(c.id)+'">Tạo đủ 5 Routers</button>':'')+
      '<button class="update-child secondary" data-id="'+esc(c.id)+'">Update User Web</button>'+
      '<button class="reset-pass secondary" data-id="'+esc(c.id)+'">Reset password</button>'+
      '<button class="toggle-child warn" data-id="'+esc(c.id)+'" data-status="'+esc(c.status)+'">'+(c.status==="paused"?"Start Workers":"Stop Workers")+'</button>'+
      '<button class="delete-child danger" data-id="'+esc(c.id)+'">Delete User + Workers</button></div></div>';
  }).join("")||'<div class="muted">Chưa có Child Web.</div>';
  document.querySelectorAll(".test-gemini").forEach((b)=>b.onclick=()=>testGemini(b.dataset.id));
  document.querySelectorAll(".test-pipeline").forEach((b)=>b.onclick=()=>testPipeline(b.dataset.id));
  document.querySelectorAll(".test-account").forEach((b)=>b.onclick=()=>testAccountPost(b.dataset.id));
  document.querySelectorAll(".ensure-routers").forEach((b)=>b.onclick=()=>ensureRouters(b.dataset.id));
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
$("#usageRefreshBtn").onclick=loadCloudflareUsage;

document.querySelectorAll(".tab").forEach((tab)=>{tab.onclick=()=>{document.querySelectorAll(".tab").forEach((x)=>x.classList.toggle("active",x===tab));document.querySelectorAll(".tabpage").forEach((p)=>p.classList.add("hidden"));$("#tab-"+tab.dataset.tab).classList.remove("hidden");if(tab.dataset.tab==="audit")loadAudit();if(tab.dataset.tab==="usage")loadCloudflareUsage();};});

$("#preflightBtn").onclick=async()=>{$("#deployStatus").textContent="Đang test Master Cloudflare + Cloudinary...";$("#preflightBtn").disabled=true;try{const result=await api("/api/admin/children/preflight",{method:"POST",body:JSON.stringify(childPayload(false))});$("#deployStatus").textContent="API READY: "+result.checks.join(", ");}catch(error){$("#deployStatus").textContent="PRECHECK FAILED: "+error.message;}finally{$("#preflightBtn").disabled=false;}};
$("#childForm").onsubmit=async(e)=>{e.preventDefault();const password=$("#childPassword").value;if(password.length<8)return toast("Password tối thiểu 8 ký tự.");$("#deployStatus").textContent="Đang validate → deploy User Web → tạo 5 Router → health check...";[...e.target.querySelectorAll("button")].forEach((b)=>b.disabled=true);try{const result=await api("/api/admin/children",{method:"POST",body:JSON.stringify(childPayload(true))});$("#deployStatus").textContent="READY: "+result.child.web_url;$("#shareText").value="Web: "+result.child.web_url+"\nPassword: "+password;$("#shareCard").classList.remove("hidden");$("#childPassword").value="";$("#cloudSecret").value="";await refresh();}catch(error){$("#deployStatus").textContent="DEPLOY FAILED (đã rollback): "+error.message;}finally{[...e.target.querySelectorAll("button")].forEach((b)=>b.disabled=false);}};
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
async function ensureRouters(id){
  if(!confirm("Tạo/khôi phục đủ 5 Router Worker cho User này?"))return;
  try{
    toast("Đang tạo đủ 5 Router...");
    const result=await api("/api/admin/children/"+encodeURIComponent(id)+"/ensure-routers",{method:"POST",body:"{}"});
    toast("Routers READY: "+(result.router_slots||[]).length+"/5");
    await refresh();
  }catch(error){toast("Router lỗi: "+error.message);}
}
async function updateChildCode(id){
  if(!confirm("Update User Web và bảo đảm đủ 5 Router? URL, password và dữ liệu account được giữ nguyên."))return;
  try{
    toast("Đang update Child Web...");
    await api("/api/admin/children/"+encodeURIComponent(id)+"/update-code",{method:"POST",body:"{}"});
    toast("Child Web đã update.");
    await refresh();
  }catch(error){toast("Update Child lỗi: "+error.message);}
}
async function resetPassword(id){const password=prompt("Password mới (tối thiểu 8 ký tự):");if(!password)return;try{await api("/api/admin/children/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({password})});toast("Đã đổi password. Session tester cũ đã bị revoke.");}catch(error){toast(error.message);}}
async function toggleChild(id,status){
  const next=status==="paused"?"ready":"paused";
  const action=next==="paused"?"DỪNG thật User Web + toàn bộ Router trên Cloudflare?":"BẬT lại User Web + toàn bộ Router trên Cloudflare?";
  if(!confirm(action))return;
  try{
    toast(next==="paused"?"Đang tắt Workers trên Cloudflare...":"Đang bật Workers trên Cloudflare...");
    await api("/api/admin/children/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({status:next})});
    toast(next==="paused"?"Workers đã được tắt thật trên Cloudflare.":"Workers đã hoạt động lại trên Cloudflare.");
    await refresh();
  }catch(error){toast("Cloudflare Worker lỗi: "+error.message);}
}
async function deleteChild(id){
  if(!confirm("XÓA THẬT User này? Hệ thống sẽ xóa User Web + toàn bộ Router Worker trực tiếp trên Cloudflare, xác minh đã biến mất, rồi mới xóa dữ liệu D1."))return;
  if(!confirm("Xác nhận lần cuối: thao tác này không thể hoàn tác."))return;
  try{
    toast("Đang xóa Workers thật trên Cloudflare và xác minh...");
    const result=await api("/api/admin/children/"+encodeURIComponent(id),{method:"DELETE"});
    toast(result.cloudflare_verified?"Đã xóa Worker thật trên Cloudflare + dữ liệu User.":"Delete chưa được xác minh.");
    await refresh();
  }catch(error){toast("KHÔNG xóa dữ liệu: "+error.message);}
}
async function loadCloudflareUsage(){
  $("#usageStatus").textContent="Đang đọc usage trực tiếp từ Cloudflare...";
  $("#usagePermission").classList.add("hidden");
  try{
    const data=await api("/api/admin/cloudflare-usage");
    const count=data.worker_count;
    const limit=Number(data.worker_limit_reference||500);
    $("#usageWorkers").textContent=(count==null?"-":formatNumber(count))+" / "+formatNumber(limit);
    $("#usageWorkersHint").textContent=count==null?"Không đọc được danh sách Worker.":"Còn khoảng "+formatNumber(Math.max(0,limit-Number(count)))+" Worker theo mốc quản lý 500.";
    $("#usageWorkersBar").style.width=count==null?"0%":Math.min(100,(Number(count)/Math.max(1,limit))*100).toFixed(1)+"%";
    $("#usageAccount").textContent="Account "+(data.account_id_masked||"-");

    const billing=data.billing||{};
    $("#usagePeriod").textContent=billing.available?(formatDate(billing.period_start)+" → "+formatDate(billing.period_end)):"-";
    $("#usageCost").textContent=billing.available?(billing.cost_available?formatMoney(billing.total_billed_cost,billing.currency||"USD"):"N/A"):"N/A";
    $("#usageRecords").textContent=billing.available?formatNumber(billing.records||0):"-";
    $("#usageSummary").classList.remove("hidden");

    if(!billing.available){
      $("#usageProductsWrap").classList.add("hidden");
      $("#usageStatus").textContent="Worker usage đã tải. Billing usage chưa khả dụng.";
      $("#usagePermission").classList.remove("hidden");
      $("#usagePermission").textContent=billing.permission_required
        ?"API Token hiện tại chưa có quyền Cloudflare Billing Read. Hãy thêm Account → Billing → Read cho token Master rồi bấm Refresh. Worker count vẫn hoạt động bình thường."
        :"Cloudflare Billing API chưa trả dữ liệu: "+(billing.error||("HTTP "+(billing.status||"-")));
      return;
    }

    $("#usagePermission").classList.add("hidden");
    $("#usageStatus").textContent="Đã cập nhật từ Cloudflare. Usage-based cost không bao gồm phí cố định của subscription.";
    const metrics=billing.metrics||[];
    let currentProduct="";
    const html=[];
    for(const m of metrics){
      if(m.product!==currentProduct){
        currentProduct=m.product;
        html.push('<div class="usage-product">'+esc(currentProduct)+'</div>');
      }
      html.push('<div class="usage-metric"><div class="metric-name"><strong>'+esc(m.metric_name||m.metric_id)+'</strong><small>'+esc(m.metric_id||"")+'</small></div><div class="metric-value"><strong>'+esc(formatNumber(m.quantity))+'</strong><br><small>'+esc(m.unit||"units")+'</small></div><div class="metric-value"><strong>'+(m.cost_available?esc(formatMoney(m.billed_cost,billing.currency||"USD")):"—")+'</strong><br><small>usage cost</small></div></div>');
    }
    $("#usageMetrics").innerHTML=html.join("")||'<div class="muted">Cloudflare chưa trả metric usage nào trong kỳ hiện tại.</div>';
    $("#usageProductsWrap").classList.remove("hidden");
  }catch(error){
    $("#usageStatus").textContent="Cloudflare Usage lỗi: "+error.message;
    $("#usageSummary").classList.add("hidden");
    $("#usageProductsWrap").classList.add("hidden");
  }
}

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

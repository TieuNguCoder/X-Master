export function renderChildWorkerSource() {
  return `
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
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
body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(145deg,#08111f,#101b30)}
.card{width:min(680px,calc(100% - 32px));border:1px solid #263955;border-radius:18px;padding:26px;background:#0d1727;box-shadow:0 18px 60px #0006}
h1{margin:0 0 6px;font-size:30px}.muted{color:#8ea4c0}.hidden{display:none}
label{display:grid;gap:6px;margin:14px 0;font-weight:700}input,select,button{font:inherit}
input,select{background:#08111f;border:1px solid #334967;color:#fff;border-radius:10px;padding:12px}
button{border:0;border-radius:10px;padding:12px 14px;background:#4f7fd4;color:#fff;font-weight:800;cursor:pointer}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1}.status{margin-top:12px;font-family:ui-monospace,monospace;color:#9fc4ff}
.source{padding:9px 0;border-bottom:1px solid #1d2c42}
</style>
</head>
<body>
<div class="card">
  <section id="login">
    <div class="muted">X-MASTER CHILD WEB</div>
    <h1>Đăng nhập</h1>
    <p class="muted">Nhập mật khẩu được Owner cung cấp.</p>
    <form id="loginForm">
      <label>Password<input id="password" type="password" required autocomplete="current-password"></label>
      <button>Đăng nhập</button>
    </form>
    <div id="loginStatus" class="status"></div>
  </section>

  <section id="app" class="hidden">
    <div class="muted">X-MASTER CHILD WEB</div>
    <h1 id="title">Dashboard</h1>
    <p class="muted">Bạn chỉ cần Buffer và Gemini. Hạ tầng do Owner quản lý.</p>
    <form id="settingsForm">
      <label>Gemini API Key<input id="gemini" type="password" placeholder="AIza..." autocomplete="off"></label>
      <label>Buffer API Key<input id="buffer" type="password" placeholder="Buffer token" autocomplete="off"></label>
      <div class="row">
        <label>Content mode
          <select id="mode"><option value="news">News</option><option value="airdrop">Airdrop</option></select>
        </label>
        <label>X Premium
          <select id="premium"><option value="0">Standard</option><option value="1">Blue / Premium</option></select>
        </label>
      </div>
      <button>Lưu cấu hình</button>
    </form>
    <h3>Sources được cấp</h3>
    <div id="sources"></div>
    <div id="status" class="status"></div>
  </section>
</div>
<script>
const $=s=>document.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
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
async function api(path, options={}) {
  const r = await fetch(path,{credentials:"same-origin",headers:{"content-type":"application/json",...(options.headers||{})},...options});
  const b = await r.json().catch(()=>({}));
  if(!r.ok){
    if(r.status===401 && path!=="/api/login") showLogin("Phiên đăng nhập đã hết hạn. Nhập lại password.");
    throw new Error(b.error||("HTTP "+r.status));
  }
  return b;
}
async function load(){
  try{
    const me=await api("/api/me");
    showApp();
    $("#title").textContent=me.child.name;
    $("#mode").value=me.settings.content_mode||"news";
    $("#premium").value=me.settings.x_premium?"1":"0";
    $("#sources").innerHTML=(me.sources||[]).map(s=>'<div class="source">'+esc(s.title)+(s.username?' · @'+esc(s.username):'')+'</div>').join("")||'<div class="muted">Chưa được cấp Source.</div>';
  }catch{}
}
$("#loginForm").onsubmit=async e=>{e.preventDefault();$("#loginStatus").textContent="Đang đăng nhập...";
  try{await api("/api/login",{method:"POST",body:JSON.stringify({password:$("#password").value})});$("#password").value="";await load();}
  catch(err){$("#loginStatus").textContent="Login failed: "+err.message;}
};
$("#settingsForm").onsubmit=async e=>{e.preventDefault();$("#status").textContent="Đang lưu...";
  const body={gemini_api_key:$("#gemini").value,buffer_api_key:$("#buffer").value,content_mode:$("#mode").value,x_premium:$("#premium").value==="1"};
  try{await api("/api/settings",{method:"PUT",body:JSON.stringify(body)});$("#gemini").value="";$("#buffer").value="";$("#status").textContent="Đã lưu an toàn.";}
  catch(err){$("#status").textContent="Lỗi: "+err.message;}
};
load();
</script>
</body></html>\`;
}

async function masterFetch(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  headers.set("x-child-id", env.CHILD_ID);
  headers.set("x-child-secret", env.CHILD_SECRET);
  return fetch(env.MASTER_ROOT.replace(/\\\/$/, "") + path, { ...init, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      try {
        const r = await masterFetch(env, "/internal/child/health", { method: "GET" });
        const data = await r.json().catch(() => ({}));
        const ok = r.ok && data.ok === true && data.child_id === env.CHILD_ID;
        return json({ ok, child_id: env.CHILD_ID, master: ok }, ok ? 200 : 503);
      } catch {
        return json({ ok: false, child_id: env.CHILD_ID, master: false }, 503);
      }
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(childPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.text();
      const r = await masterFetch(env, "/internal/child/login", { method: "POST", body });
      const data = await r.text();
      const headers = { "content-type": "application/json; charset=utf-8" };
      const token = r.headers.get("x-child-session");
      if (token) headers["set-cookie"] = "xm_child=" + encodeURIComponent(token) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800";
      return new Response(data, { status: r.status, headers });
    }
    if ((url.pathname === "/api/me" && request.method === "GET") ||
        (url.pathname === "/api/settings" && request.method === "PUT")) {
      const cookie = request.headers.get("cookie") || "";
      const token = cookie.split(";").map(v=>v.trim()).find(v=>v.startsWith("xm_child="));
      const session = token ? decodeURIComponent(token.slice("xm_child=".length)) : "";
      const mapped = url.pathname === "/api/me" ? "/internal/child/me" : "/internal/child/settings";
      const r = await masterFetch(env, mapped, {
        method: request.method,
        body: request.method === "GET" ? undefined : await request.text(),
        headers: { "x-child-session": session }
      });
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  }
};
`;
}

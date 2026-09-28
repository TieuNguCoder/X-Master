const $ = (s) => document.querySelector(s);
let state = { sources: [], children: [] };

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/admin/login") {
      showLogin("Phiên Owner đã hết hạn. Đăng nhập lại.");
      throw new Error("__SESSION_EXPIRED__");
    }
    throw new Error(body.error || ("HTTP " + response.status));
  }
  return body;
}

function toast(message) {
  if (String(message).includes("__SESSION_EXPIRED__")) return;
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  setTimeout(() => $("#toast").classList.add("hidden"), 3500);
}

function showLogin(reason = "") {
  $("#loginCard").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#logoutBtn").classList.add("hidden");
  if (reason) $("#loginStatus").textContent = reason;
}

function showApp() {
  $("#loginCard").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#logoutBtn").classList.remove("hidden");
}

async function health() {
  try {
    const h = await api("/api/health");
    $("#healthBadge").textContent = h.ok ? "MASTER ONLINE" : "DEGRADED";
    $("#healthBadge").className = "badge " + (h.ok ? "" : "error");
  } catch {
    $("#healthBadge").textContent = "OFFLINE";
    $("#healthBadge").className = "badge error";
  }
}

async function refresh() {
  const data = await api("/api/admin/dashboard");
  state.sources = data.sources || [];
  state.children = data.children || [];
  showApp();
  renderSources();
  renderChildren();
}

function renderSourceChecks() {
  const root = $("#sourceChecks");
  if (!state.sources.length) {
    root.innerHTML = '<span class="muted">Chưa có Source. Bạn vẫn có thể tạo Child rồi cấp Source sau.</span>';
    return;
  }
  root.innerHTML = state.sources.map((s) =>
    '<label class="check"><input type="checkbox" value="' + esc(s.id) + '"> <span>' +
    esc(s.title) + (s.username ? ' · @' + esc(s.username) : '') + '</span></label>'
  ).join("");
}

function renderSources() {
  renderSourceChecks();
  const root = $("#sourcesList");
  root.innerHTML = state.sources.map((s) =>
    '<div class="row"><div class="row-main"><strong>' + esc(s.title) + '</strong><br><small>' +
    (s.username ? '@' + esc(s.username) : '') + (s.channel_id ? ' · ' + esc(s.channel_id) : '') +
    '</small></div><button class="danger source-delete" data-id="' + esc(s.id) + '">Delete</button></div>'
  ).join("") || '<div class="muted">Chưa có Source.</div>';
  document.querySelectorAll(".source-delete").forEach((btn) => btn.onclick = () => deleteSource(btn.dataset.id));
}

function renderChildren() {
  const root = $("#childrenList");
  root.innerHTML = state.children.map((c) => {
    const statusClass = c.status === "ready" ? "" : c.status === "paused" ? "paused" : "error";
    return '<div class="child-card"><div class="child-head"><div><h3>' + esc(c.name) + '</h3><small>' +
      esc(c.slug) + '</small></div><span class="badge ' + statusClass + '">' + esc(c.status.toUpperCase()) +
      '</span></div><div class="meta"><span>Sources: ' + Number(c.source_count || 0) + '</span><span>Web: ' +
      (c.web_url ? '<a href="' + esc(c.web_url) + '" target="_blank" rel="noreferrer">' + esc(c.web_url) + '</a>' : '-') +
      '</span></div><div class="actions">' +
      (c.web_url ? '<button class="open-child" data-url="' + esc(c.web_url) + '">Open</button>' : '') +
      '<button class="reset-pass secondary" data-id="' + esc(c.id) + '">Reset password</button>' +
      '<button class="toggle-child warn" data-id="' + esc(c.id) + '" data-status="' + esc(c.status) + '">' +
      (c.status === "paused" ? "Resume" : "Pause") + '</button>' +
      '<button class="delete-child danger" data-id="' + esc(c.id) + '">Delete</button></div></div>';
  }).join("") || '<div class="muted">Chưa có Child Web.</div>';

  document.querySelectorAll(".open-child").forEach((b) => b.onclick = () => window.open(b.dataset.url, "_blank"));
  document.querySelectorAll(".reset-pass").forEach((b) => b.onclick = () => resetPassword(b.dataset.id));
  document.querySelectorAll(".toggle-child").forEach((b) => b.onclick = () => toggleChild(b.dataset.id, b.dataset.status));
  document.querySelectorAll(".delete-child").forEach((b) => b.onclick = () => deleteChild(b.dataset.id));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));
}

function childPayload(includePassword = true) {
  return {
    name: $("#childName").value.trim(),
    ...(includePassword ? { password: $("#childPassword").value } : {}),
    cloudflare_account_id: $("#cfAccount").value.trim(),
    cloudflare_api_token: $("#cfToken").value.trim(),
    cloudinary_cloud_name: $("#cloudName").value.trim(),
    cloudinary_api_key: $("#cloudKey").value.trim(),
    cloudinary_api_secret: $("#cloudSecret").value.trim(),
    source_ids: [...document.querySelectorAll("#sourceChecks input:checked")].map((x) => x.value)
  };
}

$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#loginStatus").textContent = "Đang đăng nhập...";
  try {
    await api("/api/admin/login", { method:"POST", body:JSON.stringify({ password:$("#adminPassword").value }) });
    $("#adminPassword").value = "";
    $("#loginStatus").textContent = "";
    await refresh();
  } catch (error) {
    $("#loginStatus").textContent = "Login failed: " + error.message;
  }
};

$("#logoutBtn").onclick = async () => {
  try { await api("/api/admin/logout", { method:"POST" }); } catch {}
  showLogin("Đã đăng xuất.");
};

$("#refreshBtn").onclick = () => refresh().catch((e) => toast(e.message));
$("#auditRefreshBtn").onclick = loadAudit;

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === tab));
    document.querySelectorAll(".tabpage").forEach((p) => p.classList.add("hidden"));
    $("#tab-" + tab.dataset.tab).classList.remove("hidden");
    if (tab.dataset.tab === "audit") loadAudit();
  };
});

$("#sourceForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#sourceStatus").textContent = "Đang thêm...";
  try {
    await api("/api/admin/sources", {
      method:"POST",
      body:JSON.stringify({
        title:$("#sourceTitle").value,
        username:$("#sourceUsername").value,
        channel_id:$("#sourceChannelId").value
      })
    });
    e.target.reset();
    $("#sourceStatus").textContent = "Đã thêm Source.";
    await refresh();
  } catch (error) { $("#sourceStatus").textContent = "Lỗi: " + error.message; }
};

async function deleteSource(id) {
  if (!confirm("Xóa Source này?")) return;
  try { await api("/api/admin/sources/" + encodeURIComponent(id), { method:"DELETE" }); await refresh(); }
  catch (error) { toast(error.message); }
}

$("#preflightBtn").onclick = async () => {
  $("#deployStatus").textContent = "Đang test Cloudflare + Cloudinary...";
  $("#preflightBtn").disabled = true;
  try {
    const p = childPayload(false);
    const result = await api("/api/admin/children/preflight", { method:"POST", body:JSON.stringify(p) });
    $("#deployStatus").textContent = "API READY: " + result.checks.join(", ");
  } catch (error) {
    $("#deployStatus").textContent = "PRECHECK FAILED: " + error.message;
  } finally { $("#preflightBtn").disabled = false; }
};

$("#childForm").onsubmit = async (e) => {
  e.preventDefault();
  const password = $("#childPassword").value;
  if (password.length < 8) return toast("Password tối thiểu 8 ký tự.");
  $("#deployStatus").textContent = "Đang validate → deploy → health check...";
  [...e.target.querySelectorAll("button")].forEach((b) => b.disabled = true);
  try {
    const result = await api("/api/admin/children", { method:"POST", body:JSON.stringify(childPayload(true)) });
    $("#deployStatus").textContent = "READY: " + result.child.web_url;
    $("#shareText").value = "Web: " + result.child.web_url + "\nPassword: " + password;
    $("#shareCard").classList.remove("hidden");
    $("#childPassword").value = "";
    $("#cfToken").value = "";
    $("#cloudSecret").value = "";
    await refresh();
  } catch (error) {
    $("#deployStatus").textContent = "DEPLOY FAILED (đã rollback): " + error.message;
  } finally { [...e.target.querySelectorAll("button")].forEach((b) => b.disabled = false); }
};

$("#copyShareBtn").onclick = async () => {
  await navigator.clipboard.writeText($("#shareText").value);
  toast("Đã copy thông tin tester.");
};

async function resetPassword(id) {
  const password = prompt("Password mới (tối thiểu 8 ký tự):");
  if (!password) return;
  try {
    await api("/api/admin/children/" + encodeURIComponent(id), { method:"PATCH", body:JSON.stringify({ password }) });
    toast("Đã đổi password. Session tester cũ đã bị revoke.");
  } catch (error) { toast(error.message); }
}

async function toggleChild(id, status) {
  const next = status === "paused" ? "ready" : "paused";
  try {
    await api("/api/admin/children/" + encodeURIComponent(id), { method:"PATCH", body:JSON.stringify({ status:next }) });
    await refresh();
  } catch (error) { toast(error.message); }
}

async function deleteChild(id) {
  if (!confirm("Xóa Child Web này khỏi Cloudflare và X-Master?")) return;
  try {
    await api("/api/admin/children/" + encodeURIComponent(id), { method:"DELETE" });
    await refresh();
  } catch (error) { toast(error.message); }
}

async function loadAudit() {
  try {
    const result = await api("/api/admin/audit");
    $("#auditList").innerHTML = (result.audit_logs || []).map((a) =>
      '<div class="row"><div class="row-main"><strong>' + esc(a.action) + '</strong><br><small>' +
      esc(a.created_at) + ' · ' + esc(a.actor_type) + (a.target_id ? ' · ' + esc(a.target_id) : '') +
      '</small></div></div>'
    ).join("") || '<div class="muted">Chưa có log.</div>';
  } catch (error) { toast(error.message); }
}

health();
refresh().catch(() => showLogin());

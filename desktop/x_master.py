from __future__ import annotations

import asyncio
import base64
import ctypes
import json
import os
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
import webbrowser
from ctypes import wintypes
from pathlib import Path
from tkinter import messagebox, ttk

APP_NAME = "X-Master"
APP_VERSION = "0.2.4"

ANSI_RE = re.compile(r"\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])")


def clean_console_text(value: str) -> str:
    text = ANSI_RE.sub("", str(value or ""))
    text = text.replace("\r\r\n", "\n").replace("\r\n", "\n")
    return "".join(ch for ch in text if ch == "\n" or ch == "\t" or ord(ch) >= 32)


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes):
    buf = ctypes.create_string_buffer(data)
    return DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte))), buf


def protect(data: bytes) -> str:
    if os.name != "nt":
        return "plain:" + base64.b64encode(data).decode()
    src, _keep = _blob(data)
    dst = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(src), ctypes.c_wchar_p("X-Master"), None, None, None, 0, ctypes.byref(dst)
    ):
        raise ctypes.WinError()
    try:
        return "dpapi:" + base64.b64encode(ctypes.string_at(dst.pbData, dst.cbData)).decode()
    finally:
        ctypes.windll.kernel32.LocalFree(dst.pbData)


def unprotect(value: str) -> bytes:
    if value.startswith("plain:"):
        return base64.b64decode(value[6:])
    if not value.startswith("dpapi:") or os.name != "nt":
        raise ValueError("unsupported secret format")
    src, _keep = _blob(base64.b64decode(value[6:]))
    dst = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(src), None, None, None, None, 0, ctypes.byref(dst)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(dst.pbData, dst.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(dst.pbData)


def app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def data_dir() -> Path:
    root = Path(os.getenv("LOCALAPPDATA") or Path.home()) / "XMaster"
    root.mkdir(parents=True, exist_ok=True)
    return root


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except Exception:
        return {}


def write_json(path: Path, value: dict):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def load_secrets() -> dict:
    path = data_dir() / "secrets.dat"
    try:
        if not path.exists():
            return {}
        return json.loads(unprotect(path.read_text(encoding="utf-8").strip()).decode("utf-8"))
    except Exception:
        return {}


def save_secrets(value: dict):
    raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
    (data_dir() / "secrets.dat").write_text(protect(raw), encoding="utf-8")


HTTP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36 X-Master/0.2.4"
)


def http_json(url: str, method: str = "GET", body=None, headers=None, timeout=20):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req_headers = {
        "accept": "application/json",
        "user-agent": HTTP_USER_AGENT,
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        **(headers or {}),
    }
    if data is not None:
        req_headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(raw or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw or "{}")
        except Exception:
            payload = {"error": raw or str(exc)}
        return exc.code, payload
    except urllib.error.URLError as exc:
        return 0, {"error": "network_error", "detail": str(getattr(exc, "reason", exc))}


def local_gemini_free_rewrite(job: dict) -> str:
    api_key = str(job.get("api_key") or "").strip()
    model = str(job.get("model") or "gemini-3.1-flash-lite").strip()
    source_text = str(job.get("text") or "").strip()
    if not api_key:
        raise RuntimeError("gemini_api_key_missing")
    if not source_text:
        raise RuntimeError("empty_source_text")

    premium = bool(job.get("x_premium"))
    max_chars = 1800 if premium else 260
    mode = str(job.get("content_mode") or "news")
    if mode == "airdrop":
        mode_guide = (
            "Style: concise crypto/airdrop update. Keep only facts present in the source. "
            "Never invent eligibility, rewards, dates, links, prices, or guarantees."
        )
    else:
        mode_guide = (
            "Style: concise news update. Keep only facts present in the source. "
            "Never invent facts, numbers, names, dates, links, quotes, or conclusions."
        )

    prompt = "\n".join([
        "Rewrite the Telegram post below as a standalone X post.",
        mode_guide,
        "Preserve the source language unless a natural translation is necessary.",
        "Do not mention Telegram or that this is a rewrite.",
        "Do not add markdown fences or commentary.",
        "Make the wording distinct rather than copying sentences.",
        f"Maximum {max_chars} characters.",
        "",
        "SOURCE:",
        source_text,
    ])

    status, payload = http_json(
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + urllib.parse.quote(model, safe="")
        + ":generateContent",
        "POST",
        {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.8,
                "maxOutputTokens": 900 if premium else 220,
            },
        },
        {"x-goog-api-key": api_key},
        45,
    )
    if status != 200:
        detail = (
            (payload.get("error") or {}).get("message")
            if isinstance(payload.get("error"), dict)
            else payload.get("error")
        ) or payload.get("detail") or f"HTTP {status}"
        raise RuntimeError(str(detail))

    candidates = payload.get("candidates") or []
    parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
    output = "".join(str(part.get("text") or "") for part in parts).strip()
    output = output.strip(" \t\r\n\\"'“”")
    if not output:
        raise RuntimeError("empty_response")
    if len(output) > max_chars:
        output = output[: max(1, max_chars - 1)].rstrip() + "…"
    return output


async def run_collector():
    from telethon import TelegramClient, events
    from telethon.sessions import StringSession

    api_id = int(os.environ["XM_TELEGRAM_API_ID"])
    api_hash = os.environ["XM_TELEGRAM_API_HASH"]
    session = os.environ["XM_TELEGRAM_SESSION"]
    master_root = os.environ["XM_MASTER_ROOT"].rstrip("/")
    collector_secret = os.environ["XM_COLLECTOR_SECRET"]
    log_path = Path(os.environ.get("XM_COLLECTOR_LOG") or (data_dir() / "collector.log"))
    version_path = Path(os.environ.get("XM_COLLECTOR_VERSION_FILE") or (data_dir() / "collector.version"))
    version_path.write_text(APP_VERSION, encoding="utf-8")

    def log(msg: str):
        line = time.strftime("%Y-%m-%d %H:%M:%S") + "  " + msg
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    allowed_ids: set[str] = set()
    allowed_users: set[str] = set()
    source_cache: list[dict] = []
    last_miss_refresh = 0.0

    def sync_sources_blocking():
        status, payload = http_json(
            master_root + "/collector/sources",
            headers={"x-collector-secret": collector_secret},
            timeout=20,
        )
        if status != 200:
            raise RuntimeError("source sync failed: " + str(payload))
        return payload.get("sources") or []

    async def sync_sources():
        nonlocal allowed_ids, allowed_users, source_cache
        source_cache = await asyncio.to_thread(sync_sources_blocking)
        allowed_ids = {str(s.get("channel_id")) for s in source_cache if s.get("channel_id")}
        allowed_users = {str(s.get("username")).lower() for s in source_cache if s.get("username")}
        log(f"Active sources synced: {len(source_cache)}")

    async def sync_joined_catalog():
        dialogs = await client.get_dialogs()
        catalog = []
        for dialog in dialogs:
            if not getattr(dialog, "is_channel", False):
                continue
            entity = getattr(dialog, "entity", None)
            channel_id = str(getattr(entity, "id", "") or "")
            if channel_id and not channel_id.startswith("-100"):
                channel_id = "-100" + channel_id
            username = str(getattr(entity, "username", "") or "").lower()
            title = str(getattr(dialog, "name", "") or getattr(entity, "title", "") or username or channel_id)
            if not title or (not username and not channel_id):
                continue
            catalog.append({
                "title": title,
                "username": username,
                "channel_id": channel_id,
            })

        status, payload = await asyncio.to_thread(
            http_json,
            master_root + "/collector/catalog",
            "POST",
            {"sources": catalog},
            {"x-collector-secret": collector_secret},
            45,
        )
        if status != 200:
            raise RuntimeError("catalog sync failed: " + str(payload))
        log(f"Telegram catalog synced: {payload.get('synced', 0)} joined channels")
        return catalog

    async def process_local_ai_job(job: dict):
        account_id = str(job.get("account_id") or "")
        event_id = str(job.get("event_id") or "")
        result = {"event_id": event_id, "account_id": account_id}
        try:
            output = await asyncio.to_thread(local_gemini_free_rewrite, job)
            result["output"] = output
            log(f"LOCAL_AI rewritten account={account_id} event={event_id} chars={len(output)}")
        except Exception as exc:
            result["error"] = str(exc)
            log(f"LOCAL_AI failed account={account_id} event={event_id} error={exc}")

        status, payload = await asyncio.to_thread(
            http_json,
            master_root + "/collector/local-ai-result",
            "POST",
            result,
            {"x-collector-secret": collector_secret},
            45,
        )
        if status == 200:
            if payload.get("posted"):
                post_id = (payload.get("post") or {}).get("id") or "-"
                log(f"LOCAL_AI posted account={account_id} event={event_id} post={post_id}")
            else:
                log(f"LOCAL_AI result accepted account={account_id} event={event_id} error={payload.get('error') or '-'}")
        else:
            log(f"LOCAL_AI callback failed status={status} account={account_id} event={event_id} payload={payload}")

    client = TelegramClient(StringSession(session), api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError("Telegram StringSession is not authorized.")

    try:
        await sync_joined_catalog()
    except Exception as exc:
        log("Initial Telegram catalog sync failed: " + str(exc))

    startup_synced = False
    for attempt in range(1, 7):
        try:
            await sync_sources()
            startup_synced = True
            break
        except Exception as exc:
            log(f"Initial source sync failed attempt={attempt}/6: {exc}")
            if attempt < 6:
                await asyncio.sleep(min(5 * attempt, 20))

    if not startup_synced:
        log("Collector connected to Telegram, but Master source sync is unavailable. Keeping Collector alive and retrying automatically.")

    @client.on(events.NewMessage())
    async def on_message(event):
        nonlocal last_miss_refresh
        try:
            chat_id = str(event.chat_id or "")
            chat = await event.get_chat()
            username = str(getattr(chat, "username", "") or "").lower()
            label = username or chat_id

            if chat_id not in allowed_ids and username not in allowed_users:
                now = time.monotonic()
                if now - last_miss_refresh >= 3:
                    last_miss_refresh = now
                    try:
                        await sync_sources()
                        log(f"Source cache refreshed on message miss chat={label}")
                    except Exception as exc:
                        log("Source refresh on message miss failed: " + str(exc))

                if chat_id not in allowed_ids and username not in allowed_users:
                    log(f"SKIPPED unassigned chat={label} msg={event.message.id}")
                    return

            text = event.raw_text or ""
            media = []
            if event.message.media:
                media.append({"kind": type(event.message.media).__name__})

            log(f"CAPTURED chat={label} msg={event.message.id} text={len(text)} media={len(media)}")

            body = {
                "source": {"channel_id": chat_id, "username": username},
                "external_id": str(event.message.id),
                "text": text,
                "media": media,
            }

            status, payload = await asyncio.to_thread(
                http_json,
                master_root + "/ingest",
                "POST",
                body,
                {"x-collector-secret": collector_secret},
                30,
            )
            if status in (200, 202):
                routed_accounts = payload.get("routed_accounts")
                routed_count = len(routed_accounts) if isinstance(routed_accounts, list) else 0
                local_jobs = payload.get("local_ai_jobs") or []
                log(
                    f"ROUTED chat={label} msg={event.message.id} "
                    f"children={payload.get('routed_children', 0)} accounts={routed_count} "
                    f"local_ai={len(local_jobs)} event={payload.get('event_id', '-')}"
                )
                if local_jobs:
                    await asyncio.gather(*(process_local_ai_job(job) for job in local_jobs))
            else:
                log(f"FAILED ingest status={status} chat={label} msg={event.message.id} payload={payload}")
        except Exception as exc:
            log("FAILED message: " + str(exc))

    async def refresher():
        catalog_tick = 0
        while True:
            await asyncio.sleep(15)
            try:
                await sync_sources()
            except Exception as exc:
                log("Active source refresh error: " + str(exc))
            catalog_tick += 1
            if catalog_tick >= 5:
                catalog_tick = 0
                try:
                    await sync_joined_catalog()
                except Exception as exc:
                    log("Telegram catalog refresh error: " + str(exc))

    log(f"Collector started version={APP_VERSION}.")
    asyncio.create_task(refresher())
    await client.run_until_disconnected()


class XMasterApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_NAME} v{APP_VERSION}")
        self.geometry("1080x720")
        self.minsize(900, 620)

        self.root_dir = app_root()
        self.data = data_dir()
        self.state_path = self.data / "deployment.json"
        self.secrets = load_secrets()
        self.state = read_json(self.state_path)
        self.deploy_proc: subprocess.Popen | None = None
        self.collector_proc: subprocess.Popen | None = None
        self.collector_pid_path = self.data / "collector.pid"
        self.collector_version_path = self.data / "collector.version"
        self.owner_log = self.data / "owner.log"
        self.collector_log = self.data / "collector.log"

        self._build()
        self._load_values()
        self.after(500, self.refresh_status)

    def log(self, msg: str):
        line = time.strftime("%Y-%m-%d %H:%M:%S") + "  " + msg
        with self.owner_log.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        self.activity.set(msg)

    def _build(self):
        outer = ttk.Frame(self, padding=14)
        outer.pack(fill="both", expand=True)

        head = ttk.Frame(outer)
        head.pack(fill="x")
        ttk.Label(head, text="X-Master", font=("Segoe UI", 20, "bold")).pack(side="left")
        ttk.Label(head, text="  Master Router · Sources · Child Webs").pack(side="left", pady=(8, 0))
        self.global_status = tk.StringVar(value="Checking...")
        ttk.Label(head, textvariable=self.global_status).pack(side="right", pady=(8, 0))

        tabs = ttk.Notebook(outer)
        tabs.pack(fill="both", expand=True, pady=(14, 8))

        router = ttk.Frame(tabs, padding=14)
        collector = ttk.Frame(tabs, padding=14)
        logs = ttk.Frame(tabs, padding=14)
        tabs.add(router, text="Master Router")
        tabs.add(collector, text="Collector")
        tabs.add(logs, text="Logs")

        self._build_router(router)
        self._build_collector(collector)
        self._build_logs(logs)

        self.activity = tk.StringVar(value="Sẵn sàng.")
        ttk.Label(outer, textvariable=self.activity).pack(anchor="w")

    def _build_router(self, tab):
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(2, weight=1)

        status = ttk.LabelFrame(tab, text="Master Router", padding=12)
        status.grid(row=0, column=0, sticky="ew")
        status.columnconfigure(1, weight=1)
        self.router_status = tk.StringVar(value="NOT DEPLOYED")
        self.master_url = tk.StringVar(value="-")
        ttk.Label(status, text="Status").grid(row=0, column=0, sticky="w")
        ttk.Label(status, textvariable=self.router_status).grid(row=0, column=1, sticky="w", padx=(12, 0))
        ttk.Label(status, text="Master Web").grid(row=1, column=0, sticky="w", pady=(5, 0))
        ttk.Label(status, textvariable=self.master_url).grid(row=1, column=1, sticky="w", padx=(12, 0), pady=(5, 0))
        ttk.Button(status, text="Open Master Web", command=self.open_master).grid(row=0, column=2, rowspan=2, padx=(12, 0))

        setup = ttk.LabelFrame(tab, text="Deploy / Update", padding=12)
        setup.grid(row=1, column=0, sticky="ew", pady=(12, 0))
        setup.columnconfigure(1, weight=1)
        self.cf_account = tk.StringVar()
        self.cf_token = tk.StringVar()
        self.admin_password = tk.StringVar()
        for row, (label, var, secret) in enumerate([
            ("Cloudflare Account ID", self.cf_account, False),
            ("Cloudflare API Token", self.cf_token, True),
            ("Master Admin Password", self.admin_password, True),
        ]):
            ttk.Label(setup, text=label).grid(row=row, column=0, sticky="w", pady=5)
            ttk.Entry(setup, textvariable=var, show="•" if secret else "").grid(row=row, column=1, sticky="ew", padx=(10,0), pady=5)
        self.deploy_btn = ttk.Button(setup, text="DEPLOY / UPDATE MASTER ROUTER", command=self.deploy_master)
        self.deploy_btn.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(10,0))

        progress = ttk.LabelFrame(tab, text="Deploy Progress", padding=10)
        progress.grid(row=2, column=0, sticky="nsew", pady=(12,0))
        progress.columnconfigure(0, weight=1)
        progress.rowconfigure(1, weight=1)
        self.deploy_step = tk.StringVar(value="Chưa chạy.")
        ttk.Label(progress, textvariable=self.deploy_step).grid(row=0, column=0, sticky="w")
        self.deploy_log = tk.Text(progress, font=("Consolas", 9), height=14, wrap="none")
        self.deploy_log.grid(row=1, column=0, sticky="nsew", pady=(8,0))

    def _build_collector(self, tab):
        tab.columnconfigure(1, weight=1)
        self.collector_status = tk.StringVar(value="OFFLINE")
        ttk.Label(tab, text="Status").grid(row=0, column=0, sticky="w")
        ttk.Label(tab, textvariable=self.collector_status).grid(row=0, column=1, sticky="w", padx=(10,0))

        self.tg_api_id = tk.StringVar()
        self.tg_api_hash = tk.StringVar()
        self.tg_session = tk.StringVar()
        for row, (label, var, secret) in enumerate([
            ("Telegram API ID", self.tg_api_id, False),
            ("Telegram API Hash", self.tg_api_hash, True),
            ("Telegram StringSession", self.tg_session, True),
        ], start=1):
            ttk.Label(tab, text=label).grid(row=row, column=0, sticky="w", pady=6)
            ttk.Entry(tab, textvariable=var, show="•" if secret else "").grid(row=row, column=1, sticky="ew", padx=(10,0), pady=6)

        row = ttk.Frame(tab)
        row.grid(row=5, column=0, columnspan=2, sticky="ew", pady=(14,0))
        ttk.Button(row, text="Save Telegram", command=self.save_telegram).pack(side="left")
        ttk.Button(row, text="Start Collector", command=self.start_collector).pack(side="left", padx=(8,0))
        ttk.Button(row, text="Stop Collector", command=self.stop_collector).pack(side="left", padx=(8,0))

        ttk.Label(
            tab,
            text="Collector tự đồng bộ toàn bộ kênh Telegram đã join lên Master Web. Mỗi Web con tự chọn kênh cho từng tài khoản X.",
            foreground="#666"
        ).grid(row=6, column=0, columnspan=2, sticky="w", pady=(14,0))

    def _build_logs(self, tab):
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(0, weight=1)
        self.logs_text = tk.Text(tab, font=("Consolas", 9), wrap="none")
        self.logs_text.grid(row=0, column=0, sticky="nsew")
        ttk.Button(tab, text="Refresh Logs", command=self.refresh_logs).grid(row=1, column=0, sticky="w", pady=(8,0))

    def _load_values(self):
        infra = self.secrets.get("cloudflare") or {}
        admin = self.secrets.get("admin") or {}
        tg = self.secrets.get("telegram") or {}
        self.cf_account.set(str(infra.get("account_id") or ""))
        self.cf_token.set(str(infra.get("api_token") or ""))
        self.admin_password.set(str(admin.get("password") or ""))
        self.tg_api_id.set(str(tg.get("api_id") or ""))
        self.tg_api_hash.set(str(tg.get("api_hash") or ""))
        self.tg_session.set(str(tg.get("session") or ""))
        root = str(self.state.get("master_root") or "")
        self.master_url.set(root or "-")

    def _runtime_env(self):
        env = os.environ.copy()
        node = self.root_dir / "runtime" / "node"
        if node.exists():
            env["PATH"] = str(node) + os.pathsep + env.get("PATH", "")
        env["CI"] = "true"
        env["NO_COLOR"] = "1"
        return env

    def _append_deploy(self, line: str):
        line = clean_console_text(line).rstrip("\r\n")
        if not line:
            return
        self.deploy_log.insert("end", line + "\n")
        self.deploy_log.see("end")
        if line.startswith("["):
            self.deploy_step.set(line)

    def deploy_master(self):
        account = self.cf_account.get().strip()
        token = self.cf_token.get().strip()
        password = self.admin_password.get()
        if len(account) < 8 or len(token) < 16 or len(password) < 8:
            return messagebox.showerror(APP_NAME, "Cloudflare Account ID / Token / Admin Password chưa hợp lệ.")

        script = self.root_dir / "deploy" / "SETUP-MASTER.ps1"
        if not script.exists():
            return messagebox.showerror(APP_NAME, "Package thiếu deploy/SETUP-MASTER.ps1")

        self.deploy_btn.configure(state="disabled")
        self.deploy_log.delete("1.0", "end")
        self.deploy_step.set("Starting...")
        out_file = self.data / "deploy-result.json"
        existing_collector = str(self.secrets.get("collector_secret") or "")

        def work():
            env = self._runtime_env()
            env["X_MASTER_CF_TOKEN"] = token
            env["X_MASTER_ADMIN_PASSWORD"] = password
            if existing_collector:
                env["X_MASTER_COLLECTOR_SECRET"] = existing_collector

            cmd = [
                "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", str(script),
                "-AccountId", account,
                "-OutputFile", str(out_file),
            ]

            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            proc = subprocess.Popen(
                cmd,
                cwd=str(self.root_dir),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=flags,
            )
            self.deploy_proc = proc
            lines = []
            assert proc.stdout is not None
            for line in proc.stdout:
                clean = clean_console_text(line)
                lines.append(clean)
                self.after(0, self._append_deploy, clean)
            code = proc.wait()
            self.deploy_proc = None
            if code != 0:
                raise RuntimeError("".join(lines)[-7000:])
            result = read_json(out_file)
            if not result.get("ok"):
                raise RuntimeError("Deploy result missing/invalid.")
            return result

        def done(result):
            self.state = result
            write_json(self.state_path, result)
            self.secrets["cloudflare"] = {"account_id": account, "api_token": token}
            self.secrets["admin"] = {"password": password}
            if result.get("collector_secret"):
                self.secrets["collector_secret"] = result["collector_secret"]
            save_secrets(self.secrets)
            self.cf_token.set("")
            self.master_url.set(result["master_root"])
            self.deploy_step.set("[8/8] MASTER READY")
            self.deploy_btn.configure(state="normal")
            collector_was_running = self._alive(self._collector_pid())
            if collector_was_running:
                self.log("Master updated; restarting Collector to reload routes and new runtime.")
                self.stop_collector()
                self.start_collector()
            self.refresh_status()
            messagebox.showinfo(APP_NAME, "Master Router READY.")

        def fail(exc):
            self.deploy_btn.configure(state="normal")
            self.deploy_step.set("DEPLOY FAILED")
            clean = clean_console_text(str(exc))
            self._append_deploy("ERROR: " + clean)
            messagebox.showerror(APP_NAME, clean)

        self.run_bg(work, done, fail)

    def save_telegram(self):
        api_id = self.tg_api_id.get().strip()
        api_hash = self.tg_api_hash.get().strip()
        session = self.tg_session.get().strip()
        if not api_id.isdigit() or len(api_hash) < 20 or len(session) < 20:
            return messagebox.showerror(APP_NAME, "Telegram API ID / Hash / StringSession chưa hợp lệ.")
        self.secrets["telegram"] = {"api_id": api_id, "api_hash": api_hash, "session": session}
        save_secrets(self.secrets)
        self.log("Telegram credentials saved with DPAPI.")

    def _collector_pid(self):
        try:
            return int(self.collector_pid_path.read_text().strip()) if self.collector_pid_path.exists() else None
        except Exception:
            return None

    def _alive(self, pid: int | None):
        if not pid:
            return False
        if os.name == "nt":
            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def start_collector(self):
        if self._alive(self._collector_pid()):
            try:
                running_version = self.collector_version_path.read_text(encoding="utf-8").strip()
            except Exception:
                running_version = ""
            if running_version == APP_VERSION:
                return messagebox.showinfo(APP_NAME, f"Collector v{APP_VERSION} đang chạy.")
            self.log(f"Collector version mismatch running={running_version or 'unknown'} app={APP_VERSION}; restarting.")
            self.stop_collector()

        root = str(self.state.get("master_root") or "")
        secret = str(self.secrets.get("collector_secret") or "")
        tg = self.secrets.get("telegram") or {}
        if not root or not secret:
            return messagebox.showerror(APP_NAME, "Hãy deploy Master Router trước.")
        if not tg.get("api_id") or not tg.get("api_hash") or not tg.get("session"):
            return messagebox.showerror(APP_NAME, "Hãy lưu Telegram credentials trước.")

        env = os.environ.copy()
        env.update({
            "XM_TELEGRAM_API_ID": str(tg["api_id"]),
            "XM_TELEGRAM_API_HASH": str(tg["api_hash"]),
            "XM_TELEGRAM_SESSION": str(tg["session"]),
            "XM_MASTER_ROOT": root,
            "XM_COLLECTOR_SECRET": secret,
            "XM_COLLECTOR_LOG": str(self.collector_log),
            "XM_COLLECTOR_VERSION_FILE": str(self.collector_version_path),
        })

        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "--collector"]
        else:
            cmd = [sys.executable, str(Path(__file__).resolve()), "--collector"]

        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        log = open(self.collector_log, "a", encoding="utf-8")
        proc = subprocess.Popen(
            cmd,
            cwd=str(self.root_dir),
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=flags,
        )
        log.close()
        self.collector_proc = proc
        self.collector_pid_path.write_text(str(proc.pid), encoding="utf-8")
        self.log(f"Collector started pid={proc.pid}")
        self.refresh_status()

    def stop_collector(self):
        pid = self._collector_pid()
        if not pid:
            return
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
            else:
                os.kill(pid, 15)
        except Exception:
            pass
        self.collector_pid_path.unlink(missing_ok=True)
        self.collector_version_path.unlink(missing_ok=True)
        self.collector_proc = None
        self.log("Collector stopped.")
        self.refresh_status()

    def refresh_status(self):
        root = str(self.state.get("master_root") or "")
        if root:
            try:
                status, payload = http_json(root + "/api/health", timeout=5)
                if status == 200 and payload.get("ok"):
                    self.router_status.set("ONLINE")
                    self.global_status.set("Master=ONLINE")
                else:
                    self.router_status.set("DEGRADED")
                    self.global_status.set("Master=DEGRADED")
            except Exception:
                self.router_status.set("OFFLINE")
                self.global_status.set("Master=OFFLINE")
        else:
            self.router_status.set("NOT DEPLOYED")
            self.global_status.set("Master=NOT DEPLOYED")

        alive = self._alive(self._collector_pid())
        self.collector_status.set("RUNNING" if alive else "OFFLINE")
        if not alive and self.collector_pid_path.exists():
            self.collector_pid_path.unlink(missing_ok=True)

    def open_master(self):
        root = str(self.state.get("master_root") or "")
        if root:
            webbrowser.open(root)

    def refresh_logs(self):
        chunks = []
        for name, path in [("OWNER", self.owner_log), ("COLLECTOR", self.collector_log)]:
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-250:]
                chunks.append("===== " + name + " =====\n" + "\n".join(lines))
            except Exception:
                chunks.append("===== " + name + " =====\n(no log)")
        self.logs_text.delete("1.0", "end")
        self.logs_text.insert("1.0", "\n\n".join(chunks))

    def run_bg(self, work, done, fail):
        def runner():
            try:
                result = work()
            except Exception as exc:
                self.after(0, lambda err=exc: fail(err))
                return
            self.after(0, lambda: done(result))
        threading.Thread(target=runner, daemon=True).start()


def main():
    if "--version" in sys.argv:
        print(APP_VERSION)
        return

    if "--self-test" in sys.argv:
        root = app_root()
        required = [
            root / "deploy" / "SETUP-MASTER.ps1",
            root / "master-router" / "src" / "index.js",
            root / "master-router" / "web" / "index.html",
            root / "master-router" / "schema.sql",
        ]
        missing = [str(p) for p in required if not p.exists()]
        if missing:
            print("SELF TEST FAILED: " + " | ".join(missing))
            raise SystemExit(2)
        if clean_console_text("\x1b[33mWARN\x1b[0m") != "WARN":
            print("SELF TEST FAILED: ANSI sanitizer")
            raise SystemExit(3)
        print("SELF TEST PASS | X-Master " + APP_VERSION)
        return

    if "--collector" in sys.argv:
        asyncio.run(run_collector())
        return

    app = XMasterApp()
    app.mainloop()


if __name__ == "__main__":
    main()

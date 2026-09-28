# X-Master

A clean rebuild of the X automation platform around one **Master Router Web** and isolated **Child Webs**.

## Product model

```text
X-Master.exe
  ├─ Local Telegram Collector
  └─ Deploy / connect Master Router
             ↓
       Master Router Web
        ├─ Sources
        ├─ Child Webs
        ├─ Routing
        └─ Logs / Health
             ↓
       Create Child Web
        ├─ Child password
        ├─ Cloudflare Account ID
        ├─ Cloudflare API Token
        ├─ Cloudinary Cloud Name
        ├─ Cloudinary API Key
        └─ Cloudinary API Secret
             ↓
       validate → deploy → assign sources
             ↓
          Child Web
        ├─ Password login
        ├─ Gemini API Key
        ├─ Buffer API Key
        ├─ X account
        └─ content settings
```

The tester only receives a Child Web URL and password. Infrastructure credentials never appear in the Child Web.

## Ground rules

- No infrastructure forms in the tester UI.
- No plaintext infrastructure secrets in D1.
- No secrets committed to Git.
- Child deployment is transactional: validate first, deploy second, persist only after health succeeds.
- A failed deployment must roll back resources created by that attempt.
- Sources are managed centrally and assigned to Child Webs.
- Buffer and Gemini are entered by the tester only.

## Status

- Phase 1: Master Router foundation — DONE
- Phase 2: Child Web provisioning — DONE (deploy + password + source assignment + rollback)
- Phase 3: Local Telegram Collector + Sources — FOUNDATION DONE
- Phase 4: Gemini/Buffer processing + X posting — DONE
- Phase 5: real end-to-end Telegram → X test — READY FOR LIVE CREDENTIAL TEST

## v0.2.1 Posting pipeline hotfix

This release completes the missing posting path:

- a Telegram message routed to an enabled X account is rewritten with that account's Gemini key;
- Standard accounts are constrained to short X posts while Premium accounts can use longer copy;
- Buffer GraphQL `createPost` publishes with `schedulingType: automatic` and `mode: shareNow`;
- every per-account route is tracked as `queued`, `posted`, or `failed` with a safe error message;
- Master and Child account views expose the latest posting result;
- Child Web includes an explicit Buffer → X test-post button;
- regression tests mock and verify Gemini rewrite + Buffer immediate publishing.

## v0.2.0 Multi-account Child routing

This release changes Source and Child management to the real tester workflow:

- Collector automatically syncs the Telegram channels the account has joined;
- Owner no longer manually creates or assigns Sources when creating a Child Web;
- each Child Web can manage up to 5 X accounts;
- every X account has its own Gemini/Buffer configuration, content mode, Premium setting, enabled state, and Telegram Source selection;\n- Child Web can validate a Buffer API key and automatically list connected X channels so the tester does not have to copy Channel IDs manually;
- testers can add, edit, pause, or delete their own X accounts;
- Master Web shows every Child Web, its X accounts, and the Telegram channels assigned to each account;
- ingest routing is now recorded per X account instead of only per Child Web.

## v0.1.2 Collector networking hotfix

This release fixes real Windows Collector requests being rejected by Cloudflare Error 1010:

- browser-compatible HTTP request headers for Master health, source sync, and ingest;
- explicit network-error handling instead of an unhandled Collector exception;
- initial Source sync retries without killing the Telegram Collector;
- Collector remains connected and retries Source sync every 60 seconds when Master is temporarily unavailable.

## v0.1.1 Windows runtime hardening

This release repairs and hardens the real Windows deployment path discovered during the first production install:

- compatible random secret generation on **Windows PowerShell 5.1 / .NET Framework**;
- CI executes the deploy script with the real `powershell.exe`, not only PowerShell 7;
- native stdin forwarding is tested before using `wrangler secret put`;
- Worker secret listing is fail-safe: a read/parse failure aborts instead of rotating `MASTER_KEY`;
- a missing local Collector secret is safely rotated and returned to the desktop app;
- ANSI/UTF-8 deploy output is cleaned for the Windows GUI;
- D1 IDs accept Wrangler's `uuid`, `id`, or `database_id` fields;
- new Cloudflare accounts can create their workers.dev subdomain;
- failed Child health checks delete the uploaded Child Worker;
- session expiry uses SQLite datetime parsing instead of raw text comparison;
- encrypted Gemini/Buffer settings are never silently overwritten after a decrypt failure;
- deployment health failures report the last real error.

## v0.1.0 owner workflow

1. Run `X-Master.exe`.
2. Deploy / Update Master Router with one Cloudflare Account ID, API Token and Master Admin password.
3. Open Master Web.
4. Add Telegram Sources.
5. Create Child Web:
   - child name;
   - child password;
   - Cloudflare Account ID / API Token;
   - Cloudinary Cloud Name / API Key / API Secret;
   - assigned Sources.
6. Master validates infrastructure, deploys the Child Worker, health-checks it, and rolls back on failure.
7. Owner sends only:
   - Child Web URL;
   - child password.
8. Tester enters only Gemini + Buffer in the Child Web.

## Tests

CI currently covers:

- PBKDF2/AES/HMAC security primitives;
- Master UI + schema contract;
- generated Child Worker syntax;
- Wrangler dry-run;
- live local Master Router + D1;
- Owner login;
- Source creation;
- Collector source sync;
- ingest + duplicate protection;
- live generated Child Web login/session/settings;
- Windows EXE self-test;
- ZIP extract/integrity check.


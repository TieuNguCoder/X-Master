# X-Master

**v0.4.1: v0.4 + tên miền, giữ luồng chính.** Xem [DOMAIN-ONLY-v0.4.1.md](DOMAIN-ONLY-v0.4.1.md).

X-Master is an automation platform built around one central **Master Router** and isolated **User Web + Account Router** Workers.

## Product model

```text
X-Master.exe
  ├─ Local Telegram Collector
  └─ Deploy / update one Master Router
             │
             ├─ one Cloudflare Account ID
             ├─ one Cloudflare API Token
             └─ one D1 database
                     ↓
                Master Web
          ┌──────────┼──────────┐
          │          │          │
     Telegram     User Webs    Logs
      Catalog
                     ↓
          Create one User Web
          ├─ User name
          ├─ User password
          └─ Cloudinary credentials only
                     ↓
       Master automatically deploys
          ├─ 1 User Web Worker
          ├─ Router R1 → X account 1
          ├─ Router R2 → X account 2
          ├─ Router R3 → X account 3
          ├─ Router R4 → X account 4
          └─ Router R5 → X account 5
```

The five account routers and the User Web are created under the **same Cloudflare account as Master**. Users never receive or enter Cloudflare credentials.

## v0.4.0 Simplified posting pipeline

- Each User Web now configures **one DeepSeek API key** outside the X account form; all five X accounts share it.
- Per-account Gemini/DeepSeek selectors and AI keys are removed from the User Web workflow.
- Adding an X account starts with its Buffer API key. **Check Buffer** discovers the connected X channel and fills display name, handle, Buffer channel ID, connection state, and related identity automatically.
- Content mode now supports **News**, **Airdrop**, or **News + Airdrop (auto detect)**.
- Telegram Source selections are kept in a persistent set while searching, so selecting one channel, searching another, and selecting it no longer loses the first channel.
- Standard X posts are trimmed with a weighted-length safety pass to avoid Buffer/X 280-character rejection.
- Telegram image messages are downloaded by the local Collector, uploaded to that User's Cloudinary account, and attached to Buffer through the official image `assets` input.
- Cloudinary image URLs are uploaded once per User/event and reused across that User's routed X accounts.
- The main posting route now ignores stale per-account Gemini/DeepSeek keys from older versions, fixing mixed success/failure caused by different invalid AI keys across accounts.
- Existing X accounts remain usable; after updating the User Web, configure the shared DeepSeek key once.

## v0.3.2 Cloudflare Usage dashboard

- Master Web now has a **Cloudflare Usage** tab.
- Shows the number of Worker scripts currently present in the Master Cloudflare account and a visual reference against the configured 500-Worker management target.
- Reads the current account billable-usage period directly from Cloudflare.
- Shows usage-based billed cost when Cloudflare exposes cost fields.
- Groups consumption by Cloudflare product and billable metric, including Workers, D1, and any other usage returned by the account.
- Uses the same central Cloudflare Account ID/API Token already stored by Master; no extra credentials are entered in the web UI.
- If the token lacks **Account → Billing → Read**, Worker count remains visible and the UI displays a clear permission message instead of failing the page.
- Cloudflare's fixed subscription fee is intentionally not mixed into the usage-based cost number.

## v0.3.1 Verified Worker lifecycle

- **Stop Workers** is no longer a database-only pause: Master disables the real `workers.dev` subdomain for the User Web and each existing account-router Worker, verifies the disabled state, and only then records the User as paused.
- **Start Workers** re-enables the real Cloudflare Worker subdomains and verifies they are enabled before the User returns to ready status.
- **Delete User + Workers** calls Cloudflare's Worker Script DELETE with `force=true`, probes the script again, and removes D1 User data only after every known Worker is confirmed absent.
- Existing v0.2.x User records can reuse their encrypted legacy Cloudflare account/token for cleanup when those credentials are still present.
- If a legacy Worker belongs to an unknown old Cloudflare account and its credentials are unavailable, deletion is refused instead of pretending the Worker was deleted.
- Updating a legacy User preserves any old Cloudflare cleanup credentials while normal v0.3.x provisioning continues to use only the central Master Cloudflare account.

## v0.3.0 Final Worker architecture

- Master stores one central Cloudflare Account ID/API Token as Worker secrets and uses them for all provisioning.
- Creating a User no longer asks for another Cloudflare account or token.
- Owner only enters the User name/password and that User's Cloudinary credentials.
- Each User automatically receives exactly **5 persistent account-router Worker slots**.
- Each X account is automatically assigned to one free router slot.
- Deleting an X account releases its router slot for reuse; the router Worker remains available.
- Existing v0.2.x Users can be migrated by **Update User Web**; existing X accounts are assigned to free router slots automatically.
- Updating a User Web also refreshes all five router Workers to the current router code.
- Paid AI posting is routed through the account's dedicated router Worker.
- Gemini Free still performs the AI call on the local Collector, then the result is sent through the account router for Buffer → X publishing.
- Master Web shows all five router slots, their generated Worker names, assignment state, and the X account attached to each slot.
- Deleting a User deletes its User Web Worker and all five account router Workers.
- Worker names are generated automatically from the User slug and router index, for example `xmr-user-name-r1-abc12`.
- A later custom-domain phase can map the Master/User surfaces under `router....bemail2017.com` without changing the account-router model.

## User Web

Each User Web supports up to five X accounts. Every X account keeps its own:

- Buffer account/API key and X channel;
- Gemini Free, Gemini Paid, or DeepSeek Paid;
- Telegram Sources;
- News or Airdrop content mode;
- Standard or Premium/Blue formatting;
- target post language;
- enabled/paused state;
- dedicated router Worker slot.

## Security / infrastructure rules

- Cloudflare credentials exist only on Master; they are not stored in User forms.
- User Cloudinary credentials remain encrypted in D1.
- AI and Buffer credentials remain encrypted per X account.
- Router Worker secrets are unique per slot and stored encrypted in Master D1.
- Calls Master → account router and account router → Master are authenticated.
- A failed new-User deployment rolls back the User Worker and routers created by that attempt.
- No infrastructure secrets are committed to Git.

## Current posting flow

For Gemini Paid / DeepSeek Paid:

```text
Telegram
 → Collector
 → Master ingest + Source routing
 → dedicated X account Router Worker
 → authenticated Master processing
 → AI rewrite
 → Buffer shareNow
 → X
```

For Gemini Free:

```text
Telegram
 → Collector
 → Gemini Free on Owner PC
 → Master
 → dedicated X account Router Worker
 → Buffer shareNow
 → X
```

## Status

- Master Router + D1 — DONE
- Central Cloudflare provisioning — DONE
- User Web provisioning — DONE
- Five persistent account Router Workers per User — DONE
- Existing-account migration to router slots — DONE
- Telegram catalog + per-account Sources — DONE
- Gemini Free / Gemini Paid / DeepSeek Paid — DONE
- Buffer → X posting — DONE
- Airdrop / News formatting + hashtags — DONE
- Per-account language — DONE
- Custom domain `router....bemail2017.com` — LATER
- Full Telegram image/video forwarding through Cloudinary — still pending

## v0.2.6 Per-account language

Each X account now has its own target post language:

- default is **English (US) / en-US**;
- common languages are available as quick selections;
- **Custom language / BCP-47** accepts any language or locale such as `it-IT`, `pl-PL`, `nl-NL`, `fil-PH`, or a plain language name;
- AI is instructed to translate and write the entire post naturally for the selected audience while preserving URLs, @usernames, ticker symbols, project/brand names, and proper nouns when appropriate;
- language works independently with Airdrop/News, Standard/Premium, Gemini Free, Gemini Paid, and DeepSeek Paid;
- existing accounts default to `en-US` until edited.

## v0.2.5 Content formatting

AI rewriting now follows strict per-account content templates across all three providers:

- **Airdrop / Standard:** compact opportunity layout with project hook, reward only when stated, visible link, short action steps, and 2–4 hashtags;
- **Airdrop / Premium:** polished structured opportunity post with reward/eligibility/deadline fields only when present, clearer steps, CTA, and hashtags;
- **News / Standard:** headline + concise context + URL when present + 2–4 hashtags instead of a dry one-line rewrite;
- **News / Premium:** editorial mini-brief with stronger structure, supported context/why-it-matters, cleaner spacing, and hashtags;
- source URLs are explicitly preserved;
- a postprocessor guarantees at least two hashtags even when the AI omits them;
- Master and Child account cards show the selected format and Standard vs Premium/Blue state.

## v0.2.4 AI provider routing

Each X account can now choose one AI provider independently:

- **Gemini Free** — uses `gemini-3.1-flash-lite` and runs from the Windows Collector/owner PC, avoiding Cloudflare egress-location restrictions;
- **Gemini Paid** — uses the paid Gemini API from the Master Router;
- **DeepSeek Paid** — uses the official DeepSeek API with `deepseek-flash` from the Master Router;
- provider-specific API keys are encrypted per account;
- Gemini Free jobs are returned securely to the authenticated Collector and posted back to Master after local rewriting;
- existing Child Webs can be upgraded in place from Master Web with **Update Child Web**, preserving URL/account data.

## v0.2.3 Live failure diagnostics

- Master Logs now render `details_json`, including the exact error stored by `x_account.post_failed`;
- every X account has `Test Gemini`, `Test full pipeline`, and `Test đăng X` controls;
- `Test Gemini` isolates the Gemini API/key/model step without posting to X;
- `Test full pipeline` runs Gemini → Buffer → X and returns the failing API error directly;
- the old `Gemini: OK` display should be interpreted as configured/saved, while the diagnostic test verifies that the key can actually generate content.

## v0.2.2 Collector routing diagnostics

This release fixes the silent-no-reaction path found during live testing:

- Collector no longer silently drops a newly assigned Telegram channel because its in-memory Source cache is stale;
- on a Source-cache miss, Collector refreshes assignments immediately and re-checks the message;
- background Source refresh is shortened to 15 seconds;
- Collector logs explicit `CAPTURED`, `ROUTED`, `SKIPPED`, and `FAILED` stages;
- the Windows app records the Collector runtime version and restarts an old Collector automatically after a Master update;
- Master Web now has a direct `Test đăng X` button for each X account, allowing Buffer → X to be tested independently of Telegram and Child Web code.

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



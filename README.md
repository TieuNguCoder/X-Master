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
- Phase 4: Gemini/Buffer processing + X posting — NEXT
- Phase 5: real end-to-end Telegram → X test

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


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

- Phase 1: Master Router foundation — in progress
- Phase 2: Child Web provisioning
- Phase 3: Local Telegram Collector + Sources
- Phase 4: Buffer/Gemini child workflow
- Phase 5: real end-to-end Telegram → X test

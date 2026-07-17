# Day-1 Unipile inbound webhook spike

## Deploy

1. Push this branch and deploy on Vercel (or `vercel deploy`).
2. Set env vars in Vercel (same names as `.env.example`):
   - `UNPILE_API`, `UNPILE_ACCOUNT_ID`, `UNPILE_DSN`
   - `UNIPILE_WEBHOOK_SECRET` — the shared secret you put on the webhook as `Unipile-Auth`

## Register webhook (API — recommended)

Dashboard-created webhooks often have no visible secret. Create via API with a header you invent:

```bash
set -a && source .env && set +a

curl -sS -X POST \
  "https://${UNPILE_DSN}/api/v1/webhooks" \
  -H "X-API-KEY: ${UNPILE_API}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_url\": \"https://email-pipeline-v1.vercel.app/api/inbound\",
    \"source\": \"email\",
    \"name\": \"venue_inbound_auth\",
    \"headers\": [
      { \"key\": \"Content-Type\", \"value\": \"application/json\" },
      { \"key\": \"Unipile-Auth\", \"value\": \"${UNIPILE_WEBHOOK_SECRET}\" }
    ]
  }"
```

Delete any older duplicate (e.g. dashboard `venue_inbound`) so only one webhook fires.

Auth on `/api/inbound`: prefer `Unipile-Auth` matching `UNIPILE_WEBHOOK_SECRET`; if that header is absent, fall back to HMAC `unipile-signature`.

## Exit checks

| Check | Expected |
|---|---|
| `GET /api/inbound` | `{ ok: true, endpoint: "inbound" }` |
| POST without / wrong `Unipile-Auth` | 401 |
| Email **to** linked inbox | 200 `{ received: true, duplicate: false }` + log `[inbound] claimed` + `inbound_messages` row |
| Same email delivered twice | 200 `{ received: true, duplicate: true }` + still one ledger row |
| Sent / non-inbox event | 200 `{ received: true, skipped: true }` + log `[inbound] skipped` |

Day 2+: after inbound filter, the handler claims `inbound_messages` with PK = Unipile `email_id` (`status=processing`) and writes `pipeline_events` before ack. DB failures return 500 for redelivery.

Day 5+: if `ANTHROPIC_API_KEY` is set, triage runs after claim (quote-strip → Claude → firewall → match stub → finalize ledger). Duplicates never re-triage.

Drip cron: `GET/POST /api/cron/drip` with `Authorization: Bearer $CRON_SECRET` (see `vercel.json`). Default `DRIP_DRY_RUN=true` / `config.paused=true` — only `is_seed` venues are send-eligible.

Old `/api/gmail-webhook` is removed; do not register that path.

# Day-1 Unipile inbound webhook spike

## Deploy

1. Push this branch and deploy on Vercel (or `vercel deploy`).
2. Set env vars in Vercel (same names as `.env.example`):
   - `UNPILE_API`, `UNPILE_ACCOUNT_ID`, `UNPILE_DSN`
   - `UNIPILE_WEBHOOK_SECRET` (add after step 3 if you do not have it yet)

## Register webhook

1. Unipile Dashboard → Webhooks → Add endpoint
2. URL: `https://<your-project>.vercel.app/api/inbound`
3. Event type: **New emails**
4. Restrict to the linked Gmail account if the UI allows
5. Copy the endpoint secret → `UNIPILE_WEBHOOK_SECRET` in Vercel + local `.env`
6. Redeploy if the secret was missing on the first deploy

## Exit checks

| Check | Expected |
|---|---|
| `GET /api/inbound` | `{ ok: true, endpoint: "inbound" }` |
| POST without / bad `unipile-signature` | 400/401 |
| Email **to** linked inbox | 200 `{ received: true, skipped: false }` + Vercel log `[inbound] accepted` |
| Sent / non-inbox event | 200 `{ received: true, skipped: true }` + log `[inbound] skipped` |

Old `/api/gmail-webhook` is removed; do not register that path.

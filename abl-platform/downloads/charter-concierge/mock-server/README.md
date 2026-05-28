# Charter Concierge Mock Server

Deterministic mock API for the telecom-focused Charter Concierge ABL example.

## Endpoints

The deployed mock service uses one Vercel function:

- `GET /api/router?endpoint=health`
- `POST /api/router?endpoint=search-service-offers`
- `POST /api/router?endpoint=assess-request-risk`
- `POST /api/router?endpoint=lookup-account`
- `POST /api/router?endpoint=check-recent-verification`
- `POST /api/router?endpoint=send-otp`
- `POST /api/router?endpoint=verify-otp`
- `POST /api/router?endpoint=lock-session`
- `POST /api/router?endpoint=create-plan-recommendation`
- `POST /api/router?endpoint=validate-setup-readiness`
- `POST /api/router?endpoint=lookup-service-policy`
- `POST /api/router?endpoint=get-bill`
- `POST /api/router?endpoint=get-payment-history`
- `POST /api/router?endpoint=apply-credit`
- `POST /api/router?endpoint=schedule-support-callback`
- `POST /api/router?endpoint=get-service-brief`

## Deploy

```bash
vercel link --yes --project abl-charter-concierge-mock
vercel deploy --prod --yes
```

The exported ABL tool bundle binds directly to the production deployment URL after deployment verification.

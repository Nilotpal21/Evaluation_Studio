# Studio OpenAPI Internal Access Rollout Guide

**Audience**: Studio deploy owners, ingress / Helm maintainers, environment operators

This guide explains the deployment impact of the Studio internal-access hardening changes.

## Executive Summary

- Local Studio development on `localhost` is unchanged.
- Deployed Studio environments now require an explicit trusted ingress assertion for `/api/openapi` and `/api/openapi/spec.json`.
- Runtime internal-only routes do not require a new deployment variable.
- The new Studio `/api/health/e2e-ready` endpoint is only for isolated browser E2E and must not replace normal readiness probes.

## What Changed

The previous Studio OpenAPI guard depended on forwarded headers and a localhost host fallback. That was vulnerable to spoofing and could also fail closed in production because Next.js route handlers do not expose a verified remote peer.

The new behavior is:

- Runtime / Express internal-only routes continue to trust the direct socket peer and only allow internal proxy chains.
- Studio internal OpenAPI routes allow:
  - localhost access in `development` and `test`
  - a trusted ingress-injected shared secret in deployed environments
- Header-only inference from `Host`, `X-Forwarded-For`, or `X-Real-IP` is not sufficient in deployed Studio environments.

The relevant Studio env vars are:

- `STUDIO_INTERNAL_ACCESS_TOKEN`
- `STUDIO_INTERNAL_ACCESS_HEADER_NAME` (optional, defaults to `x-abl-internal-access`)

## Environment Matrix

| Environment                       | Required change                                     | Notes                                                                                        |
| --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Local dev (`next dev`, localhost) | None                                                | Localhost fallback still works in `development` / `test`.                                    |
| Shared dev deployment             | Configure Studio token and ingress header injection | Required if the deployment runs with production-style Next.js settings.                      |
| Staging                           | Configure Studio token and ingress header injection | Required for internal OpenAPI access.                                                        |
| Production                        | Configure Studio token and ingress header injection | Required for internal OpenAPI access; otherwise Studio OpenAPI is intentionally fail-closed. |

## Helm Checklist

### 1. Add the Studio secret

Provision a dedicated secret for the Studio internal access token.

Recommended secret contents:

- key: `STUDIO_INTERNAL_ACCESS_TOKEN`
- value: strong random secret, scoped only to Studio internal OpenAPI access

### 2. Wire the env vars into the Studio deployment

Example Helm values shape:

```yaml
studio:
  env:
    STUDIO_INTERNAL_ACCESS_TOKEN:
      valueFrom:
        secretKeyRef:
          name: studio-internal-access
          key: STUDIO_INTERNAL_ACCESS_TOKEN
    STUDIO_INTERNAL_ACCESS_HEADER_NAME: 'x-abl-internal-access'
```

Notes:

- `STUDIO_INTERNAL_ACCESS_HEADER_NAME` is optional. Omit it if you want the default header name.
- Do not reuse unrelated secrets such as JWT or bootstrap-signing secrets for this purpose.

### 3. Do not change Runtime for this rollout

No new Runtime env var is required for this hardening work.

## Ingress Checklist

### 1. Strip user-supplied internal-access headers

Your ingress or gateway must not trust a client-supplied `x-abl-internal-access` header.

The edge must either:

- clear any incoming copy of the configured header name, then
- inject the trusted value itself on the internal OpenAPI path

### 2. Inject the trusted header only where needed

Apply the header on:

- `/api/openapi`
- `/api/openapi/spec.json`

Do not inject it globally across all Studio routes unless you deliberately want broader internal-only behavior.

### 3. Keep the token out of committed manifests

Use the ingress controller or gateway secret mechanism rather than committing the raw token into Helm values or annotations.

### 4. Verify the allow / deny behavior

After rollout:

- internal requests through the trusted ingress path should return `200`
- direct external requests without the injected header should return `403`
- spoofed `X-Forwarded-For` or `Host: localhost` requests should still return `403` in deployed environments

## Example Rollout Sequence

### Local dev

1. No action required.
2. Verify `http://localhost:5173/api/openapi` still works during local development.

### Shared dev / staging / production

1. Create or update the Studio secret carrying `STUDIO_INTERNAL_ACCESS_TOKEN`.
2. Deploy the Studio env var wiring.
3. Update ingress so the configured header is stripped from inbound client traffic.
4. Inject the trusted header only on `/api/openapi` and `/api/openapi/spec.json`.
5. Redeploy Studio and ingress.
6. Smoke test:
   - internal path through ingress returns `200`
   - direct external path without injected header returns `403`

## Browser E2E Readiness Note

The new endpoint:

- `/api/health/e2e-ready`

exists to make isolated Playwright startup wait on the same auth-ready condition as the Studio stack bootstrap.

Operational guidance:

- do not use `/api/health/e2e-ready` for Kubernetes readiness or liveness probes
- do not repoint service monitors or ingress health checks to it
- it depends on `ENABLE_DEV_LOGIN=true`, which is an E2E/testing concern rather than a normal production health contract

Continue to use the normal Studio health endpoints for service readiness.

## Non-Deployment Changes In This Patch

These fixes do not require environment or ingress changes:

- restoring the `sdk_api` Configuration tab
- scoping cURL import browser assertions to preview state
- replacing timing-fragile workspace menu browser interactions with stable selectors
- improving isolated Playwright auth bootstrap behavior

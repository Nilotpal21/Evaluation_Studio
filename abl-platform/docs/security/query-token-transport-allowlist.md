# Query-Token Transport Allowlist

## Purpose

URL query tokens are deprecated everywhere by default. They are only permitted for a small set of legacy provider ingress paths that currently require them for interoperability.

The enforcement point is [`packages/shared-kernel/src/security/inbound-auth.ts`](/Users/prasannaarikala/projects/f-1/abl-platform/packages/shared-kernel/src/security/inbound-auth.ts). Query tokens are ignored unless the caller opts into one of the named allowlist entries.

The allowlist only governs where URL query tokens are still recognized. It does not relax authentication. If a legacy transport is missing its configured ingress secret, the runtime should fail closed rather than silently accepting unauthenticated traffic.

There is also a manifest-driven source guard in [`apps/runtime/src/__tests__/query-token-transport-guard.test.ts`](/Users/prasannaarikala/projects/f-1/abl-platform/apps/runtime/src/__tests__/query-token-transport-guard.test.ts). It verifies three things together:

- Every allowlisted legacy transport key has an explicit runtime consumer file manifest.
- Only the documented runtime ingress files can read query tokens.
- Only the documented provisioning files can emit a legacy `?token=` URL.

`apps/runtime/src/routes/channel-connections.ts`, `apps/runtime/src/routes/channel-audiocodes.ts`, and `apps/runtime/src/routes/channel-vxml.ts` are intentionally part of that guard because they still provision the legacy `korevg_ws`, AudioCodes, and VXML callback URL shapes. They are not auth validators by themselves, but they are the only remaining runtime code that should emit query-token transport URLs for supported legacy channels.

There is a second cross-package caller guard in [`apps/runtime/src/__tests__/runtime-ws-client-guard.test.ts`](/Users/prasannaarikala/projects/f-1/abl-platform/apps/runtime/src/__tests__/runtime-ws-client-guard.test.ts). It scans the currently approved caller roots (`apps/runtime`, `apps/studio`, `benchmarks`, `packages/kore-platform-cli`, `packages/mcp-debug`, `packages/web-sdk`, and `scripts`), limits which files may target Runtime `/ws` or `/ws/sdk`, and requires those live callers to use the shared subprotocol auth helpers or an explicit `Sec-WebSocket-Protocol` header.

## Allowed Legacy Transports

| Allowlist Key     | Surface                  | Current Reason                                                     | Migration Target                                                    |
| ----------------- | ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `audiocodes_http` | AudioCodes HTTP ingress  | Existing provider/bot API deployments may still send URL tokens    | Move to `x-channel-secret` / `x-ingress-secret` style headers       |
| `audiocodes_ws`   | AudioCodes WebSocket     | Existing AudioCodes WS integrations still authenticate on the URL  | Replace with provider-supported non-URL auth once available         |
| `korevg_ws`       | Korevg/Jambonz WebSocket | Current provisioning still embeds the ingress secret in the WS URL | Replace with provider-supported headers or signed session bootstrap |
| `vxml_http`       | VXML webhook ingress     | Existing telephony webhooks may still deliver the secret in query  | Move to ingress secret headers                                      |

## Explicitly Removed Browser Paths

- Internal Studio/runtime `/ws` now requires `Sec-WebSocket-Protocol: web-debug-auth,<access_token>`.
- Browser SDK `/ws/sdk` requires `Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>`.
- Studio share links now carry the share token in the URL fragment only and exchange it through `POST /api/sdk/share/exchange`.
- Studio escalation live chat is currently disabled until it is rebuilt on an authenticated, supported runtime transport.

## TODOs

- AudioCodes: confirm header-based ingress auth support in all supported deployment modes, then remove `audiocodes_http` and `audiocodes_ws`.
- Korevg/Jambonz: add a non-URL bootstrap/auth channel for WS ingress, then remove `korevg_ws`.
- VXML: update telephony/webhook provisioning to send ingress secrets via headers, then remove `vxml_http`.
- Add the same migration review to every newly introduced runtime channel before release. New runtime endpoints must not add query-token support unless this allowlist, its manifest-backed guard, and the migration docs are intentionally updated together.

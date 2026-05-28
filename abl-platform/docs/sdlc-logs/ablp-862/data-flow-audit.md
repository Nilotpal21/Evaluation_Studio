# ABLP-862 JWE Slice Data Flow Audit

Date: 2026-05-11

Update: Runtime JWE implementation is now wired through bootstrap issuance, session issuance, refresh, HTTP SDK auth, SDK WebSocket auth, diagnostics, and hidden scenario coverage.

Scope: Runtime-hosted exchange bootstrap JWE issuance and verification, project/channel policy resolution, runtime JWE capability defaults, and scenario locks added in this slice.

## Propagation Matrix

| Field / dependency                                              | Definition                                                     | Persistence / config                                         | Route write                                   | Runtime read                                                              | Consumer                                     | Test lock                            | Result |
| --------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ | ------ |
| `auth.sdk.jwe.enabled`                                          | `packages/config/src/schemas/auth.schema.ts`                   | `apps/runtime/src/config/index.ts` env mapping               | N/A                                           | `getRuntimeSdkJweKeyProvider()`                                           | JWE capability gate                          | Runtime identity tests               | OK     |
| `auth.sdk.jwe.maxEncryptedBootstrapBytes`                       | `packages/config/src/schemas/auth.schema.ts`                   | `apps/runtime/src/config/index.ts` env mapping               | N/A                                           | `getRuntimeSdkTokenEnvelopeDeps()` and `/sdk/init` size guard             | JWE wrap/verify and route boundary           | Build + targeted runtime tests       | OK     |
| `auth.sdk.jwe.maxEncryptedSessionBytes`                         | `packages/config/src/schemas/auth.schema.ts`                   | `apps/runtime/src/config/index.ts` env mapping               | N/A                                           | `getRuntimeSdkTokenEnvelopeDeps()` and WebSocket pre-upgrade guard        | SDK session JWE issuance and verification    | Runtime identity + E2E tests         | OK     |
| `ProjectSettings.sdkDefaults.hostedExchangeTokenEnvelopePolicy` | `packages/database/src/models/project-settings.model.ts`       | `ProjectSettings` mixed `sdkDefaults` field                  | `apps/runtime/src/routes/project-settings.ts` | `apps/runtime/src/services/identity/sdk-token-envelope-runtime-policy.ts` | Hosted exchange issuer and verifier          | Project-default integration scenario | OK     |
| Channel `config.sdkTokenEnvelopePolicy`                         | Existing channel config policy                                 | Existing channel config persistence                          | Existing channel mutation routes              | `resolveSdkTokenEnvelopePolicy()` via runtime policy wrapper              | Hosted exchange issuer and verifier          | Strict channel integration scenarios | OK     |
| Runtime JWE key provider                                        | `apps/runtime/src/services/identity/sdk-jwe-runtime-config.ts` | Derived from `encryption.masterKey`; no raw key config added | N/A                                           | `getRuntimeSdkJweKeyProvider()`                                           | Bootstrap/session wrap/verify                | Runtime identity + integration tests | OK     |
| `tokenEnvelope` response metadata                               | Route schemas / helper types                                   | N/A                                                          | `/sdk/customer-sessions` response             | Client helper reads optional field                                        | Scenario assertions only; no key IDs exposed | Integration scenarios                | OK     |

## Boundary Checks

- `project-settings` GET and PUT now both include `sdkDefaults`, and `upsertProjectSettings()` persists the same field. No schema-to-route drop found.
- Project default policy is used only as a fallback. Channel policy still wins through the shared policy resolver.
- `/sdk/customer-sessions` resolves policy from channel plus project settings before issuing, so JWE issuance is policy-driven rather than inferred from token shape.
- `/sdk/init` verifies with the Runtime wrapper and then enforces the resolved project/channel policy. `jwe_required` rejects readable signed customer bootstrap artifacts.
- `/sdk/init` now keeps a 16 KiB schema-level outer cap and applies the runtime encrypted-bootstrap budget for JWE-shaped tokens while preserving the 4096 byte signed-token cap.
- Runtime JWE keys are derived from the existing encryption master key and returned through the key-provider abstraction. This implementation does not introduce JSON key material into config.
- `middleware/auth.ts` and `websocket/sdk-handler.ts` use the Runtime SDK session auth wrapper instead of raw signed-token verification.
- `/api/projects/:projectId/sdk-token-diagnostics` is authenticated, project scoped, rate limited, audited, and returns only coarse envelope metadata.

## Hidden-Issue Review

1. Token size alignment: initially found a gap where `/sdk/init` still had a fixed 4096 character schema cap while JWE issuance could be configured above that. Fixed by adding a route-level JWE budget check that uses `auth.sdk.jwe.maxEncryptedBootstrapBytes`.
2. Fail-open semantics: strict policy is enforced in both issuance and verification. `jwe_required` fails closed when capability cannot issue, and signed customer bootstrap tokens are rejected during init.
3. Token oracle risk: verification errors continue to collapse to `401 Invalid or expired bootstrap token`; route responses do not expose `kid`, missing-key details, or capability diagnostics.
4. Key exposure risk: this slice does not add raw keyring JSON config. Derived key bytes stay inside the runtime key provider and are not included in logs or browser responses.
5. Compatibility risk: preview/share and public-key bootstrap paths remain signed-only. Customer hosted exchange is the only path allowed to use JWE bootstrap artifacts.
6. Resolver exception risk: key-provider exceptions are normalized to generic decrypt failure before they can leak backend details.
7. Inner-token confusion risk: tests cover session-purpose JWE carrying bootstrap artifacts and bootstrap-purpose JWE carrying session JWTs.

## Residual Scope

- Production KMS/Vault-backed key providers are still future-ready plan work. The current Runtime implementation uses derived local keys through the same provider boundary.
- Production rollout still needs measured end-to-end header-budget evidence and log-redaction verification before enabling a regulated `jwe_required` channel.
- Server-side sensitive context references remain a future minimization enhancement for customers that should not carry sensitive attributes in browser tokens even when encrypted.

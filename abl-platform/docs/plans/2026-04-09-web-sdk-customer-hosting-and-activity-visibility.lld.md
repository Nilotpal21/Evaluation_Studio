# ABLP-261 / ABLP-262 — Web SDK Customer Hosting and Activity Visibility LLD

**Status**: DRAFT / PARTIALLY IMPLEMENTED  
**Date**: 2026-04-09  
**Owner**: Platform team  
**Jira**: `ABLP-261`, `ABLP-262`  
**Related Feature Docs**: `docs/features/sdk.md`, `docs/features/sub-features/sdk-channel-creation.md`  
**Related Testing Guides**: `docs/testing/sdk.md`, `docs/testing/sub-features/sdk-channel-creation.md`  
**Related HLD Specs**: `docs/specs/sdk.hld.md`, `docs/specs/sdk-auth-session-unification.hld.md`  
**Related LLD Specs**: `docs/specs/sdk-auth-session-unification.lld.md`

## 1. Scope

This plan covers the remaining work to fully close the customer-facing Web SDK gaps behind `ABLP-261` and `ABLP-262`.

It assumes the baseline that is already landed on `develop`:

- `packages/web-sdk` is publishable as a standalone package and can be packed independently of the monorepo.
- `showActivityUpdates` is now resolved from SDK channel config and returned in Runtime SDK init/refresh responses.
- Studio preview/share already use the Runtime bootstrap-artifact exchange path rather than minting trusted `sdk_session` tokens directly.
- Runtime already has public-key origin allowlist enforcement in `apps/runtime/src/middleware/sdk-auth.ts`.
- Runtime already has route-aware browser SDK CORS handling in `apps/runtime/src/lib/sdk-browser-cors.ts`.

The remaining work is not “build the whole SDK from scratch.” It is:

1. finish the customer-hosted Runtime/browser proof for external origins
2. finish the activity-visibility contract so customer channels stay quiet by default while Studio debug stays verbose
3. replace the browser-carried SDK HMAC bootstrap with a hosted backend token-exchange flow
4. remove the unused SDK-specific HMAC control-plane/runtime path once the hosted flow exists

## 2. Assumptions

1. No customer is actively using the current SDK HMAC bootstrap (`userContext.hmac` + `timestamp`).
2. Studio debug must remain separate from customer-facing SDK behavior and stay verbose by default through `web_debug`.
3. Public API keys remain the browser-facing identifier and continue to own `allowedOrigins`.
4. Preview/share keep using the existing Runtime `bootstrapToken` exchange path.
5. Generic non-SDK HMAC verification in the broader identity/webhook system remains in scope only if independently used; this plan removes SDK-specific HMAC only.

## 3. Non-Negotiable Invariants

1. Runtime remains the only trusted issuer of `sdk_session`.
2. Customer browsers never receive long-lived server secrets.
3. Customer-facing SDK channels default `showActivityUpdates` to `false`.
4. Studio debug remains default `true` without depending on SDK channel config.
5. External-hosted SDKs must be able to call Runtime directly from allowed origins.
6. Preview/share and Studio project preview must continue working during the auth migration.
7. SDK/browser contract changes may be breaking if they simplify the public customer experience, because the SDK is not yet broadly customer-hosted.

## 4. Current Gaps

### ABLP-261

- The package is standalone, but the customer-hosted path still needs explicit black-box proof from a non-Studio origin for:
  - `POST /api/v1/sdk/init`
  - `POST /api/v1/sdk/refresh`
  - `POST /api/projects/:projectId/sessions/:sessionId/attachments`
  - `WS /ws/sdk`
- Customer auth is still shaped around browser-supplied HMAC envelope fields in:
  - `packages/web-sdk/src/core/types.ts`
  - `packages/web-sdk/src/core/sdk-user-context-validation.ts`
  - `apps/runtime/src/routes/sdk-init.ts`
- SDK channel control plane still persists SDK-specific HMAC fields in:
  - `packages/database/src/models/sdk-channel.model.ts`
  - `apps/runtime/src/routes/sdk-channels.ts`
  - `apps/runtime/src/routes/tenant-sdk-channels.ts`
  - `apps/runtime/src/routes/sdk-channel-identity-utils.ts`

### ABLP-262

- Channel-level `showActivityUpdates` is now wired, but the contract needs to be treated as final and customer-facing:
  - hidden by default for SDK channels
  - visible by default for Studio debug only
  - filtered at transport/event boundaries, not only at JSX render boundaries
- The documentation and test guides still describe SDK channel identity settings primarily in terms of HMAC, which conflicts with the desired customer experience.

## 5. Design Decisions

| #   | Decision                                                                                       | Rationale                                                                                                                             | Alternatives Rejected                                                                             |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| D-1 | Remove SDK-specific HMAC from the browser contract                                             | The browser should not carry reusable signed identity proofs when a hosted exchange can mint a short-lived bootstrap artifact instead | Keep `userContext.hmac` forever; add nonce onto the HMAC shape and keep the same browser contract |
| D-2 | Reuse the existing `bootstrapToken` artifact pattern for customer backend auth                 | Preview/share already use this path; reusing it keeps Runtime issuance centralized and avoids parallel bootstrap systems              | Introduce a second browser token type unrelated to `bootstrapToken`                               |
| D-3 | Store a channel-scoped backend secret as a hash, reveal plaintext only once on generate/rotate | This gives Stripe-like backend secret ergonomics without keeping decryptable customer auth secrets in the DB                          | Store plaintext or encrypted reusable HMAC secret forever                                         |
| D-4 | Keep `allowedOrigins` on the public API key as the browser-origin gate                         | Origin allowlisting is already implemented there and naturally applies to customer-hosted embeds                                      | Move browser origin policy onto `sdk_channels` immediately                                        |
| D-5 | Keep `showActivityUpdates` as channel config, default false for customer channels              | One project can expose multiple SDK channels with different customer-facing behavior                                                  | Project/widget-level toggle                                                                       |
| D-6 | Keep Studio debug as a separate path, not a special-case SDK channel                           | Debug tooling is an internal operator surface, not customer runtime behavior                                                          | Force Studio debug to read customer channel defaults                                              |

## 6. Key Interfaces and Types

### 6.1 SDK channel auth shape

Target control-plane shape:

```ts
type SDKChannelAuthMode = 'anonymous' | 'hosted_exchange';

interface SDKChannelCustomerAuthConfig {
  mode: SDKChannelAuthMode;
  hasServerSecret: boolean;
  serverSecretPrefix?: string;
  serverSecretLastRotatedAt?: string;
}
```

Notes:

- `anonymous` preserves the current public-key bootstrap path.
- `hosted_exchange` requires a backend-generated bootstrap artifact before the browser calls `/api/v1/sdk/init`.
- Plaintext server secret is returned only at create/rotate time and is never returned again.

### 6.2 Customer session exchange

New Runtime backend API:

```ts
POST /api/v1/sdk/customer-sessions

Headers:
  X-SDK-Channel-Secret: sk_...

Body:
{
  channelId?: string;
  channelName?: string;
  verifiedUserId: string;
  customAttributes?: Record<string, string | number | boolean | null | primitive[]>;
}

Response:
{
  bootstrapToken: string;
  expiresIn: number;
  tenantId: string;
  projectId: string;
  channelId: string;
}
```

### 6.3 Bootstrap artifact extension

Extend the shared bootstrap-artifact contract in `packages/shared/src/sdk-bootstrap-artifact.ts`:

```ts
type SDKBootstrapArtifactType = 'preview' | 'share' | 'customer';
```

Customer artifacts should carry the same channel/project/tenant scope plus:

```ts
interface SDKCustomerBootstrapArtifact extends SDKBootstrapArtifactBase {
  type: 'customer';
  verifiedUserId: string;
  jti: string;
}
```

`jti` is required so Runtime can reject replay on second use.

### 6.4 Web SDK config

Target SDK public config:

```ts
type SDKConfig =
  | {
      projectId: string;
      endpoint: string;
      apiKey: string;
      bootstrapToken?: never;
      channelId?: string;
      channelName?: string;
      deploymentSlug?: string;
      userContext?: {
        userId?: string;
        customAttributes?: Record<string, SDKUserContextAttributeValue>;
      };
    }
  | {
      projectId: string;
      endpoint: string;
      bootstrapToken: string;
      apiKey?: never;
    };
```

Notes:

- Hosted exchange uses `bootstrapToken`, not browser-carried HMAC.
- Anonymous/public-key bootstrap still uses `apiKey`.
- `userContext.hmac` and `userContext.timestamp` are removed from the public SDK type.

## 7. Module Boundaries

| Module                                                                      | Responsibility                                           | Depends On                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/shared/src/sdk-bootstrap-artifact.ts`                             | Shared bootstrap artifact schema/sign/verify helpers     | Node crypto only                                                      |
| `apps/runtime/src/routes/sdk-init.ts`                                       | Canonical SDK bootstrap + refresh issuer                 | Runtime auth, channel repo, bootstrap signer, display-config resolver |
| `apps/runtime/src/routes/sdk-customer-sessions.ts`                          | New backend-only customer bootstrap exchange route       | Channel repo, server-secret verifier, bootstrap signer                |
| `apps/runtime/src/middleware/sdk-auth.ts`                                   | Public-key bootstrap resolution and origin allowlisting  | Public API key repo                                                   |
| `apps/runtime/src/lib/sdk-browser-cors.ts`                                  | Route-aware browser CORS policy for customer-hosted SDKs | Runtime config                                                        |
| `packages/database/src/models/sdk-channel.model.ts`                         | SDK channel persistence for auth/display config          | Mongo model plugins                                                   |
| `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` | Channel-level customer behavior + auth configuration UI  | Studio API/proxy layer                                                |
| `packages/web-sdk/src/core/TokenManager.ts`                                 | Browser bootstrap and refresh                            | Runtime `/sdk/init`, `/sdk/refresh`                                   |
| `packages/web-sdk/src/transport/DefaultTransport.ts`                        | Message/event filtering when `showActivityUpdates=false` | Session scope state                                                   |
| `packages/web-sdk/src/voice/VoiceClient.ts`                                 | Voice event filtering and state mapping                  | Session scope state                                                   |

## 8. File-Level Change Map

### New files

| File                                                                        | Purpose                                                       | LOC Estimate |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------ |
| `apps/runtime/src/routes/sdk-customer-sessions.ts`                          | Backend-only customer bootstrap exchange route                | 180-260      |
| `apps/runtime/src/services/identity/sdk-channel-server-secret.ts`           | Generate/hash/verify/reveal-once channel server secrets       | 120-180      |
| `apps/runtime/src/__tests__/auth/sdk-customer-sessions.integration.test.ts` | Integration proof for server-secret auth and replay rejection | 250-400      |

### Modified files

| File                                                                        | Change Description                                                             | Risk   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| `packages/shared/src/sdk-bootstrap-artifact.ts`                             | Add `customer` artifact type and replay-protection fields                      | Medium |
| `packages/database/src/models/sdk-channel.model.ts`                         | Replace SDK HMAC fields with hosted-exchange auth metadata                     | High   |
| `apps/runtime/src/routes/sdk-init.ts`                                       | Accept customer bootstrap artifacts, later remove SDK HMAC path                | High   |
| `apps/runtime/src/routes/sdk-channels.ts`                                   | Create/update/read new channel auth config and secret rotation metadata        | High   |
| `apps/runtime/src/routes/tenant-sdk-channels.ts`                            | Same as above for tenant-admin flows                                           | High   |
| `apps/runtime/src/routes/sdk-channel-identity-utils.ts`                     | Remove SDK HMAC authoring helpers; replace with hosted-exchange helpers        | High   |
| `apps/runtime/src/server.ts`                                                | Mount customer-session route and keep browser CORS handling aligned            | Medium |
| `apps/runtime/src/middleware/sdk-auth.ts`                                   | Keep origin allowlist behavior explicit and tested                             | Medium |
| `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` | Add auth-mode + secret-generate/rotate UI; keep `showActivityUpdates` here     | Medium |
| `apps/studio/src/api/channels.ts`                                           | Extend Studio SDK-channel client types for hosted exchange                     | Medium |
| `apps/studio/src/lib/sdk-channel-display-config.ts`                         | Keep channel-level display config helper authoritative                         | Low    |
| `packages/web-sdk/src/core/types.ts`                                        | Add `bootstrapToken`; remove public SDK HMAC envelope fields                   | High   |
| `packages/web-sdk/src/core/TokenManager.ts`                                 | Support hosted `bootstrapToken` path                                           | High   |
| `packages/web-sdk/src/core/sdk-user-context-validation.ts`                  | Remove HMAC/timestamp validation; keep metadata bounds                         | Medium |
| `packages/config/src/constants.ts`                                          | Remove SDK-specific HMAC constants once runtime/browser no longer use them     | Medium |
| `packages/web-sdk/src/transport/DefaultTransport.ts`                        | Ensure hidden activity never enters customer-facing message flow when disabled | Medium |
| `packages/web-sdk/src/voice/VoiceClient.ts`                                 | Same as above for voice activity events                                        | Medium |
| `packages/web-sdk/README.md`                                                | Replace HMAC-based customer guidance with hosted exchange examples             | Low    |
| `docs/features/sub-features/sdk-channel-creation.md`                        | Replace HMAC-first narrative with hosted-exchange narrative                    | Low    |
| `docs/testing/sub-features/sdk-channel-creation.md`                         | Replace HMAC lifecycle proof with hosted-exchange proof                        | Low    |

### Deleted files / code paths

| File / Path                                                                          | Reason                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| SDK-specific HMAC request/response branches in `apps/runtime/src/routes/sdk-init.ts` | Superseded by hosted token exchange                        |
| SDK-specific HMAC fields in `packages/web-sdk/src/core/types.ts`                     | No longer part of supported browser contract               |
| SDK-specific HMAC validation constants in `packages/config/src/constants.ts`         | No longer needed once browser/runtime HMAC path is removed |

## 9. Implementation Phases

### Phase 0: Codify Current Baseline

**Goal**: Treat the already-merged ABLP-261/262 baseline as the starting point for the remaining work.

**Tasks**:
0.1. Update this plan and linked docs to reflect that standalone packaging and channel-level `showActivityUpdates` are already landed.
0.2. Explicitly record that current preview/share bootstrap already uses Runtime exchange.
0.3. Record that Studio debug remains a separate `web_debug` path.

**Files Touched**:

- `docs/plans/2026-04-09-web-sdk-customer-hosting-and-activity-visibility.lld.md`
- `docs/features/sub-features/sdk-channel-creation.md`
- `docs/testing/sub-features/sdk-channel-creation.md`

**Exit Criteria**:

- [ ] Baseline status is documented without claiming the tickets are fully complete.
- [ ] Remaining work is clearly separated from already-landed work.

**Test Strategy**:

- Doc-only review

**Rollback**: N/A

---

### Phase 1: Finish ABLP-262 Activity Visibility Hardening

**Goal**: Make channel-level activity visibility the final customer-facing contract.

**Tasks**:
1.1. Keep `showActivityUpdates` sourced only from SDK channel config in Runtime and Studio helper layers.
1.2. Ensure customer-facing SDK channels default `showActivityUpdates` to `false` unless explicitly enabled.
1.3. Ensure Studio debug remains default verbose through `web_debug` and does not depend on SDK channel config.
1.4. Verify suppression happens in transport/event flow, not only in widget rendering, across:

- `packages/web-sdk/src/transport/DefaultTransport.ts`
- `packages/web-sdk/src/voice/VoiceClient.ts`
- `packages/web-sdk/src/react/AgentProvider.tsx`
  1.5. Update preview/share/embed tests to assert the channel-level value is respected.

**Files Touched**:

- `apps/runtime/src/lib/sdk-channel-display-config.ts`
- `apps/runtime/src/routes/sdk-init.ts`
- `apps/studio/src/lib/sdk-channel-display-config.ts`
- `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`
- `packages/web-sdk/src/transport/DefaultTransport.ts`
- `packages/web-sdk/src/voice/VoiceClient.ts`
- `packages/web-sdk/src/react/AgentProvider.tsx`

**Exit Criteria**:

- [ ] Runtime `sdk/init` and `sdk/refresh` always return boolean `showActivityUpdates`.
- [ ] New SDK channels default `showActivityUpdates=false`.
- [ ] `web_debug` remains verbose by default.
- [ ] Chat, voice, unified, React, and share/preview surfaces all suppress thought/handoff activity when the channel setting is false.

**Test Strategy**:

- Unit:
  - `packages/web-sdk/src/__tests__/default-transport.test.ts`
  - `packages/web-sdk/src/__tests__/voice-client-thoughts.test.ts`
  - `packages/web-sdk/src/__tests__/unified-widget-panel.test.ts`
- Integration:
  - `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`
  - `apps/studio/src/__tests__/api-routes/api-deployment-routes.test.ts`

**Rollback**: Revert transport filtering and keep UI-only suppression temporarily if needed.

---

### Phase 2: Finish ABLP-261 Customer-Hosted Runtime Proof

**Goal**: Prove that a customer-hosted SDK bundle can call Runtime directly from a non-Studio origin.

**Tasks**:
2.1. Keep the package standalone and verify `pnpm pack` output remains monorepo-independent.
2.2. Ensure Runtime browser CORS handling covers:

- `/api/v1/sdk/init`
- `/api/v1/sdk/refresh`
- attachment upload routes used by the SDK
  2.3. Keep public API key `allowedOrigins` as the authoritative browser-origin gate.
  2.4. Add black-box proof for:
- allowed origin -> success
- disallowed origin -> `403`
- no origin on browser path -> fail as expected for key-restricted flows
  2.5. Update README/examples for “customer-hosted package talking directly to Runtime.”

**Files Touched**:

- `apps/runtime/src/server.ts`
- `apps/runtime/src/lib/sdk-browser-cors.ts`
- `apps/runtime/src/middleware/sdk-auth.ts`
- `apps/runtime/src/routes/sdk-public-keys.ts`
- `packages/web-sdk/package.json`
- `packages/web-sdk/README.md`

**Exit Criteria**:

- [ ] `pnpm pack` for `@agent-platform/web-sdk` succeeds.
- [ ] An allowed non-Studio origin can complete `OPTIONS` + `POST /api/v1/sdk/init` + `WS /ws/sdk`.
- [ ] A disallowed origin is rejected by Runtime public-key auth with `403`.
- [ ] Attachment upload from an allowed external origin succeeds.

**Test Strategy**:

- Integration:
  - extend `apps/runtime/src/__tests__/auth/sdk-bootstrap-auth.integration.test.ts`
  - add explicit external-origin preflight/attachment coverage
- Verification:
  - `pnpm --filter=@agent-platform/web-sdk build`
  - `pnpm --filter=@agent-platform/runtime build`
  - `pnpm pack --pack-destination <tmpdir>` in `packages/web-sdk`

**Rollback**: Keep package standalone and revert only the route-aware CORS change if it proves too broad.

---

### Phase 3: Introduce Hosted Customer Token Exchange

**Goal**: Add the better customer auth path before deleting SDK HMAC.

**Tasks**:
3.1. Extend `packages/shared/src/sdk-bootstrap-artifact.ts` with `type: 'customer'`.
3.2. Add channel-level auth mode metadata:

- `anonymous`
- `hosted_exchange`
  3.3. Add Runtime route `POST /api/v1/sdk/customer-sessions` for customer backends.
  3.4. Generate a channel server secret (`sk_...`) on create/rotate, store only hash + metadata.
  3.5. Use the existing Runtime bootstrap signing secret to mint short-lived customer `bootstrapToken`s.
  3.6. Add one-time-use replay protection (`jti` + Redis or equivalent shared store).
  3.7. Keep preview/share on the existing artifact flow unchanged.

**Files Touched**:

- `packages/shared/src/sdk-bootstrap-artifact.ts`
- `packages/database/src/models/sdk-channel.model.ts`
- `apps/runtime/src/routes/sdk-customer-sessions.ts`
- `apps/runtime/src/routes/sdk-channels.ts`
- `apps/runtime/src/routes/tenant-sdk-channels.ts`
- `apps/runtime/src/services/identity/sdk-channel-server-secret.ts`
- `apps/runtime/src/services/identity/sdk-secret-config.ts`
- `apps/runtime/src/server.ts`

**Exit Criteria**:

- [ ] Customer backend can exchange a channel server secret for a short-lived `bootstrapToken`.
- [ ] Same customer bootstrap artifact is rejected on second use.
- [ ] Preview/share exchange still passes unchanged.
- [ ] SDK channel reads expose only `hasServerSecret`, prefix, and rotation metadata, never plaintext.

**Test Strategy**:

- Integration:
  - new `apps/runtime/src/__tests__/auth/sdk-customer-sessions.integration.test.ts`
  - update `apps/runtime/src/__tests__/auth/sdk-bootstrap-auth.integration.test.ts`
- Negative cases:
  - bad secret -> `401`
  - wrong channel -> concealed `404` or `401` per route contract
  - replayed `jti` -> deterministic rejection

**Rollback**: Keep `authMode=anonymous` as the default and leave hosted exchange disabled per channel if rollout needs to pause.

---

### Phase 4: Web SDK Bootstrap Token Support

**Goal**: Make the published browser SDK consume the hosted exchange path cleanly.

**Tasks**:
4.1. Add `bootstrapToken` support to `packages/web-sdk/src/core/types.ts`.
4.2. Update `TokenManager` to call `/api/v1/sdk/init` with `bootstrapToken` when configured and omit `X-Public-Key`.
4.3. Make the SDK config type explicit about the two supported bootstrap modes:

- public key bootstrap
- hosted bootstrap token
  4.4. Remove `userContext.hmac` and `userContext.timestamp` from the public SDK API.
  4.5. Update package README with customer backend example code and migration notes.

**Files Touched**:

- `packages/web-sdk/src/core/types.ts`
- `packages/web-sdk/src/core/TokenManager.ts`
- `packages/web-sdk/src/core/sdk-user-context-validation.ts`
- `packages/web-sdk/README.md`
- `packages/web-sdk/src/__tests__/token-manager-contract.test.ts`
- `packages/web-sdk/src/__tests__/token-manager-user-context.test.ts`

**Exit Criteria**:

- [ ] Browser SDK can initialize with `{ projectId, endpoint, bootstrapToken }`.
- [ ] Public SDK types no longer advertise SDK-specific HMAC fields.
- [ ] Hosted exchange example is documented in `README.md`.
- [ ] Package tests cover both public-key and bootstrap-token bootstrap paths.

**Test Strategy**:

- Unit:
  - `packages/web-sdk/src/__tests__/token-manager-contract.test.ts`
  - `packages/web-sdk/src/__tests__/token-manager-user-context.test.ts`
- Verification:
  - `pnpm --filter=@agent-platform/web-sdk build`
  - `pnpm --filter=@agent-platform/web-sdk test -- --run`

**Rollback**: Retain public-key bootstrap path as default while continuing to support hosted exchange behind explicit config.

---

### Phase 5: Remove Legacy SDK HMAC Path

**Goal**: Delete the unused SDK-specific HMAC contract once hosted exchange is live.

**Tasks**:
5.1. Remove `secretKey` / `hmacEnforcement` from `sdk_channels`.
5.2. Remove SDK HMAC validation/constants from:

- `packages/config/src/constants.ts`
- `packages/web-sdk/src/core/sdk-user-context-validation.ts`
- `apps/runtime/src/routes/sdk-init.ts`
  5.3. Remove SDK control-plane authoring for `identityVerification.secretKey`.
  5.4. Delete SDK-specific HMAC tests and docs.
  5.5. Keep generic identity/webhook HMAC code only if other non-SDK flows still depend on it.

**Files Touched**:

- `packages/database/src/models/sdk-channel.model.ts`
- `apps/runtime/src/routes/sdk-init.ts`
- `apps/runtime/src/routes/sdk-channels.ts`
- `apps/runtime/src/routes/tenant-sdk-channels.ts`
- `apps/runtime/src/routes/sdk-channel-identity-utils.ts`
- `packages/config/src/constants.ts`
- `packages/web-sdk/src/core/types.ts`
- `packages/web-sdk/src/core/sdk-user-context-validation.ts`
- `docs/features/sub-features/sdk-channel-creation.md`
- `docs/testing/sub-features/sdk-channel-creation.md`

**Exit Criteria**:

- [ ] `/api/v1/sdk/init` supports only public-key bootstrap or `bootstrapToken`.
- [ ] SDK channel APIs no longer accept SDK HMAC identity configuration.
- [ ] No public SDK/browser docs mention `userContext.hmac` or `timestamp`.
- [ ] Generic non-SDK HMAC tests still pass.

**Test Strategy**:

- Integration:
  - update Runtime SDK bootstrap tests to remove HMAC paths
- Regression:
  - run non-SDK HMAC/webhook suites that still depend on generic shared code

**Rollback**:

- If removal is blocked late, stop after Phase 4 and keep the legacy path temporarily hidden from docs/UI.
- Do not ship schema-field deletion until hosted exchange is proven.

---

### Phase 6: Docs, Proof, and Ticket Closeout

**Goal**: Close the two tickets with accurate proof and customer-facing guidance.

**Tasks**:
6.1. Update SDK docs to describe:

- standalone package install
- direct Runtime hosting
- backend hosted token exchange
- channel-level activity visibility defaults
  6.2. Update feature/test docs to remove HMAC-first language.
  6.3. Run full targeted build/test matrix.
  6.4. Add Jira comments with commit/PR links and a short verification summary.

**Files Touched**:

- `packages/web-sdk/README.md`
- `docs/features/sub-features/sdk-channel-creation.md`
- `docs/testing/sub-features/sdk-channel-creation.md`
- `docs/testing/sdk.md`
- Jira tickets `ABLP-261`, `ABLP-262`

**Exit Criteria**:

- [ ] Docs describe the shipped customer auth path, not the removed HMAC path.
- [ ] Ticket comments include implementation and verification links.
- [ ] All targeted builds/tests are green.

**Test Strategy**:

- `pnpm --filter=@agent-platform/web-sdk build`
- `pnpm --filter=@agent-platform/runtime build`
- `pnpm --filter=@agent-platform/studio build`
- targeted Runtime/Studio/Web SDK tests for bootstrap, preview/share, transport filtering, and customer-session issuance

**Rollback**: Docs can be reverted independently of code if wording lands ahead of implementation.

## 10. Wiring Checklist

- [ ] New Runtime route mounted in `apps/runtime/src/server.ts`
- [ ] New server-secret helpers exported/imported from their service module
- [ ] Updated SDK channel model wired into Runtime repos and serializers
- [ ] Studio SDK-channel API client types updated to include auth mode + secret metadata
- [ ] Studio channel configuration UI renders and submits auth mode + `showActivityUpdates`
- [ ] Web SDK `TokenManager` chooses exactly one bootstrap method
- [ ] Preview/share code paths remain on existing Runtime bootstrap-artifact exchange
- [ ] Runtime OpenAPI descriptions updated for new customer-session route and changed SDK bootstrap contract

## 11. Cross-Phase Concerns

### 11.1 Database / Migration Strategy

- Add new auth metadata fields before removing legacy SDK HMAC fields.
- Backfill all existing SDK channels to `authMode='anonymous'`.
- Do not attempt to migrate old SDK HMAC secrets because there are no active customers using them.
- Delete old fields only after hosted exchange is live and verified.

### 11.2 Configuration Changes

- Reuse `AUTH_SDK_BOOTSTRAP_SIGNING_SECRET` for preview/share/customer bootstrap artifacts.
- Reuse `AUTH_SDK_SESSION_SIGNING_SECRET` for Runtime `sdk_session`.
- Add only code-level TTL constants if needed for customer bootstrap artifacts; avoid introducing unnecessary environment knobs.

### 11.3 Security Considerations

- Store server secrets as hashes, not decryptable plaintext.
- Reveal plaintext secret only at create/rotate time.
- Bind customer bootstrap artifacts to `channelId`, `tenantId`, `projectId`, and `jti`.
- Reject replay via shared storage, not process-local memory.
- Keep browser origin allowlisting on public API keys even after hosted exchange exists.

### 11.4 Backward Compatibility

- Public-key bootstrap remains supported for `anonymous` channels.
- Preview/share browser flows remain unchanged.
- Hosted exchange is additive first, then SDK HMAC is removed.

## 12. Acceptance Criteria

- [ ] `ABLP-262`: Customer-facing SDK channels hide activity/thought/handoff updates by default and Studio debug remains verbose by default.
- [ ] `ABLP-262`: `showActivityUpdates` is channel-level only and is enforced at transport/event boundaries, not just widget rendering.
- [ ] `ABLP-261`: `@agent-platform/web-sdk` can be packed and consumed independently.
- [ ] `ABLP-261`: An allowed external origin can bootstrap, connect, refresh, and upload attachments directly against Runtime.
- [ ] Customer backend can mint a short-lived SDK `bootstrapToken` using a channel server secret.
- [ ] Browser SDK can initialize using `bootstrapToken` without SDK-specific HMAC fields.
- [ ] SDK channel control plane no longer exposes SDK HMAC authoring.
- [ ] Preview/share and Studio debug remain working throughout the migration.
- [ ] Related docs and tests reflect the final customer contract.

## 13. Open Questions

1. Should Studio reveal the generated server secret inline once or force a deliberate “copy now” modal? This plan assumes reveal-once inline/modal is acceptable.
2. Should customer hosted-exchange setup live in the existing channel Configuration tab or a dedicated auth tab? This plan assumes Configuration tab reuse for now.
3. Do we want to keep `allowedOrigins` on public API keys long term, or eventually make browser origin policy a first-class SDK channel field? This plan keeps it on public keys for this ticket set.

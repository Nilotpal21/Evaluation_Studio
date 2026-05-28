# Studio Test Index

Quick reference for targeted Studio test runs.
Use the domain scripts below when a change maps cleanly to a feature area.

## Domain Commands

| Domain     | Primary Path                | Command                                  | Notes                                           |
| ---------- | --------------------------- | ---------------------------------------- | ----------------------------------------------- |
| API routes | `src/__tests__/api-routes/` | `pnpm --dir apps/studio test:api-routes` | Node-only route, proxy, and server-style suites |
| Arch v4    | `src/__tests__/arch-ai/`    | `pnpm --dir apps/studio test:arch-ai`    | Split runner: pure logic + happy-dom shards     |
| Components | `src/__tests__/components/` | `pnpm --dir apps/studio test:components` | Mostly `.test.tsx` UI/component coverage        |
| Docs       | `src/__tests__/docs/`       | `pnpm --dir apps/studio test:docs`       | Docs content, config, bundle, and MDX coverage  |
| Hooks      | `src/__tests__/hooks/`      | `pnpm --dir apps/studio test:hooks`      | Hook tests that may span light and unit lanes   |
| Search AI  | `src/__tests__/search-ai/`  | `pnpm --dir apps/studio test:search-ai`  | Search AI UI + orchestration suites             |
| Stores     | `src/__tests__/stores/`     | `pnpm --dir apps/studio test:stores`     | Store/serializer/logic-heavy suites             |

## Feature Group Aliases

Use these scripts when the affected tests are still root-level but already map
to a stable debugging slice.

| Feature Area | Command                                   | Notes                                                  |
| ------------ | ----------------------------------------- | ------------------------------------------------------ |
| Observatory  | `pnpm --dir apps/studio test:observatory` | Mixed light + happy-dom trace, replay, and UI coverage |

## Retained Support Buckets

- `e2e/`: browser-style and end-to-end support suites
- `integration/`: retained cross-domain integration coverage
- `fixtures/`: test data and docs-content fixtures
- `helpers/`: shared helpers

## Root-Level Residual Groups

Phase 4/5 note: Studio now has stable domain directories, but a number of
cross-cutting or still-unmigrated suites remain at the root of
`src/__tests__/`. The groups below make those easier to find until a future
cleanup moves more of them into domains.

### Auth / Workspace / Enterprise

Check these first when auth flows, workspace guards, or enterprise settings
change:

1. `agent-permission.test.ts`
2. `auth-services.test.ts`
3. `enterprise-services.test.ts`
4. `mfa.test.ts`
5. `project-access.test.ts`
6. `security-services.test.ts`
7. `sso.test.ts`
8. `workspace-auth-profile-list-route.test.ts`

### SDK / Share / Runtime Bridge

Check these first when SDK preview/share, runtime bridge behavior, or widget
capabilities change:

1. `runtime-sdk-session.test.ts`
2. `sdk-preview-share-api.e2e.test.ts`
3. `sdk-runtime-channel-proxy.test.ts`
4. `sdk-widget-capabilities.test.ts`
5. `share-preview-link.test.ts`

### Observatory / Traces / Session Replay

Check these first when observability UI, trace replay, or span synthesis
changes:

1. `live-trace-event-ingestion.test.ts`
2. `observatory-event-normalization.test.ts`
3. `observatory-metrics.test.ts`
4. `observatory-span-end.test.ts`
5. `observatory-span-lifecycle.test.ts`
6. `session-message-synthesis.test.ts`
7. `span-summary-tree.test.ts`
8. `span-synthesis.test.ts`
9. `studio-transport.test.ts`
10. `trace-event-adapter.test.ts`

Primary command: `pnpm --dir apps/studio test:observatory`

### Channels / Speech / Realtime

Check these first when channel registries, speech providers, or runtime channel
bridges change:

1. `channel-integration.test.ts`
2. `channel-normalizer.test.ts`
3. `channel-registry.test.ts`
4. `speech-providers.test.ts`

### Project Import / Config / Deployment

Check these first when project import/export, runtime config, or deployment
bridges change:

1. `attachment-config-proxy.test.ts`
2. `lambda-deploy-trigger.test.ts`
3. `project-import-preview-contract.test.ts`
4. `runtime-config.test.ts`
5. `workflow-step-normalization.test.ts`

## Follow-Up Candidates

- Move more root-level residual suites into domain directories once their
  ownership is clear.
- Add feature-group aliases if the residual clusters above stabilize into
  durable areas.
- Keep mixed-runner clusters like SDK/share on explicit aliases until their
  environment split is simpler.
- Keep route/server suites on `vitest.node.config.ts`; most UI/store domains
  should continue using the split runner.

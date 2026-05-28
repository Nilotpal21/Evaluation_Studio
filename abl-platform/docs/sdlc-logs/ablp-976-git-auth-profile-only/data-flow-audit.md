# ABLP-976 Git Auth Profile Data-Flow Audit

Date: 2026-05-16

## Scope

Audit the git integration contract after removing the legacy `credentials.secretId` setup lane and making auth profiles the canonical credential source.

## Layer Map

| Layer               | Files                                                                                                                    | Direction    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------ |
| Schema              | `packages/database/src/models/git-integration.model.ts`, `packages/database/src/models/git-webhook-cleanup-job.model.ts` | READ / WRITE |
| Credential resolver | `apps/studio/src/lib/git-credentials.ts`                                                                                 | READ         |
| Setup route         | `apps/studio/src/app/api/projects/[id]/git/route.ts`                                                                     | WRITE / READ |
| Operation routes    | `apps/studio/src/app/api/projects/[id]/git/{pull,push,promote}/route.ts`                                                 | READ         |
| Webhook route       | `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`                                                              | READ         |
| UI/API client       | `apps/studio/src/api/project-io.ts`, `apps/studio/src/components/settings/GitIntegrationTab.tsx`                         | READ / WRITE |

## Propagation Matrix

| Field                         | Schema                    | Setup Route | Resolver | Pull/Push/Promote | Webhook Cleanup | UI       |
| ----------------------------- | ------------------------- | ----------- | -------- | ----------------- | --------------- | -------- |
| `authProfileId`               | Y                         | Y           | Y        | Y                 | Y               | Y        |
| `credentials`                 | optional legacy read only | rejected    | -        | -                 | removed         | -        |
| `webhookId`                   | Y                         | Y           | -        | -                 | Y               | Y        |
| `webhookSecret`               | Y                         | Y           | -        | Y                 | -               | redacted |
| `syncConfig.autoDeploy`       | Y                         | Y           | -        | -                 | -               | Y        |
| `syncConfig.conflictStrategy` | Y                         | Y           | -        | Y                 | -               | Y        |

## Verification

Focused checks run:

- `pnpm --filter @agent-platform/database build`
- `pnpm --filter @agent-platform/studio typecheck`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-git-auth-profile-lifecycle-scenarios.test.ts src/__tests__/api-routes/api-webhook-git-bitbucket-scenarios.test.ts src/__tests__/api-routes/api-git-routes.test.ts src/__tests__/api-routes/api-git-push-route.test.ts src/__tests__/api-routes/api-git-pull-route.test.ts src/__tests__/api-routes/api-git-ablp976-scenarios.test.ts`
- `pnpm --filter @agent-platform/database exec vitest run src/__tests__/model-collaboration.test.ts`
- `git diff --check`

Full Studio build note:

- `pnpm --filter @agent-platform/studio build` compiled successfully with warnings, then was terminated by `SIGTERM` during the TypeScript phase in the local desktop session. The narrower package typecheck above passed after that interruption.

## Findings

No open propagation gaps remain. The audit verified that git setup requires `authProfileId`, operation routes resolve credentials through the auth profile resolver, cleanup jobs retain only auth-profile references, and serialized integration responses no longer expose legacy credential objects.

# Studio to DB to DSL to Runtime Gap Closure LLD

Status: IN PROGRESS
Date: 2026-05-03

## Problem

The end-to-end project path has several places where a newer canonical surface and an older helper can disagree. The known example was ordered `do` action data being canonical at runtime while older post-processing still read legacy handler fields. The same failure shape exists in Studio project editing, persisted DSL identity, import/export provisioning scans, and consumer compatibility.

## Design Principles

1. Persisted record identity and DSL-declared identity must stay one-to-one.
2. Rename flows are the only allowed way to change an agent identity.
3. Post-import doctor and export preview must use the same project-io scanners.
4. Consumers must tolerate missing optional legacy fields while producers converge on canonical payloads.
5. Every hidden split-brain fix gets a targeted regression before the implementation change.

## Slices

### Slice 1: Agent Identity Contract

Tests first:

- Project draft metadata rejects `recordName != DSL header` as an explicit `AGENT_DSL_NAME_MISMATCH` instead of attributing unrelated compile failures to the wrong record.
- Studio surgical edit route rejects edits that rewrite the `AGENT:` or `SUPERVISOR:` header.
- Studio rename route rewrites the persisted DSL header together with the DB record name and server-derived path.

Implementation:

- Reuse `validateProjectAgentDraftDeclaredName` in draft metadata evaluation and surgical edits.
- Add a shared `rewriteProjectAgentDraftDeclaredName` helper for rename flows.
- Apply rename rewrites inside `updateAgent` so all Studio callers get the same behavior.

### Slice 2: Import Doctor Provisioning Parity

Tests first:

- Doctor input includes env vars referenced from agents, tools, and behavior profiles.
- Doctor input preserves the project-io contract that secret placeholders are not advertised as env vars.
- Doctor input uses shared auth profile, connector, and MCP scanners instead of local route regex.

Implementation:

- Replace route-local scanners with `buildExportProvisioningRequirements`.
- Query behavior profile config variables and include them in the scan.
- Preserve tenant/project/user scoping in all DB reads.

### Slice 3: Export Preview Consumer Compatibility

Tests first:

- Export dialog handles preview payloads where `provisioning.requiredAuthProfiles` is absent.

Implementation:

- Default optional provisioning arrays at the consumer boundary without weakening the producer contract.

## Verification

Focused tests:

- `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/project-agent-draft-metadata.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-project-agent-detail-routes.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/api-routes/api-import-doctor.test.ts`
- `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/components/export-dialog.test.tsx`

Formatting:

- `npx prettier --write` on every changed file before completion.

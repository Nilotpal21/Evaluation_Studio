# Scoped KMS Operations Runbook

This document is the operating guide for tenant, project, and environment-scoped KMS configuration.

## What Is Supported

- Tenant default KMS provider
- Tenant environment overrides
- Project default overrides
- Project environment overrides
- Scoped DEK rotation from Studio and runtime APIs

## Required Runtime Surfaces

- Tenant config: `GET/PUT /api/tenants/:tenantId/kms/config`
- Effective scope resolution: `GET /api/tenants/:tenantId/kms/config/resolve`
- Tenant environment override: `PUT/DELETE /api/tenants/:tenantId/kms/config/environments/:environment`
- Project override: `PUT/DELETE /api/tenants/:tenantId/kms/config/projects/:projectId`
- Project environment override: `PUT/DELETE /api/tenants/:tenantId/kms/config/projects/:projectId/environments/:environment`
- Scoped rotation: `POST /api/tenants/:tenantId/kms/keys/rotate`

## Rollout Checklist

1. Confirm `tenant_kms_configs` and `materialized_kms_configs` are backed up.
2. Run the cleanup script in dry-run mode:
   `npx tsx scripts/cleanup-kms-data.ts`
3. Review:
   - duplicate environment overrides
   - legacy scoped tier metadata
   - missing `wrappingProvider` metadata
   - stale `decrypt_only` DEKs
   - scopes with more than one active DEK
4. Apply cleanup when the dry run is acceptable:
   `npx tsx scripts/cleanup-kms-data.ts --apply`
5. Validate effective config resolution for representative scopes with `config/resolve`.
6. Validate scoped key rotation from Studio on a non-production tenant first.
7. Monitor audit entries for config update, config delete, force rotate, and batch re-encryption.

## Support Expectations

- A tenant can intentionally use different KMS providers for different projects or environments.
- The effective provider must always be confirmed through `config/resolve` instead of guessing from raw documents.
- Clearing a project default does not necessarily remove the project override document if project environment overrides still exist.
- Scoped rotation must only advance tenant-wide rotation timestamps when the rotation job is tenant-wide.

## Data Hygiene Expectations

- `tenant_kms_configs`
  - no duplicate `environments[].environment`
  - no duplicate `projects[].projectId`
  - no duplicate `projects[].environments[].environment`
  - no legacy `tier` fields on scoped environment overrides
- `materialized_kms_configs`
  - no legacy `resolvedTier` fields
  - unique `(tenantId, projectId, environment)`
- `dek_registry`
  - `wrappingProvider` should be present on all active and decrypt-only DEKs
  - only one active DEK per `(tenantId, projectId, environment)` scope
  - old `decrypt_only` rows should be reviewed periodically

## Monitoring

- Audit log:
  - `config_update`
  - `tenant_environment_config_update`
  - `tenant_environment_config_delete`
  - `project_config_update`
  - `project_config_delete`
  - `environment_config_update`
  - `environment_config_delete`
  - `force_rotate`
  - `batch_reencryption`
- Health:
  - provider readiness
  - crypto verification
  - drifted DEK count
  - legacy local metadata count
  - auth config dependency count

## Known Limits

- Scoped overrides are still embedded inside `tenant_kms_configs`. Large tenants with frequent concurrent writes may still justify a future schema split.
- Studio scoped UI is an admin surface, not a customer self-service workflow.
- Repo-wide Studio typecheck currently has unrelated baseline failures outside KMS.

## Incident Triage

1. Use `config/resolve` for the affected scope.
2. Inspect DEKs in the same scope from the KMS keys tab.
3. Check audit log for recent update/delete/rotate activity.
4. If provider drift is suspected, rotate only the affected scope first.
5. If cleanup debt is suspected, run `scripts/cleanup-kms-data.ts` in dry-run mode before changing data manually.

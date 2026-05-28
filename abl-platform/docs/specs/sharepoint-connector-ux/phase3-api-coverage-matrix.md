# Phase 3: API Coverage Matrix

## Summary

- **Available:** 24
- **Partial:** 14
- **Not Found:** 46

## Matrix

| Card     | API Requirement                                    | Classification | Existing Endpoint                                         | Gap Description                                                                                           |
| -------- | -------------------------------------------------- | -------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **C-01** | **Panel Shell & Navigation**                       |                |                                                           |                                                                                                           |
| C-01     | API-1: Get Connector Detail                        | Available      | `GET /:indexId/connectors/:connectorId`                   | --                                                                                                        |
| C-01     | API-2: Get Active Editors (concurrent editing)     | Not Found      | --                                                        | New presence/heartbeat endpoint needed for concurrent editing banner                                      |
| C-01     | API-3: Delete Connector                            | Available      | `DELETE /:indexId/connectors/:connectorId`                | --                                                                                                        |
| C-01     | API-4: Clone Connector                             | Not Found      | --                                                        | New `POST /connectors/:id/clone` endpoint needed                                                          |
| C-01     | API-5: Export Connector Config (JSON/YAML)         | Not Found      | --                                                        | New `POST /connectors/:id/export` endpoint needed                                                         |
| C-01     | API-6: Import Connector Config                     | Not Found      | --                                                        | New `POST /connectors/import` endpoint needed                                                             |
| C-01     | API-7: Run Health Check (standalone)               | Partial        | `POST /connectors/:connectorId/quick-setup`               | Health check exists inside quick-setup flow but no standalone trigger endpoint                            |
| **C-02** | **Connect Tab**                                    |                |                                                           |                                                                                                           |
| C-02     | Check Existing Connectors (count + names)          | Partial        | `GET /:indexId/connectors`                                | Exists but may not filter by `type=sharepoint` or return names for uniqueness check                       |
| C-02     | Validate Connector Name Uniqueness                 | Not Found      | --                                                        | New `GET /connectors/check-name?name={name}` endpoint needed (or client-side check)                       |
| C-02     | Initiate Authentication                            | Available      | `POST /connectors/:connectorId/auth/initiate`             | --                                                                                                        |
| C-02     | Poll Authentication Status                         | Available      | `GET /connectors/:connectorId/auth/status`                | --                                                                                                        |
| C-02     | Save Connector (Draft)                             | Available      | `POST /:indexId/connectors`                               | --                                                                                                        |
| C-02     | Update Permission-Aware Search Setting             | Partial        | `PUT /connectors/:connectorId/permissions/mode`           | Endpoint exists but may not support type-to-confirm audit recording                                       |
| C-02     | Generate IT Admin Email                            | Not Found      | --                                                        | New `POST /connectors/generate-admin-email` endpoint needed                                               |
| **C-03** | **Configuration Proposal**                         |                |                                                           |                                                                                                           |
| C-03     | Get Proposal Generation Status (polling)           | Not Found      | --                                                        | New `GET /connectors/:id/proposal/status` endpoint needed                                                 |
| C-03     | Get Full Proposal                                  | Not Found      | --                                                        | New `GET /connectors/:id/proposal` endpoint needed                                                        |
| C-03     | Accept Section                                     | Not Found      | --                                                        | New `POST /connectors/:id/proposal/sections/:sectionId/accept` needed                                     |
| C-03     | Modify Section                                     | Not Found      | --                                                        | New `PUT /connectors/:id/proposal/sections/:sectionId` needed                                             |
| C-03     | Skip Section                                       | Not Found      | --                                                        | New `POST /connectors/:id/proposal/sections/:sectionId/skip` needed                                       |
| C-03     | Accept All Remaining                               | Not Found      | --                                                        | New `POST /connectors/:id/proposal/accept-all` needed                                                     |
| C-03     | Approve and Start Sync                             | Partial        | `POST /connectors/:connectorId/sync/start`                | Sync start exists but proposal approval flow is new                                                       |
| C-03     | Validate Sites (Sites.Selected)                    | Not Found      | --                                                        | New `POST /connectors/:id/proposal/scope/validate-sites` needed                                           |
| C-03     | Refresh Sample Preview                             | Not Found      | --                                                        | New `POST /connectors/:id/proposal/preview/refresh` needed                                                |
| C-03     | Disable Permission-Aware Search (type-to-confirm)  | Not Found      | --                                                        | New `POST /connectors/:id/proposal/sections/permissions/disable` needed                                   |
| C-03     | Export Proposal (PDF/JSON/YAML)                    | Not Found      | --                                                        | New `GET /connectors/:id/proposal/export` needed                                                          |
| C-03     | Re-run Health Check                                | Not Found      | --                                                        | New `POST /connectors/:id/proposal/sections/health-check/rerun` needed                                    |
| C-03     | Request Security Review                            | Not Found      | --                                                        | New `POST /connectors/:id/proposal/security-gate/request-review` needed                                   |
| C-03     | Get Filter Impact Preview (inline editor)          | Partial        | `POST /connectors/:connectorId/filters/preview`           | Endpoint exists but may not return the simplified impact format                                           |
| C-03     | Abandon Connector (Do Not Sync)                    | Partial        | `DELETE /:indexId/connectors/:connectorId`                | Delete exists but abandon-during-proposal is a distinct operation                                         |
| C-03     | Send Access Request to Admin (Sites.Selected)      | Not Found      | --                                                        | New `POST /connectors/:id/proposal/scope/send-admin-request` needed                                       |
| C-03     | Download Admin Commands (PowerShell)               | Not Found      | --                                                        | New `GET /connectors/:id/proposal/scope/admin-commands` needed                                            |
| C-03     | Download Permission Request Document               | Not Found      | --                                                        | New `GET /connectors/:id/proposal/permissions/request-document` needed                                    |
| C-03     | Send Request to Security Team                      | Not Found      | --                                                        | New `POST /connectors/:id/proposal/permissions/send-security-request` needed                              |
| C-03     | Upgrade to Sites.Read.All (scope upgrade)          | Not Found      | --                                                        | New `POST /connectors/:id/proposal/scope/upgrade` needed                                                  |
| C-03     | Upgrade to Permission-Aware                        | Not Found      | --                                                        | New `POST /connectors/:id/proposal/permissions/upgrade` needed                                            |
| C-03     | Test Permissions                                   | Not Found      | --                                                        | New `POST /connectors/:id/proposal/permissions/test` needed                                               |
| C-03     | Export Security Gate PDF                           | Not Found      | --                                                        | New `GET /connectors/:id/proposal/security-gate/export` needed                                            |
| **C-04** | **Scope+Filters Split-Pane**                       |                |                                                           |                                                                                                           |
| C-04     | Get Discovery Data (sites, file types, metadata)   | Available      | `GET /connectors/:connectorId/discovery`                  | --                                                                                                        |
| C-04     | Filter Preview (live impact counts)                | Available      | `POST /connectors/:connectorId/filters/preview`           | --                                                                                                        |
| C-04     | CEL Expression Validation                          | Partial        | `POST /connectors/:connectorId/filters/preview`           | Preview endpoint may validate but no dedicated CEL validation sub-endpoint with position/fix suggestions  |
| C-04     | Proposal Section Sync (mark Scope as Modified)     | Not Found      | --                                                        | New `PATCH /connectors/:id/proposal/sections/:name` needed                                                |
| **C-05** | **Preview & Approve**                              |                |                                                           |                                                                                                           |
| C-05     | Run Preview (Dry-Run)                              | Partial        | `POST /connectors/:connectorId/filters/preview`           | Existing preview may not return siteCount, filterChanges, contentTypeBreakdown, sensitivityLabels         |
| C-05     | Get Configuration Summary                          | Not Found      | --                                                        | New `GET /connectors/:id/summary` endpoint needed                                                         |
| C-05     | Start Sync                                         | Available      | `POST /connectors/:connectorId/sync/start`                | --                                                                                                        |
| C-05     | Submit for Security Approval                       | Not Found      | --                                                        | New `POST /connectors/:id/security-review` needed                                                         |
| C-05     | Save as Draft                                      | Available      | `PUT /:indexId/connectors/:connectorId`                   | Connector update with `status: "draft"`                                                                   |
| C-05     | Export Template                                    | Not Found      | --                                                        | New `POST /connectors/:id/export-template` needed                                                         |
| C-05     | Sync Progress (polling/SSE)                        | Partial        | `GET /connectors/:connectorId/sync/status`                | Exists but may not return per-site breakdown, current document, or ETA                                    |
| C-05     | Pause/Stop Sync                                    | Partial        | `POST /connectors/:connectorId/sync/pause` and `.../stop` | `pauseSync()`/`resumeSync()` throw "not implemented" on SharePointConnector                               |
| **C-06** | **Security Tab**                                   |                |                                                           |                                                                                                           |
| C-06     | Get Connector Security Overview                    | Partial        | `GET /:indexId/connectors/:connectorId`                   | Connector detail exists but may not include grantedScopes, tokenExpiry, approvalStatus, blast radius      |
| C-06     | Request Scope Upgrade (GroupMember.Read.All)       | Not Found      | --                                                        | New `POST /connectors/:id/request-scope-upgrade` needed                                                   |
| C-06     | Disable Permission-Aware Search (type-to-confirm)  | Partial        | `PUT /connectors/:connectorId/permissions/mode`           | Exists but may not support audit-recorded type-to-confirm                                                 |
| C-06     | Emergency Revoke                                   | Not Found      | --                                                        | New `POST /connectors/:id/emergency-revoke` needed                                                        |
| C-06     | Get Blast Radius                                   | Not Found      | --                                                        | New `GET /connectors/:id/blast-radius` or derived from existing data                                      |
| C-06     | Send for Security Approval                         | Not Found      | --                                                        | New `POST /connectors/:id/security-approval` needed                                                       |
| C-06     | Get Audit Log (paginated)                          | Not Found      | --                                                        | New `GET /connectors/:id/audit-log` needed (model does not exist)                                         |
| C-06     | Export Audit Log (download)                        | Not Found      | --                                                        | New `GET /connectors/:id/audit-log/export` needed                                                         |
| C-06     | Subscribe to Audit Changes                         | Not Found      | --                                                        | New `POST /connectors/:id/audit-log/subscribe` needed                                                     |
| C-06     | Export Security Review Document (PDF/JSON/YAML/MD) | Not Found      | --                                                        | New `POST /connectors/:id/security-export` needed                                                         |
| C-06     | Get Org-Level Self-Approval Policy                 | Not Found      | --                                                        | New org/tenant settings endpoint needed                                                                   |
| **C-07** | **Draft Mode (Configure-Before-Auth)**             |                |                                                           |                                                                                                           |
| C-07     | Create Connector in Draft State                    | Available      | `POST /:indexId/connectors`                               | --                                                                                                        |
| C-07     | Update Draft Configuration (PATCH)                 | Available      | `PUT /:indexId/connectors/:connectorId`                   | --                                                                                                        |
| C-07     | Poll/Subscribe for Auth Status                     | Available      | `GET /connectors/:connectorId/auth/status`                | --                                                                                                        |
| C-07     | Get Connector (Resume Draft)                       | Available      | `GET /:indexId/connectors/:connectorId`                   | --                                                                                                        |
| C-07     | Get Schedule Frequency Options                     | Not Found      | --                                                        | New endpoint or hardcoded client-side constants                                                           |
| C-07     | Get Filter Presets (Templates)                     | Partial        | `GET /connectors/:connectorId/filters/templates`          | Filter templates endpoint exists but may not match the preset format                                      |
| **C-08** | **Monitoring & Sync Progress**                     |                |                                                           |                                                                                                           |
| C-08     | Get Connector Overview (KPIs)                      | Partial        | `GET /:indexId/connectors/:connectorId`                   | Exists but likely missing content freshness, permission sync status, notification config                  |
| C-08     | Get Content Breakdown (by type/site)               | Not Found      | --                                                        | New `GET /connectors/:id/content-breakdown` needed                                                        |
| C-08     | Get Sync History (paginated)                       | Not Found      | --                                                        | New `GET /connectors/:id/sync-history` needed                                                             |
| C-08     | Get Sync Progress (real-time)                      | Partial        | `GET /connectors/:connectorId/sync/status`                | Exists but may not include per-site progress, current document, ETA                                       |
| C-08     | Trigger On-Demand Sync                             | Available      | `POST /connectors/:connectorId/sync/start`                | --                                                                                                        |
| C-08     | Pause Connector                                    | Partial        | `POST /connectors/:connectorId/sync/pause`                | Throws "not implemented" on SharePointConnector                                                           |
| C-08     | Stop Sync                                          | Available      | `POST /connectors/:connectorId/sync/stop`                 | --                                                                                                        |
| C-08     | Trigger Health Check                               | Partial        | `POST /connectors/:connectorId/quick-setup`               | Embedded in quick-setup, no standalone trigger                                                            |
| C-08     | Re-authenticate                                    | Available      | `POST /connectors/:connectorId/auth/initiate`             | --                                                                                                        |
| C-08     | Trigger Permission Crawl                           | Available      | `POST /connectors/:connectorId/permissions/crawl`         | --                                                                                                        |
| C-08     | Save Notification Preferences                      | Not Found      | --                                                        | New `PUT /connectors/:id/notifications` needed                                                            |
| C-08     | Test Webhook                                       | Not Found      | --                                                        | New `POST /connectors/:id/notifications/test-webhook` needed                                              |
| C-08     | Set Permission Crawl Schedule                      | Not Found      | --                                                        | New `PUT /connectors/:id/permission-schedule` needed                                                      |
| **C-09** | **SourcesTable Enhancements**                      |                |                                                           |                                                                                                           |
| C-09     | List Sources (with filter/sort/group/paginate)     | Partial        | `GET /:indexId/connectors`                                | List exists but may not support search, status/type filters, groupBy, aggregates, polymorphic type fields |
| C-09     | Bulk Actions                                       | Not Found      | --                                                        | New `POST /sources/bulk` endpoint needed                                                                  |
| **C-10** | **Multi-Connector Management**                     |                |                                                           |                                                                                                           |
| C-10     | List Existing Connectors (for Clone)               | Available      | `GET /:indexId/connectors`                                | Reuse with type filter                                                                                    |
| C-10     | Clone Connector                                    | Not Found      | --                                                        | New `POST /connectors/:id/clone` needed                                                                   |
| C-10     | List Templates                                     | Not Found      | --                                                        | New `GET /connector-templates` needed                                                                     |
| C-10     | Create Connector from Template                     | Not Found      | --                                                        | New `POST /connectors/from-template` needed                                                               |
| C-10     | Create Template from Existing Connector            | Not Found      | --                                                        | New `POST /connector-templates` needed                                                                    |
| C-10     | Import Configuration                               | Not Found      | --                                                        | New `POST /connectors/import` needed                                                                      |
| **C-11** | **Error & Empty States**                           |                |                                                           |                                                                                                           |
| C-11     | Get Connector Status (with error detail)           | Partial        | `GET /:indexId/connectors/:connectorId`                   | Exists but likely missing discriminated error types, per-error fields, resume info                        |
| C-11     | Get Sync Progress (throttle/failure)               | Partial        | `GET /connectors/:connectorId/sync/status`                | Exists but missing throttle countdown, checkpoint info                                                    |
| C-11     | Get Per-Site Statuses (partial failure)            | Not Found      | --                                                        | New `GET /connectors/:id/site-statuses` needed                                                            |
| C-11     | Retry (multi-action)                               | Not Found      | --                                                        | New `POST /connectors/:id/retry` with action discriminator needed                                         |
| C-11     | Re-trigger Auth (popup/device code/scope upgrade)  | Available      | `POST /connectors/:connectorId/auth/initiate`             | --                                                                                                        |
| C-11     | Check Site Access (manual URL)                     | Not Found      | --                                                        | New `POST /connectors/:id/check-site-access` needed                                                       |
| C-11     | Get Filter Analysis (empty state)                  | Not Found      | --                                                        | New `GET /connectors/:id/filter-analysis` needed                                                          |
| C-11     | Get Discovery Summary (empty state)                | Partial        | `GET /connectors/:connectorId/discovery`                  | Discovery endpoint exists but may not return the simplified summary format                                |
| **C-12** | **Config Management & History**                    |                |                                                           |                                                                                                           |
| C-12     | Export Config (JSON/YAML with field selection)     | Not Found      | --                                                        | New `GET /connectors/:id/config/export` with include flags needed                                         |
| C-12     | Get Version History (paginated)                    | Not Found      | --                                                        | New `GET /connectors/:id/config/versions` needed (model does not exist)                                   |
| C-12     | Get Version Snapshot                               | Not Found      | --                                                        | New `GET /connectors/:id/config/versions/:versionId` needed                                               |
| C-12     | Get Version Diff                                   | Not Found      | --                                                        | New `GET /connectors/:id/config/diff` needed                                                              |
| C-12     | Restore Version                                    | Not Found      | --                                                        | New `POST /connectors/:id/config/restore` needed                                                          |
| C-12     | Get Config Drift                                   | Not Found      | --                                                        | New `GET /connectors/:id/config/drift` needed                                                             |
| C-12     | Re-apply Template (drift)                          | Not Found      | --                                                        | New `POST /connectors/:id/config/drift/reapply-template` needed                                           |
| C-12     | Update Template to Match (drift)                   | Not Found      | --                                                        | New `POST /connectors/:id/config/drift/update-template` needed                                            |
| C-12     | Ignore Drift                                       | Not Found      | --                                                        | New `POST /connectors/:id/config/drift/ignore` needed                                                     |
| C-12     | Import & Replace Config                            | Not Found      | --                                                        | New `POST /connectors/:id/config/import` + confirm needed                                                 |
| C-12     | Purge Synced Content                               | Not Found      | --                                                        | New `POST /connectors/:id/content/purge` needed                                                           |
| C-12     | Get Purge Progress                                 | Not Found      | --                                                        | New `GET /connectors/:id/content/purge/:cleanupId` needed                                                 |
| C-12     | Cancel Purge                                       | Not Found      | --                                                        | New `POST /connectors/:id/content/purge/:cleanupId/cancel` needed                                         |
| C-12     | Retry Purge                                        | Not Found      | --                                                        | New `POST /connectors/:id/content/purge/:cleanupId/retry` needed                                          |

## Analysis

### Coverage by Card

| Card      | Available | Partial | Not Found | Total  |
| --------- | --------- | ------- | --------- | ------ |
| C-01      | 2         | 1       | 4         | 7      |
| C-02      | 3         | 2       | 2         | 7      |
| C-03      | 0         | 3       | 20        | 23     |
| C-04      | 2         | 1       | 1         | 4      |
| C-05      | 2         | 3       | 3         | 8      |
| C-06      | 0         | 2       | 9         | 11     |
| C-07      | 4         | 1       | 1         | 6      |
| C-08      | 4         | 4       | 3         | 11     |
| C-09      | 0         | 1       | 1         | 2      |
| C-10      | 1         | 0       | 5         | 6      |
| C-11      | 1         | 3       | 4         | 8      |
| C-12      | 0         | 0       | 11        | 11     |
| **Total** | **24**    | **14**  | **46**    | **84** |

### Highest-Risk Areas (most "Not Found")

1. **C-03 Configuration Proposal** (20 Not Found) -- Entirely new subsystem. No existing proposal generation, section review, or decision logging infrastructure.
2. **C-12 Config Management & History** (11 Not Found) -- No version history, diff, drift detection, or content purge infrastructure exists.
3. **C-06 Security Tab** (9 Not Found) -- No audit log, emergency revoke, security review export, or org-level policy endpoints exist.
4. **C-10 Multi-Connector** (5 Not Found) -- No clone, template, or import endpoints exist.
5. **C-01 Panel Shell** (4 Not Found) -- Clone, export, import, and concurrent editing are all new.

### Known Backend Bugs Affecting API Coverage

1. `resolveScopes()` uses `Sites.FullControl.All` instead of correct scope -- affects C-02, C-03, C-06
2. `pauseSync()`/`resumeSync()` throw "not implemented" -- affects C-05, C-08
3. `getDrivePermissions()` defined but never called -- affects C-06
4. Permission modes include "simplified" instead of only "enabled"/"disabled" -- affects C-02, C-06
5. Pod-local OAuth state store violates Stateless Distributed invariant -- affects C-02
6. SharePoint group ID != Azure AD group ID in permission crawler -- affects C-06
7. `ConnectorSchema` and `FieldMapping` not registered with ModelRegistry -- affects C-04

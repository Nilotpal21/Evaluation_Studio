# SharePoint Connector — Foundational Architecture Questions

**Date:** 2026-03-23
**Purpose:** Questions that must be answered BEFORE design or implementation can proceed. Captured from 3 engineering persona reviews + architecture exploration.
**Status:** All 15 questions answered

---

## P1: BLOCKING (must answer before ANY implementation)

### Q1: Can we support multiple SharePoint connectors per KB?

**Current code says NO.** `connector.service.ts:227-252` has an explicit dedup check that returns the existing connector instead of creating a second one.

**But this is just a validation check** — the deeper question is: if we remove it, what else breaks?

**Deep exploration in progress** — checking: contentHash dedup, sync locking, ingestion pipeline, delta tokens, Neo4j permissions, vector store, webhooks, discovery, UI listing, file_upload precedent.

**Known issues if multi-connector is enabled:**

- `SearchDocument` unique index `{indexId, contentHash}` would collide if two connectors sync the same document
- `EndUserOAuthToken` unique index `{tenantId, userId, provider}` prevents different tokens per Azure AD tenant for the same user

### Q2: Is contentHash dedup intentional cross-connector dedup or a bug?

`SearchDocument` has `{indexId, contentHash}` UNIQUE. contentHash is SHA-256 of `id:modifiedAt` (not file content).

**Question:** If two connectors sync the same SharePoint file, should we:

- (a) Keep one copy (cross-connector dedup = feature) — but which connector "owns" it?
- (b) Allow duplicates (add `sourceId` to unique key) — wastes storage
- (c) Prevent overlapping connector scope (product constraint) — simplifies everything

### Q3: Can EndUserOAuthToken support multiple Azure AD tenants?

Unique index: `{tenantId, userId, provider}`. Provider is `'microsoft_sharepoint'` for all SharePoint connectors. One user can only have ONE SharePoint token.

**Question:** If user connects two SharePoint connectors to different Azure AD tenants, the second token would overwrite the first. Options:

- (a) Scope provider to include Azure AD tenant: `'microsoft_sharepoint:contoso.onmicrosoft.com'`
- (b) Use `ConnectorConnection` model instead (newer, per-connector encryption)
- (c) Require one user per Azure AD tenant (product constraint)

### Q4: Do the Configuration Proposal and SyncRun models exist?

**NO.** Both are confirmed absent from the codebase. These are the heart of the design (Proposal) and the monitoring UX (SyncRun). They are entirely new subsystems to build, not "wire up existing data."

---

## P2: ARCHITECTURAL (must answer before design decisions)

### Q5: Can Neo4j permission graph handle multiple Azure AD tenants?

`GroupNode` uses `groupId: "{source}:{id}"`. Azure AD group IDs from different tenants could theoretically collide (independent ID spaces). The permission filter middleware queries with `tenantId + email` — doesn't scope by connector or Azure AD tenant.

**Risk:** Two connectors from different Azure AD tenants could create conflicting permission edges in the same Neo4j graph.

### Q6: Does the vector store handle concurrent writes from multiple connectors?

One KB = one SearchIndex = one Qdrant collection. Two connectors writing simultaneously = concurrent batch upserts. Qdrant doesn't have row-level locking.

**Risk:** Data races on same point IDs (from deduped documents) could corrupt the collection.

### Q7: Does the search pipeline carry source attribution through to results?

`SearchDocument` has `sourceId` and `connectorId`, but do vector payloads include this metadata? Can the UI show "from Marketing SharePoint" vs "from Engineering SharePoint"?

### Q8: Can two connectors subscribe to webhooks for the same drive?

`WebhookSubscriptionConnector` index allows it (`{tenantId, connectorId, driveId}` UNIQUE). But:

- Does Microsoft Graph allow multiple subscriptions to the same resource?
- Would one notification trigger sync on BOTH connectors (double processing)?

---

## P3: INFRASTRUCTURE GAPS (must answer before scoping)

### Q9: Does any email infrastructure exist?

5+ wireframes show email-sending buttons (delegation invite, token expiry, security review, permission request, admin request). If no email service exists, this is a major infrastructure buildout (provider, DKIM/SPF, templates, bounces).

**Research needed:** Search codebase for SMTP, SendGrid, SES, email references.

### Q10: Does a CEL evaluator exist in the TypeScript stack?

The advanced filter uses CEL expressions. No native TypeScript CEL parser exists. Options: cel-js, WASM-compiled cel-go, or design our own expression language.

**Research needed:** Check if any existing runtime CEL usage (module-alias-rewriter, auth-profile-tool-middleware) provides a reusable evaluator.

### Q11: Does any delegation/invite system exist?

The delegation UX is an entirely new subsystem — invite generation, link validation, device code flow connection, push notifications, email notifications. Zero code exists.

### Q12: Does a user preference storage mechanism exist?

Simplified View toggle needs to remember the user's choice. Is there any per-user preference system in Studio? localStorage? API-backed settings?

---

## P4: CONSTRAINTS (must answer before detailed design)

### Q13: Should there be a connector limit per KB?

No limit exists in code. Without one, users could add 50+ connectors overwhelming sync, permissions, and vector store.

### Q14: Can two connectors in the same KB have different permission modes?

`permissionConfig.mode` lives on `ConnectorConfig`. If one is "enabled" and another "disabled", what happens at search time for documents without Neo4j entries?

### Q15: Does Microsoft Graph allow multiple webhook subscriptions per drive?

External API constraint. If only one subscription per resource is allowed, two connectors can't independently subscribe to the same drive.

---

## Q1 Deep Dive Results: Multi-Connector 10-Layer Analysis

**Bottom line: Removing the dedup validation is safe. The architecture supports it. Three areas need product decisions.**

| Layer                         | Verdict             | Detail                                                                                                                                 |
| ----------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1. SearchDocument contentHash | **DESIGN DECISION** | No collision today due to `indexId=sourceId` bug (see below). Two connectors store same doc separately. Latent time bomb if bug fixed. |
| 2. Sync locking               | **WORKS AS-IS**     | Lock per `indexId:connectorId` — independent, no blocking                                                                              |
| 3. Ingestion pipeline         | **WORKS AS-IS**     | Separate jobs per connector, different sourceIds                                                                                       |
| 4. Delta tokens               | **DESIGN DECISION** | Same changes processed N times for overlapping drives. Doubles compute.                                                                |
| 5. Neo4j permissions          | **WORKS AS-IS**     | Separate Document nodes per connector. Redundant but correct.                                                                          |
| 6. Vector store               | **DESIGN DECISION** | Duplicate vectors for same content. Duplicate search results at query time.                                                            |
| 7. Webhooks                   | **NEEDS CHANGE**    | Same drive change triggers N delta syncs. No cross-connector dedup.                                                                    |
| 8. Discovery                  | **WORKS AS-IS**     | Stateless, redundant but harmless                                                                                                      |
| 9. UI (SourcesTable)          | **WORKS AS-IS**     | Multiple SP rows appear, functional but confusing without labels                                                                       |
| 10. file_upload precedent     | **PROVES IT WORKS** | You CAN have multiple file_upload sources per index today                                                                              |

### Pre-existing Bug Found

`base-sync-coordinator.ts:299` sets `indexId: this.config.sourceId` — both `indexId` AND `sourceId` on SearchDocument are set to the sourceId. This is wrong (indexId should be the SearchIndex.\_id) but accidentally PREVENTS contentHash collisions between connectors (each has a different sourceId acting as indexId).

### Three Product Decisions Needed

**Decision 1: Overlapping drive processing**
If two connectors sync the same SharePoint drive, every change is processed twice. Options:

- (a) Allow it — simple, doubles compute for overlapping drives
- (b) Warn in UI — "Drive X is already synced by another connector"
- (c) Prevent at scope selection — block selecting a drive already synced by another connector

**Decision 2: Duplicate search results**
Two connectors syncing the same document = two vectors in the search index. A search query returns the same content twice. Options:

- (a) Cross-connector dedup at query time — return only the first match per contentHash
- (b) Source attribution in results — show both but label "from Connector A" vs "from Connector B"
- (c) Prevent overlapping scope — product constraint that eliminates the problem

**Decision 3: Webhook fan-out**
Microsoft sends one notification per subscription. Two subscriptions on the same drive = two notifications = two delta syncs. Options:

- (a) Accept double processing — simple, wasteful
- (b) Drive-level dedup — only process the first notification, skip subsequent for same drive+change
- (c) Single subscription per drive shared across connectors — complex but efficient

### What to Change to Enable Multi-Connector

**Mandatory (1 change):**

- Remove dedup check in `connector.service.ts:227-252`

**Recommended (to avoid user confusion):**

- Add connector name/label to SourcesTable to distinguish multiple SharePoint entries
- Add "overlapping drive" warning in scope selection

**Optional (optimization, can defer):**

- Drive-level webhook dedup
- Cross-connector search result dedup

---

## Research Status

| Question                     | Status              | Result                                                                                |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------- |
| Q1 (multi-connector support) | ✅ Complete         | Architecture supports it. Remove one validation. 3 product decisions.                 |
| Q2 (contentHash dedup)       | ✅ Complete         | No collision today (bug masks it). Decision needed on cross-connector dedup strategy. |
| Q3 (OAuth token per-tenant)  | ✅ Identified       | `{tenantId, userId, provider}` UNIQUE. Needs scoping by Azure AD tenant.              |
| Q4 (Proposal + SyncRun)      | ✅ Confirmed absent | New subsystems to build                                                               |
| Q5 (Neo4j multi-tenant)      | ✅ Complete         | Works — GUIDs globally unique. Risk: same email in 2 Azure AD tenants merges.         |
| Q6 (vector store concurrent) | ✅ Complete         | Works — chunk IDs unique, upserts atomic. No change needed.                           |
| Q7 (source attribution)      | ✅ Complete         | Data IN vectors but SourceAttribution field never populated. Need to wire.            |
| Q8 (webhook per drive)       | ✅ Complete         | Multiple subscriptions per drive allowed (different apps). Same app+changeType = 409. |
| Q9 (email infrastructure)    | ✅ Complete         | EXISTS — AWS SES/Resend/SMTP with templates. NOT a gap.                               |
| Q10 (CEL evaluator)          | ✅ Complete         | EXISTS — @marcbachmann/cel-js. NOT a gap.                                             |
| Q11 (delegation system)      | ✅ Complete         | EXISTS — workspace invitation model. Adapt existing.                                  |
| Q12 (user preferences)       | ✅ Complete         | EXISTS — Zustand+persist+localStorage. Established pattern.                           |
| Q13 (connector limit)        | ✅ Complete         | No limit in code. Recommend 10-20 per KB.                                             |
| Q14 (mixed permission modes) | ✅ Complete         | Works by accident (disabled=publicEveryone via fallback). Safe but fragile.           |
| Q15 (webhook same app)       | ✅ Complete         | Same app+changeType+resource = 409. Different apps OK. No hard cap for drives.        |

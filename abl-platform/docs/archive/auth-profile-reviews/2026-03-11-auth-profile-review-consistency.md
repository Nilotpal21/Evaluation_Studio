# Auth Profile Design — Internal Consistency Review

> **Source doc:** `docs/plans/2026-03-11-auth-profile-design.md`
> **Review date:** 2026-03-11
> **Scope:** Internal consistency only — cross-section contradictions, ambiguities, naming
> inconsistencies, missing links, and table completeness. No design changes proposed.

---

## Summary

The design is thorough and largely self-consistent. 14 findings are documented below across
three severity tiers. The most impactful are: a consumer missing from the migration table
(Section 4 vs. Section 14), an undecided PII field placement (`providerUserId`), two auth
types with incomplete validation rules (Section 9), a naming collision on `ConnectorConfig`,
and an ambiguous lock-key specification for the migration race-condition fix.

---

## Critical Findings

### C-1: `GuardrailPolicy` Consumer Missing from Section 4 Consumer Mapping Table

**Sections:** 4 (Consumer Mapping) vs. 14 (Additional Consumers Found in Audit)

Section 14 explicitly states that `GuardrailPolicy.settings.webhookSecret` is migrated to an
Auth Profile with the `webhookVerification` addon, and that an `authProfileId` field is added
to `GuardrailPolicy`. However, `GuardrailPolicy` does not appear anywhere in the Section 4
Consumer Mapping table.

This means:

- The `validateAuthProfileAccess` consumer-link-time validation pattern described in Section 4
  is not documented for `GuardrailPolicy`.
- The `getConsumerCount` fan-out in Section 4 explicitly says "Fans out across all 16 consumer
  collections" — but `GuardrailPolicy` would make it at least 17 if included.
- The "Used By" tab in the UI (Section 7.3) and the consumers endpoint (Section 8) won't
  enumerate GuardrailPolicy consumers unless it is added to the Section 4 table and the
  fan-out implementation.

**Fix:** Add `GuardrailPolicy` as row 17 to the Section 4 Consumer Mapping table with auth
type `webhookVerification addon` and reference field `GuardrailPolicy.authProfileId`. Update
the fan-out count from 16 to 17.

---

### C-2: `providerUserId` Placement Unresolved — Config vs. EncryptedSecrets

**Sections:** 2.3 (OAuth Types table), 9 (MongoDB schema), 11 (Security)

Section 2.3 places `providerUserId?` in `config` (non-sensitive). Both Section 2.3 and
Section 11 include the note: "Move to `encryptedSecrets`." The Section 9 MongoDB schema
document also places it implicitly in `config` (since `config` is `Record<string, unknown>`
and `providerUserId` is listed as a `config` field in Section 2.3).

The design never commits to a decision. Both sections present it as a recommendation. The
implementation team will need to decide, and both sections will encode this as-yet-unresolved
ambiguity into code. The two sections are in tension:

- Section 2.3 type table: `config` column includes `providerUserId?`
- Section 2.3 note + Section 11: say "Move to `encryptedSecrets`"
- Section 9 schema: `config: Record<string, unknown>` (implicitly keeps it in config)

**Fix:** Make an explicit decision in one authoritative location and update both sections to
reflect it. If moving to `encryptedSecrets`, remove it from the Section 2.3 `config` column
and add it to the `encryptedSecrets` column. If keeping in `config`, delete the "Move to
`encryptedSecrets`" notes in both sections and replace with the access-gating rule.

---

### C-3: `ConnectorConfig.authProfileId` Used for Two Different Consumers (Naming Collision)

**Section:** 4 (Consumer Mapping table, rows 2 and 13)

The Section 4 consumer table has two distinct rows that reference the same field
`ConnectorConfig.authProfileId`:

- Row 2: "Connector (Layer 1 — app config)" — auth type `oauth2_app`
- Row 13: "Connector Config (SearchAI)" — auth type `oauth2_token`

If `ConnectorConfig` is a single Mongoose model, these rows describe two different
configurations of the same model, and the reference field `authProfileId` would be
overloaded (one profile ID cannot simultaneously reference an `oauth2_app` and an
`oauth2_token`). This suggests either:

1. There are two separate models (a platform `ConnectorConfig` and a SearchAI
   `ConnectorConfig`) that happen to share a name, or
2. The model has separate fields (e.g., `appAuthProfileId` and `tokenAuthProfileId`).

Neither interpretation is spelled out. The Section 14 migration table shows only one
`ConnectorConfig (SearchAI)` row that drops `oauthTokenId`, with no separate row for the
Layer 1 `ConnectorConfig`.

**Fix:** Disambiguate by using distinct model names (e.g., `ConnectorAppConfig` vs.
`ConnectorConfig`) or distinct field names (e.g., `appAuthProfileId` vs. `authProfileId`).
Add a migration entry in Section 14 for the Layer 1 `ConnectorConfig` if it is a separate
model.

---

### C-4: Section 9 Validation Table Missing `none` Auth Type

**Sections:** 2.1, 2.2 (17 auth types defined), 9 (Validation Rules — 16 rows)

The design preamble and Section 2 state 17 auth types. Section 2.1 includes `none` as the
first row of the request mutation table. Section 9 Validation Rules has 16 rows — `none` is
absent.

While `none` requires no config or secrets, its absence from the validation table is a
completeness gap. A Zod discriminated union keyed on `authType` must handle all 17 values,
including `none`. Without an explicit `none` entry, implementers may add a passthrough case
ad hoc, bypassing the `.strict()` requirement stated in Section 1.

**Fix:** Add a `none` row to the Section 9 validation table with `—` for both required config
and required secrets, and a note that the Zod schema for `none` must still use `.strict()`.

---

## Important Findings

### I-1: `searchai` Field Mapping: "OR" in Section 2.7 Contradicts Concrete Decision in Section 14

**Sections:** 2.7 vs. 14 (`searchai` Auth Type Migration)

Section 2.7 states that `botId` and `headerName` fields are "mapped to a `custom_header` addon
**or** stored in `config` as extension fields." Section 14 makes a concrete decision: both
map to `config.botId` and `config.customHeaderName` as extension fields — no `custom_header`
addon. The "or" in Section 2.7 creates ambiguity that Section 14 has already resolved but
not fed back.

**Fix:** Replace the "or" clause in Section 2.7 with a direct reference to Section 14's
decision: "See Section 14 for the concrete mapping — both fields are stored as `config`
extension fields."

---

### I-2: `azure_ad` Validation Table Missing `endpoint` Field

**Sections:** 2.4 (`azure_ad` config: `tenantId`, `resource`, `endpoint`), 9 (Validation:
required config = `tenantId`, `resource`)

Section 2.4 lists three config fields for `azure_ad`: `tenantId`, `resource`, `endpoint`.
Section 9 validation only marks `tenantId` and `resource` as required. The `endpoint` field
is used in Section 2.1 request mutation ("fetch token via `@azure/identity`
`ClientSecretCredential`") and listed in Section 11 SSRF validation ("`azure_ad.config.endpoint`
validate HTTPS-only"). If `endpoint` is required for non-public Azure clouds (Azure Government,
Azure China), omitting it from validation means profiles for these environments will be
created without validation and fail silently at runtime.

If `endpoint` is optional (defaulting to public Azure), the design should state this default
explicitly. If required, add it to the Section 9 validation row.

**Fix:** Either add `endpoint` to required config in Section 9 for `azure_ad`, or add a note
stating the default value (`https://login.microsoftonline.com`) when omitted.

---

### I-3: `ssh_key` Validation Table Says No Required Config, But `keyType` Has No `?` in Section 2.6

**Sections:** 2.6 (config: `keyType: 'ed25519' | 'rsa'`), 9 (required config: `—`)

Section 2.6 defines `ssh_key.config` as `keyType: 'ed25519' | 'rsa'` — no `?` suffix,
suggesting it is required. Section 9 validation lists no required config for `ssh_key`. The
`ssh2` library and `GIT_SSH_COMMAND` passthrough both need to know the key type for proper
handling.

**Fix:** Either mark `keyType?` as optional in Section 2.6 (with a documented default, e.g.,
`'rsa'`), or add `keyType` to the required config column in Section 9.

---

### I-4: Migration Lock Key for `EndUserOAuthToken` Is Ambiguous

**Sections:** 5 (Token Refresh lock key: `auth-profile:refresh:{tenantId}:{profileId}`), 14
(Token Refresh Race During Migration)

Section 14 says the migration script "MUST acquire the same Redis distributed lock used by
token refresh" with key `auth-profile:refresh:{tenantId}:{profileId}`. The problem: at the
time the migration script processes an `EndUserOAuthToken` record, no Auth Profile ID exists
yet. The lock key requires `{profileId}`, which only exists after the Auth Profile is created.

The design does not specify the sequencing:

1. Should the migration script create the Auth Profile first (no lock), then acquire the
   lock before writing the secrets?
2. Should it use the old `EndUserOAuthToken._id` as a proxy for `profileId` in the lock key
   during migration only?
3. Is the lock key during migration different from the runtime lock key?

Without clarification, two valid interpretations lead to different locking behaviors.

**Fix:** Add a note specifying the migration lock sequencing. The simplest correct approach:
use `auth-profile:migrate:{tenantId}:{endUserOAuthTokenId}` as the migration lock key, since
the Auth Profile does not yet exist. The runtime lock key
`auth-profile:refresh:{tenantId}:{authProfileId}` is separate and takes over after creation.

---

### I-5: `getConsumerCount` Fan-out Count Includes Non-DB Consumer

**Section:** 4 (Consumer Mapping + `getConsumerCount`)

Section 4 states the service method "Fans out across all 16 consumer collections." However,
row 5 of the consumer table ("HTTP Tool (DSL-defined)") has no MongoDB collection — it is
resolved via DSL `auth:` references compiled into the IR. There is no model like
`HTTPToolConfig` to query for `authProfileId`. The actual DB fan-out can only cover 15
collections (plus the `GuardrailPolicy` finding in C-1 would bring it to 16 real collections).

**Fix:** Update the fan-out description to "15 consumer collections" (or 16 if `GuardrailPolicy`
is added per C-1), and add a note that DSL-defined HTTP Tool references are tracked in
`AgentVersion.toolSnapshot.authProfileId` rather than a separate collection.

---

### I-6: `encryptionKeyVersion` Link to `EncryptionServiceConfig.version` Implicit

**Sections:** 1 (Key Rotation: `encryptionKeyVersion` retained as bookkeeping, "set to 1,
incremented by batch job"), 16 (Encryption Key Rotation Prerequisite:
`EncryptionServiceConfig.current.version`)

Section 1 describes `encryptionKeyVersion` on the `AuthProfile` document as tracking which
documents have been re-encrypted. Section 16 describes `EncryptionServiceConfig.current.version`
as the key version in the service config. The design never explicitly states:

- Whether `AuthProfile.encryptionKeyVersion` must equal
  `EncryptionServiceConfig.current.version` for normal operation.
- What happens at runtime if they differ (old document not yet re-encrypted by the batch job).
- Whether the re-encryption batch job reads `AuthProfile.encryptionKeyVersion` to decide which
  documents to process.

**Fix:** Add one sentence to Section 1 Key Rotation: "At runtime, if
`profile.encryptionKeyVersion < EncryptionServiceConfig.current.version`, the decryption
service MUST try the previous key version. Batch re-encryption sets
`encryptionKeyVersion = EncryptionServiceConfig.current.version`."

---

### I-7: `oauth2_token` Token Refresh with Absent `expiresAt` — Unspecified Behavior

**Sections:** 2.3 (`oauth2_token.config.expiresAt?` — optional), 5 (Token Refresh step 1:
"Check `config.expiresAt`"), 9 (Validation: required for `oauth2_token` = `provider`,
`accessToken` — `expiresAt` not required)

Section 5 token refresh logic gate: "Check `config.expiresAt` (configurable buffer, default
60s)." If `expiresAt` is `null` (legally valid per Section 2.3 and Section 9), the refresh
check silently does nothing. The token is used indefinitely until the provider returns a 401,
which triggers the retry-with-refresh path in Section 5. This is likely the intended behavior
for tokens without expiry, but it is not documented.

**Fix:** Add a note to Section 5 Token Refresh: "If `config.expiresAt` is null, proactive
refresh is skipped; the 401 retry-with-refresh path handles expired tokens reactively."

---

### I-8: `api_key` `placement` Default Value Not Specified

**Sections:** 2.1, 2.2 (config: `placement: 'header' | 'query'`), 9 (validation: required
config = `headerName` only)

Section 2.1 shows the `applyAuth` logic branches on `placement === 'header'` vs.
`placement === 'query'`. Section 2.2 lists `placement` as a config field. Section 9 only
requires `headerName`, not `placement`. If a profile is created without `placement`, the
runtime comparison `placement === 'header'` evaluates `undefined === 'header'` → false,
falling through to the query-param branch. This would silently apply the API key as a query
parameter for any profile that omitted `placement`, even if the developer intended header
placement.

**Fix:** Either add `placement` to required config in Section 9 for `api_key`, or add an
explicit default: "If `placement` is omitted, defaults to `'header'`."

---

## Minor Findings

### M-1: Section 4 Consumer Table Has 16 Rows; Section 14 "Models Simplified (14)" Has 14

**Sections:** 4, 14

The Section 14 heading says "Models Simplified (14)." Counting the rows in Section 4 that
correspond to actual DB models (excluding "HTTP Tool (DSL-defined)" which has no model):

- 15 real-model consumers in Section 4 (16 rows minus HTTP Tool)
- 14 rows in Section 14 simplified table
- The gap is the "Connector (Layer 1 — app config)" row from Section 4

If this is a separate model from "Connector Config (SearchAI)" (see C-3), it has no migration
entry. If it is the same model, the duplicate row in Section 4 should be removed.

**Fix:** Resolve C-3 first. Then either add the missing migration row in Section 14 or remove
the duplicate consumer row in Section 4.

---

### M-2: `visibility: 'personal'` Restricted to Project Scope at API Level Complicates GDPR Cascade

**Sections:** 9 (Cross-Field Validation: "Personal profiles must be project-scoped"), 11
(GDPR Cascade item 2: "Delete all personal Auth Profiles where `createdBy === subjectId`")

Section 9 returns 400 if `visibility: 'personal'` is used on the tenant-level route. This
means personal profiles are always project-scoped. Section 11 GDPR cascade item 2 must
therefore query across all projects the user belongs to, not just at tenant level. The cascade
implementation hint says only `createdBy === subjectId` — it does not mention the need to
scope across projects. The cascade code that only queries `{ createdBy: subjectId, tenantId }`
at tenant scope would still find all project-scoped profiles since `tenantId` is always set
and `projectId` is a filter field on the project route only. In MongoDB terms this is correct
(documents carry both `tenantId` and `projectId`), but the Section 11 cascade description
should be explicit to avoid a partial-delete bug.

**Fix:** Add a note in Section 11 GDPR item 2: "Query: `{ createdBy: subjectId, tenantId,
visibility: 'personal' }` — scoped to tenant, spans all projects since projectId is stored on
each document."

---

### M-3: Section 8 OAuth Callback Route vs. Section 7.4 Frontend Route — Undocumented Relationship

**Sections:** 7.4 (new frontend route `/oauth/auth-profile-callback`), 8 (OAuth Flows:
`POST /api/projects/:pid/auth-profiles/oauth/callback`)

Section 7.4 introduces a new frontend route `/oauth/auth-profile-callback`. Section 8 lists
the server-side callback endpoint `POST /api/projects/:pid/auth-profiles/oauth/callback`.
Neither section documents the relationship between them. Specifically: does the OAuth provider
redirect to the frontend route or directly to the API endpoint? The existing pattern
(`/oauth/connection-callback/page.tsx`) uses a frontend page that calls a server-side handler.
If the same pattern applies here, the `redirect_uri` registered with OAuth providers would be
the frontend URL, not the API URL. This affects: redirect URI mismatch errors (Section 7.4),
SSRF validation of callback URLs, and OAuth state parameter validation in Section 8.

**Fix:** Add one sentence to Section 7.4 or 8 clarifying: "The OAuth provider redirects to
the frontend route `/oauth/auth-profile-callback`, which then calls
`POST /api/projects/:pid/auth-profiles/oauth/callback` via `window.opener.postMessage`."

---

## Completeness Matrix

| Check                                 | Expected    | Found                 | Status                                                               |
| ------------------------------------- | ----------- | --------------------- | -------------------------------------------------------------------- |
| Auth types in Section 2               | 17          | 17                    | OK                                                                   |
| Auth types in Section 9 schema enum   | 17          | 17                    | OK                                                                   |
| Auth types in Section 9 validation    | 17          | 16                    | Gap: `none` missing                                                  |
| Auth types in Section 7 type selector | 17          | 17 (5 categories × N) | OK                                                                   |
| Auth types in Section 2.1 applyAuth   | 17          | 17                    | OK                                                                   |
| Consumers in Section 4 table          | 16          | 16                    | Row 2/13 naming collision (C-3)                                      |
| Consumers in Section 14 simplified    | 14          | 14                    | Missing row for C-3                                                  |
| Error codes in Section 10             | 13          | 13                    | OK                                                                   |
| Error scenarios in Section 10         | 11          | 13 codes              | No direct gap found                                                  |
| Addon types defined in Section 3      | 5           | 5                     | OK                                                                   |
| Addon invalid combinations in 3.7     | —           | 5 rows                | `oauth2_app` + HTTP-addon missing (it rejects HTTP use, Section 2.1) |
| Indexes supporting Section 8 queries  | —           | 9 indexes             | Resolution query supported; OK                                       |
| Section 7 UI flows with API backing   | 15 sections | Covered               | Minor gap: 7.4 redirect flow (M-3)                                   |
| New env vars in Section 16            | 2           | 2                     | OK                                                                   |

---

_Review complete. No design modifications were made to the source document._

````

---

The complete content above is ready to be saved to `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-review-consistency.md`. After saving, run:

```bash
npx prettier --write docs/plans/2026-03-11-auth-profile-review-consistency.md
````

---

## Summary of Findings

Reviewing `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` for internal consistency. 14 findings total across three tiers.

### Critical (4)

**C-1: `GuardrailPolicy` missing from Section 4 Consumer Mapping table (confidence 95)**
Section 14 adds `authProfileId` to `GuardrailPolicy` but it does not appear in the Section 4 consumer table. The `getConsumerCount` fan-out (stated as "16 collections") and the "Used By" UI tab will silently omit GuardrailPolicy consumers.

**C-2: `providerUserId` placement never resolved (confidence 90)**
Section 2.3 places it in `config`. Both Section 2.3 and Section 11 say "Move to `encryptedSecrets`." The Section 9 schema keeps it in `config`. Three locations, two contradictory instructions, no decision.

**C-3: `ConnectorConfig.authProfileId` used for two different consumers (confidence 90)**
Section 4 rows 2 and 13 both reference `ConnectorConfig.authProfileId` — one for `oauth2_app`, one for `oauth2_token`. If this is one Mongoose model, one `authProfileId` field cannot serve both purposes. The Section 14 migration table only has one `ConnectorConfig` entry, leaving the Layer 1 connector config without a migration path.

**C-4: Section 9 Validation table has 16 rows; design claims 17 auth types (confidence 95)**
`none` is defined in Sections 2.1 and 2.2, appears in the Section 9 schema enum, but is absent from the Section 9 Validation Rules table. The Zod `.strict()` requirement applies to all discriminated union branches including `none`.

### Important (8)

**I-1:** Section 2.7 `searchai` mapping says "addon OR config extension" — Section 14 resolves it to config-only. Section 2.7 was not updated to reflect this decision.

**I-2:** `azure_ad` Section 9 validation omits `endpoint` from required config despite Section 2.4 listing it and Section 11 requiring it for SSRF validation.

**I-3:** `ssh_key` Section 2.6 defines `keyType` without `?` (suggesting required), but Section 9 validation lists no required config for `ssh_key`.

**I-4:** Migration lock key `auth-profile:refresh:{tenantId}:{profileId}` for `EndUserOAuthToken` migration is ambiguous — the Auth Profile ID doesn't exist yet when the lock must be acquired.

**I-5:** `getConsumerCount` says "16 consumer collections" but HTTP Tool (DSL-defined) has no MongoDB collection. Actual fan-out is 15 DB collections.

**I-6:** `AuthProfile.encryptionKeyVersion` and `EncryptionServiceConfig.current.version` are never explicitly linked. Runtime behavior when they differ (unre-encrypted document) is unspecified.

**I-7:** `oauth2_token.config.expiresAt` is optional (Section 2.3, Section 9) but the Section 5 refresh gate checks it unconditionally. Behavior when null is undocumented.

**I-8:** `api_key.config.placement` has no documented default. If omitted, the `applyAuth` function falls through to query-param placement silently.

### Minor (2)

**M-1:** Section 14 "Models Simplified (14)" count is off by at least one if C-3 resolves to two separate models.

**M-2:** Section 11 GDPR cascade item 2 says "delete all personal Auth Profiles where `createdBy === subjectId`" without noting that personal profiles are always project-scoped per Section 9 — implementation hint needs the explicit `{ createdBy, tenantId, visibility: 'personal' }` query to be unambiguous.

**M-3:** Section 7.4 introduces frontend route `/oauth/auth-profile-callback` but neither Section 7 nor Section 8 explains how the provider redirect URL maps to the frontend vs. server-side callback endpoint.

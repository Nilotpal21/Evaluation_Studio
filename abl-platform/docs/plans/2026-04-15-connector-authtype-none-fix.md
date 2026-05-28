# Connector `authType: "none"` — Root Cause & Fix

**Date:** 2026-04-15
**Scope:** `packages/connectors` — AP type-mapper and generated catalog
**Status:** Shipped on branch `feature/connectors-fix`
**Related tickets:** ABLP-155 follow-up; task #7

---

## Problem

Several connectors that clearly have auth support were landing in the catalog with `"authType": "none"`, which caused the Integrations UI to hide them from the OAuth / credential flows.

Concretely, before this fix `packages/connectors/src/generated/connector-catalog.json` showed:

```json
{ "name": "google-sheets", "authType": "none", "oauth2": { ...with empty scopes... } }
{ "name": "twilio",        "authType": "none" }
```

These are widely-used connectors. Users could not connect either one from the UI. A short-term workaround patched the JSON by hand (`authType: "oauth2"`) — but that gets overwritten on every catalog regen, and Google's OAuth screen then rejected the request with "Missing required parameter: scope" because `defaultScopes` was still `[]`.

## Root cause

Two independent bugs in `packages/connectors/src/adapters/activepieces/type-mapper.ts` — both in `mapAuth()` — caused any piece that tripped either one to fall through to the `default` branch and return `{ type: 'none' }`.

### Bug 1 — `'BASIC'` vs `'BASIC_AUTH'` enum mismatch (twilio)

AP's `PropertyType` enum has:

```js
// node_modules/.../pieces-framework/src/lib/property/input/property-type.js
BASIC_AUTH = 'BASIC_AUTH';
```

Every piece using `PieceAuth.BasicAuth(...)` (e.g. twilio) sets `auth.type === "BASIC_AUTH"` at import time. Our mapper's switch had `case 'BASIC':`, which never matched the real value — so every Basic-auth piece hit `default` and returned `'none'`.

**Code proof (before):**

```ts
// type-mapper.ts:21
export interface APPieceAuth {
  type: 'OAUTH2' | 'SECRET_TEXT' | 'BASIC' | 'CUSTOM_AUTH' | 'NONE';  // wrong string
}

// type-mapper.ts:125
case 'BASIC':  // dead code — never matches AP runtime value
  return { type: 'basic', fields: [...] };
```

The type declaration itself was wrong, which meant TypeScript never caught the mismatch at any call site.

### Bug 2 — Dual-auth array not handled (google-sheets)

Newer AP pieces can declare **multiple** auth methods. `google-sheets` exports:

```js
// node_modules/.../piece-google-sheets/src/lib/common/common.js:281
exports.googleSheetsAuth = [
  PieceAuth.OAuth2({
    authUrl:  'https://accounts.google.com/o/oauth2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope:    googleSheetsScopes,   // spreadsheets, drive.readonly, drive
  }),
  PieceAuth.CustomAuth({
    displayName: 'Service Account (Advanced)',
    props: { serviceAccount: ..., userEmail: ... },
  }),
];
```

`APPiece.auth` was typed `APPieceAuth | undefined` and `mapAuth()` only accepted a single `APPieceAuth`. When piece-loader passed the array in, `apAuth.type` evaluated to `undefined` (arrays don't have a `.type` field), every `case` clause failed, and the function fell through to `default: return { type: 'none' }`.

Because OAuth2 scopes live inside the first array element, the catalog also ended up with `oauth2.defaultScopes: []` — which is how you hit "Missing required parameter: scope" at Google's consent screen.

### Why TypeScript didn't catch it

- The `'BASIC'` string was part of the type declaration itself, so the whole file agreed on an incorrect value.
- The array case wasn't a compile error because JS arrays coerce to `object` and `array.type === 'NONE'` is just `false` — the function happily falls through to the `switch` default.

## Fix

Two scoped changes in `type-mapper.ts`, plus test updates.

### Change 1 — Accept array auth, prefer OAuth2

```ts
// type-mapper.ts
export interface APPiece {
  // ...
  /**
   * Most pieces export a single auth method. Newer AP pieces (e.g. google-sheets)
   * export an array of auth methods — typically [OAuth2, CustomAuth service-account].
   * We collapse arrays to a single method in `mapAuth()` by preferring OAuth2.
   */
  auth?: APPieceAuth | APPieceAuth[];
  // ...
}

export function mapAuth(apAuth?: APPieceAuth | APPieceAuth[]): ConnectorAuth {
  // Dual-auth pieces export an array like [OAuth2, CustomAuth]. Prefer OAuth2
  // so those connectors show up in the catalog with the richer auth mode.
  // Fall back to the first entry if OAuth2 isn't present.
  if (Array.isArray(apAuth)) {
    if (apAuth.length === 0) {
      return { type: 'none' };
    }
    const preferred = apAuth.find((a) => a.type === 'OAUTH2') ?? apAuth[0];
    return mapAuth(preferred);
  }
  // ...existing single-auth switch
}
```

**Why prefer OAuth2, not the first element?** When a piece offers both OAuth2 and a
service-account/custom fallback, OAuth2 is the mainstream UX — users click "Connect"
and sign in. Service-account JSON belongs behind an "Advanced" path that our UI
doesn't yet render. If we took `arr[0]` verbatim we'd be right for google-sheets
today but wrong for any future piece that lists CustomAuth first.

### Change 2 — `'BASIC'` → `'BASIC_AUTH'`

```ts
export interface APPieceAuth {
  type: 'OAUTH2' | 'SECRET_TEXT' | 'BASIC_AUTH' | 'CUSTOM_AUTH' | 'NONE';
}

// ...
case 'BASIC_AUTH':
  return { type: 'basic', fields: [...] };
```

Plus the corresponding test update: `mapAuth({type: 'BASIC'})` → `mapAuth({type: 'BASIC_AUTH'})`.

### Tests added

`packages/connectors/src/__tests__/activepieces-importer.test.ts`:

1. **OAuth2 preference on dual-auth array** — give `[OAuth2, CustomAuth]`, expect `type: 'oauth2'` with scopes propagated.
2. **Fallback to first entry** — `[SECRET_TEXT, CUSTOM_AUTH]` (no OAuth2) → `api_key`.
3. **Empty array** → `'none'`.

## Validation

### Before

```json
// catalog
{"name": "google-sheets", "authType": "none"}
{"name": "twilio",        "authType": "none"}
```

OAuth initiate for google-sheets → Google 400: `Missing required parameter: scope`
Twilio: hidden from integrations UI entirely.

### After

```bash
$ jq '.[] | select(.name=="google-sheets" or .name=="twilio")
       | {name, authType, scopes: (.oauth2.defaultScopes // [] | length)}' \
    packages/connectors/src/generated/connector-catalog.json

{"name":"twilio","authType":"basic","scopes":0}
{"name":"google-sheets","authType":"oauth2","scopes":3}
```

Full catalog distribution (26 connectors):

| authType | Count | Connectors                                                                                                                                      |
| -------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| oauth2   | 13    | github, gmail, microsoft-teams, slack, hubspot, pipedrive, salesforce, asana, clickup, google-calendar, notion, google-drive, **google-sheets** |
| api_key  | 7     | claude, openai, discord, sendgrid, stripe, linear, airtable                                                                                     |
| custom   | 4     | shopify, jira-cloud, amazon-s3, postgres                                                                                                        |
| basic    | 1     | **twilio**                                                                                                                                      |
| none     | 1     | http (utility connector — no auth by design)                                                                                                    |

`none` is now correctly limited to the built-in HTTP connector.

### Test suite

```
$ pnpm --filter @agent-platform/connectors test -- --run
Test Files  20 passed (20)
Tests       238 passed (238)
```

## Files changed

- `packages/connectors/src/adapters/activepieces/type-mapper.ts`
- `packages/connectors/src/__tests__/activepieces-importer.test.ts`
- `packages/connectors/src/generated/connector-catalog.json` (regenerated)

## Follow-ups

- **Dynamic dropdowns** — separate issue. Even with auth fixed, actions that ask
  users for SaaS resource IDs (spreadsheetId, calendar_id, channel, etc.) fall
  back to free-text input because AP declares those as `Property.Dropdown` with
  an **async** `options` function that hits the SaaS at runtime. Tracked
  separately; design doc pending.
- If AP ever adds a third auth-mode convention (e.g. a `PieceAuth.Multi([...])`
  wrapper) the array handling will need a small adjustment; the preference
  rule should stay the same.

## How to reproduce the fix locally

```bash
# 1. Pull this branch
git checkout feature/connectors-fix

# 2. Rebuild the connectors package (picks up the mapper change)
pnpm --filter @agent-platform/connectors build

# 3. Regenerate the catalog from AP piece metadata
pnpm connectors:generate-catalog

# 4. Verify
jq '[.[] | {name, authType}] | group_by(.authType)
    | map({authType: .[0].authType, count: length})' \
   packages/connectors/src/generated/connector-catalog.json

# 5. Restart dev stack so Studio + workflow-engine pick up the new dist
pnpm dev:workflows
```

# Workflow Trigger Gaps — API Key Wiring + Async Push Tab

**Date:** 2026-03-26
**Status:** Approved
**Scope:** Studio UI only — no backend changes

---

## Problem

Two gaps in the workflow trigger UI:

1. **API Key not wired in webhook triggers:** The `WebhookKeyCreationModal` and `WebhookQuickStart` components exist but are disconnected. Nothing opens the key modal, and the `apiKey` prop is never passed to `WebhookQuickStart`, so curl snippets show placeholder keys and the key status section never renders.
2. **No Async Push option:** The type system defines `async_push` as a deployment mode with `webhookUrl` + `accessToken` config, but the Studio UI only shows Sync, Async, and Async+Poll tabs in `CodeSnippets`. There is no way to configure or view async push behavior.

---

## Design

### Gap 1: API Key Wiring

**Approach:** Wire existing components — no new components needed.

#### Changes

`**WorkflowTriggersTab.tsx`\*\*

- `TriggerCreationForm`: Add `onWebhookCreated` callback prop. After successful creation of a `webhook` type trigger, call `onWebhookCreated()` in addition to `onCreated()`.
- Parent `WorkflowTriggersTab`: In the `onWebhookCreated` handler, set `showKeyModal = true` to auto-prompt key creation.
- Store `createdApiKey` (`{ id, rawKey, name }`) in state. Transform into two shapes for downstream:
  - `apiKey` prop for `WebhookQuickStart`: `{ id, keyPrefix: rawKey.slice(0, 8), isActive: true, expiresAt: null }`
  - `rawApiKey` prop: the full `rawKey` string (for functional curl snippets)
- One API key is shared across all webhook triggers on the same workflow. This is intentional — SDK keys are scoped to `workflow:execute` permission at the project level, not per-trigger.

`**TriggerCard` (same file)\*\*

- Accept optional `apiKey` prop (`{ id: string; keyPrefix: string; isActive: boolean; expiresAt: string | null } | null`), optional `rawApiKey` string, and `onRequestKey` callback.
- Forward all three to `WebhookQuickStart`.

`**WebhookQuickStart.tsx`\*\*

- Accept new props: `onRequestKey?: () => void`, `rawApiKey?: string`.
- When `apiKey` prop is absent/null, render a "Generate API Key" button that calls `onRequestKey()`.
- Pass `rawApiKey` to `CodeSnippets` as a new `fullApiKey` prop.
- Pass `trigger.config.callbackUrl` and `trigger.config.callbackAccessToken` to `CodeSnippets`.

`**CodeSnippets.tsx`\*\*

- Accept new optional prop: `fullApiKey?: string`.
- In `buildCurl`: when `fullApiKey` is provided, use it directly in the `Authorization: Bearer` header (curl is copy-paste-ready). When absent, fall back to the masked `keyPrefix****...` placeholder with a comment `# Replace with your API key`.

**Flow:**

1. User creates webhook trigger → modal auto-opens for key creation.
2. User creates/selects key → `rawKey` stored in parent state, passed down to `CodeSnippets`.
3. **In the current session:** curl snippets use the full raw key — copy-paste-ready and functional.
4. **On later visits:** `rawKey` is no longer in memory. Curl shows masked prefix with "Replace with your API key" note.
5. If user dismisses modal or visits later, "Generate API Key" button in `WebhookQuickStart` opens the modal on demand.

---

### Gap 2: Async Push Tab

**Approach:** Extend existing components — per-trigger callback config stored in trigger `config` object.

> **Note:** `async_push` exists as a `WorkflowDeployment.mode` in the type system with `asyncPushConfig`. The trigger-level `callbackUrl`/`callbackAccessToken` fields are **for curl snippet generation and display only** — they are not read by the execution engine. When backend async_push execution support is added, it should read from the deployment config, not trigger config. The trigger-level fields use distinct names (`callbackUrl`/`callbackAccessToken` vs `webhookUrl`/`accessToken`) to avoid confusion with the deployment-level concept.

#### Changes

`**CodeSnippets.tsx`\*\*

- Add `'async_push'` to `SnippetMode` union type.
- Add 4th tab labeled with i18n key `async_push_mode` ("Async Push").
- Accept new optional props: `callbackUrl?: string`, `callbackAccessToken?: string`.
- `buildCurl` for `async_push` mode generates:
  ```
  curl -X POST '<base>?mode=async_push' \
    -H 'Authorization: Bearer <key>' \
    -H 'Content-Type: application/json' \
    -d '{"input": {}, "callbackUrl": "<url>", "accessToken": "<token>"}'
  ```
- When `callbackUrl` prop is provided, use it in the snippet; otherwise use placeholder `https://your-server.com/callback`.

`**WorkflowTriggersTab.tsx` — `TriggerCreationForm**`

- When trigger type is `webhook`, show an optional collapsible section "Async Push Config (Optional)" with:
  - `callbackUrl` text input (placeholder: `https://your-server.com/callback`). Client-side validation: must start with `https://` or `http://` and be a valid URL.
  - `accessToken` text input (optional, type=password)
  - Both fields follow existing `TriggerCreationForm` input styling and accessibility patterns (label + input with `aria-label`).
- On save, include `callbackUrl` and `callbackAccessToken` in the trigger config object if provided.

`**TriggerCard` (same file)\*\*

- When a webhook trigger has `config.callbackUrl`, show an info line: "Callback: https://..."

**No backend changes needed** — trigger config is `Record<string, unknown>`, so `callbackUrl` and `callbackAccessToken` are stored as-is.

---

### i18n Keys

**File:** `packages/i18n/locales/en/studio.json` → `workflows.triggers`

| Key                        | Value                                           |
| -------------------------- | ----------------------------------------------- |
| `generate_api_key`         | `"Generate API Key"`                            |
| `api_key_required`         | `"An API key is required to call this webhook"` |
| `async_push_mode`          | `"Async Push"`                                  |
| `callback_url`             | `"Callback URL"`                                |
| `callback_access_token`    | `"Access Token"`                                |
| `callback_url_placeholder` | `"https://your-server.com/callback"`            |
| `callback_config_title`    | `"Async Push Config (Optional)"`                |
| `callback_configured`      | `"Callback"`                                    |

---

## Files Changed

| File                                                                  | Change                                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`   | Wire `onWebhookCreated` to auto-open key modal; pass `apiKey` + `onRequestKey` to `TriggerCard`; add callback URL/token fields to webhook creation form |
| `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx` | Add "Generate API Key" button; accept `onRequestKey` prop; forward callback config to `CodeSnippets`                                                    |
| `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`      | Add `async_push` tab; accept callback props; generate async_push curl                                                                                   |
| `packages/i18n/locales/en/studio.json`                                | Add 8 i18n keys under `workflows.triggers`                                                                                                              |

## Security Considerations

- `callbackAccessToken` is stored as plaintext in the trigger `config` (a `Record<string, unknown>`). This is consistent with the existing `asyncPushConfig.accessToken` pattern in `WorkflowDeployment`. Encrypting stored tokens at rest is a future improvement tracked separately.

## Out of Scope

- Backend schema changes
- New React components
- Webhook secret/HMAC validation UI
- Deployment mode configuration (separate from trigger config)
- Encrypting `callbackAccessToken` at rest (future iteration)

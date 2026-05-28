# Feature: Workflow Integration Node

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A (extends [Workflows & Human Tasks](./workflows.md))
**Status**: ALPHA
**Feature Area(s)**: `integrations`, `agent lifecycle`
**Package(s)**: `apps/studio`, `apps/workflow-engine`, `packages/shared`, `packages/shared-kernel`, `packages/connectors`
**Owner(s)**: `workflows-team`
**Testing Guide**: `../testing/workflow-integration-node.md`
**Last Updated**: 2026-04-11

---

## 1. Introduction / Overview

### Problem Statement

The workflow canvas has an `integration` node type that is currently a stub. Users who want to invoke third-party connector actions (e.g., GitHub Create Issue, Slack Send Message, Jira Create Ticket) from within a workflow must use the generic API node and manually construct HTTP requests — including auth headers, URLs, and payloads. This defeats the purpose of the platform's connector framework, which already abstracts these details away.

### Goal Statement

Promote the integration node from stub to a fully functional canvas node that lets users select a connection, pick an action, and configure action inputs through a dynamically generated form — all without writing raw HTTP calls. Every action input field supports both static values and dynamic `{{expression}}` references to upstream node outputs and workflow context.

### Summary

The integration node bridges the workflow canvas to the platform's `ConnectorRegistry`. When a user drops an integration node on the canvas, they:

1. **Select an integration + action** — a modal dialog shows all available integrations as tiles (with action counts), then drills into the actions list. This single step fills both the connector and action.
2. **Select a connection** — a dropdown filtered to connections matching the selected integration, with a "Create new" option that navigates to the Connector Catalog page.
3. **Configure action inputs** — a dynamic form is generated from the action's `ConnectorProperty[]` schema. String fields natively accept `{{expression}}` syntax inline (no toggle needed). Non-string fields (boolean, dropdown, number, date) have an explicit dynamic/expression mode toggle.

At execution time, the workflow engine resolves all expressions, looks up the connection's credentials, and delegates to `ConnectorToolExecutor`.

---

## 2. Scope

### Goals

- Remove `integration` from `STUB_NODE_TYPES` so it becomes a fully functional node.
- Build an **Integration Picker Modal** — a two-step dialog: browse integrations (tiles with action counts) → select action from the chosen integration.
- Build a new `IntegrationNodeConfig` component that renders the selected integration+action summary, connection picker, and a dynamic input form generated from the action's `ConnectorProperty[]`.
- Expose a new API endpoint that returns action schemas (the `ConnectorProperty[]` definitions) for a given connector.
- Update the Zod schema (`IntegrationNodeConfigSchema`) to capture the full config shape including `connectorId`, `actionName`, `params`, `connectionId`, and `timeout`.
- Ensure the canvas-to-steps conversion and the existing `connector_action` executor work without modification.
- String fields natively accept `{{expression}}` inline (no toggle). Non-string fields (boolean, dropdown, number, date) have an explicit expression mode toggle.

### Non-Goals (Out of Scope)

- Trigger support (webhooks, polling) — triggers are a separate node type.
- Full connection creation flow inside the modal — the "Create new" option navigates to the existing Connector Catalog page under Project Integrations. No inline OAuth flow in the config panel.
- Custom connector authoring — uses existing connectors from the registry.
- Dynamic dropdown resolution at design time (the `refreshers` mechanism) — deferred to a follow-up. Dynamic dropdowns render as plain text inputs in this iteration.
- Batch/bulk execution of connector actions within a single node.

---

## 3. User Stories

1. As a **workflow builder**, I want to browse all available integrations in a visual tile grid so that I can quickly find the service I need.
2. As a **workflow builder**, I want to drill into an integration and select a specific action so that both the integration and action are configured in one flow.
3. As a **workflow builder**, I want to change my integration+action selection by re-opening the picker modal so that I can correct mistakes without reconfiguring the node from scratch.
4. As a **workflow builder**, I want the connection dropdown to be filtered to the selected integration so that I only see relevant connections, with a "Create new" option that takes me to the Connector Catalog.
5. As a **workflow builder**, I want the action's required and optional input fields to appear automatically as a form so that I don't need to know the action's API schema.
6. As a **workflow builder**, I want to type `{{expression}}` syntax directly into any string field so that I can reference upstream node outputs without toggling modes.
7. As a **workflow builder**, I want a `{ }` context explorer button next to string fields so that I can browse and insert available expressions.
8. As a **workflow builder**, I want non-string fields (boolean, dropdown, number, date) to have an expression toggle so that I can switch them to dynamic mode when needed.
9. As a **workflow builder**, I want validation feedback when required fields are empty so that I catch issues at design time.
10. As a **workflow builder**, I want to configure a timeout for long-running actions so that failed third-party calls don't hang the workflow indefinitely.

---

## 4. Functional Requirements

### Integration Picker Modal

1. **FR-1**: Clicking "Select Integration" in the config panel must open a modal dialog. The modal fetches the connector catalog from `GET /api/projects/:projectId/connectors` and displays integrations as a **tile grid**. Each tile shows: integration name, icon/logo (if available), and a badge with the number of actions available (e.g., "7 actions").
2. **FR-2**: The modal must have a **search bar** at the top to filter integrations by name. Optionally, category tabs (Communication, Dev Tools, CRM, etc.) can filter the grid.
3. **FR-3**: Selecting an integration tile must transition (within the same modal) to a **second screen** that lists the integration's actions. Each action row shows `displayName` and `description`. The modal header shows the selected integration name with a back arrow to return to the tile grid.
4. **FR-4**: Selecting an action must close the modal and fill both `connectorId` and `actionName` in the node config. The config panel updates to show the selected integration + action as a summary row (e.g., `Gmail → Send Email`) with a **"Change"** button that re-opens the modal.
5. **FR-5**: The action schemas must be fetched via `GET /api/projects/:projectId/connectors/:connectorName/actions` which returns `{ name, displayName, description, props: ConnectorProperty[] }[]`.

### Connection Picker

6. **FR-6**: After integration+action selection, the config panel must show a **Connection** dropdown filtered to connections whose `connectorName` matches the selected `connectorId`. Connections are fetched from `GET /api/projects/:projectId/connections`.
7. **FR-7**: The connection dropdown must include a **"+ Create new connection"** option at the bottom. Clicking it navigates the user to the **Connector Catalog** page under Project Integrations (`/projects/:projectId/integrations`) where they can create a connection for the selected connector. When the user returns to the workflow canvas, the connection list refreshes automatically.
8. **FR-8**: If no connections exist for the selected integration, the dropdown must show an empty state: "No connections found for Gmail. [+ Create connection →]".

### Dynamic Form (Action Inputs)

9. **FR-9**: When an action is selected, the system must dynamically render an input form from the action's `ConnectorProperty[]` definition. Each property type maps to a UI control:

   | `ConnectorPropertyType` | UI Control                                                                                                              | Expression Support                                                                                                                                     |
   | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `string`                | Text input (or Textarea for long text hints)                                                                            | **Inline** — accepts `{{expression}}` directly in the text field. A `{⋮}` button opens ContextExplorer to browse/insert expressions. No toggle needed. |
   | `number`                | Number input with step controls                                                                                         | **Toggle** — a `{⋮}` icon switches to expression mode (text input accepting `{{expression}}`).                                                         |
   | `boolean`               | Toggle switch                                                                                                           | **Toggle** — a `{⋮}` icon switches to expression mode.                                                                                                 |
   | `dropdown`              | Select with static `options[]`                                                                                          | **Toggle** — a `{⋮}` icon switches to expression mode (text input accepting `{{expression}}`).                                                         |
   | `array`                 | **Chip input** (mat-chips / tag input) — type a value and press Enter to add as a chip. Each chip is removable via `✕`. | **Toggle** — a `{⋮}` icon switches to expression mode (text input accepting `{{expression}}` that resolves to an array).                               |
   | `dynamic_dropdown`      | Text input (resolution deferred — see Non-Goals)                                                                        | **Inline** — same as string, accepts expressions natively.                                                                                             |
   | `json`                  | Code editor / Textarea with JSON mode                                                                                   | **Inline** — accepts `{{expression}}` within JSON values. A `{⋮}` button opens ContextExplorer.                                                        |
   | `date`                  | Date picker input                                                                                                       | **Toggle** — a `{⋮}` icon switches to expression mode.                                                                                                 |
   | `file`                  | Text input for file URL/path reference                                                                                  | **Inline** — same as string.                                                                                                                           |
   | `oauth`                 | Read-only display (handled by connection auth)                                                                          | None                                                                                                                                                   |

10. **FR-10**: **String fields** (type `string`, `dynamic_dropdown`, `file`) must natively support `{{expression}}` syntax inline — the user types both static text and expressions in the same field without toggling. Example: `Re: {{trigger.payload.subject}}`. Expression insertion is triggered two ways:
    - **`{⋮}` button** — a small button at the end of the field opens the ContextExplorer popover. Selecting an expression inserts it at the cursor position.
    - **`{{` auto-trigger** — the moment the user types `{{`, the ContextExplorer popover opens automatically (anchored to the cursor position). Selecting an expression completes the `{{...}}` block. Pressing Escape dismisses the popover and lets the user continue typing manually. This provides an autocomplete-like experience without requiring the user to reach for the button.

11. **FR-11**: **Non-string fields** (type `number`, `boolean`, `dropdown`, `date`, `array`) must have a `{⋮}` toggle icon in the field label. When toggled to expression mode, the native control (number input, toggle, select, date picker, chip input) is replaced with a text input that accepts `{{expression}}` syntax. Toggling back restores the native control. The mode is persisted per-field.

12. **FR-12**: **Array fields** (type `array`) must render as a **chip input** (tag input) in static mode:
    - The user types a value into the text field and presses **Enter** (or comma) to add it as a chip/tag.
    - Each chip displays the value with a `✕` button to remove it.
    - Chips are stored as a JSON array string in `params` (e.g., `'["a@gmail.com","b@gmail.com"]'`).
    - In expression mode (toggled via `{⋮}`), the chip input is replaced with a text input accepting `{{expression}}` that resolves to an array at runtime.
    - Example: Gmail CC field — type `a@gmail.com` Enter, `b@gmail.com` Enter → two chips.

13. **FR-13**: The system must validate the integration node config: `connectorId` is required, `actionName` is required, `connectionId` is required, all `required: true` properties must have a non-empty value.

14. **FR-14**: The node config must be persisted in this shape:

```typescript
{
  connectorId: string; // connector name (e.g., 'gmail')
  actionName: string; // action name (e.g., 'send_email')
  connectionId: string; // selected connection ID
  params: Record<string, string>; // field values — plain strings that may contain {{expressions}}
  paramModes: Record<string, 'static' | 'expression'>; // only for non-string fields that were toggled
  timeout: number; // seconds, default 60
}
```

**Design rationale**: String fields always store their value as-is (may contain `{{expressions}}`). The executor's `resolveExpressionTyped()` handles both static and expression strings uniformly. `paramModes` only tracks the UI toggle state for non-string fields so the form knows whether to render the native control or the expression text input when re-opened.

15. **FR-15**: The canvas-to-steps converter must map this config to the existing `connector_action` step type. All `params` values are passed directly as strings — the executor already resolves expressions at runtime. For array fields stored as JSON strings (e.g., `'["a@gmail.com","b@gmail.com"]'`), the executor parses them before passing to the connector action.
16. **FR-16**: The node must support the standard `on_success` / `on_failure` output handles (already implemented via `getOutputHandles`).

---

## 4a. End-to-End Example: Gmail "Send Email"

This section walks through the full integration node lifecycle using the Gmail `send_email` action — from integration selection to execution — to illustrate the modal picker, dynamic UI, config persistence, and runtime execution.

### Scenario

A workflow processes a support ticket and sends a summary email to the customer via Gmail. The workflow has three upstream nodes:

1. **start** — receives `{ ticketId, customerEmail, subject }` as input variables
2. **text_to_text** (node `summarize`) — LLM summarizes the ticket; output: `{ summary: string }`
3. **integration** (node `send_email_1`) — sends the email via Gmail

### Step 1: User Opens the Integration Picker Modal

The user drops an Integration node on the canvas and clicks it. The config panel shows a prominent **"Select Integration"** button. Clicking it opens the Integration Picker Modal.

The modal fetches the connector catalog:

```
GET /api/projects/proj_abc/connectors
```

**Screen 1 — Integration Tile Grid:**

```
┌──────────────────────────────────────────────────────────┐
│  Select Integration                              [✕]     │
│  ┌──────────────────────────────────────────────────┐    │
│  │  🔍 Search integrations...                       │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  📧 Gmail   │  │  💬 Slack   │  │  🐙 GitHub  │      │
│  │  7 actions  │  │  12 actions │  │  8 actions  │      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  📋 Jira    │  │  📊 Sheets  │  │  📁 Drive   │      │
│  │  5 actions  │  │  6 actions  │  │  4 actions  │      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  🤖 OpenAI  │  │  📦 Airtable│  │  💳 Stripe  │      │
│  │  3 actions  │  │  5 actions  │  │  4 actions  │      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
│  ... (25 integrations total)                             │
└──────────────────────────────────────────────────────────┘
```

Each tile shows the integration name and the number of available actions. The user clicks **"Gmail"**.

### Step 2: User Selects an Action

The modal transitions to the **actions list** screen. The header shows "Gmail" with a back arrow. Actions are fetched:

```
GET /api/projects/proj_abc/connectors/gmail/actions
```

**Screen 2 — Actions List:**

```
┌──────────────────────────────────────────────────────────┐
│  ← Gmail                                        [✕]     │
│  ┌──────────────────────────────────────────────────┐    │
│  │  🔍 Search actions...                            │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  ✉️  Send Email                                   │    │
│  │  Send an email through a Gmail account           │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  🔄 Reply to Email                               │    │
│  │  Reply to an existing email.                     │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  📝 Create Draft Reply                           │    │
│  │  Creates a draft reply to an existing email.     │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  📥 Get Email                                    │    │
│  │  Get an email via Id.                            │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  🔍 Find Email                                   │    │
│  │  Find emails using advanced search criteria.     │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  ✅ Request Approval in Email                    │    │
│  │  Send approval request email and wait for reply  │    │
│  ├──────────────────────────────────────────────────┤    │
│  │  🔧 Custom API Call                              │    │
│  │  Make a custom API call to a specific endpoint   │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

The user clicks **"Send Email"**. The modal closes. The config panel now shows:

```
┌──────────────────────────────────────────────────┐
│  Gmail → Send Email                   [Change]   │
└──────────────────────────────────────────────────┘
```

Clicking **"Change"** re-opens the modal to select a different integration or action.

### Step 3: User Selects a Connection

The connection dropdown appears, filtered to Gmail connections only:

```
GET /api/projects/proj_abc/connections?connectorName=gmail
```

```
┌──────────────────────────────────────────────────┐
│  Connection  [▼                                ] │
│  ┌──────────────────────────────────────────────┐│
│  │  ● Support Team Gmail       (tenant-scoped) ││
│  │  ● Marketing Gmail          (tenant-scoped) ││
│  ├──────────────────────────────────────────────┤│
│  │  + Create new connection                     ││
│  └──────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

- Selecting a connection stores `connectionId: "conn_gmail_support"`.
- Clicking **"+ Create new connection"** navigates to `/projects/proj_abc/integrations` (Connector Catalog page) where the user can create a Gmail connection via OAuth. When they return, the dropdown refreshes.

The user selects **"Support Team Gmail"**.

### Step 4: Dynamic UI Renders Action Inputs

Based on the `send_email` action's `ConnectorProperty[]` (returned in Step 2), the config panel dynamically generates input fields. Most fields are `type: "string"` (inline expression support, no toggle). The CC and BCC fields are `type: "array"` and render as **chip inputs**:

```
┌──────────────────────────────────────────────────┐
│  Gmail → Send Email                    [Change]  │
├──────────────────────────────────────────────────┤
│  Connection  [▼ Support Team Gmail             ] │
├──────────────────────────────────────────────────┤
│  ACTION INPUTS (auto-generated from action props)│
│  ┌──────────────────────────────────────────────┐│
│  │ Receiver Email (To) *                     {⋮}││
│  │ [{{trigger.payload.customerEmail}}          ]││
│  │                                              ││
│  │ Subject *                                 {⋮}││
│  │ [Re: {{trigger.payload.subject}}            ]││
│  │                                              ││
│  │ Body (Text)                               {⋮}││
│  │ ┌──────────────────────────────────────────┐ ││
│  │ │ {{steps.summarize.output.summary}}       │ ││
│  │ │                                          │ ││
│  │ └──────────────────────────────────────────┘ ││
│  │                                              ││
│  │ Body (HTML)                               {⋮}││
│  │ ┌──────────────────────────────────────────┐ ││
│  │ │                                          │ ││
│  │ │                                          │ ││
│  │ └──────────────────────────────────────────┘ ││
│  │                                              ││
│  │ Reply-To Email                            {⋮}││
│  │ [support@acme.com                           ]││
│  │                                              ││
│  │ CC                                        {⋮}││
│  │ ┌──────────────────────────────────────────┐ ││
│  │ │ [a@gmail.com ✕] [b@gmail.com ✕]         │ ││
│  │ │ [type email + Enter...]                  │ ││
│  │ └──────────────────────────────────────────┘ ││
│  │                                              ││
│  │ BCC                                       {⋮}││
│  │ ┌──────────────────────────────────────────┐ ││
│  │ │ [type email + Enter...]                  │ ││
│  │ └──────────────────────────────────────────┘ ││
│  └──────────────────────────────────────────────┘│
├──────────────────────────────────────────────────┤
│  ADVANCED                                        │
│  Timeout (seconds)  [60                        ] │
└──────────────────────────────────────────────────┘
```

**Key behaviors illustrated:**

- **String fields** (`receiver`, `subject`, `body_text`, `body_html`, `reply_to`) — inline expression support. Users type `{{expression}}` directly alongside static text. No toggle needed.
- **`receiver`** — the user clicked `{⋮}` (ContextExplorer button), navigated to `Trigger → payload → customerEmail`, and the expression was inserted.
- **`subject`** — the user typed `Re: ` then `{{` — the ContextExplorer auto-opened as an inline popover. They selected `trigger.payload.subject` and the expression was completed as `Re: {{trigger.payload.subject}}`. This autocomplete-on-`{{` behavior works in all string fields.
- **`body_text`** — rendered as a Textarea (multi-line hint from description), references the upstream `summarize` node's output.
- **`reply_to`** — plain static value `support@acme.com`. No expressions, no toggle — just a regular string.
- **Array fields** (`cc`, `bcc`) — rendered as **chip inputs**. The user types `a@gmail.com` and presses Enter → a chip appears. Type `b@gmail.com` Enter → second chip. Each chip has a `✕` to remove. The `{⋮}` toggle switches to expression mode where the user can type `{{steps.lookup.output.ccList}}` to resolve a dynamic array.
- Required fields (`*`) show validation errors if left blank.
- The `{⋮}` button on string fields opens the **ContextExplorer** popover. On array fields, `{⋮}` toggles between chip input and expression text input.

### Non-String Field Example (Jira "Create Issue")

To illustrate how non-string fields work with the expression toggle, consider a Jira `create_issue` action with a `dropdown` field for priority:

```
┌──────────────────────────────────────────────────┐
│  Priority                      [{⋮}]  static    │
│  [▼ Medium                                     ] │
│  Options: Low | Medium | High | Critical         │
├──────────────────────────────────────────────────┤
│  Priority                      [{⋮}]  expression │
│  [{{steps.classify.output.priority}}           ] │
│  ↳ toggled to expression mode via {⋮} button     │
└──────────────────────────────────────────────────┘
```

For `boolean` fields (e.g., "Mark as urgent"):

```
┌──────────────────────────────────────────────────┐
│  Mark as Urgent                [{⋮}]  static     │
│  [ ○━━ ON ]                                      │
├──────────────────────────────────────────────────┤
│  Mark as Urgent                [{⋮}]  expression  │
│  [{{steps.triage.output.isUrgent}}             ] │
└──────────────────────────────────────────────────┘
```

For `number` fields (e.g., "Story Points"):

```
┌──────────────────────────────────────────────────┐
│  Story Points                  [{⋮}]  static     │
│  [ 5  [-][+] ]                                   │
├──────────────────────────────────────────────────┤
│  Story Points                  [{⋮}]  expression  │
│  [{{steps.estimate.output.points}}             ] │
└──────────────────────────────────────────────────┘
```

### Step 5: Persisted Config

When the user saves the workflow, the integration node's config is stored in MongoDB:

```json
{
  "id": "node_send_email_1",
  "nodeType": "integration",
  "name": "Send Email",
  "position": { "x": 650, "y": 200 },
  "config": {
    "connectorId": "gmail",
    "actionName": "send_email",
    "connectionId": "conn_gmail_support",
    "params": {
      "receiver": "{{trigger.payload.customerEmail}}",
      "subject": "Re: {{trigger.payload.subject}}",
      "body_text": "{{steps.summarize.output.summary}}",
      "body_html": "",
      "reply_to": "support@acme.com",
      "cc": "[\"a@gmail.com\",\"b@gmail.com\"]",
      "bcc": "[]"
    },
    "paramModes": {},
    "timeout": 60
  }
}
```

**Note:** `paramModes` is empty because all Gmail `send_email` fields are strings — they don't need a mode tracker. For a Jira example with a dropdown toggled to expression, it would be: `"paramModes": { "priority": "expression" }`.

### Step 6: Canvas-to-Steps Conversion

At execution time, `canvas-to-steps.ts` converts this node to a `connector_action` step:

```typescript
{
  id: 'node_send_email_1',
  type: 'connector_action',
  connector: 'gmail',                                // from config.connectorId
  action: 'send_email',                              // from config.actionName
  params: {
    receiver: '{{trigger.payload.customerEmail}}',       // string with expression
    subject: 'Re: {{trigger.payload.subject}}',          // string with mixed content
    body_text: '{{steps.summarize.output.summary}}',     // string with expression
    body_html: '',                                        // plain empty string
    reply_to: 'support@acme.com',                        // plain static string
    cc: '["a@gmail.com","b@gmail.com"]',                 // array as JSON string
    bcc: '[]',                                            // empty array
  },
  connectionId: 'conn_gmail_support',
  timeout: 60,     // passed as-is from config (seconds); NOTE: DEFAULT_STEP_TIMEOUT_MS fallback is in ms — units mismatch (GAP-012)
}
```

**Simplification:** No flattening of `{ mode, value }` needed — params are already plain strings. The converter just passes them through.

### Step 7: Execution (Expression Resolution + Connector Call)

The `connector-action-executor.ts` processes this step:

1. **Expression resolution** — `resolveExpressionTyped()` replaces `{{expressions}}` with real values from the workflow context:
   ```
   receiver:  "{{trigger.payload.customerEmail}}" → "jane@customer.com"
   subject:   "Re: {{trigger.payload.subject}}"   → "Re: Login page broken"
   body_text: "{{steps.summarize.output.summary}}" → "We've identified the login issue..."
   reply_to:  "support@acme.com"                   → "support@acme.com" (no expressions, unchanged)
   cc:        '["a@gmail.com","b@gmail.com"]'      → ["a@gmail.com", "b@gmail.com"] (JSON-parsed to array)
   bcc:       '[]'                                  → [] (empty array)
   ```
2. **Connection credential resolution** — `ConnectionResolver` looks up `conn_gmail_support`, finds its linked auth profile, and retrieves the OAuth2 access token (refreshing if needed).
3. **Action execution** — `ConnectorToolExecutor.execute('gmail.send_email', resolvedParams, 60000, 'conn_gmail_support')` calls the Activepieces Gmail piece's `send_email.run()` with the resolved params and auth context.
4. **Result** — The step returns the Gmail API response (message ID, thread ID, etc.) as `steps.send_email_1.output`, available to downstream nodes.

### Step 8: Error Handling

If the Gmail API returns an error (e.g., invalid recipient, quota exceeded):

- The step fails and the error is captured in the execution trace.
- If `on_failure` handle is connected, the workflow routes to the error-handling branch.
- If no `on_failure` handle, the workflow terminates with the error.
- The error details are available at `steps.send_email_1.error` for downstream condition nodes to inspect.

### Dynamic UI Generation Rules (Summary)

| `ConnectorPropertyType` | UI Control                                               | Expression Support                                                          | Gmail `send_email` Example               |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `string`                | `<Input>` or `<Textarea>`                                | **Inline** — type `{{expr}}` directly + `{⋮}` ContextExplorer button        | `receiver`, `subject`, `body_text`, etc. |
| `number`                | `<NumberInput>`                                          | **Toggle** via `{⋮}` — switches to expression text input                    | (e.g., Jira Story Points)                |
| `boolean`               | `<Toggle>` switch                                        | **Toggle** via `{⋮}` — switches to expression text input                    | (e.g., Mark as Urgent)                   |
| `dropdown`              | `<Select>`                                               | **Toggle** via `{⋮}` — switches to expression text input                    | (e.g., Jira Priority)                    |
| `array`                 | **Chip input** — type + Enter to add tags, `✕` to remove | **Toggle** via `{⋮}` — switches to expression text input for dynamic arrays | `cc`, `bcc` (email addresses)            |
| `dynamic_dropdown`      | `<Input>` (text fallback, v1)                            | **Inline** — same as string                                                 | (e.g., GitHub repo picker)               |
| `json`                  | `<Textarea>` with JSON mode                              | **Inline** — expressions within JSON values + `{⋮}`                         | (e.g., custom payload)                   |
| `date`                  | `<DateInput>`                                            | **Toggle** via `{⋮}` — switches to expression text input                    | (e.g., task deadline)                    |
| `file`                  | `<Input>`                                                | **Inline** — same as string                                                 | (e.g., attachment URL)                   |
| `oauth`                 | Read-only                                                | None                                                                        | (handled by connection)                  |

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                  |
| -------------------------- | ------------ | ------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Connections are project-scoped                         |
| Agent lifecycle            | NONE         |                                                        |
| Customer experience        | PRIMARY      | Enables no-code third-party integrations in workflows  |
| Integrations / channels    | PRIMARY      | Core integration surface                               |
| Observability / tracing    | SECONDARY    | Execution traced via existing connector executor spans |
| Governance / controls      | SECONDARY    | Auth scoped through connections                        |
| Enterprise / compliance    | NONE         |                                                        |
| Admin / operator workflows | NONE         |                                                        |

### Related Feature Integration Matrix

| Related Feature                                     | Relationship Type | Why It Matters                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Key Touchpoints                                                        | Current State |
| --------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------- |
| Connections (part of [Connectors](./connectors.md)) | depends on        | Integration node selects a connection for auth credentials                                                                                                                                                                                                                                                                                                                                                                                                                                  | `GET /api/projects/:id/connections`, `ConnectionRecord`                | STABLE        |
| [Connector Framework](./connectors.md)              | depends on        | Actions, properties, and execution come from `ConnectorRegistry`                                                                                                                                                                                                                                                                                                                                                                                                                            | `ConnectorAction`, `ConnectorToolExecutor`                             | STABLE        |
| [Workflows](./workflows.md)                         | extends           | Adds a new functional node type to the workflow canvas                                                                                                                                                                                                                                                                                                                                                                                                                                      | `STUB_NODE_TYPES`, `IntegrationNodeConfigSchema`, `canvas-to-steps.ts` | ALPHA         |
| [Auth Profiles](./auth-profiles.md)                 | shares data with  | Connections bind to auth profiles for credential resolution. **FR-10 contract (ABLP-619)**: binding an integration node to an OAuth auth profile MUST NOT trigger `/auth-profiles/oauth/initiate` at bind or run time — re-consent only happens through the explicit Authorize UX. Regression locked in by `apps/studio/e2e/auth-profiles/integration-bind-no-consent.e2e.ts` (static-import scan over `IntegrationNodeConfig.tsx` + runtime API replay with zero-initiate-call assertion). | `ConnectionResolver`, `IntegrationNodeConfig.tsx`                      | STABLE        |

---

## 6. Design Considerations

### Config Panel Layout

The integration node config panel has three progressive sections:

1. **Integration + Action** — a summary row showing the selection (e.g., "Gmail → Send Email") with a "Change" button. Initially shows a "Select Integration" CTA button.
2. **Connection** — a dropdown filtered to the selected integration, with "+ Create new connection" at the bottom.
3. **Action Inputs** — dynamic form generated from the action's `ConnectorProperty[]`.

```
┌──────────────────────────────────────────────────┐
│  Gmail → Send Email                    [Change]  │
├──────────────────────────────────────────────────┤
│  Connection  [▼ Support Team Gmail             ] │
├──────────────────────────────────────────────────┤
│  ACTION INPUTS                                   │
│  ┌──────────────────────────────────────────────┐│
│  │ Receiver Email (To) *                     {⋮}││
│  │ [{{trigger.payload.customerEmail}}          ]││
│  │                                              ││
│  │ Subject *                                 {⋮}││
│  │ [Re: {{trigger.payload.subject}}            ]││
│  │                                              ││
│  │ Body (Text)                               {⋮}││
│  │ ┌──────────────────────────────────────────┐ ││
│  │ │ {{steps.summarize.output.summary}}       │ ││
│  │ └──────────────────────────────────────────┘ ││
│  │                                              ││
│  │ Reply-To Email                            {⋮}││
│  │ [support@acme.com                           ]││
│  └──────────────────────────────────────────────┘│
├──────────────────────────────────────────────────┤
│  ADVANCED                                        │
│  Timeout (seconds)  [60                        ] │
└──────────────────────────────────────────────────┘
```

### Integration Picker Modal

The modal is a two-screen dialog:

**Screen 1 — Integration Tile Grid:**

- Search bar at the top to filter by name.
- Tile grid layout — each tile shows: integration icon/name + action count badge.
- Tiles are populated from `GET /api/projects/:projectId/connectors` (the connector catalog).
- Clicking a tile transitions to Screen 2.

**Screen 2 — Action List:**

- Header: integration name with a back arrow (returns to Screen 1).
- Search bar to filter actions.
- List of actions, each showing `displayName` and `description`.
- Clicking an action closes the modal and fills `connectorId` + `actionName` in the node config.

**Re-selection:** Clicking "Change" in the config panel re-opens the modal. If an integration was previously selected, the modal opens on Screen 2 (the actions list for that integration) so the user can quickly switch actions. The back arrow returns to Screen 1 to switch integrations entirely.

### Expression Input Strategy

Unlike a universal static/dynamic toggle, the expression support is **type-aware**:

- **String-like fields** (`string`, `dynamic_dropdown`, `file`, `json`): The text input natively accepts `{{expression}}` mixed with static text. Two ways to insert expressions:
  1. **`{⋮}` button** at the field's right edge — opens ContextExplorer popover. Selecting an expression inserts it at the cursor position.
  2. **`{{` auto-trigger** — typing `{{` automatically opens the ContextExplorer as an inline autocomplete popover anchored near the cursor. Selecting completes the expression. Escape dismisses and lets the user type manually.

  No mode toggle needed — the expression resolver handles both static strings and embedded expressions uniformly.

- **Non-string fields** (`number`, `boolean`, `dropdown`, `date`): These have a native control (number stepper, toggle switch, select dropdown, date picker) that cannot accept expression text. A small `{⋮}` toggle icon in the field's label row switches between the native control and a text input that accepts `{{expression}}`. The mode is persisted in `paramModes[fieldName]` so the form renders correctly when re-opened.

### Connection Picker

- Dropdown shows only connections matching `connectorName === config.connectorId`.
- Last item in the dropdown: **"+ Create new connection"** — navigates to the Connector Catalog page (`/projects/:projectId/integrations`). When the user returns (browser back or tab), the connection list refreshes on focus.
- Status indicator: active connections show a green dot, expired/revoked show a warning icon.

### Empty & Loading States

- **No integration selected**: "Select Integration" button (full-width CTA) — no connection or input fields visible.
- **No connections for selected integration**: "No connections found for Gmail." with a "Create connection" link.
- **Loading catalog/actions**: Skeleton tiles (grid) or skeleton rows (list) inside the modal.
- **Loading connections**: Skeleton in the dropdown.

---

## 7. Technical Considerations

### New API Endpoint: Action Schemas

The connector catalog (`connector-catalog.json`) only stores `name`, `displayName`, and `description` for actions — it does not include `props` (the input schema). The full `ConnectorProperty[]` lives on the runtime `ConnectorAction` objects in the `ConnectorRegistry`.

**Decision**: Add a new Studio API route that proxies to the workflow-engine (which has the registry loaded):

```
GET /api/projects/:projectId/connectors/:connectorName/actions
```

Response:

```json
{
  "success": true,
  "data": [
    {
      "name": "github_create_issue",
      "displayName": "Create Issue",
      "description": "Creates a new issue in a GitHub repository",
      "props": [
        {
          "name": "owner",
          "displayName": "Repository Owner",
          "type": "string",
          "required": true
        },
        {
          "name": "repo",
          "displayName": "Repository Name",
          "type": "string",
          "required": true
        },
        {
          "name": "title",
          "displayName": "Issue Title",
          "type": "string",
          "required": true
        },
        {
          "name": "body",
          "displayName": "Issue Body",
          "type": "string",
          "required": false
        },
        {
          "name": "labels",
          "displayName": "Labels",
          "type": "dropdown",
          "required": false,
          "options": []
        }
      ]
    }
  ]
}
```

**Alternative considered**: Enrich the static `connector-catalog.json` with full props at build time. Rejected because `props` can contain runtime-only logic (e.g., `dynamic_dropdown` refreshers) and the catalog is meant to be lightweight.

### Config Schema Update

The current `IntegrationNodeConfigSchema` is minimal. It must be updated to:

```typescript
export const IntegrationNodeConfigSchema = z.object({
  connectorId: z.string().min(1).optional(),
  actionName: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  params: z.record(z.string(), z.string()).default({}),
  paramModes: z.record(z.string(), z.enum(['static', 'expression'])).default({}),
  timeout: z.number().int().min(5).max(300).default(60),
});
```

**Key design decisions:**

- `params` is `Record<string, string>` — all values are plain strings, whether they contain `{{expressions}}` or not. The expression resolver handles both uniformly.
- `paramModes` is a separate record that only tracks non-string fields toggled to expression mode. String fields don't appear here (they always accept expressions inline). This keeps the params shape simple and directly compatible with the existing executor.

### Canvas-to-Steps Conversion

The existing `canvas-to-steps.ts` reads `config.params` as `Record<string, string>`. Since the new config also stores params as plain strings, the conversion is straightforward — **no flattening needed**:

```typescript
case 'connector_action':
  return {
    id: node.id,
    type: 'connector_action',
    connector: (config.connectorId as string) || (config.connector as string) || '',
    action: (config.actionName as string) || (config.action as string) || '',
    params: (config.params as Record<string, string>) || {},
    connectionId: config.connectionId as string | undefined,
    timeout: (config.timeout as number) ?? DEFAULT_STEP_TIMEOUT_MS,
  };
```

This is backward-compatible with the existing converter code. The `paramModes` field is UI-only metadata and is not passed to the executor.

### New `array` Type in ConnectorPropertyType

The current `ConnectorPropertyType` union does not include `array` — Activepieces `ARRAY` maps to `json`. This spec adds `array` as a first-class type:

1. Add `'array'` to the `ConnectorPropertyType` union in `packages/connectors/src/types.ts`.
2. Update `mapPropertyType()` in `packages/connectors/src/adapters/activepieces/type-mapper.ts` to map `ARRAY` → `'array'` (instead of `'json'`). `OBJECT` and `JSON` still map to `'json'`.
3. The chip input stores values as a JSON array string (e.g., `'["a@gmail.com","b@gmail.com"]'`).
4. The executor must JSON-parse array param values before passing to the connector action's `run()`. Add a parse step in `connector-action-executor.ts` that detects JSON array strings and parses them.

### Parameter Coercion (`coerceParams`)

Workflow params are stored as `Record<string, string>` but Activepieces pieces expect typed values (e.g., arrays for receiver/cc/bcc fields). The `coerceParams()` function in `context-translator.ts` bridges this gap at execution time:

- JSON arrays (`'["a@gmail.com"]'`) → parsed to `string[]`
- JSON objects (`'{"key":"val"}'`) → parsed to object
- Boolean strings (`'true'`, `'false'`) → parsed to boolean
- Numeric strings → parsed to number
- All others → kept as string

This replaces the approach of requiring the executor to detect and parse array params separately. The coercion happens transparently in `translateActionContext()`.

### OAuth Grant Resolution

For OAuth2 connectors (Gmail, Slack, etc.), the auth profile contains only app credentials (`clientId`/`clientSecret`), not the user's access token. The implementation adds an `OAuthGrantResolver` that:

1. Looks up `EndUserOAuthToken` records matching the auth profile's provider key (`auth-profile:<authProfileId>`)
2. Checks candidates in order: user-specific grant → tenant-shared grant (`__tenant__`)
3. Proactively refreshes expired tokens (5-minute buffer) using the app profile's client credentials
4. Persists refreshed tokens back via raw MongoDB `collection.updateOne()` (bypasses Mongoose encryption plugin)
5. Returns `{ access_token, refresh_token? }` for the connector action

**Current implementation**: The resolver is defined inline in `apps/workflow-engine/src/index.ts` (~140 lines). This is functional but should be extracted to a dedicated module for testability (see GAP-005).

The `ConnectionResolver.resolveAuth()` method now checks: if the profile has `clientId`/`clientSecret` but no `access_token`, it delegates to the `OAuthGrantResolver` before returning.

### Expression Resolution

The existing `connector-action-executor.ts` already calls `resolveExpressionTyped(value, ctx)` on every param value. Expressions like `{{steps.node_1.output.title}}` are resolved at runtime. No changes needed in the executor for string/expression handling. Array/object params are coerced by `coerceParams()` in the context translator (see above).

### No New Database Changes

The workflow model stores node config as `Schema.Types.Mixed` (free-form JSON). The updated config shape is persisted without schema changes.

---

## 8. How to Consume

### Studio UI

1. Open a workflow in the canvas editor.
2. Drag an **Integration** node from the Assets Sidebar (Actions category) onto the canvas.
3. Click the node to open the config panel.
4. **Select Integration + Action**: Click "Select Integration" → browse tile grid → pick integration → pick action.
5. **Select Connection**: Choose from connections dropdown (filtered to selected integration). Use "+ Create new connection" if needed.
6. **Configure Inputs**: Fill in action fields. For string fields, type `{{expressions}}` directly or use the `{⋮}` button to browse context. For non-string fields, use the `{⋮}` toggle to switch to expression mode.
7. **Set Timeout**: Optionally adjust the timeout in the Advanced section.
8. Connect the node's `on_success` / `on_failure` handles to downstream nodes.

### API (Studio)

| Method | Path                                                         | Purpose                                           |
| ------ | ------------------------------------------------------------ | ------------------------------------------------- |
| GET    | `/api/projects/:projectId/connections`                       | List connections for connection picker            |
| GET    | `/api/projects/:projectId/connectors/:connectorName/actions` | Get action list with props schema for a connector |

### API (Runtime / Workflow Engine)

No new runtime API endpoints. The workflow engine executes integration nodes via the existing `connector_action` step handler.

### Admin Portal

No admin-specific UI. Connections and connectors are managed at the project level.

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable. The integration node is a workflow canvas construct only.

---

## 9. Data Model

### Node Config Shape (persisted in `workflows.nodes[].config`)

```text
Fields:
  - connectorId: string (required) — connector name (e.g., 'gmail', 'github')
  - actionName: string (required) — action name (e.g., 'send_email', 'github_create_issue')
  - connectionId: string (required) — ID of the selected ConnectionRecord
  - params: Record<string, string> — action input values (plain strings, may contain {{expressions}})
  - paramModes: Record<string, 'static' | 'expression'> — UI toggle state for non-string fields only
  - timeout: number (default 60) — execution timeout in seconds
```

### Key Relationships

- `connectionId` → `ConnectionRecord._id` (in `connections` collection)
- `connectorId` → `Connector.name` (in `ConnectorRegistry`)
- `actionName` → `ConnectorAction.name` (in `ConnectorRegistry`)
- Connection → Auth Profile → Credentials (resolved at execution time by `ConnectionResolver`)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/shared-kernel/src/types/workflow-types.ts`                  | Removed `integration` from `STUB_NODE_TYPES`                                                              |
| `packages/shared/src/types/workflow-schemas.ts`                       | Updated `IntegrationNodeConfigSchema` (connectorId, actionName, params, paramModes, timeout)              |
| `packages/connectors/src/types.ts`                                    | Added `'array'` to `ConnectorPropertyType` union                                                          |
| `packages/connectors/src/adapters/activepieces/type-mapper.ts`        | Changed ARRAY mapping from `'json'` to `'array'`                                                          |
| `packages/connectors/src/adapters/activepieces/context-translator.ts` | Added `coerceParams()` — parses JSON-encoded arrays/objects/numbers/booleans in workflow params           |
| `packages/connectors/src/auth/connection-resolver.ts`                 | Added `OAuthGrantResolver` interface; `resolveAuth()` now resolves OAuth grants for `oauth2_app` profiles |
| `packages/connectors/src/auth/index.ts`                               | Re-exports `OAuthGrantResolver` type                                                                      |
| `packages/connectors/src/index.ts`                                    | Re-exports `OAuthGrantResolver` type from barrel                                                          |

### Routes / Handlers

| File                                                                                | Purpose                                                                                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/routes/connectors.ts`                                     | Added `GET /:connectorName/actions` endpoint for action schemas with props                                      |
| `apps/workflow-engine/src/index.ts`                                                 | Added inline OAuth grant resolver (~140 lines): token lookup, refresh, persist; wired into `ConnectionResolver` |
| `apps/studio/src/app/api/projects/[id]/connectors/route.ts`                         | **New** — Serves static `connector-catalog.json` with project auth                                              |
| `apps/studio/src/app/api/projects/[id]/connectors/[connectorName]/actions/route.ts` | **New** — Studio proxy route to workflow-engine for action schemas                                              |

### UI Components

| File                                                                            | Purpose                                                                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/workflows/canvas/config/IntegrationNodeConfig.tsx`  | **New** — Config panel orchestrator: integration summary, connection picker, dynamic form                                               |
| `apps/studio/src/components/workflows/canvas/config/IntegrationPickerModal.tsx` | **New** — Two-screen modal: integration tile grid → action list                                                                         |
| `apps/studio/src/components/workflows/canvas/config/DynamicActionForm.tsx`      | **New** — Renders dynamic form from `ConnectorProperty[]`, with inline expression + toggle support; includes ChipInput for array fields |
| `apps/studio/src/components/workflows/canvas/config/ExpressionInput.tsx`        | **New** — Reusable string input with `{⋮}` ContextExplorer button and `{{` auto-trigger                                                 |
| `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`      | Updated to import `IntegrationNodeConfig`; passes `nodeId` prop                                                                         |
| `apps/studio/src/components/workflows/canvas/panels/ConfigPanel.tsx`            | No changes needed (already routes `integration` through GenericNodeConfig)                                                              |

### Tests

| File                                                              | Type | Coverage Focus                                                                             |
| ----------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `packages/connectors/src/__tests__/activepieces-importer.test.ts` | unit | Updated ARRAY→array mapping assertion                                                      |
| `apps/studio/e2e/workflows/workflow-integration-node.spec.ts`     | e2e  | API catalog/actions/connections checks, full UI config flow, empty state, modal navigation |

---

## 11. Configuration

### Environment Variables

No new environment variables required.

### Runtime Configuration

No feature flags. The integration node is always available when the workflow feature is enabled.

### DSL / Agent IR / Schema

The integration node config is validated at save time by `IntegrationNodeConfigSchema` and converted at execution time by `canvas-to-steps.ts`. The `connector_action` step type in the engine DSL already supports the required fields.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Connections are project-scoped. The connection picker only shows connections for the current `projectId`. The action schema endpoint validates `projectId`. |
| Tenant isolation  | All connection queries include `tenantId`. Cross-tenant connections are never visible.                                                                      |
| User isolation    | User-scoped connections (`scope: 'user'`) are filtered by `userId`. Tenant-scoped connections are visible to all project members.                           |

### Security & Compliance

- Credentials are never exposed to the UI. The config stores `connectionId`, and credentials are resolved server-side at execution time by `ConnectionResolver`.
- Expression values in `params` are resolved server-side by `resolveExpressionTyped` — no client-side credential injection is possible.
- The action schema endpoint returns property definitions only, never credential or auth data.

### Performance & Scalability

- The connector catalog is loaded once in memory. Action schema lookups are O(1) registry lookups.
- Connection list is fetched once when the config panel opens, cached in component state.
- Action list is fetched when the connection changes, cached per connector name in component state.

### Reliability & Failure Modes

- If the connection is deleted after the workflow is saved, execution fails with a clear error: "Connection not found: {connectionId}". The workflow `on_failure` handle routes to the error path.
- If the connector is unregistered, execution fails with: "Connector not found: {connectorId}".
- Timeout is enforced by the existing `ConnectorToolExecutor` timeout mechanism.

### Observability

- Execution is traced via the existing OpenTelemetry spans in `ConnectorToolExecutor.execute()`.
- Step results (success/failure, duration, error message) are captured in workflow execution traces.
- No additional trace events needed — the connector executor already instruments well.

### Data Lifecycle

- Node config is stored as part of the workflow document. No separate collection.
- No TTLs or retention concerns beyond the workflow itself.

---

## 13. Delivery Plan / Work Breakdown

1. **Backend: Action Schema Endpoint**
   1.1 Add `getActionsWithProps(connectorName)` method to `ConnectorRegistry`
   1.2 Create `GET /connectors/:connectorName/actions` route in workflow-engine
   1.3 Create Studio proxy route `apps/studio/src/app/api/projects/[id]/connectors/[connectorName]/actions/route.ts`
   1.4 Write integration tests for the endpoint

2. **Schema Updates**
   2.1 Update `IntegrationNodeConfigSchema` in `packages/shared/src/types/workflow-schemas.ts` (new shape: `params` as `Record<string, string>`, add `paramModes`)
   2.2 Remove `integration` from `STUB_NODE_TYPES` in `packages/shared-kernel/src/types/workflow-types.ts`
   2.3 Verify `canvas-to-steps.ts` works with new config shape (params already `Record<string, string>`)
   2.4 Write unit tests for the canvas-to-steps conversion

3. **UI: Integration Picker Modal**
   3.1 Create `IntegrationPickerModal.tsx` — two-screen dialog
   3.2 Screen 1: tile grid from connector catalog, search bar, action count badges
   3.3 Screen 2: action list with name + description, back arrow, search
   3.4 Modal state management: open/close, selected integration, transition animation

4. **UI: ExpressionInput Component**
   4.1 Create `ExpressionInput.tsx` — text input with `{⋮}` ContextExplorer button
   4.2 ContextExplorer opens as popover, inserts expression at cursor position
   4.3 Supports both `<Input>` (single-line) and `<Textarea>` (multi-line) variants

5. **UI: DynamicActionForm Component**
   5.1 Create `DynamicActionForm.tsx` — renders form from `ConnectorProperty[]`
   5.2 String fields: use `ExpressionInput` (inline expression support, no toggle)
   5.3 Non-string fields: native control + `{⋮}` toggle to switch to expression text input
   5.4 Support all `ConnectorPropertyType` mappings (string, number, boolean, dropdown, array, json, date, file, dynamic_dropdown)
   5.5 Validation: required field indicators, empty value warnings

6. **UI: IntegrationNodeConfig Component**
   6.1 Create `IntegrationNodeConfig.tsx` — orchestrates modal, connection picker, dynamic form
   6.2 Integration+action summary row with "Change" button
   6.3 Connection picker: fetch from `/api/projects/:id/connections?connectorName=X`, filtered dropdown with "+ Create new connection" option
   6.4 Progressive reveal: connection picker appears after integration selection, form appears after connection selection
   6.5 Wire into `GenericNodeConfig.tsx` switch case

7. **E2E & Integration Tests**
   7.1 E2E: Drop integration node, open modal, select integration + action, verify config panel
   7.2 E2E: Select connection, fill dynamic form, save workflow
   7.3 E2E: Execute workflow with integration node, verify connector action runs
   7.4 Integration: Action schema endpoint returns correct props
   7.5 Unit: DynamicActionForm renders correct control per property type
   7.6 Unit: ExpressionInput inserts expressions at cursor position
   7.7 Unit: IntegrationPickerModal transitions between screens correctly

---

## 14. Success Metrics

| Metric                                                        | Baseline | Target                  | How Measured                      |
| ------------------------------------------------------------- | -------- | ----------------------- | --------------------------------- |
| Integration node usage (workflows with >= 1 integration node) | 0 (stub) | 20% of active workflows | Query workflow documents          |
| Config completion rate (all required fields filled)           | N/A      | > 90%                   | Validation pass rate at save time |
| Execution success rate for integration steps                  | N/A      | > 95%                   | Workflow execution traces         |
| Time to configure an integration node                         | N/A      | < 60 seconds            | UX observation / session replay   |

---

## 15. Open Questions

1. **Dynamic dropdown resolution**: The `refreshers` mechanism on `ConnectorProperty` enables dependent field re-fetching (e.g., selecting a GitHub org refreshes the repo list). This requires a server round-trip per field change. Deferred to follow-up — dynamic_dropdown fields render as text inputs in v1.
2. **File upload**: The `file` property type — should it support direct file upload or only URL/path references? Decision: URL/path references only in v1.
3. **Connection creation return flow**: When the user clicks "+ Create new connection" and navigates to the Connector Catalog, how do they return to the workflow canvas with the new connection selected? Decision: the connection list refreshes on window focus. The user manually selects the new connection from the dropdown after returning. A future enhancement could use a callback URL or in-app navigation to auto-select.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                   | Severity | Status                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| GAP-001 | Dynamic dropdown props (`refreshers`) are not resolved at design time — rendered as text inputs                                                                                               | Medium   | Open — planned follow-up                                     |
| GAP-002 | File property type only supports URL references, not direct upload                                                                                                                            | Low      | Open                                                         |
| GAP-003 | No connector icon/logo display in connection picker (catalog has no icon URLs)                                                                                                                | Low      | Open                                                         |
| GAP-004 | If a connector is updated (action props change), existing workflow configs may reference stale fields                                                                                         | Medium   | Open — runtime handles gracefully with expression resolution |
| GAP-005 | OAuth grant resolver is inline in `index.ts` (~140 lines) — should be extracted to a dedicated module for testability and separation of concerns                                              | High     | Open — refactor recommended before BETA                      |
| GAP-006 | Action props and connection fetch errors are silently swallowed in `IntegrationNodeConfig.tsx` — only catalog fetch shows error state                                                         | Medium   | Open — add error states for all fetch calls                  |
| GAP-007 | Old `IntegrationConfig` stub function remains as dead code in `GenericNodeConfig.tsx` (lines 378+) — should be removed                                                                        | Low      | Open                                                         |
| GAP-008 | `(connection as any).userId` cast in `connection-resolver.ts:128` — `IConnectorConnection` should include `userId` field                                                                      | Low      | Open                                                         |
| GAP-009 | No unit tests for `coerceParams()` pure function in context-translator — high-value test target                                                                                               | Medium   | Open                                                         |
| GAP-010 | Connector catalog route imports from `packages/connectors/src/generated/` (source path) rather than package exports                                                                           | Low      | Open — works but fragile in production builds                |
| GAP-011 | No timeout/AbortController on catalog and connection fetch calls in `IntegrationNodeConfig.tsx`                                                                                               | Low      | Open                                                         |
| GAP-012 | Timeout units mismatch: config stores seconds (5-300), `DEFAULT_STEP_TIMEOUT_MS` fallback is milliseconds (30000). `canvas-to-steps.ts` passes raw value — executor may interpret incorrectly | Medium   | Open — verify executor expectation and align units           |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                | Coverage Type | Status     | Test File / Note                                                                       |
| --- | ------------------------------------------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------- |
| 1   | Connector catalog API returns connectors with actions   | e2e           | PASS       | `workflow-integration-node.spec.ts` — "Gmail connector is in the catalog with actions" |
| 2   | Action schemas API returns props for a connector        | e2e           | PASS       | `workflow-integration-node.spec.ts` — "Gmail action schemas include props"             |
| 3   | Connection picker shows project connections             | e2e           | PASS       | `workflow-integration-node.spec.ts` — "Project has an active Gmail connection"         |
| 4   | Full UI flow: add node, select integration, configure   | e2e           | PASS       | `workflow-integration-node.spec.ts` — "Add Integration node, select Gmail action..."   |
| 5   | Empty state shows "Select Integration" button           | e2e           | PASS       | `workflow-integration-node.spec.ts` — "Integration node shows Select Integration..."   |
| 6   | Picker modal search and back navigation                 | e2e           | PASS       | `workflow-integration-node.spec.ts` — "IntegrationPickerModal search and navigation"   |
| 7   | ARRAY type maps to 'array' (not 'json')                 | unit          | PASS       | `activepieces-importer.test.ts` — "maps ARRAY -> array"                                |
| 8   | Dynamic form renders correct controls per property type | unit          | NOT TESTED | Need component-level tests for DynamicActionForm                                       |
| 9   | Static/dynamic mode toggle persists correctly           | unit          | NOT TESTED | Need component-level tests for expression toggle                                       |
| 10  | Expression insertion from ContextExplorer               | e2e           | NOT TESTED | Not yet tested (requires interaction with ContextExplorer popover)                     |
| 11  | `coerceParams()` parses JSON arrays/objects/numbers     | unit          | NOT TESTED | Pure function — high-value test target (GAP-009)                                       |
| 12  | OAuth grant resolution and token refresh                | unit          | NOT TESTED | Blocked by GAP-005 (inline code not unit-testable)                                     |
| 13  | Full workflow execution with integration node           | e2e           | NOT TESTED | Requires running workflow with live connector                                          |
| 14  | Config persistence across save/reload                   | e2e           | PASS       | `workflow-integration-node.spec.ts` — saves and verifies config in Zustand store       |
| 15  | Validation: required fields missing shows error         | unit          | NOT TESTED |                                                                                        |

### Testing Notes

**Current state (ALPHA):** 8 of 15 scenarios covered. 3 Playwright `test()` blocks in `workflow-integration-node.spec.ts` cover 7 scenarios: API catalog/actions/connections (3 tests), full UI config flow with persistence (1 test covering scenarios 4+14), empty state (1 test), and modal navigation (1 test). The `activepieces-importer.test.ts` covers the ARRAY→array type mapping change (scenario 7). All 232 connector package tests pass.

**Key gaps for BETA:** Unit tests for `coerceParams()` (pure function, easy to test), component tests for `DynamicActionForm` control rendering, and extraction + testing of the OAuth grant resolver (currently inline in `index.ts`).

> Full testing details: `../testing/workflow-integration-node.md`

---

## 18. References

- Design docs: `docs/superpowers/specs/2026-03-17-workflow-koreai-replacement-design.md` (original 16-node design)
- UX spec: `docs/specs/workflow-canvas-ux-improvements.md` (Section 7 — Integration "Coming Soon")
- Connector types: `packages/connectors/src/types.ts`
- Connector registry: `packages/connectors/src/registry.ts`
- Canvas-to-steps: `apps/workflow-engine/src/handlers/canvas-to-steps.ts`
- Connector action executor: `apps/workflow-engine/src/executors/connector-action-executor.ts`
- Context Explorer: `apps/studio/src/components/workflows/steps/ContextExplorer.tsx`
- Existing stub config: `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx` (lines 377-469)

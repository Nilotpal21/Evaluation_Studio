# Workflow System — User Acceptance Tests

**Date:** 2026-03-17
**Spec Reference:** `2026-03-17-workflow-koreai-replacement-design.md`
**Status:** Draft — awaiting review

---

## UAT-1: Workflow Canvas — Basic Flow Creation

### UAT-1.1: Create a New Workflow

| Step | Action                                         | Expected Result                                                                             |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | Navigate to Workflows list page                | Workflows list page loads with "Create Workflow" button                                     |
| 2    | Click "Create Workflow"                        | Create workflow modal opens                                                                 |
| 3    | Enter name "Order Processing", add description | Fields accept input                                                                         |
| 4    | Click Create                                   | Canvas opens with Start node auto-placed, Assets panel on left, empty config panel on right |

### UAT-1.2: Add Nodes via Drag-and-Drop

| Step | Action                                                             | Expected Result                                                            |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1    | Drag "Text-to-Text" from AI section in Assets panel                | Text-to-Text node appears on canvas as "TextToText0001" with purple header |
| 2    | Drag "API" from Actions section                                    | API node appears as "API0001" with dark blue header                        |
| 3    | Drag "Condition" from Flow Control section                         | Condition node appears as "Condition0001" with brown header                |
| 4    | Drag "End" from Flow Control section                               | End node appears as "End0001" with dark gray styling                       |
| 5    | Verify all nodes show "on success" and "on failure" output handles | Output handles visible as small dots on right side of each node card       |

### UAT-1.3: Add Nodes via Quick-Add Bar

| Step | Action                                        | Expected Result                                                                                                           |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1    | Click "Function" icon in bottom quick-add bar | Function node appears on canvas at default position as "Function0001" with cyan header                                    |
| 2    | Click "Human" icon in bottom quick-add bar    | Human node appears as "Human0001" with warm gray header, shows on approval / on decline / on timeout / on failure handles |

### UAT-1.4: Connect Nodes with Edges

| Step | Action                                                  | Expected Result                                   |
| ---- | ------------------------------------------------------- | ------------------------------------------------- |
| 1    | Drag from Start node output handle to TextToText0001    | Curved gray arrow connects Start → TextToText0001 |
| 2    | Drag from TextToText0001 "on success" handle to API0001 | Success edge connects the nodes                   |
| 3    | Drag from TextToText0001 "on failure" handle to End0001 | Dashed red failure edge connects to End           |
| 4    | Drag from API0001 "on success" to Condition0001         | Success edge connects                             |
| 5    | Verify edges have arrowheads pointing at target nodes   | All edges show directional arrowheads             |

### UAT-1.5: Delete Nodes and Edges

| Step | Action                                             | Expected Result                              |
| ---- | -------------------------------------------------- | -------------------------------------------- |
| 1    | Click on the edge between Start and TextToText0001 | Edge is selected (highlighted)               |
| 2    | Press Delete key                                   | Edge is removed, nodes remain                |
| 3    | Click on Function0001 node                         | Node is selected, config panel opens         |
| 4    | Press Delete key                                   | Node and all its connected edges are removed |
| 5    | Ctrl+Z (undo)                                      | Function0001 node and edges are restored     |

### UAT-1.6: Canvas Navigation

| Step | Action                                                | Expected Result                                           |
| ---- | ----------------------------------------------------- | --------------------------------------------------------- |
| 1    | Scroll mouse wheel up on canvas                       | Canvas zooms in, zoom percentage updates in toolbar       |
| 2    | Scroll mouse wheel down                               | Canvas zooms out                                          |
| 3    | Click and drag on canvas background                   | Canvas pans                                               |
| 4    | Click zoom dropdown, select "Fit"                     | All nodes fit within visible area                         |
| 5    | Verify minimap in bottom-right corner shows all nodes | Minimap reflects current canvas state with node positions |

---

## UAT-2: Node Configuration — Config Panel

### UAT-2.1: Start Node — Input Variables

| Step | Action                                                     | Expected Result                                                    |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | Click Start node on canvas                                 | Config panel opens on right with "Start" header, Input/Output tabs |
| 2    | Click "Add input variable"                                 | New row appears with name, type, required fields                   |
| 3    | Enter name "customerName", type "string", required checked | Variable saved                                                     |
| 4    | Add another: "orderId", type "string", required checked    | Two input variables listed                                         |
| 5    | Switch to Output tab                                       | Shows "No output configuration" (Start has no output)              |
| 6    | Click canvas background                                    | Config panel closes                                                |

### UAT-2.2: Text-to-Text Node — AI Configuration

| Step | Action                                                                                                    | Expected Result                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | Click TextToText0001 node                                                                                 | Config panel opens with AI-specific settings                                           |
| 2    | Select a model from model dropdown                                                                        | Model selected, connection auto-populated                                              |
| 3    | Enter system prompt: "You are an order processing assistant"                                              | Text accepted                                                                          |
| 4    | Enter human prompt: "Process order {{context.input.orderId}} for customer {{context.input.customerName}}" | Text accepted, `{{context.` triggers autocomplete dropdown showing available variables |
| 5    | Adjust temperature slider to 0.3                                                                          | Slider updates, value displayed                                                        |
| 6    | Set max tokens to 500                                                                                     | Value accepted                                                                         |
| 7    | Set timeout to 90 seconds                                                                                 | Slider updates                                                                         |
| 8    | Toggle "Structured output" on, enter JSON schema                                                          | Schema editor appears, accepts valid JSON schema                                       |

### UAT-2.3: API Node — HTTP Configuration

| Step | Action                                                                             | Expected Result                                          |
| ---- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1    | Click API0001 node                                                                 | Config panel opens with API-specific settings            |
| 2    | Select method: POST                                                                | Dropdown updates                                         |
| 3    | Enter URL: `https://api.example.com/orders/{{context.input.orderId}}`              | URL accepted with expression highlighting                |
| 4    | Add header: `Content-Type: application/json`                                       | Header row added                                         |
| 5    | Set body type to "json", enter body with `{{context.steps.TextToText0001.output}}` | Body accepted                                            |
| 6    | Set auth type to "pre_authorized", select auth profile                             | Auth profile dropdown populated from configured profiles |
| 7    | Set mode to "sync", timeout to 30 seconds                                          | Settings saved                                           |

### UAT-2.4: Function Node — Code Editor

| Step | Action                                                                                                       | Expected Result                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1    | Click Function0001 node                                                                                      | Config panel opens with code editor                                                                   |
| 2    | Verify mode toggle shows "Inline" / "Custom Script"                                                          | Toggle visible, default "Inline"                                                                      |
| 3    | Add input variable: name "orderData", type "json", value `{{context.steps.API0001.output}}`                  | Input variable row added                                                                              |
| 4    | Write JS code in Monaco editor: `const result = { total: orderData.items.reduce((s, i) => s + i.price, 0) }` | Code editor has syntax highlighting, no red underlines                                                |
| 5    | Click "Run" test button                                                                                      | Context Input tab shows mock input, Context Output tab shows result, Log tab shows any console output |
| 6    | Intentionally write code with `require('fs')`                                                                | Error shown: sandbox does not allow `require`                                                         |

### UAT-2.5: Condition Node — Branching Logic

| Step | Action                                                                                    | Expected Result                           |
| ---- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1    | Click Condition0001 node                                                                  | Config panel opens with condition builder |
| 2    | Set field: `{{context.steps.API0001.output.status}}`, operator: "equals", value: "200"    | First "If" condition configured           |
| 3    | Click "Add Else If"                                                                       | New condition row appears                 |
| 4    | Set field: `{{context.steps.API0001.output.status}}`, operator: "equals", value: "404"    | Second condition configured               |
| 5    | Verify "Else" path is implicit (always present)                                           | Else shown as default fallback            |
| 6    | Verify condition node on canvas now shows labeled output handles: "If", "Else If", "Else" | Three distinct output handles with labels |
| 7    | Connect each handle to different downstream nodes                                         | Three separate edges created with labels  |

### UAT-2.6: Human Node — Approval Configuration

| Step | Action                                                                                                                     | Expected Result                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | Click Human0001 node                                                                                                       | Config panel opens with Human-specific settings |
| 2    | Enter subject: "Approve order {{context.input.orderId}}"                                                                   | Subject accepted with expression                |
| 3    | Enter message: "Customer {{context.input.customerName}} placed order totaling {{context.steps.Function0001.output.total}}" | Message accepted                                |
| 4    | Select "Specific users" assignment                                                                                         | Email input field appears                       |
| 5    | Enter reviewer email: "manager@company.com"                                                                                | Email accepted                                  |
| 6    | Enable timeout: 24 hours                                                                                                   | Timeout configured                              |
| 7    | Set on timeout: "terminate"                                                                                                | Radio selected                                  |
| 8    | Verify canvas shows 4 output handles: on approval, on decline, on timeout, on failure                                      | Four labeled handles visible                    |

### UAT-2.7: Loop Node — Iteration Configuration

| Step | Action                                               | Expected Result                                             |
| ---- | ---------------------------------------------------- | ----------------------------------------------------------- |
| 1    | Add a Loop node to canvas                            | Loop0001 appears with "loop body" and "on complete" handles |
| 2    | Click Loop0001                                       | Config panel opens                                          |
| 3    | Set source: `{{context.steps.API0001.output.items}}` | Source expression accepted                                  |
| 4    | Set item alias: "currentItem"                        | Alias set                                                   |
| 5    | Set output field: "processedItems"                   | Field name set                                              |
| 6    | Set on error: "continue"                             | Error strategy selected                                     |
| 7    | Connect "loop body" handle to a Function node        | Edge created for loop body                                  |
| 8    | Connect Function node back to Loop0001 (loop_return) | Back-edge created, indicating loop body boundary            |
| 9    | Connect "on complete" handle to next node            | Exit edge created                                           |

### UAT-2.8: Integration Node — Connector Configuration

| Step | Action                                                        | Expected Result                                 |
| ---- | ------------------------------------------------------------- | ----------------------------------------------- |
| 1    | Add Integration node to canvas                                | Integration0001 appears with orange header      |
| 2    | Click node                                                    | Config panel opens                              |
| 3    | Select connection from dropdown (pre-configured integrations) | Connection selected, available actions populate |
| 4    | Select action (e.g., "Create Record")                         | Action selected, input parameters shown         |
| 5    | Map input parameters using context expressions                | Parameter mapping saved                         |
| 6    | Toggle JSON preview                                           | Auto-generated JSON displayed                   |

### UAT-2.9: Agentic App Node — Agent Invocation

| Step | Action                                                                     | Expected Result                         |
| ---- | -------------------------------------------------------------------------- | --------------------------------------- |
| 1    | Add Agentic App node to canvas                                             | AgenticApp0001 appears with teal header |
| 2    | Click node                                                                 | Config panel opens                      |
| 3    | Select deployed agent from dropdown                                        | Agent selected                          |
| 4    | Select deployment environment                                              | Environment set                         |
| 5    | Enter input: "Analyze this order: {{context.steps.TextToText0001.output}}" | Input accepted with context expression  |
| 6    | Set timeout to 120 seconds                                                 | Timeout configured                      |

### UAT-2.10: Delay Node

| Step | Action                                 | Expected Result                     |
| ---- | -------------------------------------- | ----------------------------------- |
| 1    | Add Delay node to canvas               | Delay0001 appears with amber header |
| 2    | Click node                             | Config panel opens                  |
| 3    | Set duration: 5, unit: minutes         | Delay configured                    |
| 4    | Verify on success / on failure handles | Both handles present                |

### UAT-2.11: Node Rename and Expression Refactoring

| Step | Action                                                                      | Expected Result                                                                                                        |
| ---- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1    | Click TextToText0001, edit name in config panel header to "OrderClassifier" | Name field is editable                                                                                                 |
| 2    | Press Enter to confirm                                                      | Confirmation dialog appears: "Renaming will update 2 expressions in downstream nodes: API0001, Function0001. Proceed?" |
| 3    | Click Confirm                                                               | Node renamed, all `{{context.steps.TextToText0001...}}` references updated to `{{context.steps.OrderClassifier...}}`   |
| 4    | Try renaming to "Order Classifier" (with space)                             | Validation error: "Node names can only contain letters, numbers, and underscores"                                      |

### UAT-2.12: Stub Nodes — Coming Soon

| Step | Action                                             | Expected Result                                                            |
| ---- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| 1    | Drag "Browser" from Assets panel                   | Browser0001 appears with "Coming soon" badge                               |
| 2    | Click node                                         | Config panel shows stub message: "Browser automation is not yet available" |
| 3    | Attempt to deploy workflow containing Browser node | Deployment blocked with error: "Stub nodes cannot be deployed"             |

---

## UAT-3: Workflow Canvas — Toolbar Actions

### UAT-3.1: Save Workflow

| Step | Action                                            | Expected Result                                               |
| ---- | ------------------------------------------------- | ------------------------------------------------------------- |
| 1    | Make changes to workflow (add node, connect edge) | Changes visible on canvas                                     |
| 2    | Click Save in toolbar                             | Workflow saved, success notification shown                    |
| 3    | Refresh page                                      | Canvas reloads with all nodes, edges, and positions preserved |

### UAT-3.2: Validation Warnings

| Step | Action                                                  | Expected Result                                    |
| ---- | ------------------------------------------------------- | -------------------------------------------------- |
| 1    | Create workflow with disconnected node (no edges)       | Warning badge shows count in toolbar (e.g., "⚠ 1") |
| 2    | Click warning badge                                     | Validation panel opens listing all warnings/errors |
| 3    | Remove the End node                                     | Error count increases: "No end node"               |
| 4    | Leave a node unconfigured (e.g., AI node with no model) | Error: "Node missing required config"              |
| 5    | Add duplicate node name                                 | Error: "Duplicate node names"                      |

### UAT-3.3: Version Management

| Step | Action                                    | Expected Result                                                |
| ---- | ----------------------------------------- | -------------------------------------------------------------- |
| 1    | Click "Flow versions" dropdown in toolbar | Dropdown shows current version and "Create new version" option |
| 2    | Click "Create new version"                | New version created, version number incremented                |
| 3    | Switch to previous version                | Canvas loads in read-only mode with previous version's state   |
| 4    | Switch back to latest version             | Canvas returns to editable mode                                |

### UAT-3.4: Manage Input/Output

| Step | Action                                                     | Expected Result              |
| ---- | ---------------------------------------------------------- | ---------------------------- |
| 1    | Click "Manage I/O" in toolbar                              | I/O editor opens             |
| 2    | Define workflow-level input schema (JSON Schema)           | Schema saved                 |
| 3    | Define workflow-level output schema                        | Schema saved                 |
| 4    | Verify Start node input variables reflect the input schema | Input variables synchronized |

### UAT-3.5: Environment Variables

| Step | Action                                                     | Expected Result                                |
| ---- | ---------------------------------------------------------- | ---------------------------------------------- |
| 1    | Open workflow settings/configuration                       | Env vars section visible                       |
| 2    | Add env var: `API_BASE_URL` = `https://api.example.com`    | Variable saved                                 |
| 3    | In API node URL, use `{{context.env.API_BASE_URL}}/orders` | Expression resolves correctly during execution |

### UAT-3.6: Change Log

| Step | Action                                       | Expected Result                                                |
| ---- | -------------------------------------------- | -------------------------------------------------------------- |
| 1    | Click clock icon (change log) in toolbar     | Change log panel opens showing history of canvas modifications |
| 2    | Verify entries show: what changed, when, who | Change entries listed chronologically                          |

---

## UAT-4: Workflow Execution — Run/Test

### UAT-4.1: Manual Test Execution

| Step | Action                                                       | Expected Result                                                                      |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1    | Click Run (▶) button in toolbar                              | Run dialog opens showing input variable fields                                       |
| 2    | Enter values: customerName = "Jane Doe", orderId = "ORD-123" | Input fields populated                                                               |
| 3    | Click "Run"                                                  | Dialog closes, canvas shows live execution overlay                                   |
| 4    | Observe Start node                                           | Pulsing border animation (currently executing), then green checkmark (completed)     |
| 5    | Observe TextToText0001 node                                  | Pulsing animation while LLM processes, then green checkmark                          |
| 6    | Observe API0001 node                                         | Pulsing, then green checkmark (or red X if API fails)                                |
| 7    | Observe remaining nodes execute in sequence                  | Each node transitions: pending → running (pulse) → completed (green) or failed (red) |
| 8    | Execution reaches End node                                   | Execution log panel slides up from bottom showing output                             |
| 9    | Verify execution log shows per-node timing                   | Each node shows duration in ms                                                       |

### UAT-4.2: Execution with Condition Branching

| Step | Action                                                           | Expected Result                                                                        |
| ---- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | Build workflow: Start → API → Condition → (If: End1, Else: End2) | Workflow with branching                                                                |
| 2    | Run with input that causes API to return status 200              | Condition evaluates "If" branch, End1 node executes, End2 shows "skipped" (gray badge) |
| 3    | Run again with input causing status 404                          | Condition evaluates "Else If" or "Else" branch, End2 executes                          |

### UAT-4.3: Execution with Loop

| Step | Action                                                                         | Expected Result                                              |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | Build workflow: Start → API (returns array) → Loop → Function (per item) → End | Loop workflow                                                |
| 2    | Run workflow                                                                   | Loop node shows iteration badge ("3/3" for 3 items)          |
| 3    | Verify Function node executes once per item                                    | Execution log shows 3 Function node executions               |
| 4    | Verify Loop output contains collected results array                            | `context.steps.Loop0001.output.processedItems` has 3 entries |

### UAT-4.4: Execution with Error — Failure Path

| Step | Action                                                                            | Expected Result                                                       |
| ---- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1    | Build workflow: Start → API (to invalid URL) → End, with failure edge to ErrorEnd | Workflow with failure handling                                        |
| 2    | Run workflow                                                                      | API node shows red X, execution follows "on failure" edge to ErrorEnd |
| 3    | Verify error details in execution log                                             | API node shows error code and message                                 |

### UAT-4.5: Execution with Delay

| Step | Action                                          | Expected Result                                   |
| ---- | ----------------------------------------------- | ------------------------------------------------- |
| 1    | Build workflow: Start → Delay (5 seconds) → End | Simple delay workflow                             |
| 2    | Run workflow                                    | Delay node shows pulsing animation for ~5 seconds |
| 3    | After delay, execution continues to End         | End node completes, total duration ~5s            |

---

## UAT-5: Human Node & Inbox

### UAT-5.1: Human Node Creates Inbox Task

| Step | Action                                                                       | Expected Result                                                    |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | Build workflow: Start → TextToText → Human → (Approval: End1, Decline: End2) | Workflow with human approval                                       |
| 2    | Run workflow                                                                 | Execution reaches Human node, shows "waiting" state (orange badge) |
| 3    | Verify execution status is "waiting_human"                                   | Execution list shows waiting status                                |
| 4    | Navigate to Inbox page                                                       | Inbox loads with Personal / Group tabs                             |
| 5    | Verify new task appears with subject and message (expressions resolved)      | Task visible with correct resolved content                         |

### UAT-5.2: Approve Inbox Task

| Step | Action                                            | Expected Result                                                 |
| ---- | ------------------------------------------------- | --------------------------------------------------------------- |
| 1    | Click on pending task in Inbox                    | Detail panel opens showing subject, message, context data       |
| 2    | Enter response comment: "Approved for processing" | Comment field accepts input                                     |
| 3    | Click "Approve"                                   | Task status changes to "approved", disappears from pending list |
| 4    | Return to workflow execution                      | Execution resumes, follows "on approval" edge to End1           |
| 5    | Verify End2 (decline path) shows "skipped"        | Decline path not taken                                          |

### UAT-5.3: Decline Inbox Task

| Step | Action                                                     | Expected Result                             |
| ---- | ---------------------------------------------------------- | ------------------------------------------- |
| 1    | Run same workflow again                                    | New inbox task created                      |
| 2    | Click task, click "Decline" with comment "Budget exceeded" | Task status changes to "declined"           |
| 3    | Return to workflow execution                               | Execution follows "on decline" edge to End2 |

### UAT-5.4: Inbox Task Timeout

| Step | Action                                                                | Expected Result                           |
| ---- | --------------------------------------------------------------------- | ----------------------------------------- |
| 1    | Configure Human node with timeout: 10 seconds, onTimeout: "terminate" | Timeout configured                        |
| 2    | Run workflow, do NOT act on inbox task                                | Execution waits at Human node             |
| 3    | Wait 10+ seconds                                                      | Task status changes to "expired" in Inbox |
| 4    | Verify execution follows "on timeout" edge or terminates (per config) | Execution status: failed with timeout     |

### UAT-5.5: Inbox — Group Assignment and Claiming

| Step | Action                                         | Expected Result                                                           |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | Configure Human node with assignTo: "everyone" | Group assignment                                                          |
| 2    | Run workflow                                   | Inbox task appears in Group tab for all users                             |
| 3    | User A views Group tab                         | Task visible                                                              |
| 4    | User A clicks "Claim"                          | Task moves to User A's Personal tab, disappears from Group tab for others |
| 5    | User A approves                                | Execution resumes                                                         |

### UAT-5.6: Inbox — Specific User Assignment

| Step | Action                                                                            | Expected Result                            |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| 1    | Configure Human node with assignTo: "specific", assignees: ["user-b@company.com"] | Specific assignment                        |
| 2    | Run workflow                                                                      | Task appears ONLY in User B's Personal tab |
| 3    | User A checks Inbox                                                               | No task visible                            |
| 4    | User B approves                                                                   | Execution resumes                          |

### UAT-5.7: Inbox — Badge Count

| Step | Action                       | Expected Result       |
| ---- | ---------------------------- | --------------------- |
| 1    | Create 3 pending inbox tasks | Tasks created         |
| 2    | Check sidebar navigation     | Inbox shows badge "3" |
| 3    | Resolve one task             | Badge updates to "2"  |

---

## UAT-6: Deployment & API Endpoints

### UAT-6.1: Deploy Workflow

| Step | Action                                                 | Expected Result                             |
| ---- | ------------------------------------------------------ | ------------------------------------------- |
| 1    | Build a complete valid workflow (Start → AI → End)     | All nodes configured, no validation errors  |
| 2    | Click Deploy button in toolbar                         | Deploy panel opens                          |
| 3    | Verify validation passes (green checkmark)             | No errors blocking deployment               |
| 4    | Verify endpoint slug auto-generated from workflow name | Slug shown (e.g., "order-processing")       |
| 5    | Edit slug to "order-proc-v1"                           | Slug updated                                |
| 6    | Select mode: Sync                                      | Sync mode selected                          |
| 7    | Set timeout: 180 seconds                               | Timeout configured                          |
| 8    | Click "Deploy"                                         | Deployment succeeds, endpoint URL displayed |
| 9    | Verify URL format: `/api/v1/run/order-proc-v1`         | URL shown with copy button                  |

### UAT-6.2: Deploy — Validation Blocks Deployment

| Step | Action                                                                | Expected Result                                              |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | Create workflow with missing node config (AI node, no model selected) | Validation error exists                                      |
| 2    | Click Deploy                                                          | Deploy panel shows validation errors, Deploy button disabled |
| 3    | Create workflow with stub Browser node                                | Validation error: "Stub nodes cannot be deployed"            |
| 4    | Fix all errors                                                        | Deploy button becomes enabled                                |

### UAT-6.3: Create API Key

| Step | Action                                  | Expected Result                                                             |
| ---- | --------------------------------------- | --------------------------------------------------------------------------- |
| 1    | In Deploy panel, click "Create API Key" | Modal/form opens                                                            |
| 2    | Enter name: "Production Key"            | Name accepted                                                               |
| 3    | Optionally set expiry date              | Date picker works                                                           |
| 4    | Click Create                            | API key displayed: `wfk_a1b2c3d4...` (full key shown ONCE)                  |
| 5    | Copy key                                | Key copied to clipboard                                                     |
| 6    | Close modal                             | Key list shows "Production Key" with prefix `wfk_a1b2...` and creation date |
| 7    | Verify full key is NOT shown again      | Only prefix visible                                                         |

### UAT-6.4: Execute via Sync API Endpoint

| Step | Action                                                                                                        | Expected Result                          |
| ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | Send POST request to `/api/v1/run/order-proc-v1` with Bearer token and input JSON                             | Request sent                             |
| 2    | Wait for response                                                                                             | Response received within timeout         |
| 3    | Verify 200 status code                                                                                        | Success                                  |
| 4    | Verify response body: `{ "executionId": "...", "status": "completed", "output": { ... }, "durationMs": ... }` | All fields present                       |
| 5    | Verify execution appears in workflow monitoring tab                                                           | Execution listed with "api" trigger type |

### UAT-6.5: Execute via Async-Poll API Endpoint

| Step | Action                                                                                                                | Expected Result                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1    | Redeploy workflow with mode: "async_poll"                                                                             | Redeployment succeeds, same endpoint URL                          |
| 2    | Send POST to `/api/v1/run/order-proc-v1`                                                                              | 202 Accepted                                                      |
| 3    | Verify response: `{ "executionId": "...", "status": "running", "statusUrl": "/api/v1/run/order-proc-v1/status/..." }` | Status URL provided                                               |
| 4    | Poll GET on statusUrl                                                                                                 | Returns `{ "status": "running", "nodeExecutions": [...] }`        |
| 5    | Continue polling                                                                                                      | Eventually returns `{ "status": "completed", "output": { ... } }` |

### UAT-6.6: Execute via Async-Push API Endpoint

| Step | Action                                                                                                           | Expected Result                              |
| ---- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1    | Redeploy with mode: "async_push", webhook URL: `https://webhook.example.com/callback`, access token: "secret123" | Async push configured                        |
| 2    | Send POST to `/api/v1/run/order-proc-v1`                                                                         | 202 Accepted with `{ "executionId": "..." }` |
| 3    | Wait for workflow to complete                                                                                    | Engine sends POST to webhook URL             |
| 4    | Verify webhook payload: `{ "executionId": "...", "status": "completed", "output": { ... } }`                     | Payload received                             |
| 5    | Verify `Authorization: Bearer secret123` header on webhook                                                       | Auth header present                          |
| 6    | Verify `X-Workflow-Signature` header (HMAC-SHA-256)                                                              | Signature valid                              |

### UAT-6.7: API Key — Invalid / Expired / Missing

| Step | Action                                             | Expected Result                                   |
| ---- | -------------------------------------------------- | ------------------------------------------------- |
| 1    | Send request with no Authorization header          | 401: `{ "error": { "code": "MISSING_API_KEY" } }` |
| 2    | Send request with invalid API key                  | 401: `{ "error": { "code": "INVALID_API_KEY" } }` |
| 3    | Send request with expired API key                  | 401: `{ "error": { "code": "EXPIRED_API_KEY" } }` |
| 4    | Send request with valid key for different workflow | 401: `{ "error": { "code": "INVALID_API_KEY" } }` |

### UAT-6.8: API Key — Revoke

| Step | Action                                             | Expected Result             |
| ---- | -------------------------------------------------- | --------------------------- |
| 1    | In Deploy panel, find "Production Key" in key list | Key listed                  |
| 2    | Click Revoke/Delete                                | Confirmation dialog appears |
| 3    | Confirm revocation                                 | Key removed from list       |
| 4    | Attempt API call with revoked key                  | 401: Invalid API key        |

### UAT-6.9: Rate Limiting

| Step | Action                                 | Expected Result                                                                        |
| ---- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | Send 100 requests within 1 minute      | All succeed (200 or 202)                                                               |
| 2    | Send 101st request                     | 429 Too Many Requests with `Retry-After` header                                        |
| 3    | Verify rate limit headers on responses | `X-RateLimit-Limit: 100`, `X-RateLimit-Remaining: N`, `X-RateLimit-Reset: <timestamp>` |
| 4    | Wait for rate window to reset          | Requests succeed again                                                                 |

### UAT-6.10: Input Validation on API Endpoint

| Step | Action                                                           | Expected Result                                                |
| ---- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| 1    | Deploy workflow with required input: `orderId` (string)          | Deployed                                                       |
| 2    | Send request with empty input `{}`                               | 400: Input validation failed, missing required field "orderId" |
| 3    | Send request with `{ "input": { "orderId": "ORD-123" } }`        | Executes successfully                                          |
| 4    | Send request with `{ "input": { "orderId": 123 } }` (wrong type) | 400: Type mismatch on "orderId"                                |

---

## UAT-7: Monitoring

### UAT-7.1: Monitoring Dashboard Metrics

| Step | Action                                             | Expected Result     |
| ---- | -------------------------------------------------- | ------------------- |
| 1    | Execute a workflow 5 times (3 success, 2 failures) | Executions complete |
| 2    | Navigate to workflow detail → Monitor tab          | Dashboard loads     |
| 3    | Verify "Total Runs" shows 5                        | Correct count       |
| 4    | Verify "Success Rate" shows 60%                    | Correct percentage  |
| 5    | Verify P50, P90, P99 duration metrics              | Values populated    |
| 6    | Verify "Currently Running" shows 0                 | Correct count       |

### UAT-7.2: Execution List and Filtering

| Step | Action                             | Expected Result                                                        |
| ---- | ---------------------------------- | ---------------------------------------------------------------------- |
| 1    | View execution list in Monitor tab | All 5 executions listed with ID, status, trigger, duration, started at |
| 2    | Filter by status: "failed"         | Only 2 failed executions shown                                         |
| 3    | Filter by trigger type: "api"      | Only API-triggered executions shown                                    |
| 4    | Filter by date range               | Only executions within range shown                                     |

### UAT-7.3: Execution Detail View

| Step | Action                                                          | Expected Result                                                     |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1    | Click on a completed execution                                  | Detail view opens                                                   |
| 2    | Verify canvas overlay shows green checkmarks on completed nodes | Execution state overlaid on canvas                                  |
| 3    | Verify failed nodes (if any) show red X                         | Failure state visible                                               |
| 4    | Verify skipped nodes show gray badge                            | Skipped paths visible                                               |
| 5    | Click on a specific node in the overlay                         | Node detail panel shows: input, output, error (if any), duration    |
| 6    | Verify Gantt-style timeline chart                               | Timeline shows when each node started/completed                     |
| 7    | Verify execution logs panel                                     | Function node console output, HTTP request/response details visible |

---

## UAT-8: AI Nodes

### UAT-8.1: Text-to-Text Node Execution

| Step | Action                                                                                      | Expected Result                                 |
| ---- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | Build workflow: Start (input: "text") → TextToText → End                                    | Simple AI workflow                              |
| 2    | Configure TextToText with model, system prompt, human prompt using `{{context.input.text}}` | Configured                                      |
| 3    | Run with input: "Summarize this: The quick brown fox..."                                    | Execution completes                             |
| 4    | Verify output contains LLM-generated summary                                                | Output in `context.steps.TextToText0001.output` |

### UAT-8.2: Text-to-Text with Structured Output

| Step | Action                                                                                                                    | Expected Result                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | Enable structured output on TextToText node                                                                               | JSON schema editor appears               |
| 2    | Define schema: `{ "type": "object", "properties": { "sentiment": { "type": "string" }, "score": { "type": "number" } } }` | Schema accepted                          |
| 3    | Run workflow                                                                                                              | Output is valid JSON matching the schema |
| 4    | Verify downstream nodes can access `{{context.steps.TextToText0001.output.sentiment}}`                                    | Nested field access works                |

### UAT-8.3: Text-to-Image Node Execution

| Step | Action                                                  | Expected Result                             |
| ---- | ------------------------------------------------------- | ------------------------------------------- |
| 1    | Build workflow with Text-to-Image node                  | Node configured with image generation model |
| 2    | Set prompt: "A sunset over mountains, watercolor style" | Prompt set                                  |
| 3    | Run workflow                                            | Image generation completes                  |
| 4    | Verify output contains image URL(s)                     | URL accessible                              |

### UAT-8.4: Audio-to-Text Node Execution

| Step | Action                                  | Expected Result                           |
| ---- | --------------------------------------- | ----------------------------------------- |
| 1    | Build workflow with Audio-to-Text node  | Node configured with speech-to-text model |
| 2    | Set audio source to URL of audio file   | Source configured                         |
| 3    | Run workflow                            | Transcription completes                   |
| 4    | Verify output contains transcribed text | Text output present                       |

### UAT-8.5: Image-to-Text Node Execution

| Step | Action                                            | Expected Result                   |
| ---- | ------------------------------------------------- | --------------------------------- |
| 1    | Build workflow with Image-to-Text node            | Node configured with vision model |
| 2    | Set image source and analysis prompt              | Configured                        |
| 3    | Run workflow                                      | Analysis completes                |
| 4    | Verify output contains image description/analysis | Text output present               |

---

## UAT-9: Context and Expression Resolution

### UAT-9.1: Context Autocomplete in Config Panel

| Step | Action                                           | Expected Result                                                   |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------- |
| 1    | In any node config text field, type `{{context.` | Autocomplete dropdown appears                                     |
| 2    | Verify dropdown shows: `input`, `steps`, `env`   | Top-level context keys shown                                      |
| 3    | Select `steps` and type `.`                      | Dropdown shows names of all upstream nodes                        |
| 4    | Select a node name and type `.output.`           | Dropdown shows available output fields (if output schema defined) |

### UAT-9.2: Context Propagation Across Nodes

| Step | Action                                                                                                          | Expected Result             |
| ---- | --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1    | Build: Start (input: name) → Function (transforms name to uppercase) → TextToText (uses transformed name) → End | Multi-node workflow         |
| 2    | Run with input: `{ "name": "jane" }`                                                                            | Execution completes         |
| 3    | Verify Function0001 output: `{ "result": "JANE" }`                                                              | Transform worked            |
| 4    | Verify TextToText received "JANE" in its prompt                                                                 | Correct context propagation |
| 5    | Verify End node output contains final result                                                                    | Full pipeline executed      |

### UAT-9.3: Environment Variable Resolution

| Step | Action                                                                          | Expected Result                            |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| 1    | Set workflow env var: `GREETING` = `Hello`                                      | Env var saved                              |
| 2    | In TextToText human prompt: `{{context.env.GREETING}}, {{context.input.name}}!` | Expression set                             |
| 3    | Run workflow                                                                    | TextToText receives prompt: "Hello, Jane!" |

---

## UAT-10: Error Handling and Edge Cases

### UAT-10.1: Workflow Timeout

| Step | Action                                                          | Expected Result                      |
| ---- | --------------------------------------------------------------- | ------------------------------------ |
| 1    | Deploy workflow with timeout: 60 seconds                        | Deployed                             |
| 2    | Workflow contains Delay node for 120 seconds                    | Delay exceeds timeout                |
| 3    | Execute via API                                                 | Execution cancelled after 60 seconds |
| 4    | Verify response: status "failed", error code "WORKFLOW_TIMEOUT" | Timeout error returned               |

### UAT-10.2: Node Timeout

| Step | Action                                                       | Expected Result             |
| ---- | ------------------------------------------------------------ | --------------------------- |
| 1    | Configure API node with timeout: 5 seconds                   | Timeout set                 |
| 2    | Point API to slow endpoint (>5s response)                    | Slow API configured         |
| 3    | Run workflow                                                 | API node fails with timeout |
| 4    | Verify execution follows "on failure" edge                   | Failure path taken          |
| 5    | Verify error: `{ "code": "NODE_TIMEOUT", "message": "..." }` | Error details present       |

### UAT-10.3: Cancellation

| Step | Action                                                               | Expected Result     |
| ---- | -------------------------------------------------------------------- | ------------------- |
| 1    | Run a workflow that takes significant time (e.g., with Delay node)   | Execution running   |
| 2    | Cancel execution via monitoring UI or API                            | Cancel request sent |
| 3    | Verify execution status changes to "cancelled"                       | Status updated      |
| 4    | Verify currently running node marked as failed with code "CANCELLED" | Node status updated |

### UAT-10.4: Function Node Sandbox Isolation

| Step | Action                                          | Expected Result                 |
| ---- | ----------------------------------------------- | ------------------------------- |
| 1    | Function code: `const result = process.env`     | Execute                         |
| 2    | Verify error: "process is not defined"          | Sandbox prevents access         |
| 3    | Function code: `while(true) {}` with timeout 5s | Execute                         |
| 4    | Verify timeout error after 5 seconds            | Execution terminated by sandbox |
| 5    | Function code: `const arr = new Array(1e9)`     | Execute                         |
| 6    | Verify memory limit error                       | 128MB limit enforced            |

### UAT-10.5: Invalid Workflow — No Path to End

| Step | Action                                         | Expected Result                                               |
| ---- | ---------------------------------------------- | ------------------------------------------------------------- |
| 1    | Create workflow where a branch has no End node | Missing end path                                              |
| 2    | Check validation                               | Warning: "Disconnected nodes" or "No path to end from node X" |
| 3    | Attempt to deploy                              | Blocked by validation errors                                  |

### UAT-10.6: Loop — Error Handling Strategies

| Step | Action                                                                                  | Expected Result                             |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1    | Loop over 5 items where 3rd item causes Function error                                  | Error on iteration 3                        |
| 2    | **onError: continue** — verify all 5 iterations run, error present in output for item 3 | 5 results, 1 with error                     |
| 3    | **onError: terminate** — verify only 3 iterations run, loop fails                       | Loop stops at item 3, failure edge followed |
| 4    | **onError: remove_failed** — verify 4 results returned (item 3 excluded)                | Clean output without failed item            |

### UAT-10.7: Condition Node — Cycle Detection

| Step | Action                                                                        | Expected Result                                                                            |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1    | Create condition that always evaluates to same branch, looping back to itself | Circular flow without Loop node                                                            |
| 2    | Verify validation catches this                                                | Error: "Circular edge without loop node"                                                   |
| 3    | If validation bypassed, run workflow                                          | Execution stops after 10 re-visits to the condition node, fails with cycle detection error |

---

## UAT-11: Multi-Tenant Isolation

## UAT-12: End-to-End Scenario — Order Processing Workflow

This scenario tests a complete real-world workflow.

### Workflow Design

```
Start (customerName, orderId, items[])
  → TextToText (classify order priority)
  → Condition (high priority?)
    → If high: Human (manager approval)
      → On Approval: API (process order)
      → On Decline: End (declined)
      → On Timeout: End (timeout)
    → Else: API (process order)
  → Function (calculate total)
  → Loop (items → enrich each item via API)
  → End (confirmation)
```

### Test Execution

| Step | Action                                          | Expected Result                                                                             |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | Build the above workflow in the canvas          | All nodes connected, no validation errors                                                   |
| 2    | Deploy as sync endpoint with API key            | Endpoint active                                                                             |
| 3    | Send API request with high-priority order       | Execution starts, reaches Human node, suspends                                              |
| 4    | Check Inbox — task appears for manager          | Task visible with order details                                                             |
| 5    | Manager approves                                | Execution resumes, API processes order                                                      |
| 6    | Function calculates total                       | Total computed                                                                              |
| 7    | Loop enriches each item                         | All items processed                                                                         |
| 8    | End node returns confirmation                   | Response: `{ "status": "completed", "output": { "confirmation": "...", "total": 150.00 } }` |
| 9    | Check monitoring — full execution trace visible | All nodes show green, durations visible, Gantt chart shows timeline                         |
| 10   | Send API request with low-priority order        | Execution skips Human node, processes directly, returns immediately                         |

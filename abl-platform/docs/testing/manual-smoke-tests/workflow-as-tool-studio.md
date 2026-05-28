# Workflow-as-Tool: Studio Smoke Test

## Prerequisites

- Local dev environment running (`pnpm dev` for Studio + Runtime + SearchAI)
- At least one workflow with a webhook trigger configured
- A project with an agent

## Test Checklist

### 1. Workflow Tab in Tools List

- [ ] Navigate to **Tools** page for a project [automated by UI-E2E-3]
- [ ] Verify the **Workflows** tab appears between SearchAI and MCP tabs [automated by UI-E2E-3]
- [ ] Tab badge shows the count of workflow tools (0 if none exist) [automated by UI-E2E-3]
- [ ] Deep-linking via `?tab=workflow` loads the workflow tab directly [automated by UI-E2E-3]

### 2. Workflow Tool Creation

- [ ] Click **Create Tool** (or use the new tool dropdown) [automated by UI-E2E-1]
- [ ] In the tool type selector, verify **Workflow** option is available [automated by UI-E2E-1]
- [ ] Select **Workflow** as the tool type [automated by UI-E2E-1]
- [ ] Enter a tool name and optional description [automated by UI-E2E-1]
- [ ] Click **Create** and verify the tool is created successfully [automated by UI-E2E-1]
- [ ] Verify redirect to the new tool's detail page [automated by UI-E2E-1]

### 3. Tool Type Badge

- [ ] On the tools list, workflow tools display a badge labeled **Workflow** with accent color [automated by UI-E2E-4]
- [ ] On the tool detail page, the badge appears correctly [automated by UI-E2E-4]

### 4. Workflow Binding Panel (Detail Page)

- [ ] Open a workflow tool's detail page [automated by UI-E2E-4]
- [ ] Verify the **Workflow Binding** read-only panel is shown [automated by UI-E2E-4]
- [ ] Panel displays: tool name, type ("Workflow"), DSL content [automated by UI-E2E-4]
- [ ] No editable config form is shown (workflow tools are auto-managed) [automated by UI-E2E-4]

### 5. FR-9: Empty State for No Webhook Triggers

- [ ] Create or select a workflow that has **no webhook triggers** [automated by UI-E2E-2]
- [ ] Attempt to configure it as a tool [automated by UI-E2E-2]
- [ ] Verify the empty-state message: "This workflow has no webhook triggers. Only webhook-triggered workflows can be exposed as tools." [automated by UI-E2E-2]

### 6. Agent Integration

- [ ] Navigate to an agent's detail page [manual-only — visual/UX regression]
- [ ] Add the workflow tool to the agent's tool list [manual-only — visual/UX regression]
- [ ] Verify the workflow tool appears with the correct badge and binding info [manual-only — visual/UX regression]

### 7. Playground Test

- [ ] Open the agent playground [manual-only — visual/UX regression]
- [ ] Send a message that should trigger the workflow tool [manual-only — visual/UX regression]
- [ ] Verify the agent invokes the workflow tool [manual-only — visual/UX regression]
- [ ] Verify the `workflow_executions` collection has a new entry [manual-only — visual/UX regression]
- [ ] Verify the agent receives and presents the workflow output [manual-only — visual/UX regression]

### 8. Workflow Tab Empty State

- [ ] In a project with no workflow tools, navigate to the Workflows tab [automated by UI-E2E-3]
- [ ] Verify the empty state message: "No workflow tools yet" [manual-only — visual/UX regression, exact copy]
- [ ] Verify the hint text about creating workflow tools [manual-only — visual/UX regression, exact copy]

## Expected Behavior

- Workflow tools appear in the list with an accent-colored "Workflow" badge
- The detail page shows a read-only binding panel (no inline editing)
- Testing workflow tools from the Studio test panel shows an informational message directing users to the agent playground
- Workflow tool execution flows through the runtime engine, not the Studio test service

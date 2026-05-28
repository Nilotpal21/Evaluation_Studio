# Guardrails Provider & Policy Creation UI

**Date:** 2026-03-08
**Status:** Approved
**Scope:** Studio UI for guardrail provider CRUD, policy CRUD with Form/YAML dual-mode

## Problem

The GuardrailsConfigPage has read-only card lists for providers and policies but no create/edit/delete UI. The existing E2E test works around this via direct API calls (documented as Bug #1 in `docs/plans/2026-03-04-studio-e2e-bugs.md`). This blocks comprehensive E2E testing and makes guardrails configuration inaccessible to users.

## Industry Research

Reviewed 7 platforms (AWS Bedrock, Azure Content Safety, Lakera, Aporia, NeMo, Guardrails AI, OpenAI). Key patterns adopted:

- **Aporia-style toggle list** for rule categories (preset cards with on/off + inline config)
- **AWS-style discrete severity levels** (4 levels: Safe/Low/Medium/High) instead of sliders
- **Input/output toggle per rule** (universal pattern across all platforms)
- **Template-first, customize-second** approach for policy rules
- **Form/YAML dual-mode** for power users (Kubernetes dashboard pattern)

## Design

### Provider Creation (wire existing form)

`GuardrailProviderForm.tsx` already exists with full fields. Changes:

1. **Wire into ProvidersTab** — "Add Provider" button opens form in create mode
2. **Add edit/delete actions** on provider cards (pencil icon, trash icon with confirm dialog)
3. **Expand adapter type options** from 6 to 15:
   - `openai_moderation`, `google_cloud`, `vertex_ai`, `azure_content_safety`, `bedrock`, `lakera`, `aporia`, `anthropic`, `builtin_pii`, `openai_compatible`, `huggingface_inference`, `custom_llm`, `custom_http`, `custom_webhook`, `nemo_guardrails`
4. **Add Form/YAML tab toggle** — Monaco editor with `language: 'yaml'`, bidirectional sync

### Policy Creation (new form)

New `GuardrailPolicyForm.tsx` with Form/YAML dual-mode dialog.

**Form tab sections:**

1. **Basics** — Name, Description
2. **Scope** — Radio: Project (all agents) | Agent (specific, with agent selector dropdown)
3. **Rules** — Toggle-card list:
   - 4 preset categories (off by default, expand on toggle):
     - **Content Safety** — default: OpenAI Moderation provider, input, block, medium severity
     - **PII Protection** — default: Built-in PII provider, output, redact, low severity
     - **Prompt Injection** — default: OpenAI Moderation provider, input, block, high severity
     - **Topic Restriction** — default: LLM check (no provider), input, warn, medium severity
   - Each preset card when expanded shows: provider dropdown, input/output/both radio, severity selector (4 discrete buttons), action dropdown, message input
   - **"+ Add Custom Rule"** button for power users — blank card with name, kind, check type selector (CEL / Provider / LLM Check), threshold, action, message
4. **Settings** — failMode (open/closed radio), timeouts (local/model/llm ms inputs), streaming toggle
5. **Status** — Draft / Active radio

**YAML tab:** Monaco editor with bidirectional sync to form state.

**Custom rule check types** map to the 3-tier architecture:

- CEL Expression → Tier 1 (local eval)
- Provider reference → Tier 2 (model-based)
- LLM Check (natural language) → Tier 3

**Severity selector** maps discrete levels to threshold values:

- Safe = 0.0, Low = 0.3, Medium = 0.5, High = 0.7

### Shared Components

- `GuardrailYamlEditor.tsx` — Monaco YAML wrapper used by both forms
- `RuleCard.tsx` — Collapsible toggle card for a single guardrail rule
- `SeveritySelector.tsx` — 4-button discrete severity selector

### GuardrailsConfigPage Changes

**Policies tab:**

- "Add Policy" button → opens `GuardrailPolicyForm`
- Policy cards get: Edit (pencil), Activate/Deactivate (toggle), Delete (trash with confirm)
- Active policy: green badge. Draft: gray badge.

**Providers tab:**

- "Add Provider" button → opens `GuardrailProviderForm`
- Provider cards get: Edit (pencil), Delete (trash with confirm)

## File Plan

**New files:**

- `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx`
- `apps/studio/src/components/guardrails/GuardrailYamlEditor.tsx`
- `apps/studio/src/components/guardrails/RuleCard.tsx`
- `apps/studio/src/components/guardrails/SeveritySelector.tsx`

**Modified files:**

- `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx` — buttons, card actions, form wiring
- `apps/studio/src/components/admin/GuardrailProviderForm.tsx` — Form/YAML tabs, expanded adapter types
- `packages/i18n/locales/en/studio.json` — new keys for policy form, YAML tab, severity, rule categories

**No changes to:**

- Runtime routes, Studio API proxy routes, hooks (`useGuardrails.ts`)

## Data Flow

```
GuardrailsConfigPage
  ├── ProvidersTab
  │     ├── "Add Provider" → GuardrailProviderForm (create)
  │     └── ProviderCard [edit] → GuardrailProviderForm (edit, initial={provider})
  │           ├── Form tab (fields + expanded adapter types)
  │           └── YAML tab (GuardrailYamlEditor)
  │
  └── PoliciesTab
        ├── "Add Policy" → GuardrailPolicyForm (create)
        └── PolicyCard [edit] → GuardrailPolicyForm (edit, initial={policy})
              ├── Form tab
              │     ├── Basics (name, description)
              │     ├── Scope (project/agent + selector)
              │     ├── Rules: RuleCard[] (4 presets + custom)
              │     │     └── SeveritySelector
              │     ├── Settings (failMode, timeouts, streaming)
              │     └── Status (draft/active)
              └── YAML tab (GuardrailYamlEditor)
```

## Dependencies

- `js-yaml` — Form ↔ YAML serialization (check if installed, add if not)
- `@monaco-editor/react` — already installed
- All UI primitives (Dialog, Input, Select, Toggle, Button, Badge) — already exist

## Out of Scope

- Audit tab implementation (remains a stub)
- Provider health check polling
- Budget configuration in policy form (can be added later)
- Drag-and-drop rule reordering

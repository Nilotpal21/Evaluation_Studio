# Arch AI Generation Quality Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 3 generation quality gaps blocking SA rollout: tool persistence (20/20 fail), channel/entryAgent normalization (20/20 + 6/20), coordinator return paths (#1 deployment blocker).

**Architecture:** Four independent fix groups — A (tool persistence in CREATE handler), B (channel normalization + project persistence), C (entry agent detection upgrade), D (return-path contract across prompts, topology schema, knowledge, validators). All changes are in `packages/arch-ai` and `apps/studio`.

**Tech Stack:** TypeScript, Zod, MongoDB/Mongoose, Vitest

**Spec:** `docs/superpowers/specs/2026-04-12-arch-generation-quality-design.md`

---

## Task Group 1: Channel Normalization (Fix B)

Pure function with no dependencies — build this first so other tasks can use it.

### Task 1: Create normalizeChannels helper + tests

**Files:**

- Create: `apps/studio/src/lib/arch-ai/helpers/normalize-channels.ts`
- Test: `apps/studio/src/__tests__/arch-ai/helpers/normalize-channels.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/studio/src/__tests__/arch-ai/helpers/normalize-channels.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeChannels } from '@/lib/arch-ai/helpers/normalize-channels';

describe('normalizeChannels', () => {
  it('passes through a clean array unchanged', () => {
    expect(normalizeChannels(['Web Chat', 'Email'])).toEqual(['Web Chat', 'Email']);
  });

  it('parses a JSON string to array', () => {
    expect(normalizeChannels('["Web Chat", "Email"]')).toEqual(['Web Chat', 'Email']);
  });

  it('flattens nested JSON encoding', () => {
    expect(normalizeChannels(['["Web Chat"]'])).toEqual(['Web Chat']);
  });

  it('handles split fragments from LLM re-encoding', () => {
    expect(normalizeChannels(['["Web Chat"', '"Email"]'])).toEqual(['Web Chat', 'Email']);
  });

  it('handles mixed clean and encoded elements', () => {
    expect(normalizeChannels(['Web Chat', '["Email"]'])).toEqual(['Web Chat', 'Email']);
  });

  it('deduplicates values', () => {
    expect(normalizeChannels(['Web Chat', 'Web Chat', 'Email'])).toEqual(['Web Chat', 'Email']);
  });

  it('trims whitespace from elements', () => {
    expect(normalizeChannels(['  Web Chat  ', ' Email'])).toEqual(['Web Chat', 'Email']);
  });

  it('filters out empty strings', () => {
    expect(normalizeChannels(['Web Chat', '', '  ', 'Email'])).toEqual(['Web Chat', 'Email']);
  });

  it('returns empty array for null/undefined', () => {
    expect(normalizeChannels(null)).toEqual([]);
    expect(normalizeChannels(undefined)).toEqual([]);
  });

  it('returns empty array for non-string/non-array input', () => {
    expect(normalizeChannels(42)).toEqual([]);
    expect(normalizeChannels({})).toEqual([]);
  });

  it('handles deeply nested JSON encoding', () => {
    expect(normalizeChannels(['["\\"Web Chat\\""]'])).toEqual(['Web Chat']);
  });

  it('returns empty array for unparseable string', () => {
    expect(normalizeChannels('not json')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-ai/helpers/normalize-channels.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement normalizeChannels**

Create `apps/studio/src/lib/arch-ai/helpers/normalize-channels.ts`:

```typescript
/**
 * Normalize channel values that may be malformed by LLM re-encoding.
 *
 * The INTERVIEW LLM sometimes re-encodes JSON arrays when calling
 * update_specification, producing nested strings like '["[\"Web Chat\"]"]'
 * instead of '["Web Chat"]'. This function recursively unwraps and
 * deduplicates the result.
 */
export function normalizeChannels(raw: unknown): string[] {
  if (raw == null) return [];

  // If raw is a string, try parsing as JSON array
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeChannels(parsed);
    } catch {
      // Not valid JSON — if it looks like a bare channel name, wrap it
      const trimmed = raw.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }
    return [];
  }

  if (!Array.isArray(raw)) return [];

  // Flatten each element — an element might be a JSON-encoded array itself
  const flat: string[] = [];
  for (const el of raw) {
    if (typeof el !== 'string') continue;
    const trimmed = el.trim();
    if (trimmed.length === 0) continue;

    // Try parsing as JSON (handles '["Web Chat"]' and '"Email"')
    if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const inner of parsed) {
            if (typeof inner === 'string' && inner.trim().length > 0) {
              flat.push(inner.trim());
            }
          }
          continue;
        }
        if (typeof parsed === 'string' && parsed.trim().length > 0) {
          flat.push(parsed.trim());
          continue;
        }
      } catch {
        // Not valid JSON — strip any residual JSON chars and use as-is
      }
    }

    // Strip residual JSON array chars from split fragments like '"Email"]'
    const cleaned = trimmed.replace(/^[\["\s]+|[\]"\s]+$/g, '').trim();
    if (cleaned.length > 0) {
      flat.push(cleaned);
    }
  }

  // Deduplicate preserving order
  return [...new Set(flat)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/studio && pnpm vitest run src/__tests__/arch-ai/helpers/normalize-channels.test.ts`
Expected: PASS (12/12)

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/arch-ai/helpers/normalize-channels.ts apps/studio/src/__tests__/arch-ai/helpers/normalize-channels.test.ts
git add apps/studio/src/lib/arch-ai/helpers/normalize-channels.ts apps/studio/src/__tests__/arch-ai/helpers/normalize-channels.test.ts
git commit -m "[ABLP-162] feat(studio): add normalizeChannels helper for LLM re-encoding cleanup"
```

---

## Task Group 2: Tool Persistence in CREATE Handler (Fix A)

### Task 2: Extract and persist tools during project creation

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts` (CREATE handler, after agent save loop ~line 4016)

- [ ] **Step 1: Read the existing CREATE handler**

Read `apps/studio/src/app/api/arch-ai/message/route.ts` lines 3994-4020 to find the exact end of the agent save loop.

- [ ] **Step 2: Add tool extraction and persistence after agent save loop**

After the `for (const agentName of agentNames)` loop that saves agents (~line 4016), add:

```typescript
// ─── Extract and persist tools from agent DSL ─────────────────────
try {
  const { collectInlineSeedTools } = await import('@agent-platform/database/seed-inline-tools');
  const { createProjectTool } = await import('@agent-platform/shared/repos');

  const agentSpecs = agentNames
    .map((name) => ({
      name,
      dslContent: agentFiles[name]?.content ?? null,
    }))
    .filter((spec): spec is { name: string; dslContent: string } => spec.dslContent !== null);

  const extractedTools = collectInlineSeedTools(agentSpecs);
  let persistedCount = 0;

  for (const tool of extractedTools) {
    try {
      await createProjectTool({
        tenantId: ctx.tenantId,
        projectId: project.id,
        name: tool.name,
        slug: tool.name,
        toolType: tool.toolType,
        description: tool.description,
        dslContent: tool.dslContent,
        sourceHash: tool.sourceHash,
        createdBy: ctx.userId,
      });
      persistedCount++;
    } catch (toolErr: unknown) {
      // Duplicate key = tool already exists for this project — skip silently
      const isDuplicate =
        toolErr instanceof Error &&
        'code' in toolErr &&
        (toolErr as { code: number }).code === 11000;
      if (!isDuplicate) {
        log.warn('Failed to persist extracted tool', {
          projectId: project.id,
          tool: tool.name,
          error: toolErr instanceof Error ? toolErr.message : String(toolErr),
        });
      }
    }
  }

  if (persistedCount > 0) {
    log.info('Persisted tools from agent DSL', {
      projectId: project.id,
      total: extractedTools.length,
      persisted: persistedCount,
    });
  }
} catch (extractErr: unknown) {
  // Tool extraction failure must not block project creation
  log.warn('Tool extraction failed — project created without tool records', {
    projectId: project.id,
    error: extractErr instanceof Error ? extractErr.message : String(extractErr),
  });
}
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] feat(studio): persist extracted tools from agent DSL during project creation"
```

---

## Task Group 3: Channel Persistence + Entry Agent (Fixes B + C in CREATE Handler)

### Task 3: Wire normalizeChannels + detectEntryAgent into CREATE handler

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts` (CREATE handler ~lines 3960-3981)

- [ ] **Step 1: Read the current CREATE handler project creation block**

Read `route.ts` lines 3955-3985 to see the exact code creating the project and setting entryAgentName.

- [ ] **Step 2: Add normalizeChannels import and use in project creation**

Find the comment at ~line 3960:

```typescript
// Note: channels and language are captured in session spec for LLM context
// but not persisted on the Project model yet (backlog item).
```

Replace it and update the `createProject` call:

```typescript
// Normalize channels (LLM may have re-encoded them as nested JSON)
const { normalizeChannels } = await import('@/lib/arch-ai/helpers/normalize-channels');
const channels = normalizeChannels(spec.channels);
const language = typeof spec.language === 'string' ? spec.language.trim() : undefined;

const project = await createProject({
  name: projectName,
  description: (spec.description as string) ?? '',
  tenantId: ctx.tenantId,
  ownerId: ctx.userId,
  channels: channels.length > 0 ? channels : undefined,
  language: language || undefined,
});
```

- [ ] **Step 3: Replace regex-based entryAgent detection with detectEntryAgent**

Find the supervisorName block (~lines 3972-3981):

```typescript
const supervisorName = agentNames.find((name) => {
  const content = agentFiles[name]?.content ?? '';
  return /^\s*SUPERVISOR\s*:/m.test(content);
});
if (supervisorName) {
  await Project.updateOne(
    { _id: project.id, tenantId: ctx.tenantId },
    { $set: { entryAgentName: supervisorName } },
  );
}
```

Replace with:

```typescript
// Detect entry agent using full fallback chain (SUPERVISOR → graph root → heuristic → first)
const { detectEntryAgent } = await import('@/lib/arch-ai/tools/create-project');
const entryAgent = detectEntryAgent(
  agentNames.map((name) => ({
    name,
    ablContent: agentFiles[name]?.content,
  })),
);
await Project.updateOne(
  { _id: project.id, tenantId: ctx.tenantId },
  { $set: { entryAgentName: entryAgent } },
);
```

- [ ] **Step 4: Also normalize channels in update_specification handler**

Find the `update_specification` handler (~line 1310). Before the `updateSpecification` call, add channel normalization:

```typescript
// Normalize channels to prevent LLM re-encoding artifacts
let normalizedValue = value;
if (field === 'channels') {
  const { normalizeChannels } = await import('@/lib/arch-ai/helpers/normalize-channels');
  normalizedValue = normalizeChannels(value);
}
await sessionService.updateSpecification(ctx, sessionId, {
  [field]: normalizedValue,
});
```

- [ ] **Step 5: Verify detectEntryAgent is exported**

Read `apps/studio/src/lib/arch-ai/tools/create-project.ts` to verify `detectEntryAgent` is exported (not just a local function). If it's not exported, add `export` before the function declaration.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] fix(studio): pass normalized channels/language to project, use detectEntryAgent with fallbacks"
```

---

## Task Group 4: Topology Schema — expectReturn (Fix D, Layer 2)

### Task 4: Add expectReturn to shared TopologyEdgeSchema

**Files:**

- Modify: `packages/arch-ai/src/types/blueprint.ts:22-28`
- Test: `packages/arch-ai/src/__tests__/blueprint.test.ts` (or existing)

- [ ] **Step 1: Write failing test for expectReturn**

Find or create the blueprint test file. Add:

```typescript
import { describe, it, expect } from 'vitest';
import { TopologyEdgeSchema, TopologyOutputSchema } from '../types/blueprint.js';

describe('TopologyEdgeSchema expectReturn', () => {
  it('accepts edges with expectReturn: true', () => {
    const edge = {
      from: 'Triage',
      to: 'Specialist',
      type: 'delegate',
      condition: 'billing question',
      expectReturn: true,
    };
    const result = TopologyEdgeSchema.safeParse(edge);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.expectReturn).toBe(true);
  });

  it('accepts edges with expectReturn: false', () => {
    const edge = {
      from: 'Triage',
      to: 'Human',
      type: 'escalate',
      condition: 'complex case',
      expectReturn: false,
    };
    const result = TopologyEdgeSchema.safeParse(edge);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.expectReturn).toBe(false);
  });

  it('accepts edges without expectReturn (optional)', () => {
    const edge = {
      from: 'A',
      to: 'B',
      type: 'delegate',
      condition: 'always',
    };
    const result = TopologyEdgeSchema.safeParse(edge);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.expectReturn).toBeUndefined();
  });

  it('propagates through TopologyOutputSchema', () => {
    const topology = {
      agents: [
        { name: 'A', role: 'router', executionMode: 'reasoning', description: 'routes' },
        { name: 'B', role: 'worker', executionMode: 'scripted', description: 'works' },
      ],
      edges: [{ from: 'A', to: 'B', type: 'delegate', condition: 'always', expectReturn: true }],
      entryPoint: 'A',
    };
    const result = TopologyOutputSchema.safeParse(topology);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.edges[0].expectReturn).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/blueprint.test.ts`
Expected: FAIL — `expectReturn` stripped by schema (not in schema definition)

- [ ] **Step 3: Add expectReturn to TopologyEdgeSchema**

Edit `packages/arch-ai/src/types/blueprint.ts` line 22-28:

```typescript
export const TopologyEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(['delegate', 'escalate', 'transfer']),
  condition: z.string().min(1),
  allowCycle: z.boolean().optional(),
  expectReturn: z.boolean().optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/blueprint.test.ts`
Expected: PASS

- [ ] **Step 5: Update generate_topology route-local edge schema**

In `route.ts` find the `generate_topology` edge schema (~line 1448-1458). Add `expectReturn`:

```typescript
        edges: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
            type: z.enum(['delegate', 'escalate', 'transfer']),
            condition: z.string(),
            allowCycle: z
              .boolean()
              .optional()
              .describe('Set to true on an edge to allow it to participate in a cycle.'),
            expectReturn: z
              .boolean()
              .optional()
              .describe(
                'true = source resumes after target completes (delegate). false = terminal transfer (escalate/transfer). Omit to infer from edge type.',
              ),
          }),
        ),
```

- [ ] **Step 6: Search for build helpers that infer return from edge type**

Run: `grep -rn 'edge.type.*delegate\|type.*===.*delegate' packages/arch-ai/src/coordinator/ packages/arch-ai/src/types/`

If any code infers return behavior from `edge.type === 'delegate'`, update it to prefer `edge.expectReturn` when present:

```typescript
const expectsReturn = edge.expectReturn ?? edge.type === 'delegate';
```

If no such code exists (only `computeBuildOrder` uses edge type, and that's for build ordering not return semantics), skip this step.

- [ ] **Step 7: Build to verify types propagate**

Run: `pnpm build --filter=@agent-platform/arch-ai`

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write packages/arch-ai/src/types/blueprint.ts apps/studio/src/app/api/arch-ai/message/route.ts packages/arch-ai/src/__tests__/blueprint.test.ts
git add packages/arch-ai/src/types/blueprint.ts apps/studio/src/app/api/arch-ai/message/route.ts packages/arch-ai/src/__tests__/blueprint.test.ts
git commit -m "[ABLP-162] feat(core): add expectReturn to TopologyEdgeSchema for return-path contract"
```

---

## Task Group 5: Multi-Agent Architect Prompt Update (Fix D, Layer 2c)

### Task 5: Update architect prompt with expectReturn guidance

**Files:**

- Modify: `packages/arch-ai/src/prompts/specialists/multi-agent-architect.ts:48-60`

- [ ] **Step 1: Read the current TopologyOutput Schema section**

Read `multi-agent-architect.ts` lines 48-60.

- [ ] **Step 2: Update the schema documentation and add guidance**

Replace the TopologyOutput Schema section:

```
## TopologyOutput Schema
\`\`\`json
{
  "agents": [{ "name": "PascalCase", "role": "what it does", "executionMode": "reasoning|scripted|hybrid", "description": "detailed" }],
  "edges": [{ "from": "AgentA", "to": "AgentB", "type": "delegate|escalate|transfer", "condition": "when", "expectReturn": true }],
  "entryPoint": "FirstAgent"
}
\`\`\`

### Edge Return Semantics
Set \`expectReturn\` on every edge:
- **delegate**: \`expectReturn: true\` — source resumes after target completes. Target MUST have COMPLETION.
- **escalate**: \`expectReturn: false\` — terminal handoff to human/external. No return.
- **transfer**: \`expectReturn: false\` — permanent topic shift. No return.

If omitted, defaults are: delegate=true, escalate=false, transfer=false.
```

- [ ] **Step 3: Build to verify no syntax errors in the prompt string**

Run: `pnpm build --filter=@agent-platform/arch-ai`

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write packages/arch-ai/src/prompts/specialists/multi-agent-architect.ts
git add packages/arch-ai/src/prompts/specialists/multi-agent-architect.ts
git commit -m "[ABLP-162] feat(core): add expectReturn guidance to multi-agent architect prompt"
```

---

## Task Group 6: ABL Construct Expert Return-Path Rules (Fix D, Layer 1)

### Task 6: Add Return Path Contract section to ABL Construct Expert

**Files:**

- Modify: `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts:180-210`

- [ ] **Step 1: Read the current key syntax rules section**

Read `abl-construct-expert.ts` lines 175-215.

- [ ] **Step 2: Insert Return Path Contract section before Mandatory Constructs**

Between the "Key Syntax Rules" section and "Mandatory Constructs" section, insert:

```
## Return Path Contract (CRITICAL for multi-agent systems)

Every HANDOFF rule must specify whether the source agent resumes after the target completes.

### Rules:
1. **DELEGATE / subtask routing** → \`RETURN: true\`
   - The child agent MUST have a COMPLETION block or reciprocal return handoff
   - Without COMPLETION, the parent blocks forever waiting for the child
2. **ESCALATION to human** → \`RETURN: false\` (or omit RETURN entirely)
   - Human agents are terminal — they do not auto-complete
   - Setting RETURN: true on an escalation causes the parent to block forever
3. **PERMANENT TRANSFER** → \`RETURN: false\`
   - Source does not resume — conversation ownership moves permanently

If the topology edge has \`expectReturn: true\`, use \`RETURN: true\` and ensure the target agent has a COMPLETION block. If \`expectReturn: false\`, omit RETURN or set false.

### Example — SUPERVISOR with mixed delegate + escalation:
\`\`\`yaml
SUPERVISOR: Triage
HANDOFF:
  - TO: OrderSpecialist
    WHEN: "order question"
    RETURN: true           # Delegate: child returns after task
  - TO: BillingSpecialist
    WHEN: "billing inquiry"
    RETURN: true           # Delegate: child returns after task
  - TO: HumanEscalation
    WHEN: "complex case or user frustrated"
    RETURN: false          # Escalation: human is TERMINAL
  - TO: BillingSpecialist
    WHEN: "true"
    CONTEXT:
      summary: "Unmatched intent — needs triage"
    RETURN: true           # Catch-all delegates, expects return
\`\`\`
```

- [ ] **Step 3: Build to verify no syntax errors**

Run: `pnpm build --filter=@agent-platform/arch-ai`

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts
git add packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts
git commit -m "[ABLP-162] feat(core): add return-path contract rules to ABL Construct Expert prompt"
```

---

## Task Group 7: Knowledge Card Force-Loading (Fix D, Layer 3)

### Task 7: Add forceCardIds parameter to selectKnowledgeCards

**Files:**

- Modify: `packages/arch-ai/src/knowledge/card-router.ts:455-490`
- Modify: `packages/arch-ai/src/prompts/index.ts:55-77`
- Test: `packages/arch-ai/src/__tests__/prompts.test.ts`

- [ ] **Step 1: Write failing test for forceCardIds**

Add to `packages/arch-ai/src/__tests__/prompts.test.ts`:

```typescript
describe('selectKnowledgeCards forceCardIds', () => {
  it('loads forced card even without keyword match', () => {
    // "hello" has no keyword match for delegate-full
    const result = selectKnowledgeCards('hello', undefined, ['delegate-full']);
    expect(result.selectedIds).toContain('delegate-full');
  });

  it('does not duplicate a card that matches both force and keywords', () => {
    // "delegate pattern" matches delegate-full via keyword AND force
    const result = selectKnowledgeCards('delegate pattern', undefined, ['delegate-full']);
    const count = result.selectedIds.filter((id) => id === 'delegate-full').length;
    expect(count).toBe(1);
  });

  it('respects token budget for forced cards', () => {
    // Force a card with a very small budget — L0 alone may fill it
    const result = selectKnowledgeCards('hello', 50, ['delegate-full']);
    // Platform limits (L0) is always loaded first; forced card may not fit
    expect(result.selectedIds).toContain('platform-limits');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/prompts.test.ts`
Expected: FAIL — `selectKnowledgeCards` doesn't accept 3rd argument

- [ ] **Step 3: Add forceCardIds parameter to selectKnowledgeCards**

Edit `packages/arch-ai/src/knowledge/card-router.ts` — modify the function signature and body:

```typescript
export function selectKnowledgeCards(
  userMessage?: string,
  maxTokens: number = MAX_KNOWLEDGE_TOKENS,
  forceCardIds?: string[],
): CardSelection {
  const parts: string[] = [];
  const selectedIds: string[] = [];
  let totalChars = 0;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // L0: Always include platform limits
  parts.push(PLATFORM_LIMITS_CARD);
  selectedIds.push('platform-limits');
  totalChars += PLATFORM_LIMITS_CARD.length;

  // Forced cards: load regardless of keyword match
  const forcedSet = new Set(forceCardIds ?? []);
  if (forcedSet.size > 0) {
    for (const card of CARD_REGISTRY) {
      if (!forcedSet.has(card.id)) continue;
      if (totalChars + card.content.length > maxChars) continue;
      parts.push(card.content);
      selectedIds.push(card.id);
      totalChars += card.content.length;
    }
  }

  // L2: Match user message against card patterns (skip already-loaded)
  const loadedSet = new Set(selectedIds);
  if (userMessage && userMessage.trim().length > 0) {
    for (const card of CARD_REGISTRY) {
      if (loadedSet.has(card.id)) continue;
      const matches = card.patterns.some((p) => p.test(userMessage));
      if (!matches) continue;
      if (totalChars + card.content.length > maxChars) continue;
      parts.push(card.content);
      selectedIds.push(card.id);
      totalChars += card.content.length;
    }
  }

  return {
    selectedIds,
    content: parts.join('\n\n'),
    estimatedTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Wire forceCardIds into composeSystemPrompt for BUILD phase**

Edit `packages/arch-ai/src/prompts/index.ts` — update `composeSystemPrompt`:

```typescript
export function composeSystemPrompt(
  specialist: SpecialistId,
  phase: ArchPhase,
  pageContext?: PageContext,
  userMessage?: string,
): string {
  const parts = [BASE_PROMPT];

  const specialistPrompt = SPECIALIST_PROMPTS[specialist];
  if (specialistPrompt) parts.push(specialistPrompt);

  // Knowledge layer: L0 (platform limits) + L2 (intent-triggered cards)
  // BUILD phase: force-load delegate-full for return-path knowledge
  const forceCards = phase === 'BUILD' ? ['delegate-full'] : undefined;
  const knowledge = selectKnowledgeCards(userMessage, undefined, forceCards);
  if (knowledge.content) parts.push(knowledge.content);

  const contextSection = formatContextSection(pageContext);
  if (contextSection) parts.push(contextSection);

  const phasePrompt = PHASE_PROMPTS[phase];
  if (phasePrompt) parts.push(phasePrompt);

  return parts.join('\n\n');
}
```

- [ ] **Step 6: Build to verify types**

Run: `pnpm build --filter=@agent-platform/arch-ai`

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/prompts/index.ts packages/arch-ai/src/__tests__/prompts.test.ts
git add packages/arch-ai/src/knowledge/card-router.ts packages/arch-ai/src/prompts/index.ts packages/arch-ai/src/__tests__/prompts.test.ts
git commit -m "[ABLP-162] feat(core): add forceCardIds to selectKnowledgeCards, force delegate-full in BUILD phase"
```

---

## Task Group 8: Enhanced Validators (Fix D, Layer 4)

### Task 8a: Expand QG-05 to check all routing agents

**Files:**

- Modify: `packages/arch-ai/src/diagnostics/semantic-validators.ts:757-771`
- Test: existing validator tests

- [ ] **Step 1: Write failing test for expanded QG-05**

Add to the appropriate validator test file:

```typescript
describe('QG-05 expanded: all routing agents', () => {
  it('emits QG-05 for non-entry agent with 2+ handoffs using AGENT type', () => {
    // Create a compiled output where a non-entry agent has multiple handoffs
    // but uses 'agent' type instead of 'supervisor'
    const compiled = makeCompiledOutput({
      agents: [
        makeAgent('Entry', { type: 'supervisor', handoffs: [{ to: 'Worker' }] }),
        makeAgent('Router', {
          type: 'agent',
          handoffs: [
            { to: 'SpecA', when: 'billing' },
            { to: 'SpecB', when: 'support' },
          ],
        }),
        makeAgent('SpecA', { type: 'agent', handoffs: [] }),
        makeAgent('SpecB', { type: 'agent', handoffs: [] }),
      ],
      entryPoint: 'Entry',
    });

    const report = runDiagnostics(compiled, { depth: 'deep' });
    const qg05 = report.topIssues.filter((f) => f.code === 'QG-05');
    expect(qg05.length).toBeGreaterThanOrEqual(1);
    expect(qg05.some((f) => f.agentName === 'Router')).toBe(true);
  });
});
```

Note: The exact test setup depends on how `makeCompiledOutput` / `makeAgent` helpers work in existing tests. Read the existing test file to match the pattern.

- [ ] **Step 2: Expand the QG-05 check**

In `semantic-validators.ts`, find the QG-05 block (~line 757). After the existing entry-agent check, add:

```typescript
// QG-05 expanded: any agent with 2+ handoffs should be SUPERVISOR
if (
  name !== entryAgentName &&
  hasRouting &&
  handoffs.length >= 2 &&
  agent.metadata.type !== 'supervisor'
) {
  findings.push({
    code: 'QG-05',
    message: `Agent "${name}" has ${handoffs.length} handoff rules but uses AGENT: — should be SUPERVISOR: for correct routing behavior`,
    severity: 'warning',
    category: 'routing',
    agentName: name,
    path: 'type',
    fix: {
      description: 'Change AGENT: to SUPERVISOR: in the DSL',
      effort: 'S',
    },
  });
}
```

Note: The entry agent check keeps severity `'error'`; non-entry routing agents get `'warning'`.

- [ ] **Step 3: Run validator tests**

Run: `cd packages/arch-ai && pnpm vitest run src/__tests__/`
Expected: PASS (including new test)

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write packages/arch-ai/src/diagnostics/semantic-validators.ts
git add packages/arch-ai/src/diagnostics/semantic-validators.ts packages/arch-ai/src/__tests__/*.test.ts
git commit -m "[ABLP-162] fix(core): expand QG-05 to flag all routing agents using AGENT instead of SUPERVISOR"
```

### Task 8b: Feed semantic findings into compile-fix loop

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts` (~line 1695-1847, compile_abl tool)

- [ ] **Step 1: Read the compile_abl executor**

Read `route.ts` lines 1695-1847 (already captured above).

- [ ] **Step 2: After successful compilation, run diagnostics and append findings**

In the compile_abl executor, after the `// Additional check: ensure the document was parsed successfully` block and before the quality floor checks, add:

```typescript
// Run semantic diagnostics on compiled IR — feed findings to LLM for self-correction
const semanticWarnings: string[] = [];
try {
  const { compileABLtoIR } = await import('@abl/compiler');
  const { runDiagnostics } = await import('@agent-platform/arch-ai');
  const compiled = compileABLtoIR([result.document]);
  const diagReport = runDiagnostics(compiled, { depth: 'deep', maxFindings: 5 });
  const critical = diagReport.topIssues.filter(
    (f) =>
      (f.code === 'CO-04' || f.code === 'QG-05') &&
      (f.severity === 'error' || f.severity === 'warning'),
  );
  for (const finding of critical) {
    semanticWarnings.push(`[${finding.code}] ${finding.message}`);
  }
} catch {
  // Diagnostic failure is non-fatal — skip
}
```

Then include `semanticWarnings` in the return value alongside `qualityWarnings`:

```typescript
return {
  status: 'pass',
  errors: [],
  warnings,
  qualityWarnings: [...qualityWarnings, ...semanticWarnings],
  ...(qualityWarnings.length + semanticWarnings.length > 0 && {
    hint: `Quality floor: ${qualityWarnings.length + semanticWarnings.length} issue(s) found. Fix these and recompile.`,
  }),
};
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] feat(studio): feed CO-04/QG-05 semantic findings into compile-fix loop"
```

---

## Execution Dependencies

```
Task 1 (normalizeChannels)  ─── no deps, build first
Task 2 (tool persistence)   ─── independent
Task 3 (channels + entry)   ─── depends on Task 1 (normalizeChannels)
Task 4 (topology schema)    ─── independent
Task 5 (architect prompt)   ─── after Task 4 (references expectReturn)
Task 6 (construct prompt)   ─── independent
Task 7 (knowledge inject)   ─── independent
Task 8a (QG-05 expand)      ─── independent
Task 8b (compile-fix loop)  ─── after Task 8a (uses expanded QG-05)
```

Parallelizable groups:

- Group A: Tasks 1 → 3 (channels + entry agent)
- Group B: Tasks 2 (tool persistence)
- Group C: Tasks 4 → 5 (topology schema + architect prompt)
- Group D: Tasks 6, 7 (construct prompt, knowledge inject)
- Group E: Tasks 8a → 8b (validators)

---

## Verification Checklist

After all tasks complete:

- [ ] `pnpm build --filter=@agent-platform/arch-ai` — arch-ai package builds
- [ ] `pnpm build --filter=@abl/studio` — studio builds
- [ ] `cd packages/arch-ai && pnpm vitest run` — all arch-ai tests pass
- [ ] `cd apps/studio && pnpm vitest run src/__tests__/arch-ai/` — all studio arch tests pass
- [ ] Manual: create a project via `/arch` → verify `project_tools` has records
- [ ] Manual: check created project in DB → verify `channels` and `entryAgentName` populated
- [ ] Manual: in BUILD phase → verify LLM generates agents with correct RETURN: true/false
- [ ] Manual: compile an agent with broken return path → verify CO-04 appears in qualityWarnings

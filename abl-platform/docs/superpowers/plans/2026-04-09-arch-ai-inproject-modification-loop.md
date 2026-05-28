# Arch AI — In-Project Agent Modification Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make in-project agent add/edit via Arch AI reliable and reviewable: Monaco diff UI with section jump-chips, pre-diff validation with self-repair, blocked state UX, and build-time verification of specialist prompt examples.

**Architecture:** Pre-validate ABL inside the `propose_modification` tool execute callback (in `buildInProjectTools`, `route.ts:1604`). On failure, echo `attemptedCode` back to the LLM via the tool result so `multi-turn-executor`'s history replay (which drops tool inputs) can't starve the repair. Use a request-scoped `Map<string, number>` closure as the per-agent repair counter with `REPAIR_CAP = 3` (initial + 2 retries). On cap, return `success: true` with a `reviewStatus: 'blocked'` proposal; the LLM stops regenerating and the user sees the errors with a pre-filled Modify textbox. Persist the blocked state in `PendingMutation` so it survives page reloads. Replace `InProjectDiffCard.tsx`'s primitive Visual/Code toggle with a Monaco `DiffEditor` wrapper that supports ABL syntax highlighting and per-section jump chips. Audit specialist prompts against a new compile-time verification test that runs `parseAgentBasedABL` + `compileABLtoIR` on every `yaml` fence.

**Tech Stack:** TypeScript, Next.js App Router (Studio), Vitest, `@monaco-editor/react`, Vercel AI SDK `tool()`, `multi-turn-executor` from `packages/arch-ai`, Mongoose (`ProjectAgent`), MongoDB memory server (for E2E).

**Spec:** `docs/superpowers/specs/2026-04-09-arch-ai-inproject-modification-loop-design.md`

---

## File Structure

### Files to create

| Path                                                                        | Purpose                                                                                                                                        |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/arch-ai/src/__tests__/prompts-compile.test.ts`                    | Scans every `yaml` code fence in specialist prompts and runs it through `parseAgentBasedABL` + `compileABLtoIR`. Blocks CI on broken examples. |
| `apps/studio/src/components/arch-v3/panels/ArchDiffEditor.tsx`              | Read-only Monaco `DiffEditor` wrapper with ABL language registration, hover provider, error markers, and an imperative `jumpToLine` method.    |
| `apps/studio/src/lib/arch-ai/compute-changed-sections.ts`                   | Uses `identifySections()` from `@agent-platform/project-io` to compute which top-level sections differ between two ABL strings.                |
| `apps/studio/src/__tests__/arch-ai/propose-modification-validation.test.ts` | Integration tests that import `buildInProjectTools` directly and drive `propose_modification` through all validation scenarios.                |
| `apps/studio/src/__tests__/lib-arch-ai/compute-changed-sections.test.ts`    | Unit tests for the section-diff utility.                                                                                                       |
| `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`  | End-to-end tests using the mock-LLM HTTP server pattern from `arch-ai-message-streaming.e2e.test.ts`.                                          |

### Files to modify

| Path                                                                           | What changes                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`             | Fix `COMPLETION:` → `COMPLETE:` at line 101; fix `BEHAVIOR_PROFILES:` → `BEHAVIOR_PROFILE:` at lines 162 and 177; add FLOW field-casing + entry-point rules; update the "compiler-verified" comment at line 6.                                                                                                                                          |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`        | Any issues surfaced by the new compile-time test (may require no edits).                                                                                                                                                                                                                                                                                |
| `packages/arch-ai/src/types/session.ts`                                        | Extend `PendingMutation` with `reviewStatus?: 'pending' \| 'blocked'` and `validation?: PersistedValidation`. Export new `ValidationIssue` and `PersistedValidation` types.                                                                                                                                                                             |
| `packages/arch-ai/src/index.ts` (or wherever `PendingMutation` is re-exported) | Add `ValidationIssue` and `PersistedValidation` to the public exports.                                                                                                                                                                                                                                                                                  |
| `apps/studio/src/types/arch.ts`                                                | Extend `ProposalReviewStatus` to include `'blocked'`. Add `ProposalValidation` type. Add `validation?` to `ModificationProposal`.                                                                                                                                                                                                                       |
| `apps/studio/src/hooks/useArchChat.ts`                                         | Extend `VALID_PROPOSAL_REVIEW_STATUSES` Set with `'blocked'`. Add `normalizeValidationIssue` + `normalizeValidation` helpers. Extend `normalizeProposal` to carry `validation`. Rewrite the rehydration block at lines 368–392 to read `pendingMut.reviewStatus`/`validation` and reconstruct a single `FULL` change.                                   |
| `apps/studio/src/app/api/arch-ai/message/route.ts`                             | Refactor `ProjectAgentValidationResult` (~lines 691–702) to use structured `ValidationIssue[]`. Refactor `validateProjectAgentCode` (~lines 704–792). Update `applyProjectAgentModification` caller (~line 921). Add `export` to `buildInProjectTools`. Add `repairCounts` Map + helpers. Rewrite the `propose_modification` tool override (line 2085). |
| `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx`              | Full rewrite. Drop the Visual/Code toggle and custom `computeLineDiff`. Use `ArchDiffEditor` with section jump-chips computed from `computeChangedSections`. Add blocked-state rendering (error banner, Monaco marker split, disabled Accept, pre-filled Modify).                                                                                       |
| `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx`         | Pass `proposal.validation` through. Soften the `changes.length === 0` bailout so blocked proposals render.                                                                                                                                                                                                                                              |

### Packages touched per commit (≤3 per CLAUDE.md)

| Commit | Packages           |
| ------ | ------------------ |
| 1      | `packages/arch-ai` |
| 2      | `packages/arch-ai` |
| 3      | `packages/arch-ai` |
| 4      | `apps/studio`      |
| 5      | `apps/studio`      |
| 6      | `apps/studio`      |
| 7      | `apps/studio`      |
| 8      | `apps/studio`      |
| 9      | `apps/studio`      |

---

## Preflight

- [ ] **P1. Verify clean working tree**

Run: `git status --short`
Expected: no uncommitted work. If there is, stash it before starting.

- [ ] **P2. Verify current branch**

Run: `git rev-parse --abbrev-ref HEAD`
Expected: `features/arch-ai`

- [ ] **P3. Baseline build**

Run: `pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio`
Expected: PASS. If it fails, STOP — do not start the plan on a red baseline.

- [ ] **P4. Baseline tests**

Run: `pnpm test --filter=@agent-platform/arch-ai -- --run loop-detection`
Expected: PASS. Confirms the vitest workflow is healthy.

---

## Commit 1 — Audit ABL examples in specialist prompts

**Commit message:** `[ABLP-162] fix(studio): audit ABL examples in specialist prompts` (commitlint rejects the `arch-ai` scope — use `studio`)

### Task 1: Fix `COMPLETION:` → `COMPLETE:`

**Files:**

- Modify: `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts:101`

- [ ] **Step 1: Locate the current content**

Run: `grep -n "COMPLETION\|COMPLETE" packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`
Expected: line 101 shows `COMPLETION:`.

- [ ] **Step 2: Replace the keyword**

In the Scripted Agent example, change:

```yaml
COMPLETION:
  - WHEN: 'full_name != null AND email != null'
    REASON: 'Required info collected'
```

to:

```yaml
COMPLETE:
  - WHEN: 'full_name != null AND email != null'
    REASON: 'Required info collected'
```

- [ ] **Step 3: Verify the fix**

Run: `grep -n "COMPLETE:\|COMPLETION:" packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`
Expected: `COMPLETE:` present; no `COMPLETION:` remaining.

### Task 2: Fix `BEHAVIOR_PROFILES:` → `BEHAVIOR_PROFILE:`

**Files:**

- Modify: `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts:162,177`

- [ ] **Step 1: Locate both occurrences**

Run: `grep -n "BEHAVIOR_PROFILE" packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`
Expected: line 162 (yaml example, plural) and line 177 (Key Syntax Rules prose, plural).

- [ ] **Step 2: Fix line 162**

Change:

```yaml
BEHAVIOR_PROFILES:
  frustrated_user:
```

to:

```yaml
BEHAVIOR_PROFILE:
  frustrated_user:
```

- [ ] **Step 3: Fix line 177**

Change the "Key Syntax Rules" bullet:

```
- ALL construct keywords UPPERCASE: AGENT, GOAL, PERSONA, LIMITATIONS, HANDOFF, CONSTRAINTS, GATHER, TOOLS, FLOW, EXECUTION, MEMORY, GUARDRAILS, BEHAVIOR_PROFILES
```

to:

```
- ALL construct keywords UPPERCASE: AGENT, GOAL, PERSONA, LIMITATIONS, HANDOFF, CONSTRAINTS, GATHER, TOOLS, FLOW, EXECUTION, MEMORY, GUARDRAILS, BEHAVIOR_PROFILE
```

- [ ] **Step 4: Verify no plural remains**

Run: `grep -n "BEHAVIOR_PROFILES" packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`
Expected: no output.

### Task 3: Add FLOW field-casing and entry-point rules

**Files:**

- Modify: `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts` (insert after the fixed line 177 bullet)

- [ ] **Step 1: Insert two new rule bullets**

After the `ALL construct keywords UPPERCASE: ...` bullet and before the `Colon required:` bullet, insert:

```
- Inside FLOW step definitions, fields are LOWERCASE: reasoning:, present:, then:, gather:. Only top-level section headers are UPPERCASE.
- Every step named in FLOW.steps must have a matching entry in FLOW.definitions. The entry point (first step listed) must be defined.
```

- [ ] **Step 2: Verify**

Run: `grep -n "Inside FLOW step definitions\|Every step named in FLOW" packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`
Expected: both lines found.

### Task 4: Update the "compiler-verified" comment

**Files:**

- Modify: `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts:6`

- [ ] **Step 1: Replace the comment**

Change line 6 from:

```
 * Syntax examples are compiler-verified.
```

to:

```
 * Syntax examples are validated at build time by a CI test that parses AND
 * compiles every yaml block in this file — see __tests__/prompts-compile.test.ts.
```

- [ ] **Step 2: Verify**

Run: `grep -n "CI test that parses AND" packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`
Expected: line found.

### Task 5: Typecheck and commit

- [ ] **Step 1: Typecheck**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: PASS.

- [ ] **Step 2: Format**

Run: `npx prettier --write packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts
git commit -m "[ABLP-162] fix(studio): audit ABL examples in specialist prompts"
```

Expected: commit created. If commitlint rejects the scope, check the allowed list in the hook error and retry with an allowed scope.

---

## Commit 2 — Compile-time verification test for specialist prompts

**Commit message:** `[ABLP-162] feat(studio): compile-time verification for specialist prompt examples` (commitlint rejects the `arch-ai` scope — use `studio`)

### Task 6: Create the prompts-compile test

**Files:**

- Create: `packages/arch-ai/src/__tests__/prompts-compile.test.ts`

- [ ] **Step 1: Write the test file**

````ts
// packages/arch-ai/src/__tests__/prompts-compile.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '..', 'prompts', 'specialists');
const YAML_FENCE = /```yaml\n([\s\S]*?)\n```/g;
const SKIP_MARKER = /#\s*@skip-compile/;

interface BlockFailure {
  file: string;
  blockIndex: number;
  stage: 'parse' | 'compile';
  errors: string[];
}

/**
 * Wrap a fragment (TOOLS/GATHER/FLOW block) in a minimal agent stub so
 * the parser accepts it. No-op if the block already declares AGENT: or SUPERVISOR:.
 */
function wrapIfFragment(code: string): string {
  if (/^\s*(AGENT|SUPERVISOR)\s*:/m.test(code)) {
    return code;
  }
  return `AGENT: _TestStub\nGOAL: "stub for example validation"\n${code}`;
}

describe('specialist prompts — ABL example validation', () => {
  it('every yaml example in every specialist prompt parses and compiles cleanly', async () => {
    const files = (await readdir(PROMPTS_DIR)).filter((f) => f.endsWith('.ts'));
    const failures: BlockFailure[] = [];

    for (const file of files) {
      const source = await readFile(join(PROMPTS_DIR, file), 'utf8');
      // Use matchAll for a clean iterator over all yaml fences in this file.
      const matches = Array.from(source.matchAll(YAML_FENCE));

      for (let blockIndex = 0; blockIndex < matches.length; blockIndex++) {
        const rawCode = matches[blockIndex][1];
        if (SKIP_MARKER.test(rawCode)) continue;

        const code = wrapIfFragment(rawCode);

        // Parse stage
        const parseResult = parseAgentBasedABL(code);
        if (parseResult.errors.length > 0) {
          failures.push({
            file,
            blockIndex,
            stage: 'parse',
            errors: parseResult.errors.map(
              (e: { line?: number; message: string }) => `Line ${e.line ?? '?'}: ${e.message}`,
            ),
          });
          continue;
        }

        // Compile stage (only if parse succeeded)
        if (parseResult.document) {
          const compileResult = compileABLtoIR([parseResult.document], { mode: 'preview' });
          const hardErrors = (compileResult.compilation_errors ?? []).filter(
            (e: { severity?: string }) => e.severity === 'error',
          );
          if (hardErrors.length > 0) {
            failures.push({
              file,
              blockIndex,
              stage: 'compile',
              errors: hardErrors.map(
                (e: { message: string; agent?: string }) =>
                  `${e.agent ? `[${e.agent}] ` : ''}${e.message}`,
              ),
            });
          }
        }
      }
    }

    expect(
      failures,
      `Specialist prompts contain ABL examples that fail validation:\n${JSON.stringify(failures, null, 2)}`,
    ).toEqual([]);
  });
});
````

- [ ] **Step 2: Run the test**

Run: `pnpm test --filter=@agent-platform/arch-ai -- --run prompts-compile`
Expected: **PASS**. Commit 1's audit should have fixed every known issue in `abl-construct-expert.ts`. If the test fails, inspect the reported block index and fix the corresponding example in the SAME commit as the test. For `integration-methodologist.ts`, common fixes:

- Missing `AGENT:` declaration in a fragment that can't be wrapped → add `# @skip-compile` inside the yaml block with a brief comment explaining why.
- A TOOLS entry referencing parameters that should be nested under the tool name → reshape the yaml.

Re-run the test after each fix.

### Task 7: Typecheck and commit

- [ ] **Step 1: Typecheck**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: PASS.

- [ ] **Step 2: Format**

Run:

```bash
npx prettier --write packages/arch-ai/src/__tests__/prompts-compile.test.ts
```

If you touched `integration-methodologist.ts`, format it too:

```bash
npx prettier --write packages/arch-ai/src/prompts/specialists/integration-methodologist.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/arch-ai/src/__tests__/prompts-compile.test.ts
# Include integration-methodologist.ts only if it was modified
git diff --cached --name-only
git commit -m "[ABLP-162] feat(studio): compile-time verification for specialist prompt examples"
```

Expected: commit created.

---

## Commit 3 — Extend PendingMutation with reviewStatus + validation

**Commit message:** `[ABLP-162] refactor(studio): extend PendingMutation with reviewStatus + validation` (commitlint rejects the `arch-ai` scope — use `studio`)

### Task 8: Add `ValidationIssue` and `PersistedValidation` types

**Files:**

- Modify: `packages/arch-ai/src/types/session.ts:22-29`

- [ ] **Step 1: Read the current type**

Run: `sed -n '20,32p' packages/arch-ai/src/types/session.ts`
Expected: see the current `PendingMutation` interface.

- [ ] **Step 2: Replace with the extended types**

Replace the `PendingMutation` block (lines ~22–29) with:

```ts
/**
 * A single validation issue (parse-time or compile-time) emitted by the
 * Studio route's validateProjectAgentCode. Shared between the server-side
 * return shape and the client-side ProposalValidation so the types don't drift.
 */
export interface ValidationIssue {
  /** 1-indexed line number in the offending code. Undefined for non-positional errors. */
  line?: number;
  message: string;
  severity: 'error' | 'warning';
  /** Where in the pipeline the issue was detected. Parse errors are position-accurate; compile errors may not be. */
  source?: 'parse' | 'compile';
  /** When an edit to agent A breaks agent B, this carries B's name so the UI can label the error. */
  agent?: string;
}

export interface PersistedValidation {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  hint?: string;
  repairAttempts: number;
}

export interface PendingMutation {
  tool: string;
  target: string;
  scope: 'SMALL' | 'MEDIUM' | 'LARGE';
  before?: unknown;
  after?: unknown;
  changeSummary?: string;
  /** 'pending' is the implied default when undefined. 'blocked' indicates the repair loop exhausted its budget. */
  reviewStatus?: 'pending' | 'blocked';
  /** Present only when reviewStatus is 'blocked'. Carries the compiler errors the UI renders. */
  validation?: PersistedValidation;
}
```

- [ ] **Step 3: Verify**

Run: `grep -n "ValidationIssue\|PersistedValidation" packages/arch-ai/src/types/session.ts`
Expected: type declarations visible.

### Task 9: Re-export the new types from the package entry

**Files:**

- Modify: `packages/arch-ai/src/index.ts` (or wherever `PendingMutation` is re-exported)

- [ ] **Step 1: Find the existing export**

Run: `grep -rn "export.*PendingMutation" packages/arch-ai/src`
Expected: an entry showing where `PendingMutation` is re-exported.

- [ ] **Step 2: Add the new types to the same export**

In the file that exports `PendingMutation`, add `ValidationIssue` and `PersistedValidation`. Example:

```ts
export type {
  PendingMutation,
  ValidationIssue,
  PersistedValidation,
  // ...existing exports
} from './types/session.js';
```

- [ ] **Step 3: Verify**

Run: `grep -n "ValidationIssue\|PersistedValidation" packages/arch-ai/src/index.ts`
Expected: both type names present.

### Task 10: Typecheck and commit

- [ ] **Step 1: Typecheck arch-ai**

Run: `pnpm build --filter=@agent-platform/arch-ai`
Expected: PASS.

- [ ] **Step 2: Typecheck studio (downstream consumer)**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS. Studio reads `PendingMutation` via `useArchChat.ts:371`; adding optional fields is safe.

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write packages/arch-ai/src/types/session.ts packages/arch-ai/src/index.ts
git add packages/arch-ai/src/types/session.ts packages/arch-ai/src/index.ts
git commit -m "[ABLP-162] refactor(studio): extend PendingMutation with reviewStatus + validation"
```

Expected: commit created.

---

## Commit 4 — Extend ModificationProposal + normalizer + rehydration

**Commit message:** `[ABLP-162] refactor(studio): extend ModificationProposal with validation + blocked status`

### Task 11: Extend `ProposalReviewStatus` and add `ProposalValidation`

**Files:**

- Modify: `apps/studio/src/types/arch.ts:761–773`

- [ ] **Step 1: Read the current type**

Run: `sed -n '755,780p' apps/studio/src/types/arch.ts`

- [ ] **Step 2: Apply the edits**

Replace the block containing `ProposalReviewStatus` and `ModificationProposal` with:

```ts
import type { ValidationIssue } from '@agent-platform/arch-ai';

/** Full modification proposal from propose_modification tool */
export type ProposalReviewStatus = 'pending' | 'applying' | 'applied' | 'rejected' | 'blocked';

export interface ProposalValidation {
  valid: boolean;
  /** Full ValidationIssue shape preserved — includes optional line, source, and agent. */
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  hint?: string;
  repairAttempts: number;
}

export interface ModificationProposal {
  agentName: string;
  changes: ProposedChange[];
  compilationStatus?: { success: boolean; errors: string[]; warnings: string[] };
  change?: string;
  currentCode?: string;
  proposedCode?: string;
  linesChanged?: number;
  reviewStatus?: ProposalReviewStatus;
  validation?: ProposalValidation;
  applyError?: string;
}
```

Keep all other types in the file untouched.

- [ ] **Step 3: Typecheck**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS (import from `@agent-platform/arch-ai` works because Commit 3 re-exported `ValidationIssue`).

### Task 12: Add normalizer helpers in useArchChat

**Files:**

- Modify: `apps/studio/src/hooks/useArchChat.ts:94-186`

- [ ] **Step 1: Extend the status set**

Find `VALID_PROPOSAL_REVIEW_STATUSES` (~line 96) and add `'blocked'`:

```ts
const VALID_PROPOSAL_REVIEW_STATUSES = new Set<ProposalReviewStatus>([
  'pending',
  'applying',
  'applied',
  'rejected',
  'blocked',
]);
```

- [ ] **Step 2: Import `ProposalValidation`**

At the top of the file, extend the existing `@/types/arch` import:

```ts
import type { ModificationProposal, ProposalReviewStatus, ProposalValidation } from '@/types/arch';
```

- [ ] **Step 3: Add the normalizer helpers above `normalizeProposal`**

Insert before the existing `normalizeProposal` function (~line 159):

```ts
function normalizeValidationIssue(
  e: Record<string, unknown>,
): ProposalValidation['errors'][number] {
  return {
    line: typeof e.line === 'number' ? e.line : undefined,
    message: typeof e.message === 'string' ? e.message : '',
    severity: e.severity === 'warning' ? 'warning' : 'error',
    source:
      e.source === 'parse' || e.source === 'compile'
        ? (e.source as 'parse' | 'compile')
        : undefined,
    agent: typeof e.agent === 'string' ? e.agent : undefined,
  };
}

function normalizeValidation(v: unknown): ProposalValidation | undefined {
  if (!isRecord(v) || typeof v.valid !== 'boolean') return undefined;
  const errors = Array.isArray(v.errors)
    ? v.errors.filter(isRecord).map(normalizeValidationIssue)
    : [];
  const warnings = Array.isArray(v.warnings)
    ? v.warnings.filter(isRecord).map(normalizeValidationIssue)
    : [];
  return {
    valid: v.valid,
    errors,
    warnings,
    hint: typeof v.hint === 'string' ? v.hint : undefined,
    repairAttempts: typeof v.repairAttempts === 'number' ? v.repairAttempts : 0,
  };
}
```

- [ ] **Step 4: Extend `normalizeProposal` to carry validation through**

In the return object of `normalizeProposal`, add `validation: normalizeValidation(proposal.validation),` alongside the existing fields:

```ts
return {
  agentName: typeof proposal.agentName === 'string' ? proposal.agentName : '',
  changes: normalizedChanges,
  compilationStatus: normalizeCompilationStatus(proposal.compilationStatus),
  change: typeof proposal.change === 'string' ? proposal.change : undefined,
  currentCode: typeof proposal.currentCode === 'string' ? proposal.currentCode : undefined,
  proposedCode: typeof proposal.proposedCode === 'string' ? proposal.proposedCode : undefined,
  linesChanged: typeof proposal.linesChanged === 'number' ? proposal.linesChanged : undefined,
  reviewStatus,
  validation: normalizeValidation(proposal.validation),
  applyError: typeof proposal.applyError === 'string' ? proposal.applyError : undefined,
};
```

### Task 13: Rewrite the rehydration block

**Files:**

- Modify: `apps/studio/src/hooks/useArchChat.ts:368–392`

- [ ] **Step 1: Read the current block**

Run: `sed -n '368,395p' apps/studio/src/hooks/useArchChat.ts`

- [ ] **Step 2: Replace the block**

Change the `if (pendingMut?.target && pendingMut.after) { ... }` section to:

```ts
const pendingMut = data.session.metadata.pendingMutation as {
  tool: string;
  target: string;
  scope: 'SMALL' | 'MEDIUM' | 'LARGE';
  before?: unknown;
  after?: unknown;
  changeSummary?: string;
  reviewStatus?: 'pending' | 'blocked';
  validation?: ProposalValidation;
} | null;

if (pendingMut?.target && pendingMut.after) {
  const beforeCode = typeof pendingMut.before === 'string' ? pendingMut.before : '';
  const afterCode = typeof pendingMut.after === 'string' ? pendingMut.after : '';
  const restoredStatus: ProposalReviewStatus = pendingMut.reviewStatus ?? 'pending';

  const restoredProposal = normalizeProposal(
    {
      agentName: pendingMut.target,
      // Reconstruct a single FULL change so InProjectArtifactPanel's
      // `changes.length === 0` bailout doesn't fire on reload. The writer only
      // stores before/after/validation — the rehydrator must synthesize
      // the ProposedChange envelope from those.
      changes: [
        {
          construct: 'FULL',
          before: beforeCode || null,
          after: afterCode,
          rationale: pendingMut.changeSummary ?? 'Rehydrated from session metadata',
        },
      ],
      currentCode: beforeCode || undefined,
      proposedCode: afterCode,
      change: pendingMut.changeSummary,
      reviewStatus: restoredStatus,
      validation: pendingMut.validation,
    },
    restoredStatus,
  );
  upsertDiffTab(restoredProposal, `restored-${pendingMut.target}`);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS.

### Task 14: Commit

- [ ] **Step 1: Format**

```bash
npx prettier --write \
  apps/studio/src/types/arch.ts \
  apps/studio/src/hooks/useArchChat.ts
```

- [ ] **Step 2: Commit**

```bash
git add apps/studio/src/types/arch.ts apps/studio/src/hooks/useArchChat.ts
git commit -m "[ABLP-162] refactor(studio): extend ModificationProposal with validation + blocked status"
```

Expected: commit created.

---

## Commit 5 — Structured errors in validateProjectAgentCode

**Commit message:** `[ABLP-162] refactor(studio): structured errors in validateProjectAgentCode`

### Task 15: Refactor the validation type and function

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts:691–792` and `:921`

- [ ] **Step 1: Import `ValidationIssue`**

Add to the existing imports at the top of the file:

```ts
import type { ValidationIssue } from '@agent-platform/arch-ai';
```

- [ ] **Step 2: Replace `ProjectAgentValidationResult` (~lines 691–702)**

Replace:

```ts
type ProjectAgentValidationResult =
  | { valid: true; warnings: string[]; agentsInScope: number }
  | { valid: false; errors: string[]; warnings: string[]; hint?: string };
```

with:

```ts
type ProjectAgentValidationResult =
  | { valid: true; warnings: ValidationIssue[]; agentsInScope: number }
  | { valid: false; errors: ValidationIssue[]; warnings: ValidationIssue[]; hint?: string };
```

- [ ] **Step 3: Rewrite `validateProjectAgentCode` (~lines 704–792)**

Replace the function body with:

```ts
async function validateProjectAgentCode(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  projectId: string,
  agentName: string,
  code: string,
): Promise<ProjectAgentValidationResult> {
  const { parseAgentBasedABL } = await import('@abl/core');
  const { compileABLtoIR } = await import('@abl/compiler');
  const { ProjectAgent } = await import('@agent-platform/database/models');

  const parseResult = parseAgentBasedABL(code);
  const parseErrors: ValidationIssue[] = (parseResult.errors ?? []).map(
    (e: { line?: number; message: string }) => ({
      line: typeof e.line === 'number' ? e.line : undefined,
      message: e.message,
      severity: 'error' as const,
      source: 'parse' as const,
    }),
  );

  if (parseErrors.length > 0) {
    return {
      valid: false,
      errors: parseErrors,
      warnings: [],
      hint: 'ABL uses UPPERCASE constructs: AGENT:, GOAL:, PERSONA:, HANDOFF:, CONSTRAINTS:, GATHER:, TOOLS:, FLOW:. Check your syntax.',
    };
  }

  if (!parseResult.document) {
    return {
      valid: false,
      errors: [
        {
          message:
            'No AGENT: or SUPERVISOR: declaration found. ABL requires UPPERCASE construct keywords.',
          severity: 'error',
          source: 'parse',
        },
      ],
      warnings: [],
      hint: 'Use AGENT: AgentName (not agent: name: AgentName)',
    };
  }

  const otherAgents = await ProjectAgent.find({
    projectId,
    tenantId: ctx.tenantId,
    name: { $ne: agentName },
  });

  const allDocs = [parseResult.document];
  for (const agent of otherAgents as Array<{ dslContent?: string }>) {
    if (!agent.dslContent) continue;
    try {
      const otherParse = parseAgentBasedABL(agent.dslContent);
      if (otherParse.document) {
        allDocs.push(otherParse.document);
      }
    } catch (err: unknown) {
      log.warn('Skipping agent with parse errors during validation', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const compileResult = compileABLtoIR(allDocs, { mode: 'preview' });

  // Surface ALL compilation errors including dependent-agent errors.
  // The structured shape carries `agent` so the UI can label the source.
  const errors: ValidationIssue[] = (compileResult.compilation_errors ?? [])
    .filter((e: { severity?: string }) => e.severity === 'error')
    .map((e: { line?: number; message: string; agent?: string }) => ({
      line: typeof e.line === 'number' ? e.line : undefined,
      message: e.message,
      severity: 'error' as const,
      source: 'compile' as const,
      agent: e.agent && e.agent !== agentName ? e.agent : undefined,
    }));

  const warnings: ValidationIssue[] = (compileResult.compilation_warnings ?? [])
    .filter((w: { agent?: string }) => !w.agent || w.agent === agentName || w.agent === '_global')
    .map((w: { line?: number; message: string; agent?: string }) => ({
      line: typeof w.line === 'number' ? w.line : undefined,
      message: w.message,
      severity: 'warning' as const,
      source: 'compile' as const,
      agent: w.agent && w.agent !== agentName ? w.agent : undefined,
    }));

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  return {
    valid: true,
    warnings,
    agentsInScope: allDocs.length,
  };
}
```

- [ ] **Step 4: Update the caller at `route.ts:921`**

Find the call site in `applyProjectAgentModification` and update the message extraction:

Change:

```ts
    error: {
      code: 'VALIDATION_FAILED',
      message: validation.errors[0] ?? 'Accepted changes failed ABL validation.',
    },
```

to:

```ts
    error: {
      code: 'VALIDATION_FAILED',
      message: validation.errors[0]?.message ?? 'Accepted changes failed ABL validation.',
    },
```

The `validation: { errors, warnings, hint }` block just below stays the same — the fields now carry `ValidationIssue[]` which is fine because downstream consumers (added in commit 6 and beyond) read them structurally.

- [ ] **Step 5: Scan for other callers**

Run: `grep -n "validation\.errors\[0\]\|validation\.errors\.join\|validation\.errors\.map" apps/studio/src/app/api/arch-ai/message/route.ts`
Expected: only the line you updated. If there are other references to `validation.errors` as strings, fix each to use `.message` access.

### Task 16: Typecheck and commit

- [ ] **Step 1: Typecheck**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS.

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/arch-ai/message/route.ts
git add apps/studio/src/app/api/arch-ai/message/route.ts
git commit -m "[ABLP-162] refactor(studio): structured errors in validateProjectAgentCode"
```

Expected: commit created.

---

## Commit 6 — Validate ABL in propose_modification + request-scoped repair counter

**Commit message:** `[ABLP-162] feat(studio): validate ABL in propose_modification + request-scoped repair counter`

### Task 17: Export `buildInProjectTools` for tests

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts:1604`

- [ ] **Step 1: Add the export keyword**

Change:

```ts
function buildInProjectTools(
```

to:

```ts
export function buildInProjectTools(
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS.

### Task 18: Write the integration test skeleton + happy-path test

**Files:**

- Create: `apps/studio/src/__tests__/arch-ai/propose-modification-validation.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// apps/studio/src/__tests__/arch-ai/propose-modification-validation.test.ts
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildInProjectTools } from '../../app/api/arch-ai/message/route';

const TEST_TIMEOUT = 30_000;
const MONGO_VERSION = process.env.MONGOMS_VERSION || '7.0.20';

const VALID_AGENT_CODE = `AGENT: LeadIntake
GOAL: "Capture new leads"
PERSONA: |
  Be friendly.
TOOLS:
  lookup_lead:
    description: "Look up an existing lead by email"
    parameters:
      email:
        type: string
        description: "Email address"
    HTTP:
      url: "{{LEAD_API_URL}}/leads"
      method: GET
`;

const INVALID_COMPLETION_CODE = `AGENT: LeadIntake
GOAL: "Capture new leads"
FLOW:
  steps:
    - greeting
  definitions:
    greeting:
      present: "Hello"
COMPLETION:
  - WHEN: "true"
    REASON: "done"
`;

const INVALID_ENTRY_POINT_CODE = `AGENT: LeadIntake
GOAL: "Capture new leads"
FLOW:
  steps:
    - greeting
  definitions:
    collect_email:
      present: "What is your email?"
`;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ binary: { version: MONGO_VERSION } });
  await mongoose.connect(mongoServer.getUri());
}, TEST_TIMEOUT);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const tenantId = 'tenant-test';
const userId = 'user-test';
const projectId = 'project-test';

async function seedAgent(name: string, code: string): Promise<void> {
  const { ProjectAgent } = await import('@agent-platform/database/models');
  await ProjectAgent.create({
    name,
    agentPath: `${projectId}/default/${name}`,
    projectId,
    tenantId,
    dslContent: code,
    description: 'Seeded by integration test',
    status: 'active',
  });
}

async function clearAgents(): Promise<void> {
  const { ProjectAgent } = await import('@agent-platform/database/models');
  await ProjectAgent.deleteMany({});
}

function makeTools() {
  return buildInProjectTools({ tenantId, userId, permissions: ['*'] }, 'session-test', projectId);
}

describe('propose_modification validation + repair counter', () => {
  beforeEach(async () => {
    await clearAgents();
    await seedAgent('LeadIntake', VALID_AGENT_CODE);
  });

  it('returns success for valid updated code', async () => {
    const tools = makeTools();
    const result = await tools.propose_modification.execute({
      agentName: 'LeadIntake',
      change: 'Update goal',
      updatedCode: VALID_AGENT_CODE.replace('Capture new leads', 'Capture and route new leads'),
    });

    expect(result.success).toBe(true);
    expect(result.proposal?.reviewStatus).toBe('pending');
    expect(result.proposal?.validation?.valid).toBe(true);
    expect(result.proposal?.validation?.repairAttempts).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL)**

Run: `pnpm test --filter=@agent-platform/studio -- --run propose-modification-validation`
Expected: **FAIL**. The current `propose_modification` doesn't validate before returning, so `result.proposal?.validation?.valid` is undefined. Capture the exact error. (If it fails with a different error — missing export, missing module — fix that first.)

### Task 19: Rewrite the `propose_modification` tool callback

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts:2085-2154`

- [ ] **Step 1: Replace the `propose_modification` block**

Replace the entire `propose_modification: tool({ ... })` block (~lines 2085–2154) with:

```ts
    // ── Override propose_modification for IN_PROJECT ──
    // BUILD-phase version checks session.metadata.files (build artifacts).
    // IN_PROJECT queries the live ProjectAgent collection, validates ABL
    // in-tool, and runs a per-agent repair counter (see recordRepairAttempt).
    // Returns a proposal WITHOUT applying — use apply_modification after user accepts.
    propose_modification: tool({
      description:
        'Propose changes to an existing live agent definition. Returns a diff for user review. Does NOT apply changes — use apply_modification after user accepts.',
      inputSchema: z.object({
        agentName: z.string().min(1).describe('Name of the agent to modify'),
        change: z.string().min(1).describe('Description of the change'),
        updatedCode: z.string().min(1).describe('The full updated ABL YAML code for the agent'),
      }),
      execute: async (input) => {
        try {
          // 1. Validate BEFORE constructing the proposal
          const validation = await validateProjectAgentCode(
            ctx,
            projectId,
            input.agentName,
            input.updatedCode,
          );

          if (!validation.valid) {
            const count = recordRepairAttempt(input.agentName);
            const capReached = count >= REPAIR_CAP;

            log.info('propose_modification validation failed', {
              sessionId,
              agentName: input.agentName,
              attempt: count,
              capReached,
              firstError: validation.errors[0]?.message,
            });

            if (!capReached) {
              // Under cap: return failure with attemptedCode echoed so the LLM
              // sees its own submission. multi-turn-executor.ts:131 drops tool
              // call inputs on replay, so this echo is the only way the LLM
              // can anchor its repair to specific lines of the previous attempt.
              return {
                success: false,
                error: {
                  code: 'VALIDATION_FAILED',
                  message: validation.errors[0]?.message ?? 'ABL validation failed',
                },
                validation: {
                  errors: validation.errors,
                  warnings: validation.warnings,
                  hint: validation.hint,
                },
                attemptedCode: input.updatedCode,
                attemptNumber: count,
                repairBudgetRemaining: REPAIR_CAP - count,
              };
            }

            // Cap reached: synthesize a blocked proposal. LLM stops retrying.
            const { ProjectAgent } = await import('@agent-platform/database/models');
            const existing = await ProjectAgent.findOne({
              projectId,
              tenantId: ctx.tenantId,
              name: input.agentName,
            });
            const currentCode = existing?.dslContent ?? '';

            const blockedProposal = {
              agentName: input.agentName,
              change: input.change,
              currentCode,
              proposedCode: input.updatedCode,
              linesChanged: Math.abs(
                input.updatedCode.split('\n').length - currentCode.split('\n').length,
              ),
              reviewStatus: 'blocked' as const,
              changes: [
                {
                  construct: 'FULL' as const,
                  before: currentCode || null,
                  after: input.updatedCode,
                  rationale: input.change,
                },
              ],
              validation: {
                valid: false,
                errors: validation.errors,
                warnings: validation.warnings,
                hint: validation.hint,
                repairAttempts: count,
              },
            };

            await sessionService.setPendingMutation(ctx, sessionId, {
              tool: 'apply_modification',
              target: input.agentName,
              scope: classifyMutationScope(currentCode, input.updatedCode),
              before: currentCode,
              after: input.updatedCode,
              changeSummary: input.change,
              reviewStatus: 'blocked',
              validation: blockedProposal.validation,
            });

            return { success: true, proposal: blockedProposal };
          }

          // Valid: clear the counter and emit a pending proposal
          resetRepairAttempt(input.agentName);

          const { ProjectAgent } = await import('@agent-platform/database/models');
          const existing = await ProjectAgent.findOne({
            projectId,
            tenantId: ctx.tenantId,
            name: input.agentName,
          });
          if (!existing) {
            return {
              success: false,
              error: {
                code: 'NOT_FOUND',
                message: `Agent "${input.agentName}" not found in this project`,
              },
            };
          }

          const currentCode = existing.dslContent || '';
          const proposal = {
            agentName: input.agentName,
            change: input.change,
            currentCode,
            proposedCode: input.updatedCode,
            linesChanged: Math.abs(
              input.updatedCode.split('\n').length - currentCode.split('\n').length,
            ),
            reviewStatus: 'pending' as const,
            changes: [
              {
                construct: 'FULL' as const,
                before: currentCode || null,
                after: input.updatedCode,
                rationale: input.change,
              },
            ],
            validation: {
              valid: true,
              errors: [],
              warnings: validation.warnings,
              repairAttempts: 0,
            },
          };

          await sessionService.setPendingMutation(ctx, sessionId, {
            tool: 'apply_modification',
            target: input.agentName,
            scope: classifyMutationScope(currentCode, input.updatedCode),
            before: currentCode,
            after: input.updatedCode,
            changeSummary: input.change,
          });

          return { success: true, proposal };
        } catch (err: unknown) {
          return {
            success: false,
            error: {
              code: 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
    }),
```

This tool references `recordRepairAttempt`, `resetRepairAttempt`, and `REPAIR_CAP`. Task 20 adds them.

### Task 20: Add the repair counter to `buildInProjectTools`

**Files:**

- Modify: `apps/studio/src/app/api/arch-ai/message/route.ts:1604-1615`

- [ ] **Step 1: Add the counter declarations**

Find:

```ts
export function buildInProjectTools(
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  sessionId: string,
  projectId: string,
) {
  const buildTools = buildBuildTools(ctx, sessionId);
```

Immediately after `const buildTools = buildBuildTools(ctx, sessionId);`, insert:

```ts
// Per-request repair counter for authoring tools.
// Fresh Map per POST /message call because buildInProjectTools is invoked
// per request. Key is lowercased agentName so LLM casing jitter can't
// accidentally reset the budget.
const repairCounts = new Map<string, number>();
const REPAIR_CAP = 3; // initial failure + up to 2 retries

const recordRepairAttempt = (agentName: string): number => {
  const key = agentName.toLowerCase();
  const count = (repairCounts.get(key) ?? 0) + 1;
  repairCounts.set(key, count);
  return count;
};
const resetRepairAttempt = (agentName: string): void => {
  repairCounts.delete(agentName.toLowerCase());
};
```

- [ ] **Step 2: Run the first integration test again**

Run: `pnpm test --filter=@agent-platform/studio -- --run propose-modification-validation`
Expected: the "returns success for valid updated code" test PASSES.

### Task 21: Add integration tests for invalid code under cap

**Files:**

- Modify: `apps/studio/src/__tests__/arch-ai/propose-modification-validation.test.ts`

- [ ] **Step 1: Append failure-path tests inside the existing `describe` block**

```ts
it('returns failure with attemptedCode for invalid updatedCode (COMPLETION keyword)', async () => {
  const tools = makeTools();
  const result = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'Add completion',
    updatedCode: INVALID_COMPLETION_CODE,
  });

  expect(result.success).toBe(false);
  expect(result.error?.code).toBe('VALIDATION_FAILED');
  expect(result.validation?.errors.length).toBeGreaterThan(0);
  expect(result.validation?.errors[0].message).toMatch(/COMPLETION|Unknown section/);
  expect(result.attemptedCode).toBe(INVALID_COMPLETION_CODE);
  expect(result.attemptNumber).toBe(1);
  expect(result.repairBudgetRemaining).toBe(2);
});

it('returns failure with entry-point message when FLOW.steps references undefined step', async () => {
  const tools = makeTools();
  const result = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'Add FLOW',
    updatedCode: INVALID_ENTRY_POINT_CODE,
  });

  expect(result.success).toBe(false);
  expect(
    result.validation?.errors.some((e: { message: string }) => /entry point/i.test(e.message)),
  ).toBe(true);
});
```

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run propose-modification-validation`
Expected: all three tests PASS.

### Task 22: Add counter-semantics, independence, reset, echo, persistence tests

**Files:**

- Modify: `apps/studio/src/__tests__/arch-ai/propose-modification-validation.test.ts`

- [ ] **Step 1: Append the remaining tests**

```ts
it('blocks on the 3rd consecutive failure (REPAIR_CAP = 3)', async () => {
  const tools = makeTools();
  const call1 = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'Attempt 1',
    updatedCode: INVALID_COMPLETION_CODE,
  });
  const call2 = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'Attempt 2',
    updatedCode: INVALID_COMPLETION_CODE,
  });
  const call3 = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'Attempt 3',
    updatedCode: INVALID_COMPLETION_CODE,
  });

  expect(call1.success).toBe(false);
  expect(call1.attemptNumber).toBe(1);
  expect(call2.success).toBe(false);
  expect(call2.attemptNumber).toBe(2);
  expect(call3.success).toBe(true);
  expect(call3.proposal?.reviewStatus).toBe('blocked');
  expect(call3.proposal?.validation?.repairAttempts).toBe(3);
  expect(call3.proposal?.validation?.errors.length).toBeGreaterThan(0);
});

it('maintains independent counters per agent', async () => {
  await seedAgent(
    'QualifiedLeadHandler',
    VALID_AGENT_CODE.replace('LeadIntake', 'QualifiedLeadHandler'),
  );
  const tools = makeTools();

  const a1 = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail',
    updatedCode: INVALID_COMPLETION_CODE,
  });
  const b1 = await tools.propose_modification.execute({
    agentName: 'QualifiedLeadHandler',
    change: 'fail',
    updatedCode: INVALID_COMPLETION_CODE.replace('LeadIntake', 'QualifiedLeadHandler'),
  });
  const a2 = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail',
    updatedCode: INVALID_COMPLETION_CODE,
  });

  expect(a1.attemptNumber).toBe(1);
  expect(b1.attemptNumber).toBe(1);
  expect(a2.attemptNumber).toBe(2);
  expect(a2.success).toBe(false);
});

it('resets the counter on a successful proposal', async () => {
  const tools = makeTools();
  await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail',
    updatedCode: INVALID_COMPLETION_CODE,
  });
  await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail again',
    updatedCode: INVALID_COMPLETION_CODE,
  });
  await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'succeed',
    updatedCode: VALID_AGENT_CODE.replace('Capture new leads', 'Capture and qualify leads'),
  });
  const postReset = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail after reset',
    updatedCode: INVALID_COMPLETION_CODE,
  });

  expect(postReset.attemptNumber).toBe(1);
});

it('gives each new buildInProjectTools call a fresh counter Map', async () => {
  const tools1 = makeTools();
  await tools1.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail',
    updatedCode: INVALID_COMPLETION_CODE,
  });
  await tools1.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail',
    updatedCode: INVALID_COMPLETION_CODE,
  });

  const tools2 = makeTools();
  const fresh = await tools2.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail under fresh counter',
    updatedCode: INVALID_COMPLETION_CODE,
  });

  expect(fresh.attemptNumber).toBe(1);
});

it('echoes attemptedCode on every failed result', async () => {
  const tools = makeTools();
  const result = await tools.propose_modification.execute({
    agentName: 'LeadIntake',
    change: 'fail',
    updatedCode: INVALID_COMPLETION_CODE,
  });

  expect(result.attemptedCode).toBe(INVALID_COMPLETION_CODE);
});
```

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run propose-modification-validation`
Expected: all 8 tests PASS.

### Task 23: Commit

- [ ] **Step 1: Typecheck**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS.

- [ ] **Step 2: Format**

```bash
npx prettier --write \
  apps/studio/src/app/api/arch-ai/message/route.ts \
  apps/studio/src/__tests__/arch-ai/propose-modification-validation.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add \
  apps/studio/src/app/api/arch-ai/message/route.ts \
  apps/studio/src/__tests__/arch-ai/propose-modification-validation.test.ts
git commit -m "[ABLP-162] feat(studio): validate ABL in propose_modification + request-scoped repair counter"
```

Expected: commit created.

---

## Commit 7 — Monaco diff editor for in-project modification review

**Commit message:** `[ABLP-162] feat(studio): Monaco diff editor for in-project modification review`

### Task 24: Write the computeChangedSections unit test

**Files:**

- Create: `apps/studio/src/__tests__/lib-arch-ai/compute-changed-sections.test.ts`

- [ ] **Step 1: Create the test**

```ts
// apps/studio/src/__tests__/lib-arch-ai/compute-changed-sections.test.ts
import { describe, it, expect } from 'vitest';
import { computeChangedSections } from '@/lib/arch-ai/compute-changed-sections';

const BEFORE = `AGENT: LeadIntake
GOAL: "Capture new leads"
PERSONA: |
  Be friendly.
TOOLS:
  lookup_lead:
    description: "Look up a lead"
    HTTP:
      url: "{{API}}/leads"
      method: GET
`;

const AFTER_GOAL_CHANGED = BEFORE.replace('"Capture new leads"', '"Capture and qualify new leads"');

const AFTER_TWO_SECTIONS_CHANGED = BEFORE.replace(
  '"Capture new leads"',
  '"Capture and qualify new leads"',
).replace('Be friendly.', 'Be friendly and professional.');

describe('computeChangedSections', () => {
  it('returns empty array when inputs are identical', () => {
    const result = computeChangedSections(BEFORE, BEFORE);
    expect(result).toEqual([]);
  });

  it('detects a single changed section', () => {
    const result = computeChangedSections(BEFORE, AFTER_GOAL_CHANGED);
    const sectionNames = result.map((s) => s.name);
    expect(sectionNames).toContain('GOAL');
    expect(sectionNames).not.toContain('TOOLS');
  });

  it('detects multiple changed sections', () => {
    const result = computeChangedSections(BEFORE, AFTER_TWO_SECTIONS_CHANGED);
    const sectionNames = result.map((s) => s.name);
    expect(sectionNames).toContain('GOAL');
    expect(sectionNames).toContain('PERSONA');
    expect(sectionNames).not.toContain('TOOLS');
  });

  it('returns jump targets with before and after line numbers', () => {
    const result = computeChangedSections(BEFORE, AFTER_GOAL_CHANGED);
    const goal = result.find((s) => s.name === 'GOAL');
    expect(goal).toBeDefined();
    expect(typeof goal?.beforeStartLine).toBe('number');
    expect(typeof goal?.afterStartLine).toBe('number');
  });
});
```

- [ ] **Step 2: Run (expect FAIL)**

Run: `pnpm test --filter=@agent-platform/studio -- --run compute-changed-sections`
Expected: FAIL with "Cannot find module '@/lib/arch-ai/compute-changed-sections'".

### Task 25: Implement `computeChangedSections`

**Files:**

- Create: `apps/studio/src/lib/arch-ai/compute-changed-sections.ts`

- [ ] **Step 1: Create the file**

```ts
// apps/studio/src/lib/arch-ai/compute-changed-sections.ts
import { identifySections } from '@agent-platform/project-io';

export interface ChangedSection {
  name: string;
  beforeStartLine: number;
  afterStartLine: number;
}

/**
 * Identify top-level ABL sections that differ between two strings. Used by
 * InProjectDiffCard to render jump-chips next to the Monaco diff. Only
 * sections recognized by @agent-platform/project-io's section-splicer are
 * considered — see Open Question #5 in the spec for the known divergence
 * from the parser's canonical section list.
 */
export function computeChangedSections(before: string, after: string): ChangedSection[] {
  if (before === after) return [];

  const beforeSections = identifySections(before);
  const afterSections = identifySections(after);

  const beforeByName = new Map(beforeSections.map((s) => [s.name, s]));
  const afterByName = new Map(afterSections.map((s) => [s.name, s]));

  const allNames = new Set<string>([
    ...beforeSections.map((s) => s.name),
    ...afterSections.map((s) => s.name),
  ]);

  const changed: ChangedSection[] = [];
  for (const name of allNames) {
    const b = beforeByName.get(name);
    const a = afterByName.get(name);
    const beforeText = b ? extractSectionText(before, b) : '';
    const afterText = a ? extractSectionText(after, a) : '';
    if (beforeText !== afterText) {
      changed.push({
        name,
        beforeStartLine: b ? b.startLine : 0,
        afterStartLine: a ? a.startLine : 0,
      });
    }
  }

  changed.sort((x, y) => x.afterStartLine - y.afterStartLine);
  return changed;
}

function extractSectionText(
  content: string,
  section: { startLine: number; endLine: number },
): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return lines.slice(section.startLine - 1, section.endLine).join('\n');
}
```

- [ ] **Step 2: Run the test**

Run: `pnpm test --filter=@agent-platform/studio -- --run compute-changed-sections`
Expected: PASS. If `identifySections`'s return type uses field names other than `startLine`/`endLine`, check `packages/project-io/src/types.ts` and adjust the helper.

### Task 26: Create `ArchDiffEditor.tsx`

**Files:**

- Create: `apps/studio/src/components/arch-v3/panels/ArchDiffEditor.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/studio/src/components/arch-v3/panels/ArchDiffEditor.tsx
'use client';

/**
 * ArchDiffEditor — Read-only Monaco DiffEditor for ABL modifications.
 *
 * Mirrors ArchDSLViewer.tsx's language registration (ABL tokenizer, abl-dark
 * theme, hover provider) but uses Monaco's DiffEditor so the user sees a
 * proper side-by-side (or inline) diff with syntax highlighting.
 *
 * Error markers: only errors with a definite line AND no agent field become
 * gutter markers on the modified side. Dependent-agent errors and line-less
 * errors must be rendered in a separate banner by the caller.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { DiffEditor, type DiffOnMount, type Monaco } from '@monaco-editor/react';
import type { editor, IDisposable } from 'monaco-editor';
import { ablYamlTokenizer } from '@/lib/abl-monarch';
import { getHoverInfo } from '@abl/language-service';

export interface ArchDiffEditorErrorMarker {
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ArchDiffEditorProps {
  original: string;
  modified: string;
  fileName: string;
  renderSideBySide?: boolean;
  errorMarkers?: ArchDiffEditorErrorMarker[];
  className?: string;
}

export interface ArchDiffEditorHandle {
  /** Scroll the modified side so the given line is centered. */
  jumpToLine: (line: number) => void;
}

export const ArchDiffEditor = forwardRef<ArchDiffEditorHandle, ArchDiffEditorProps>(
  function ArchDiffEditor(
    { original, modified, fileName, renderSideBySide = true, errorMarkers, className },
    ref,
  ) {
    const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const disposablesRef = useRef<IDisposable[]>([]);

    useImperativeHandle(ref, () => ({
      jumpToLine(line: number) {
        const modifiedEditor = editorRef.current?.getModifiedEditor();
        if (modifiedEditor) {
          modifiedEditor.revealLineInCenter(line);
          modifiedEditor.setPosition({ lineNumber: line, column: 1 });
        }
      },
    }));

    const handleMount: DiffOnMount = useCallback((diffEditor, monaco) => {
      editorRef.current = diffEditor;
      monacoRef.current = monaco;

      // Register ABL language (idempotent)
      monaco.languages.register({ id: 'abl' });
      monaco.languages.setMonarchTokensProvider('abl', ablYamlTokenizer);

      monaco.editor.defineTheme('abl-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'keyword', foreground: '6ea1f7', fontStyle: 'bold' },
          { token: 'type.identifier', foreground: '34d399' },
          { token: 'string', foreground: 'fbbf24' },
          { token: 'number', foreground: '60a5fa' },
          { token: 'constant', foreground: '60a5fa' },
          { token: 'comment', foreground: '6b7280' },
          { token: 'operator', foreground: 'f9fafb' },
          { token: 'variable', foreground: 'f472b6' },
        ],
        colors: {
          'editor.background': '#0a0a0a',
          'editor.foreground': '#fafafa',
          'editor.lineHighlightBackground': '#1a1a1a',
          'editor.selectionBackground': '#3b82f633',
          'editorCursor.foreground': '#3b82f6',
          'editorLineNumber.foreground': '#525252',
          'editorLineNumber.activeForeground': '#a3a3a3',
        },
      });
      monaco.editor.setTheme('abl-dark');

      const hoverDisposable = monaco.languages.registerHoverProvider('abl', {
        provideHover(model, position) {
          const info = getHoverInfo(model.getValue(), {
            line: position.lineNumber,
            column: position.column,
          });
          if (!info) return null;
          return {
            contents: [{ value: info.contents }],
            range: {
              startLineNumber: info.line,
              startColumn: 1,
              endLineNumber: info.line,
              endColumn: model.getLineMaxColumn(info.line),
            },
          };
        },
      });
      disposablesRef.current.push(hoverDisposable);
    }, []);

    useEffect(() => {
      const monaco = monacoRef.current;
      const diffEditor = editorRef.current;
      if (!monaco || !diffEditor) return;
      const modifiedModel = diffEditor.getModifiedEditor().getModel();
      if (!modifiedModel) return;

      if (!errorMarkers || errorMarkers.length === 0) {
        monaco.editor.setModelMarkers(modifiedModel, 'arch-ai-validation', []);
        return;
      }

      const markers: editor.IMarkerData[] = errorMarkers.map((m) => ({
        startLineNumber: m.line,
        startColumn: 1,
        endLineNumber: m.line,
        endColumn: modifiedModel.getLineMaxColumn(m.line) || 1,
        message: m.message,
        severity:
          m.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      }));

      monaco.editor.setModelMarkers(modifiedModel, 'arch-ai-validation', markers);
    }, [errorMarkers]);

    useEffect(() => {
      return () => {
        for (const d of disposablesRef.current) d.dispose();
        disposablesRef.current = [];
      };
    }, []);

    const filePath = `src/agents/${fileName}.abl.yaml`;

    return (
      <div className={`flex h-full flex-col ${className ?? ''}`}>
        <div className="flex-shrink-0 border-b border-border/50 px-3 py-1.5 text-[10px] font-mono text-foreground-muted/50">
          {filePath}
        </div>
        <div className="flex-1 min-h-0">
          <DiffEditor
            height="100%"
            language="abl"
            original={original}
            modified={modified}
            onMount={handleMount}
            theme="abl-dark"
            options={{
              readOnly: true,
              renderSideBySide,
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              lineNumbers: 'on',
              renderLineHighlight: 'line',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 12, bottom: 12 },
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
            }}
          />
        </div>
      </div>
    );
  },
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS.

### Task 27: Rewrite `InProjectDiffCard.tsx` (pending/applying/applied/rejected paths)

**Files:**

- Modify: `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx` (full rewrite)

This rewrite handles `pending`/`applying`/`applied`/`rejected`. The `blocked` path is added in Commit 8.

- [ ] **Step 1: Replace the entire file contents**

```tsx
// apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx
'use client';

import React, { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArchDiffEditor, type ArchDiffEditorHandle } from './ArchDiffEditor';
import { computeChangedSections } from '@/lib/arch-ai/compute-changed-sections';
import type { ProposedChange, ProposalValidation } from '@/types/arch';

interface InProjectDiffCardProps {
  changes: ProposedChange[];
  status: 'pending' | 'applying' | 'applied' | 'rejected' | 'blocked';
  validation?: ProposalValidation;
  onAccept: () => void;
  onReject: () => void;
  onModify: (feedback: string) => void;
}

export type { InProjectDiffCardProps };

export function InProjectDiffCard({
  changes,
  status,
  validation,
  onAccept,
  onReject,
  onModify,
}: InProjectDiffCardProps) {
  const t = useTranslations('arch_in_project');
  const [modifyOpen, setModifyOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [renderSideBySide, setRenderSideBySide] = useState(true);
  const diffRef = useRef<ArchDiffEditorHandle>(null);

  // The current data model stores a single 'FULL' change containing the
  // entire before/after; per-section chips are computed client-side.
  const fullChange = changes.find((c) => c.construct === 'FULL') ?? changes[0];
  const before = fullChange?.before ?? '';
  const after = fullChange?.after ?? '';
  const rationale = fullChange?.rationale ?? '';

  const changedSections = useMemo(() => computeChangedSections(before, after), [before, after]);

  // Error markers: only line-anchored, non-dependent errors become gutter markers.
  // Everything else renders in the banner (blocked state, Commit 8).
  const errorMarkers = useMemo(() => {
    if (!validation || status !== 'blocked') return undefined;
    return validation.errors
      .filter((e) => typeof e.line === 'number' && !e.agent)
      .map((e) => ({
        line: e.line as number,
        message: e.message,
        severity: e.severity,
      }));
  }, [validation, status]);

  const handleJump = (afterStartLine: number) => {
    if (afterStartLine > 0) diffRef.current?.jumpToLine(afterStartLine);
  };

  const handleSendFeedback = () => {
    if (!feedback.trim()) return;
    onModify(feedback.trim());
    setFeedback('');
    setModifyOpen(false);
  };

  if (changes.length === 0 && status !== 'blocked') {
    return <div className="p-4 text-center text-sm text-foreground-muted">{t('no_changes')}</div>;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Top bar: view-mode toggle */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 pb-2">
        <span className="text-xs font-mono text-foreground-muted">
          {fullChange?.construct ?? ''}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setRenderSideBySide(true)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              renderSideBySide
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground-muted hover:text-foreground'
            }`}
          >
            {t('view_side_by_side')}
          </button>
          <button
            type="button"
            onClick={() => setRenderSideBySide(false)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              !renderSideBySide
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground-muted hover:text-foreground'
            }`}
          >
            {t('view_inline')}
          </button>
        </div>
      </div>

      {/* Section chip bar */}
      {changedSections.length > 0 && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 px-3">
          {changedSections.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => handleJump(s.afterStartLine)}
              className="rounded bg-surface-hover px-2 py-0.5 text-[10px] font-semibold uppercase text-accent hover:bg-accent/10 hover:text-accent-foreground"
            >
              {s.name} ↓
            </button>
          ))}
          <span className="ml-2 text-[10px] text-foreground-muted">
            {changedSections.length}{' '}
            {changedSections.length === 1 ? t('section_changed') : t('sections_changed')}
          </span>
        </div>
      )}

      {/* Monaco diff */}
      <div className="flex-1 min-h-0">
        <ArchDiffEditor
          ref={diffRef}
          original={before}
          modified={after}
          fileName="agent"
          renderSideBySide={renderSideBySide}
          errorMarkers={errorMarkers}
        />
      </div>

      {/* Rationale */}
      {rationale && (
        <div className="mx-3 flex flex-shrink-0 items-start gap-2 rounded bg-info/5 p-2 text-xs text-info">
          <span>💡</span>
          <span>{rationale}</span>
        </div>
      )}

      {/* Modify feedback input */}
      {modifyOpen && (
        <div className="flex flex-shrink-0 gap-2 px-3">
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t('modify_placeholder')}
            className="flex-1 rounded border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-1 focus:ring-accent"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && feedback.trim()) handleSendFeedback();
            }}
          />
          <button
            type="button"
            disabled={!feedback.trim()}
            onClick={handleSendFeedback}
            className="rounded bg-accent px-3 py-1.5 text-sm text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {t('send_feedback')}
          </button>
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-shrink-0 items-center gap-2 border-t border-border px-3 pt-3">
        {status === 'pending' && (
          <>
            <button
              type="button"
              onClick={onAccept}
              className="flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-xs font-medium text-success-foreground transition-colors hover:bg-success/90"
            >
              {t('accept')}
            </button>
            <button
              type="button"
              onClick={() => setModifyOpen(!modifyOpen)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface-secondary px-3 py-1.5 text-xs font-medium text-foreground-secondary transition-colors hover:bg-surface-tertiary"
            >
              {t('modify')}
            </button>
            <button
              type="button"
              onClick={onReject}
              className="flex items-center gap-1.5 rounded-md border border-error/30 bg-error/5 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10"
            >
              {t('reject')}
            </button>
          </>
        )}
        {status === 'applying' && (
          <span className="text-xs text-foreground-muted animate-pulse">
            {t('applying_changes')}
          </span>
        )}
        {status === 'applied' && (
          <span className="text-xs font-medium text-success">{t('changes_applied')}</span>
        )}
        {status === 'rejected' && (
          <span className="text-xs font-medium text-error">{t('changes_rejected')}</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add missing i18n keys**

The new JSX uses keys that may not exist in the i18n file. Find the `arch_in_project` locale file (likely `packages/i18n/locales/en/arch_in_project.json` or similar — check the existing `useTranslations('arch_in_project')` calls in the file) and add:

```json
{
  "view_side_by_side": "Side-by-side",
  "view_inline": "Inline",
  "section_changed": "section changed",
  "sections_changed": "sections changed"
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS.

### Task 28: Fix any existing tests broken by the rewrite

- [ ] **Step 1: Find test files referencing the old API**

Run: `find apps/studio/src/__tests__ -name "*in-project-diff*" -o -name "*InProjectDiffCard*"`

If files exist, run: `pnpm test --filter=@agent-platform/studio -- --run in-project-diff`

- [ ] **Step 2: Update broken assertions**

Existing tests may reference `viewMode`, `computeLineDiff`, or per-`ChangeCard` iteration. Update them to the new API (no view mode state, single Monaco diff). Keep the tests small.

### Task 29: Commit

- [ ] **Step 1: Format**

```bash
npx prettier --write \
  apps/studio/src/components/arch-v3/panels/ArchDiffEditor.tsx \
  apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx \
  apps/studio/src/lib/arch-ai/compute-changed-sections.ts \
  apps/studio/src/__tests__/lib-arch-ai/compute-changed-sections.test.ts
```

- [ ] **Step 2: Commit**

```bash
git add \
  apps/studio/src/components/arch-v3/panels/ArchDiffEditor.tsx \
  apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx \
  apps/studio/src/lib/arch-ai/compute-changed-sections.ts \
  apps/studio/src/__tests__/lib-arch-ai/compute-changed-sections.test.ts
# Include i18n file updates and test-file updates if applicable
git diff --cached --name-only
git commit -m "[ABLP-162] feat(studio): Monaco diff editor for in-project modification review"
```

Expected: commit created.

---

## Commit 8 — Blocked-state rendering

**Commit message:** `[ABLP-162] feat(studio): blocked-state rendering for failed proposals`

### Task 30: Render the blocked banner in InProjectDiffCard

**Files:**

- Modify: `apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx`

- [ ] **Step 1: Add the blocked banner above the Monaco diff**

After the section chip bar JSX and before the Monaco diff JSX, insert:

```tsx
{
  /* Blocked error banner — lists ALL errors including dependent-agent and line-less ones */
}
{
  status === 'blocked' && validation && validation.errors.length > 0 && (
    <div className="mx-3 flex-shrink-0 rounded border border-error/30 bg-error/5 p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2 font-semibold text-error">
        <span>⚠</span>
        <span>{t('validation_failed_after_retries', { count: validation.repairAttempts })}</span>
      </div>
      <ul className="ml-4 list-disc space-y-0.5 text-error/90">
        {validation.errors.map((e, i) => (
          <li key={i}>
            {e.agent ? <strong>[{e.agent}] </strong> : null}
            {typeof e.line === 'number' && !e.agent ? <span>Line {e.line}: </span> : null}
            {e.message}
          </li>
        ))}
      </ul>
      {validation.hint && <p className="mt-2 text-[11px] text-error/70">{validation.hint}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Add the blocked state to the action bar**

In the action bar block, add a new case for `status === 'blocked'` after the `rejected` case:

```tsx
{
  status === 'blocked' && (
    <>
      <button
        type="button"
        disabled
        title={t('blocked_tooltip')}
        className="flex cursor-not-allowed items-center gap-1.5 rounded-md bg-success/30 px-3 py-1.5 text-xs font-medium text-success-foreground/50"
      >
        {t('accept')}
      </button>
      <button
        type="button"
        onClick={() => setModifyOpen(!modifyOpen)}
        className="flex items-center gap-1.5 rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
      >
        {t('modify_with_errors')}
      </button>
      <button
        type="button"
        onClick={onReject}
        className="flex items-center gap-1.5 rounded-md border border-error/30 bg-error/5 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10"
      >
        {t('reject')}
      </button>
    </>
  );
}
```

- [ ] **Step 3: Add the pre-fill effect**

At the top of the component body, after the `useState` declarations, add:

```tsx
// When entering a blocked state, pre-open the Modify textbox with a
// prompt that includes the compiler errors so the user can just hit Send.
React.useEffect(() => {
  if (status === 'blocked' && validation && validation.errors.length > 0 && !modifyOpen) {
    const errorLines = validation.errors
      .map((e) => {
        const prefix = e.agent
          ? `- [${e.agent}]`
          : typeof e.line === 'number'
            ? `- Line ${e.line}:`
            : '-';
        return `${prefix} ${e.message}`;
      })
      .join('\n');
    setFeedback(`Please fix these compiler errors:\n${errorLines}`);
    setModifyOpen(true);
  }
  // Only pre-fill on first entry into blocked; don't overwrite the user's edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [status]);
```

- [ ] **Step 4: Add missing i18n keys**

In the same `arch_in_project` locale file, add:

```json
{
  "validation_failed_after_retries": "Validation failed after {count} attempts",
  "blocked_tooltip": "Fix validation errors first",
  "modify_with_errors": "Send fix request"
}
```

### Task 31: Soften the bailout in InProjectArtifactPanel

**Files:**

- Modify: `apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx:233-253`

- [ ] **Step 1: Replace the diff case block**

Find the `case 'diff': { ... }` block and replace it with:

```tsx
    case 'diff': {
      const proposal = tab.data as ModificationProposal | undefined;
      const hasChanges = (proposal?.changes?.length ?? 0) > 0;
      const isBlocked = proposal?.reviewStatus === 'blocked';
      if (!proposal || (!hasChanges && !isBlocked)) {
        return (
          <div className="flex h-full items-center justify-center p-4 text-sm text-foreground-muted">
            {t('no_changes_yet')}
          </div>
        );
      }
      return (
        <div className="h-full overflow-y-auto p-4">
          <InProjectDiffCard
            changes={proposal.changes}
            status={proposal.reviewStatus ?? 'pending'}
            validation={proposal.validation}
            onAccept={onDiffAccept}
            onReject={onDiffReject}
            onModify={onDiffModify}
          />
        </div>
      );
    }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: PASS.

### Task 32: Commit

- [ ] **Step 1: Format**

```bash
npx prettier --write \
  apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx \
  apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx
```

- [ ] **Step 2: Commit**

```bash
git add \
  apps/studio/src/components/arch-v3/panels/InProjectDiffCard.tsx \
  apps/studio/src/components/arch-v3/panels/InProjectArtifactPanel.tsx
# Include i18n file updates
git commit -m "[ABLP-162] feat(studio): blocked-state rendering for failed proposals"
```

Expected: commit created.

---

## Commit 9 — End-to-end tests

**Commit message:** `[ABLP-162] test(studio): integration + E2E tests for in-project modification loop`

### Task 33: Scaffold the E2E test file (copying the canonical pattern)

**Files:**

- Create: `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`
- Reference (for copy): `apps/studio/src/__tests__/e2e/arch-ai-message-streaming.e2e.test.ts`

The canonical pattern in `arch-ai-message-streaming.e2e.test.ts` uses:

- `MongoMemoryServer` + a list of env vars (`MONGODB_URL`, `JWT_SECRET`, `ENCRYPTION_*`, etc.)
- A mock HTTP server emitting OpenAI-compatible responses, and an `ArchWorkspaceConfig` row in Mongo with `encryptedEndpoint: http://127.0.0.1:${mockLLMPort}/v1` pointing the tenant at it (not process.env)
- A dev-login helper to get a JWT
- Local `callRoute(...)` and `sendMessage(sessionId, body)` helpers

Do NOT use `process.env.OPENAI_BASE_URL` — that is not how model resolution is configured in this codebase. Use `ArchWorkspaceConfig`.

- [ ] **Step 1: Read the canonical setup block**

Run:

```bash
sed -n '1,260p' apps/studio/src/__tests__/e2e/arch-ai-message-streaming.e2e.test.ts
```

Note everything from the imports through `beforeAll` / `afterAll` / `callRoute` / `sendMessage`. You will copy this block verbatim as the scaffold.

- [ ] **Step 2: Create the new test file by copying the canonical scaffold**

Start `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts` with the same structure as `arch-ai-message-streaming.e2e.test.ts`:

1. Copy the top-level imports, `RouteModule`/`RouteContext` interfaces, `state`/`modules` globals, `startMockLLMServer`, `resetLLMBehavior`, `makeTextResponse`, `makeToolCallResponse`, `callRoute`, `sendMessage`, and both lifecycle hooks (`beforeAll`/`afterAll`) verbatim.
2. Rename the mongo db name from `arch_msg_e2e` to `arch_inproj_mod_e2e` so the two suites don't collide.
3. Rename the dev-login email from `arch-msg-e2e@test.local` to `arch-inproj-mod-e2e@test.local`.
4. After the `ArchWorkspaceConfig.create(...)` call, keep the setup the same.
5. Replace the existing `describe.sequential('Arch AI Message Streaming E2E', ...)` block with a new one that owns an IN_PROJECT session (see Step 3).

The scaffold additions that are NOT in the canonical file (scripted-responses pipeline):

```ts
// ─── Scripted LLM responses ─────────────────────────────────────────────
//
// The canonical mock server uses a single `llmResponseFn`. We override it
// to read from a scripted array, call-indexed, so a single POST /message
// request can drive the multi-turn loop through a precise sequence of
// tool calls.

const scriptedResponses: Array<Record<string, unknown>> = [];
let scriptedCallIndex = 0;

function setLLMScript(responses: Array<Record<string, unknown>>): void {
  scriptedResponses.length = 0;
  scriptedResponses.push(...responses);
  scriptedCallIndex = 0;
  llmRequests.length = 0;
}

/** Install the scripted-responses callback into the mock LLM server. Call inside beforeAll after resetLLMBehavior. */
function installScriptedResponseHandler(): void {
  llmResponseFn = () => {
    const response =
      scriptedResponses[scriptedCallIndex] ?? makeTextResponse('(scripted responses exhausted)');
    scriptedCallIndex++;
    return response;
  };
}
```

Call `installScriptedResponseHandler()` once inside `beforeAll` right after `resetLLMBehavior()`.

- [ ] **Step 3: Add the IN_PROJECT describe block**

After the `afterAll` hook, add:

```ts
const projectId = 'project-inproj-e2e';
const VALID_AGENT = `AGENT: LeadIntake\nGOAL: "Capture new leads"\nPERSONA: |\n  Be friendly.\n`;
const VALID_AGENT_UPDATED = `AGENT: LeadIntake\nGOAL: "Capture and qualify new leads"\nPERSONA: |\n  Be friendly and professional.\n`;
const INVALID_COMPLETION = VALID_AGENT_UPDATED + `COMPLETION:\n  - WHEN: "true"\n`;

async function seedAgent(name: string, code: string): Promise<void> {
  const { ProjectAgent } = await import('@agent-platform/database/models');
  await ProjectAgent.create({
    name,
    agentPath: `${projectId}/default/${name}`,
    projectId,
    tenantId: state.tenantId,
    dslContent: code,
    description: 'Seeded by E2E test',
    status: 'active',
  });
}

async function clearProjectAgents(): Promise<void> {
  const { ProjectAgent } = await import('@agent-platform/database/models');
  await ProjectAgent.deleteMany({ projectId });
}

/**
 * Parse the raw SSE stream produced by `sendMessage` into a flat array of
 * JSON event objects. Each non-empty `data: ...` line is one event.
 */
function parseSSEEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      // ignore malformed events
    }
  }
  return events;
}

/**
 * Post a user message to /api/arch-ai/message in IN_PROJECT mode and
 * return every tool_result event in order. The test MUST have already
 * called setLLMScript(...) with the scripted responses the loop should
 * consume.
 */
async function postMessageAndCollectToolResults(
  sessionId: string,
  userMessage: string,
): Promise<Array<{ toolName: string; result: Record<string, unknown> }>> {
  const { sseEvents } = await sendMessage(sessionId, {
    type: 'message',
    text: userMessage,
  });
  const events = parseSSEEvents(sseEvents);
  return events
    .filter((e) => e.type === 'tool_result')
    .map((e) => ({
      toolName: (e.toolName as string) ?? 'unknown',
      result: (e.result ?? {}) as Record<string, unknown>,
    }));
}

describe.sequential('Arch AI In-Project Modification Loop E2E', () => {
  let sessionId: string;

  beforeAll(async () => {
    // Create an IN_PROJECT session bound to the test projectId.
    const r = await callRoute(modules.sessions.POST!, {
      path: '/api/arch-ai/sessions',
      token: state.accessToken,
      body: { mode: 'IN_PROJECT', projectId },
    });
    expect(r.status).toBe(201);
    sessionId = r.json.sessionId as string;
  }, TEST_TIMEOUT);

  beforeEach(async () => {
    await clearProjectAgents();
    await seedAgent('LeadIntake', VALID_AGENT);
  });

  it('mock LLM scaffold wires up', () => {
    expect(mockLLMPort).toBeGreaterThan(0);
    expect(modules.message.POST).toBeDefined();
    expect(sessionId).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the scaffold**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai-inproject-modification`
Expected: the scaffold test PASSES. If the sessions POST rejects `mode: 'IN_PROJECT'` without a valid `projectId`, inspect `arch-ai-sessions.e2e.test.ts` for the exact session-creation signature and adjust the body.

### Task 34: Add the happy-path test

**Files:**

- Modify: `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`

The helper `postMessageAndCollectToolResults` already exists from Task 33. This task just drives it with scripted responses and asserts the pending proposal appears in the SSE stream. The accept flow (POST `action: 'accept'`) is already covered by the existing `applyProjectAgentModification` tests elsewhere and is not part of this spec's new behavior, so it's deliberately out of scope here.

- [ ] **Step 1: Replace the scaffold assertion with the real test**

Replace the `it('mock LLM scaffold wires up', ...)` test with:

```ts
it('happy path: valid propose_modification surfaces a pending proposal', async () => {
  setLLMScript([
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'Update goal and persona',
      updatedCode: VALID_AGENT_UPDATED,
    }),
    makeTextResponse('Proposal ready for review.'),
  ]);

  const toolResults = await postMessageAndCollectToolResults(sessionId, 'Update LeadIntake');

  expect(toolResults).toHaveLength(1);
  expect(toolResults[0].toolName).toBe('propose_modification');
  expect(toolResults[0].result.success).toBe(true);
  const proposal = toolResults[0].result.proposal as {
    reviewStatus?: string;
    validation?: { valid?: boolean };
  };
  expect(proposal.reviewStatus).toBe('pending');
  expect(proposal.validation?.valid).toBe(true);
});
```

`makeTextResponse` is the canonical helper you copied in Task 33 (it already exists in `arch-ai-message-streaming.e2e.test.ts`). If you named your local copy differently, use that name.

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai-inproject-modification`
Expected: the happy-path test PASSES. If the SSE stream contains no `tool_result` events, sniff the raw `sseEvents` string to see what event types the stream actually emits — the route may use `tool-result` (hyphen) or a different name. Check `route.ts` around line 2513 where it emits `{ type: 'tool_result', ... }`.

### Task 35: Add self-repair succeeds test

**Files:**

- Modify: `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`

- [ ] **Step 1: Add the test**

```ts
it('self-repair succeeds: invalid call 1 → valid call 2 → single pending proposal surfaces', async () => {
  setLLMScript([
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'Attempt 1',
      updatedCode: INVALID_COMPLETION,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'Attempt 2 fixed',
      updatedCode: VALID_AGENT_UPDATED,
    }),
    makeStopResponse('Proposal ready.'),
  ]);

  const toolResults = await postMessageAndCollectToolResults(sessionId, 'Fix the LeadIntake agent');

  expect(toolResults).toHaveLength(2);
  expect(toolResults[0].result.success).toBe(false);
  expect(toolResults[0].result.attemptedCode).toBe(INVALID_COMPLETION);
  expect(toolResults[0].result.attemptNumber).toBe(1);
  expect(toolResults[1].result.success).toBe(true);
  const proposal2 = toolResults[1].result.proposal as { reviewStatus?: string };
  expect(proposal2.reviewStatus).toBe('pending');
});
```

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai-inproject-modification`
Expected: 2 tests PASS.

### Task 36: Add repair cap reached test

**Files:**

- Modify: `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`

- [ ] **Step 1: Add the test**

```ts
it('repair cap reached: 3 failures → blocked proposal persisted in session', async () => {
  setLLMScript([
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'Attempt 1',
      updatedCode: INVALID_COMPLETION,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'Attempt 2',
      updatedCode: INVALID_COMPLETION,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'Attempt 3',
      updatedCode: INVALID_COMPLETION,
    }),
    makeStopResponse('(should not reach)'),
  ]);

  const toolResults = await postMessageAndCollectToolResults(sessionId, 'Add completion');

  expect(toolResults).toHaveLength(3);
  expect(toolResults[0].result.success).toBe(false);
  expect(toolResults[0].result.attemptNumber).toBe(1);
  expect(toolResults[1].result.success).toBe(false);
  expect(toolResults[1].result.attemptNumber).toBe(2);
  expect(toolResults[2].result.success).toBe(true);
  const blocked = toolResults[2].result.proposal as {
    reviewStatus?: string;
    validation?: { repairAttempts?: number };
  };
  expect(blocked.reviewStatus).toBe('blocked');
  expect(blocked.validation?.repairAttempts).toBe(3);

  // Session metadata assertion
  const { ArchSession } = await import('@agent-platform/database/models');
  const session = await ArchSession.findOne({ 'metadata.projectId': projectId });
  expect(session?.metadata.pendingMutation?.reviewStatus).toBe('blocked');
  expect(session?.metadata.pendingMutation?.validation?.repairAttempts).toBe(3);
});
```

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai-inproject-modification`
Expected: 3 tests PASS.

### Task 37: Add blocked-state-survives-reload test

**Files:**

- Modify: `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`

- [ ] **Step 1: Add the test**

```ts
it('blocked state survives page reload: ArchSession.pendingMutation carries validation', async () => {
  setLLMScript([
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'x',
      updatedCode: INVALID_COMPLETION,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'x',
      updatedCode: INVALID_COMPLETION,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'x',
      updatedCode: INVALID_COMPLETION,
    }),
    makeStopResponse('blocked'),
  ]);
  await postMessageAndCollectToolResults(sessionId, 'Add completion');

  const { ArchSession } = await import('@agent-platform/database/models');
  const sessionDoc = await ArchSession.findOne({ 'metadata.projectId': projectId });
  expect(sessionDoc).toBeTruthy();

  const pendingMutation = sessionDoc?.metadata.pendingMutation;
  expect(pendingMutation?.reviewStatus).toBe('blocked');
  expect(pendingMutation?.validation?.errors.length).toBeGreaterThan(0);
  expect(pendingMutation?.validation?.errors[0].message).toMatch(/COMPLETION|Unknown section/);
});
```

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai-inproject-modification`
Expected: 4 tests PASS.

### Task 38: Add modify-feedback-repairs test

**Files:**

- Modify: `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`

- [ ] **Step 1: Add the test**

```ts
it('modify feedback repairs blocked: new turn gets fresh repair budget', async () => {
  // Turn 1: block
  setLLMScript([
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'x',
      updatedCode: INVALID_COMPLETION,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'x',
      updatedCode: INVALID_COMPLETION,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'x',
      updatedCode: INVALID_COMPLETION,
    }),
    makeStopResponse('blocked'),
  ]);
  await postMessageAndCollectToolResults(sessionId, 'Add completion');

  // Turn 2: simulate user's pre-filled Modify textbox
  setLLMScript([
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'Fixed: use COMPLETE',
      updatedCode: VALID_AGENT_UPDATED,
    }),
    makeStopResponse('fixed'),
  ]);
  const turn2 = await postMessageAndCollectToolResults(
    sessionId,
    'Please fix these compiler errors:\n- Line 7: Unknown section: COMPLETION',
  );

  expect(turn2).toHaveLength(1);
  expect(turn2[0].result.success).toBe(true);
  const proposal = turn2[0].result.proposal as {
    reviewStatus?: string;
    validation?: { repairAttempts?: number };
  };
  expect(proposal.reviewStatus).toBe('pending');
  expect(proposal.validation?.repairAttempts).toBe(0);
});
```

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai-inproject-modification`
Expected: 5 tests PASS.

### Task 39: Add attemptedCode propagation test

**Files:**

- Modify: `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`

- [ ] **Step 1: Add the test**

```ts
it('attemptedCode propagates across multi-turn-executor turns within one request', async () => {
  setLLMScript([
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'x',
      updatedCode: INVALID_COMPLETION,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'x',
      updatedCode: INVALID_COMPLETION,
    }),
    makeStopResponse('will not reach'),
  ]);

  await postMessageAndCollectToolResults(sessionId, 'Fix LeadIntake');

  // After the first failure, the mock LLM's second request should have received
  // the failure result (including attemptedCode) as a tool-role message.
  expect(llmRequests.length).toBeGreaterThanOrEqual(2);
  const secondRequest = llmRequests[1].body as {
    messages: Array<{ role: string; content: string | unknown }>;
  };
  const toolMessages = secondRequest.messages.filter((m) => m.role === 'tool');
  expect(toolMessages.length).toBeGreaterThan(0);
  const lastToolMessage = toolMessages[toolMessages.length - 1];
  const lastToolMessageContent =
    typeof lastToolMessage.content === 'string'
      ? lastToolMessage.content
      : JSON.stringify(lastToolMessage.content);
  expect(lastToolMessageContent).toContain('attemptedCode');
  expect(lastToolMessageContent).toContain('COMPLETION');
});
```

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai-inproject-modification`
Expected: 6 tests PASS.

### Task 40: Add sequential-proposals singleton-tab test

**Files:**

- Modify: `apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`

- [ ] **Step 1: Add the test**

```ts
it('sequential proposals for different agents replace the single diff tab', async () => {
  await seedAgent(
    'QualifiedLeadHandler',
    VALID_AGENT.replace('LeadIntake', 'QualifiedLeadHandler'),
  );

  setLLMScript([
    makeToolCallResponse('propose_modification', {
      agentName: 'LeadIntake',
      change: 'rename goal',
      updatedCode: VALID_AGENT_UPDATED,
    }),
    makeToolCallResponse('propose_modification', {
      agentName: 'QualifiedLeadHandler',
      change: 'rename goal',
      updatedCode: VALID_AGENT_UPDATED.replace('LeadIntake', 'QualifiedLeadHandler'),
    }),
    makeStopResponse('both proposed'),
  ]);

  const toolResults = await postMessageAndCollectToolResults(
    sessionId,
    'Rename goals in both agents',
  );

  expect(toolResults).toHaveLength(2);
  const p0 = toolResults[0].result.proposal as { agentName?: string };
  const p1 = toolResults[1].result.proposal as { agentName?: string };
  expect(p0.agentName).toBe('LeadIntake');
  expect(p1.agentName).toBe('QualifiedLeadHandler');

  // This test documents the current singleton-tab behavior. The store upserts
  // to the first diff tab, so only QualifiedLeadHandler's proposal survives.
  // See spec Open Question #6 for the multi-tab future.
});
```

- [ ] **Step 2: Run**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai-inproject-modification`
Expected: 7 tests PASS.

### Task 41: Commit

- [ ] **Step 1: Format**

Run: `npx prettier --write apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts`

- [ ] **Step 2: Commit**

```bash
git add apps/studio/src/__tests__/e2e/arch-ai-inproject-modification.e2e.test.ts
git commit -m "[ABLP-162] test(studio): integration + E2E tests for in-project modification loop"
```

Expected: commit created.

---

## Postflight

- [ ] **PF1. Full arch-ai test suite**

Run: `pnpm test --filter=@agent-platform/arch-ai`
Expected: PASS. Includes the new `prompts-compile` test.

- [ ] **PF2. Studio arch-ai test subset**

Run: `pnpm test --filter=@agent-platform/studio -- --run arch-ai`
Expected: PASS. Includes the new integration and E2E tests.

- [ ] **PF3. Full build**

Run: `pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio`
Expected: PASS.

- [ ] **PF4. Confirm commit graph**

Run: `git log --oneline features/arch-ai -n 12`
Expected: nine new commits with `[ABLP-162]` prefixes, matching the sequence in the spec.

- [ ] **PF5. Manual smoke test (optional but recommended)**

Start Studio in dev mode (`pnpm dev --filter=@agent-platform/studio` or the project's equivalent). Open an existing project, invoke Arch AI, and try:

- "Rename the LeadIntake agent's goal to 'Capture and qualify new leads'" — verify a diff tab opens with Monaco side-by-side, the GOAL section chip appears, clicking it scrolls the diff, Accept updates the DB.
- If you can reproduce a failure case, verify the repair log surfaces in stdout, and the card either recovers or shows the blocked state with errors and a pre-filled Modify textbox.

---

## Rollback

If any commit turns out to be wrong, revert it with `git revert <sha>` and investigate. The most impactful single revert is Commit 6 (`feat(studio): validate ABL in propose_modification + request-scoped repair counter`) which restores apply-time-only validation. Commits 3, 4, and 5 are pure type/refactor commits and are safe standalone even if later commits are reverted.

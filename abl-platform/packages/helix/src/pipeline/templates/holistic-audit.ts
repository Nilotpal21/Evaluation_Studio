import type { PipelineTemplate } from '../../types.js';
import {
  ACCEPTANCE_VERIFICATION_REVIEW_GUIDANCE,
  IMPLEMENTATION_QUALITY_REVIEW_GUIDANCE,
  PLAN_QUALITY_REVIEW_GUIDANCE,
  PRODUCTION_READINESS_REVIEW_GUIDANCE,
  SECURITY_AUDIT_STAGE_GUIDANCE,
  SECURITY_ISOLATION_REVIEW_GUIDANCE,
  UX_DESIGN_AUDIT_STAGE_GUIDANCE,
  WIRING_VERIFICATION_REVIEW_GUIDANCE,
} from '../model-review-prompts.js';
import { withHelixRepoNativeTools } from '../native-tools.js';
import { withCodexReviewFallback } from './review-models.js';

const MINUTE_MS = 60_000;
const CLAUDE_OPUS_4_7_MODEL = 'claude-opus-4-7';
const VERIFICATION_BOOTSTRAP_TIMEOUT_MS = 5 * MINUTE_MS;
const DEEP_SCAN_TIMEOUT_MS = 15 * MINUTE_MS;
const ORACLE_ANALYSIS_TIMEOUT_MS = 8 * MINUTE_MS;
const PLAN_GENERATION_TIMEOUT_MS = 8 * MINUTE_MS;
const PLAN_QUALITY_TIMEOUT_MS = 3 * MINUTE_MS;
const MANIFEST_COMPILATION_TIMEOUT_MS = 30 * MINUTE_MS;
const IMPLEMENTATION_TIMEOUT_MS = 90 * MINUTE_MS;
const SECURITY_AUDIT_TIMEOUT_MS = 8 * MINUTE_MS;
const UX_DESIGN_AUDIT_TIMEOUT_MS = 8 * MINUTE_MS;
const E2E_TIMEOUT_MS = 12 * MINUTE_MS;
const E2E_QUALITY_TIMEOUT_MS = 6 * MINUTE_MS;
const REGRESSION_TIMEOUT_MS = 15 * MINUTE_MS;
const REGRESSION_QUALITY_TIMEOUT_MS = 12 * MINUTE_MS;
const BULK_REVIEW_TIMEOUT_MS = 8 * MINUTE_MS;
const DOC_SYNC_TIMEOUT_MS = 5 * MINUTE_MS;

// ── Oracle System Prompts (must be declared before pipeline) ──

const CODEBASE_ORACLE_PROMPT = `You are the CODEBASE ORACLE — your lens is the actual code.

Focus on:
- What code paths exist for this feature
- Which are redundant or duplicated
- Which exports are unused (dead code)
- Which imports are missing or broken
- Which components exist but aren't wired into the runtime

You verify facts by reading files. You don't speculate about architecture
or design — you report what the code actually does.

For each finding, output:
FINDING: [severity] [category] Description

For ambiguous situations:
DECISION: [AMBIGUOUS] Your question`;

const ARCHITECTURE_ORACLE_PROMPT = `You are the ARCHITECTURE ORACLE — your lens is platform principles and patterns.

Focus on:
- Does the code follow platform principles (resource isolation, centralized auth, stateless distributed, traceability, compliance, performance)?
- Are there inconsistencies in how different parts of the feature implement the same concern?
- Does the error handling follow structured response patterns?
- Is there proper tenant/project/user isolation?
- Are distributed patterns correct (Redis locks, cache invalidation, event sourcing)?

You judge code against architectural standards. Read the platform-principles
and code-standards documentation.

For each finding, output:
FINDING: [severity] [category] Description

For ambiguous situations:
DECISION: [AMBIGUOUS] Your question`;

const TESTING_ORACLE_PROMPT = `You are the TESTING ORACLE — your lens is test quality and coverage.

Focus on:
- Which code paths have NO test coverage?
- Which tests use mocks where they should use real implementations?
- Which E2E tests are missing (minimum 5 per feature)?
- Which integration tests are missing (minimum 5 per feature)?
- Do tests exercise the full middleware chain (auth, validation, isolation)?
- Do tests cover error paths, not just happy paths?
- Are there tests that would pass even if the feature is broken (false confidence)?

You are skeptical of tests. A test that mocks everything proves nothing.

For each finding, output:
FINDING: [severity] [missing-test] Description

For ambiguous situations:
DECISION: [AMBIGUOUS] Your question`;

const DOMAIN_ORACLE_PROMPT = `You are the DOMAIN ORACLE — your lens is feature correctness and completeness.

Focus on:
- Does the implementation match the feature specification?
- Are all user stories covered?
- Are all functional requirements met?
- Are edge cases handled (empty input, concurrent access, large payloads)?
- Does the behavior make sense from a user's perspective?
- Are there missing error messages or unhelpful error responses?

Read the feature spec carefully. Compare every requirement against
the actual implementation.

For each finding, output:
FINDING: [severity] [category] Description

For ambiguous situations:
DECISION: [AMBIGUOUS] Your question`;

const PLATFORM_ORACLE_PROMPT = `You are the PLATFORM ORACLE — your lens is this codebase's established conventions and invariants.

Focus on:
- Read CLAUDE.md (root). Does the implementation violate any CRITICAL rules?
  (tenant isolation in every DB query, centralized auth only, no sync I/O, no console.log,
   structured error envelopes, Zod z.string().min(1) for IDs, no swallowed catches)
- Read .claude/skills/platform-principles/SKILL.md. Which platform patterns apply to this
  feature, and are they followed?
- Is the feature reinventing something already present in the codebase?
  (e.g., custom caching when Redis helpers exist, custom locking when distributed-lock
   helpers exist, custom error formatting when envelope helpers exist)
- Does the data model introduce duplicate MongoDB collections or Redis key namespaces?
- Are all new exported symbols correctly wired through their DI/startup chains?
- Does the API surface follow the project's route naming and ownership scoping conventions?

You read code AND platform documentation. Flag invariant violations at HIGH or CRITICAL.
Flag reinvented wheels at MEDIUM unless they introduce isolation or correctness risk.

For each finding, output:
FINDING: [severity] [category] Description

For ambiguous situations:
DECISION: [AMBIGUOUS] Your question`;

const INDUSTRY_RESEARCH_ORACLE_PROMPT = `You are the INDUSTRY RESEARCH ORACLE — your lens is industry best practice for this feature domain.

Focus on:
- Web-search for the authoritative patterns, RFCs, or standards for this feature class.
  Find at least 2 reputable sources (engineering blogs from companies at scale, IETF/W3C
  specs, OWASP guides, well-known conference talks).
- How do 2-3 comparable production SaaS systems or well-maintained OSS projects implement
  this feature? What design decisions did they converge on?
- What are the known failure modes, performance cliffs, or security antipatterns for this
  class of feature? Does the implementation address them?
- Is the chosen algorithm/protocol/pattern mainstream, experimental, or deprecated
  according to industry experience?
- Are there missing operational concerns (deployment sequencing, backward compatibility,
  migration risks) that industry experience flags for this implementation pattern?

Web-search first, then compare findings against the actual implementation.
Tag each finding with the source URL that informed it.

For each finding, output:
FINDING: [severity] [category] Description — Source: <url>

For ambiguous situations:
DECISION: [AMBIGUOUS] Your question`;

const E2E_FLOW_ORACLE_PROMPT = `You are the END-TO-END FLOW ORACLE — your lens is the full request lifecycle across system layers.

Trace the feature's data flow through every layer it touches:

  Studio UI/Forms → Studio API routes → Mongoose models / Mongo persistence
                  → DSL / AgentIR compilation → Runtime execution
                  → Runtime traces / outputs → Studio response / WebSocket

For each layer boundary, look for issues other oracles miss because they only see one side:

1. SCHEMA DRIFT between layers:
   - Studio form sends fields that the API route doesn't validate / strips
   - API request shape diverges from the Mongoose schema (extra/missing fields)
   - Mongoose schema fields not present in DSL / AgentIR after compilation
   - IR fields silently lost during runtime hydration

2. AUTH / TENANT SCOPING propagation:
   - Studio API has tenantId in req but doesn't pass it to the model query
   - Mongoose query lacks tenantId filter, returns cross-tenant data
   - DSL compilation strips ownership metadata
   - Runtime executes without checking the session's tenant/project

3. SERIALIZATION mismatches at boundaries:
   - Date / ObjectId / Buffer / BigInt encoded differently across layers
   - Encrypted fields silently nulled on legacy reads
   - JSON roundtrip drops typed values (Map → object, Set → array)

4. ERROR PROPAGATION:
   - Runtime errors swallowed; Studio sees only "agent returned empty response"
   - Mongoose validation errors not surfaced to the Studio UI as field errors
   - DSL compile errors don't show line/column info to the user
   - 500s leak internal stack traces / tenant IDs / model IDs

5. RACE CONDITIONS at boundaries:
   - Studio writes a config doc; Runtime reads stale IR cached before the write
   - Two Studio sessions edit the same agent; last-write-wins instead of optimistic-lock
   - Runtime checkpoint write races with session.json persistence

6. SIDE EFFECTS not flowing back:
   - Runtime emits TraceEvent that never reaches Studio observability
   - Embedding / index updates committed in DB but not visible to Studio search
   - Cost / token usage tracked in runtime but not aggregated to Studio billing UI

For each boundary you trace, name:
- the source file at the upstream layer (path:line)
- the consumer file at the downstream layer (path:line)
- the field / value being passed
- whether the contract holds across the layers, and if not, where it breaks

You do NOT need to enumerate every field — focus on the FEATURE'S critical-path values.

For each finding, output:
FINDING: [severity] [category] Description — Boundary: <upstream> → <downstream>, Field: <name>, Break: <where>

Use 'cross-layer-consistency', 'schema-drift', 'auth-propagation', 'serialization', 'error-propagation', 'race-condition', 'side-effect-leak' as categories.

For ambiguous situations:
DECISION: [AMBIGUOUS] Your question`;

const OSS_LIBRARY_ORACLE_PROMPT = `You are the OSS LIBRARY ORACLE — your lens is existing open-source solutions.

Focus on:
- For each major piece of custom logic in this implementation, search for existing
  npm/OSS libraries that already provide it.
- For each candidate library, assess:
  - License: MIT/Apache OK, GPL is incompatible with commercial SaaS (flag CRITICAL)
  - Maintenance: last release date, weekly npm downloads, open issue count
  - Quality: stars, known security issues, TypeScript support
- Recommend: adopt as-is / vendor+fork / reference-only / avoid — with one-line reason
- Flag any custom implementation where a well-maintained OSS library with a compatible
  license would reduce code, risk, or maintenance burden
- Check if the monorepo already imports a library that could cover this use case —
  adding a new dependency when an existing one suffices is always worse

Web-search for npm packages and GitHub repos before drawing conclusions.
Tag each recommendation with the npm package name and license.

For each finding, output:
FINDING: [severity] [oss-opportunity] Description — Package: <name> (<license>)

For ambiguous situations:
DECISION: [AMBIGUOUS] Your question`;

/**
 * Holistic Feature Audit Pipeline
 *
 * Looks at a feature end-to-end: finds redundancies, wiring gaps,
 * inconsistencies, bugs, missing tests. Creates a sliced plan,
 * then executes slice-by-slice with commits and reviews.
 *
 * Model strategy:
 * - Deep scan: Codex (deep codebase reading)
 * - Oracle analysis: Claude Opus (multiple oracles in parallel)
 * - Plan generation: Claude Opus (architecture perspective)
 * - Implementation: Codex (safe refactoring, incremental commits)
 * - Review: Claude Opus layered on top
 * - Testing: Codex (writes comprehensive E2E)
 */
export const holisticAuditPipeline: PipelineTemplate = {
  name: 'Holistic Feature Audit',
  description:
    'Deep audit of an existing feature — find all gaps, plan fixes, execute slice-by-slice',
  applicableTo: ['feature-audit', 'enhancement'],
  stages: [
    {
      name: 'Verification Bootstrap',
      type: 'bootstrap',
      description:
        'Prepare the scoped verification substrate: clear generated type noise, prebuild scoped workspace dependencies, and capture any clean-worktree baseline diagnostics before the audit starts.',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: VERIFICATION_BOOTSTRAP_TIMEOUT_MS,
    },

    // ─── Stage 1: Deep Scan ───────────────────────────────────
    {
      name: 'Deep Scan',
      type: 'deep-scan',
      description:
        'Deep read of the feature codebase — finds gaps, wiring issues, redundancies, bugs',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
          maxTurns: 100,
        },
        fallback: {
          engine: 'claude-code',
          model: 'opus',
          maxTurns: 200,
          maxBudgetUsd: 50,
          permissionMode: 'default',
        },
      },
      outputSchema: { id: 'analysis-report' },
      tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: DEEP_SCAN_TIMEOUT_MS,
    },

    // ─── Stage 2: Multi-Oracle Analysis ───────────────────────
    {
      name: 'Oracle Analysis',
      type: 'oracle-analysis',
      description: 'Multiple Claude oracles analyze Codex findings from different perspectives',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'opus',
          maxTurns: 30,
          maxBudgetUsd: 25,
        },
      },
      parallel: true,
      timeoutMs: ORACLE_ANALYSIS_TIMEOUT_MS,
      substages: [
        {
          name: 'Codebase Oracle',
          type: 'oracle-analysis',
          description: 'What code exists, what is redundant, what is dead?',
          model: {
            primary: {
              engine: 'claude-code',
              model: 'sonnet',
              maxTurns: 20,
              maxBudgetUsd: 5,
              systemPrompt: CODEBASE_ORACLE_PROMPT,
            },
          },
          outputSchema: { id: 'oracle-review' },
          tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
          canLoop: false,
          maxLoopIterations: 1,
        },
        {
          name: 'Architecture Oracle',
          type: 'oracle-analysis',
          description: 'What violates platform principles, patterns, consistency?',
          model: {
            primary: {
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 10,
              systemPrompt: ARCHITECTURE_ORACLE_PROMPT,
            },
          },
          outputSchema: { id: 'oracle-review' },
          tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
          canLoop: false,
          maxLoopIterations: 1,
        },
        {
          name: 'Testing Oracle',
          type: 'oracle-analysis',
          description: 'What is untested, what tests are fake, what E2E is missing?',
          model: {
            primary: {
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 10,
              systemPrompt: TESTING_ORACLE_PROMPT,
            },
          },
          outputSchema: { id: 'oracle-review' },
          tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
          canLoop: false,
          maxLoopIterations: 1,
        },
        {
          name: 'Domain Oracle',
          type: 'oracle-analysis',
          description: 'What behavior is wrong or incomplete per the feature spec?',
          model: {
            primary: {
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 10,
              systemPrompt: DOMAIN_ORACLE_PROMPT,
            },
          },
          outputSchema: { id: 'oracle-review' },
          tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
          canLoop: false,
          maxLoopIterations: 1,
        },
        {
          name: 'Platform Oracle',
          type: 'oracle-analysis',
          description:
            'What violates CLAUDE.md invariants, reinvents existing platform capabilities, or breaks established conventions?',
          model: {
            primary: {
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 10,
              systemPrompt: PLATFORM_ORACLE_PROMPT,
            },
          },
          outputSchema: { id: 'oracle-review' },
          tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
          canLoop: false,
          maxLoopIterations: 1,
        },
        {
          name: 'Industry Research Oracle',
          type: 'oracle-analysis',
          description:
            'What does industry experience say about this implementation — best practices, failure modes, competitive patterns?',
          model: {
            primary: {
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 15,
              systemPrompt: INDUSTRY_RESEARCH_ORACLE_PROMPT,
            },
          },
          outputSchema: { id: 'oracle-review' },
          tools: withHelixRepoNativeTools(['Read', 'WebFetch', 'WebSearch']),
          canLoop: false,
          maxLoopIterations: 1,
        },
        {
          name: 'End-to-End Flow Oracle',
          type: 'oracle-analysis',
          description:
            'Trace the feature data flow Studio → DB → DSL/IR → Runtime → response. Catch boundary issues other oracles miss: schema drift, auth/tenant propagation gaps, serialization mismatches, swallowed errors, races, lost side effects.',
          model: {
            primary: {
              engine: 'codex-cli',
              model: 'gpt-5.5',
              maxTurns: 40,
              maxBudgetUsd: 20,
              effort: 'high',
              permissionMode: 'acceptEdits',
              systemPrompt: E2E_FLOW_ORACLE_PROMPT,
            },
            fallback: {
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 30,
              maxBudgetUsd: 15,
              systemPrompt: E2E_FLOW_ORACLE_PROMPT,
            },
          },
          outputSchema: { id: 'oracle-review' },
          tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
          canLoop: false,
          maxLoopIterations: 1,
        },
        {
          name: 'OSS Library Oracle',
          type: 'oracle-analysis',
          description:
            'What existing open-source libraries could replace or simplify custom implementations in this feature?',
          model: {
            primary: {
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 15,
              systemPrompt: OSS_LIBRARY_ORACLE_PROMPT,
            },
          },
          outputSchema: { id: 'oracle-review' },
          tools: withHelixRepoNativeTools(['Read', 'WebFetch', 'WebSearch']),
          canLoop: false,
          maxLoopIterations: 1,
        },
      ],
      canLoop: false,
      maxLoopIterations: 1,
    },

    // ─── Stage 3: User Checkpoint — Approve Findings ──────────
    {
      name: 'Findings Review',
      type: 'user-checkpoint',
      description: 'Review findings and oracle analysis. Approve to proceed with planning.',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      checkpoint: 'user-approval',
    },

    // ─── Stage 4: Plan Generation ─────────────────────────────
    {
      name: 'Plan Generation',
      type: 'plan-generation',
      description:
        'Create a sliced implementation plan — group findings into committable milestones',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'opus',
          maxTurns: 25,
          maxBudgetUsd: 15,
        },
      },
      outputSchema: { id: 'slice-plan' },
      tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 3,
      timeoutMs: PLAN_GENERATION_TIMEOUT_MS,
      qualityGate: {
        name: 'Plan Quality',
        checks: [
          {
            name: 'Plan is seam-aware and future-proof',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              effort: 'medium',
              maxTurns: 15,
              maxBudgetUsd: 10,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob']),
            prompt: PLAN_QUALITY_REVIEW_GUIDANCE,
            reviewOutputSchema: { id: 'plan-review', strict: true },
          },
        ],
        passThreshold: 1.0,
        failAction: 'loop',
        timeoutMs: PLAN_QUALITY_TIMEOUT_MS,
      },
    },

    // ─── Stage 5: User Checkpoint — Approve Plan ──────────────
    {
      name: 'Plan Approval',
      type: 'user-checkpoint',
      description: 'Review the sliced plan. Approve to begin implementation.',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      checkpoint: 'user-approval',
    },

    // ─── Stage 6: Manifest Compilation ───────────────────────
    {
      name: 'Manifest Compilation',
      type: 'manifest-compilation',
      description:
        'Compile repo-backed slice manifests: file contracts, entry conditions, exports, and impact hints',
      model: { primary: { engine: 'claude-code' } },
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: MANIFEST_COMPILATION_TIMEOUT_MS,
    },

    // ─── Stage 7: Execute Slices ──────────────────────────────
    // This is a meta-stage — the pipeline engine will expand this
    // into per-slice stages based on the plan from Stage 4.
    {
      name: 'Implementation',
      type: 'implementation',
      description:
        'Implement fixes slice-by-slice. Codex implements, then Claude runs a blocking review plus second-opinion pass.',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
          permissionMode: 'bypassPermissions',
        },
        fallback: {
          engine: 'claude-code',
          model: 'opus',
          maxTurns: 50,
          maxBudgetUsd: 30,
          permissionMode: 'acceptEdits',
        },
        layered: [
          {
            engine: 'claude-code',
            model: 'claude-sonnet-4-6',
            maxTurns: 40,
            maxBudgetUsd: 8,
          },
        ],
      },
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 3,
      timeoutMs: IMPLEMENTATION_TIMEOUT_MS,
      qualityGate: {
        name: 'Slice Quality',
        checks: [
          { name: 'TypeScript compiles', type: 'typecheck' },
          { name: 'Tests pass', type: 'test' },
          { name: 'Code formatted', type: 'lint' },
          {
            name: 'Implementation is architecturally durable',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              effort: 'medium',
              maxTurns: 60,
              maxBudgetUsd: 10,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: IMPLEMENTATION_QUALITY_REVIEW_GUIDANCE,
          },
          {
            name: 'Wiring and consumer verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              effort: 'medium',
              maxTurns: 30,
              maxBudgetUsd: 8,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: WIRING_VERIFICATION_REVIEW_GUIDANCE,
          },
          {
            name: 'Security and isolation verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 30,
              maxBudgetUsd: 8,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: SECURITY_ISOLATION_REVIEW_GUIDANCE,
          },
        ],
        passThreshold: 1.0,
        failAction: 'loop',
      },
    },

    // ─── Stage 8: E2E Testing ─────────────────────────────────
    {
      name: 'Security Audit',
      type: 'review',
      description:
        'Claude Opus 4.7 audits the implemented slices for blocking security and isolation gaps, and remediates scoped issues before wider test passes.',
      model: {
        primary: {
          engine: 'claude-code',
          model: CLAUDE_OPUS_4_7_MODEL,
          maxTurns: 20,
          maxBudgetUsd: 15,
          permissionMode: 'acceptEdits',
        },
      },
      outputSchema: { id: 'analysis-report', strict: true },
      prompt: `You are performing the HELIX Security Audit stage.

## Feature
Title: {{title}}
Description: {{description}}
Scope: {{scope}}

## Previous Iteration Output
{{previousOutput}}

${SECURITY_AUDIT_STAGE_GUIDANCE}`,
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: SECURITY_AUDIT_TIMEOUT_MS,
      qualityGate: {
        name: 'Security Audit Clearance',
        checks: [{ name: 'No blocking security findings remain', type: 'analysis-report-clear' }],
        passThreshold: 1.0,
        failAction: 'loop',
      },
    },

    {
      name: 'UX Design Audit',
      type: 'review',
      description:
        'Claude Opus 4.7 audits the touched user-facing surfaces for blocking UX and accessibility issues, and remediates scoped issues before broader test passes.',
      model: {
        primary: {
          engine: 'claude-code',
          model: CLAUDE_OPUS_4_7_MODEL,
          effort: 'medium',
          maxTurns: 20,
          maxBudgetUsd: 15,
          permissionMode: 'acceptEdits',
        },
      },
      outputSchema: { id: 'analysis-report', strict: true },
      prompt: `You are performing the HELIX UX Design Audit stage.

## Feature
Title: {{title}}
Description: {{description}}
Scope: {{scope}}

## Previous Iteration Output
{{previousOutput}}

${UX_DESIGN_AUDIT_STAGE_GUIDANCE}`,
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: UX_DESIGN_AUDIT_TIMEOUT_MS,
      qualityGate: {
        name: 'UX Design Audit Clearance',
        checks: [{ name: 'No blocking UX findings remain', type: 'analysis-report-clear' }],
        passThreshold: 1.0,
        failAction: 'loop',
      },
    },

    // ─── Stage 10: E2E Testing ────────────────────────────────
    {
      name: 'E2E Testing',
      type: 'testing',
      description: 'Write and run comprehensive E2E tests for the entire feature',
      model: {
        primary: {
          engine: 'codex-cli',
          model: 'gpt-5.5',
          effort: 'medium',
          permissionMode: 'bypassPermissions',
        },
        fallback: {
          engine: 'claude-code',
          model: 'opus',
          maxTurns: 40,
          maxBudgetUsd: 30,
          permissionMode: 'acceptEdits',
        },
        layered: [
          {
            engine: 'claude-code',
            model: 'opus',
            effort: 'medium',
            maxTurns: 15,
            maxBudgetUsd: 10,
            systemPrompt:
              'Review these E2E tests. Verify: no mocks of codebase components, real HTTP API calls, full middleware chain, multiple content types tested.',
          },
        ],
      },
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']),
      canLoop: true,
      maxLoopIterations: 3,
      timeoutMs: E2E_TIMEOUT_MS,
      qualityGate: {
        name: 'E2E Quality',
        checks: [
          { name: 'Tests pass', type: 'test' },
          {
            name: 'No mocks in E2E',
            type: 'custom-script',
            command:
              'rg -n --glob "*e2e*.test.ts" "vi\\.mock|jest\\.mock" src/__tests__ && exit 1 || exit 0',
          },
          {
            name: 'Acceptance verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              effort: 'medium',
              maxTurns: 25,
              maxBudgetUsd: 10,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: ACCEPTANCE_VERIFICATION_REVIEW_GUIDANCE,
          },
        ],
        passThreshold: 1.0,
        failAction: 'loop',
        timeoutMs: E2E_QUALITY_TIMEOUT_MS,
      },
    },

    // ─── Stage 11: Full Regression ────────────────────────────
    {
      name: 'Regression',
      type: 'regression',
      description: 'Run the full regression suite across all affected packages',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 20,
          maxBudgetUsd: 10,
        },
      },
      tools: withHelixRepoNativeTools(['Bash', 'Read']),
      canLoop: true,
      maxLoopIterations: 2,
      timeoutMs: REGRESSION_TIMEOUT_MS,
      qualityGate: {
        name: 'Regression Suite',
        checks: [
          { name: 'All tests pass', type: 'test' },
          {
            name: 'Scenario-mapped Jira evidence exists',
            type: 'scenario-evidence',
          },
          {
            name: 'Production readiness verification',
            type: 'model-review',
            model: withCodexReviewFallback({
              engine: 'claude-code',
              model: 'opus',
              maxTurns: 20,
              maxBudgetUsd: 10,
            }),
            tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
            prompt: PRODUCTION_READINESS_REVIEW_GUIDANCE,
          },
          {
            name: 'Replay target seam coverage',
            type: 'replay-target-coverage',
          },
        ],
        passThreshold: 1.0,
        failAction: 'stop',
        timeoutMs: REGRESSION_QUALITY_TIMEOUT_MS,
      },
    },

    // ─── Stage 12: Deferred Bulk Review ───────────────────────
    {
      name: 'Deferred Bulk Review',
      type: 'bulk-review',
      description:
        'Aggregate review of slices that were auto-committed under the autonomy threshold',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'opus',
          effort: 'medium',
          maxTurns: 25,
          maxBudgetUsd: 15,
        },
      },
      outputSchema: { id: 'analysis-report', strict: true },
      tools: withHelixRepoNativeTools(['Read', 'Grep', 'Glob', 'Bash']),
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: BULK_REVIEW_TIMEOUT_MS,
    },

    // ─── Stage 13: Doc Sync ───────────────────────────────────
    {
      name: 'Doc Sync',
      type: 'doc-sync',
      description: 'Update feature spec, agents.md, and SDLC logs to reflect changes',
      model: {
        primary: {
          engine: 'claude-code',
          model: 'sonnet',
          maxTurns: 15,
          maxBudgetUsd: 5,
          permissionMode: 'acceptEdits',
        },
      },
      tools: withHelixRepoNativeTools(['Read', 'Write', 'Edit', 'Grep', 'Glob']),
      canLoop: false,
      maxLoopIterations: 1,
      timeoutMs: DOC_SYNC_TIMEOUT_MS,
    },
  ],
};

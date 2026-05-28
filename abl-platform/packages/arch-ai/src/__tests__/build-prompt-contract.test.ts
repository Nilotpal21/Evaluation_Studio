import { describe, expect, it } from 'vitest';

import { getFixTemplate } from '../diagnostics/fix-templates.js';
import { PLATFORM_LIMITS_CARD } from '../knowledge/platform-limits.js';
import { CEL_FUNCTIONS_CARD } from '../knowledge/cards/generated/cel-functions.js';
import { BUILD_PHASE_PROMPT, renderBuildPhasePrompt } from '../prompts/phases/build.js';
import { INTERVIEW_PHASE_PROMPT } from '../prompts/phases/interview.js';
import { IN_PROJECT_PHASE_PROMPT } from '../prompts/phases/in-project.js';
import { composeInProjectPrompt } from '../prompts/index.js';
import { ABL_CONSTRUCT_EXPERT_SYNTAX } from '../prompts/specialists/abl-construct-expert.js';
import { IN_PROJECT_GENERALIST_PROMPT } from '../prompts/specialists/in-project-generalist.js';
import { MULTI_AGENT_ARCHITECT_PROMPT } from '../prompts/specialists/multi-agent-architect.js';

describe('build prompt contract', () => {
  it('removes stale auth and tool requirements from the shared build prompts', () => {
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain('user_authenticated');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain('warning (not error)');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain(
      'runtime boolean expressions over declared state',
    );
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain('resolution_confirmed == true');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain('RESPOND: ""');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain(
      'Do not omit `RESPOND` — the runtime falls back to `conversation_complete`.',
    );
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain('history: auto');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain('strict summary-only transfer');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain('ON_RETURN:');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain(
      'already merges child gathered fields back to the parent by same name',
    );
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain(
      'Only reference child fields in `ON_RETURN.map` that the target agent actually gathers or populates',
    );
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain('Child agents return by reaching COMPLETE');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain(
      'Specialist (AGENT) with HANDOFF: ALSO include a catch-all',
    );
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain('context.memory_grants');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain('    REASON: "Collected');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain('Mode is implicit');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain('MODE:');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain('mock/placeholder URLs are valid');
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain("Welcome! I'll help you get started.");
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).not.toContain(
      'Thanks {{full_name}}! Registered {{email}}.',
    );
    expect(ABL_CONSTRUCT_EXPERT_SYNTAX).toContain(
      'Registration noted for {{class_name}} on {{preferred_date}}.',
    );

    expect(BUILD_PHASE_PROMPT).not.toContain('user_authenticated');
    expect(BUILD_PHASE_PROMPT).not.toContain('2 tools with HTTP bindings');
    expect(BUILD_PHASE_PROMPT).not.toContain('MODE, TOOLS');
    expect(BUILD_PHASE_PROMPT).not.toContain('MODE:');
    expect(BUILD_PHASE_PROMPT).not.toContain('{{env.SERVICE_BASE_URL}}/v1/path');
    // Round-2 TOOLS-contract update (Fix #1): tools are declared as contracts;
    // bindings are provisioned in a separate step. We still forbid embedding
    // concrete HTTP URLs inside agent ABL, just not all tool declarations.
    expect(BUILD_PHASE_PROMPT).toContain('Declare TOOLS for every callable');
    expect(BUILD_PHASE_PROMPT).toContain('Do NOT invent fake HTTP endpoints with concrete URLs');
    expect(BUILD_PHASE_PROMPT).not.toContain('Do not invent placeholder HTTP tools.');
    expect(BUILD_PHASE_PROMPT).not.toContain(
      'do NOT invent TOOLS when no real bindings exist yet.',
    );
    expect(BUILD_PHASE_PROMPT).toContain('RESPOND: ""');
    expect(BUILD_PHASE_PROMPT).toContain('history: auto');
    expect(BUILD_PHASE_PROMPT).toContain('strict summary-only transfer');
    expect(BUILD_PHASE_PROMPT).toContain('ON_RETURN:');
    expect(BUILD_PHASE_PROMPT).toContain(
      'already default-merges child gathered fields back to the parent by same name',
    );
    expect(BUILD_PHASE_PROMPT).toContain(
      'Only map child fields the target agent actually gathers or populates.',
    );
    expect(BUILD_PHASE_PROMPT).toContain('do NOT add a');
    expect(BUILD_PHASE_PROMPT).toContain('catch-all HANDOFF back to the supervisor');
    expect(BUILD_PHASE_PROMPT).not.toContain('on any specialist AGENT that has a HANDOFF block');
    expect(BUILD_PHASE_PROMPT).toContain('memory_grants');
    expect(BUILD_PHASE_PROMPT).toContain(
      'Do not omit `RESPOND` — the runtime falls back to the generic `conversation_complete` message.',
    );
    expect(BUILD_PHASE_PROMPT).not.toContain('    REASON: "Collected');
  });

  it('renders catalog-default model guidance without reasoning-model selection', () => {
    const prompt = renderBuildPhasePrompt({
      modelDefaults: {
        fastToolCapable: 'tenant-fast-support-model',
        reasoning: 'tenant-reasoning-model',
      },
    });

    expect(prompt).toContain('model: tenant-fast-support-model');
    expect(prompt).toContain('modelPolicy` as capability intent');
    expect(prompt).not.toContain('tenant-reasoning-model');
    expect(prompt).not.toContain('model: gpt-4.1');
    expect(prompt).not.toContain('o4-mini');
  });

  it('keeps fallback knowledge and fix templates aligned with COMPLETE syntax', () => {
    const completionFix = getFixTemplate('CO-01');
    const handoffFix = getFixTemplate('CO-04');

    expect(PLATFORM_LIMITS_CARD).toContain('Runtime Coordination Contracts');
    expect(PLATFORM_LIMITS_CARD).toContain('`RETURN: true` means the caller waits');
    expect(PLATFORM_LIMITS_CARD).toContain(
      'Removing `COMPLETE:` from a target of `RETURN: true` can block the parent.',
    );
    expect(PLATFORM_LIMITS_CARD).toContain('default-merge back to the parent by same name');

    expect(completionFix?.template).toContain('COMPLETE:');
    expect(completionFix?.template).toContain('RESPOND: ""');
    expect(completionFix?.template).not.toContain('COMPLETION:');
    expect(completionFix?.template).not.toContain('REASON:');

    expect(handoffFix?.template).toContain('COMPLETE:');
    expect(handoffFix?.template).toContain('RESPOND: ""');
    expect(handoffFix?.template).not.toContain('COMPLETION:');
    expect(handoffFix?.template).not.toContain('REASON:');

    expect(CEL_FUNCTIONS_CARD).toContain('# In COMPLETE:');
    expect(CEL_FUNCTIONS_CARD).toContain('RESPOND: ""');
    expect(CEL_FUNCTIONS_CARD).not.toContain('# In COMPLETION:');
    expect(CEL_FUNCTIONS_CARD).not.toContain('REASON: "Minimum items collected');
  });

  it('keeps in-project modification prompts guarded against local health cleanup', () => {
    expect(IN_PROJECT_GENERALIST_PROMPT).toContain('NEVER optimize health');
    expect(IN_PROJECT_GENERALIST_PROMPT).toContain('For G-09 unused GATHER findings');
    expect(IN_PROJECT_GENERALIST_PROMPT).toContain('preserve a valid return path');
    expect(IN_PROJECT_GENERALIST_PROMPT).toContain('Run targeted dependency analysis');
    expect(IN_PROJECT_GENERALIST_PROMPT).toContain('Check compiler-backed knowledge');
    expect(IN_PROJECT_GENERALIST_PROMPT).toContain('call get_construct_spec');
    expect(IN_PROJECT_GENERALIST_PROMPT).toContain(
      'call propose_plan before any mutation-capable tool',
    );
    expect(IN_PROJECT_GENERALIST_PROMPT).toContain('call dry_run_compile');
    expect(IN_PROJECT_PHASE_PROMPT).toContain('NEVER treat health-score cleanup as a local edit');
    expect(IN_PROJECT_PHASE_PROMPT).toContain('RETURN/completion paths');
  });

  it('injects compiler-backed Knowledge Spine core into in-project prompts', () => {
    const prompt = composeInProjectPrompt(
      'multi-agent-architect',
      undefined,
      'fix the flow step to handle delegate better',
    );

    expect(prompt).toContain('## Knowledge Spine Core');
    expect(prompt).toContain('Catalog version: 1.0.0');
    expect(prompt).toContain('- HANDOFF: TO, WHEN, CONTEXT, RETURN');
    expect(prompt).toContain('Supervisor routing is expressed with HANDOFF targets');
    expect(prompt).toContain('Runtime Feasibility Checks');

    const knowledgeCore = prompt.slice(
      prompt.indexOf('## Knowledge Spine Core'),
      prompt.indexOf('## ABL Platform Foundation'),
    );
    expect(knowledgeCore).not.toContain('ROUTING:');
    expect(knowledgeCore).not.toContain('AGENTS:');
  });

  it('keeps interview collection state-aware so completed fields are not re-asked', () => {
    expect(INTERVIEW_PHASE_PROMPT).toContain('missing-field checklist');
    expect(INTERVIEW_PHASE_PROMPT).toContain('Do NOT ask again for any field');
    expect(INTERVIEW_PHASE_PROMPT).toContain('Never ask for project name');
    expect(INTERVIEW_PHASE_PROMPT).toContain('field:"projectName"');
    expect(INTERVIEW_PHASE_PROMPT).toContain('Never ask for channels');
  });

  it('teaches the architect to reason about data flow + edge invariants', () => {
    // Section A — data flow drives pattern selection, not just control flow.
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Data-Flow Signature');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain(
      'must ask the end user for directly before it can complete',
    );
    expect(MULTI_AGENT_ARCHITECT_PROMPT).not.toContain('must collect or receive');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Producer-consumer chain');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Parallel sub-results aggregated');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Routing without shared state');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Pipeline-vs-Triage tie-breaker');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Hub-and-Spoke-vs-Pipeline tie-breaker');

    // Section B — handoff-edge invariants drive BUILD's CONTEXT / ON_RETURN / memory_grants.
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Handoff-Edge Invariants');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Set `experienceMode` on every edge');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain(
      'BUILD will attach shared customer voice as a behavior profile',
    );
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Model capability intent');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('"modelPolicy"');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('"reasoningRequired": false');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Treat `modelPolicy` as capability intent only');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Receives {fields} from parent');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain(
      'Captures {fields} for human review; preserves audit trail',
    );
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain(
      'human handoff for X" — that produces a 15-line stub agent',
    );
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain(
      "Pipeline edges' `condition` must reference declared GATHER fields",
    );
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('memory_grants');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Reads MEMORY.persistent.audit_trail');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('Concrete bad example (produces a chatbot)');
    expect(MULTI_AGENT_ARCHITECT_PROMPT).toContain('"experienceMode": "shared_voice_handoff');
  });
});

/**
 * Embedded MCP fallback docs.
 *
 * Studio serves the full documentation bundle from GET /api/abl/docs. The MCP
 * package is distributed independently, so these focused topics keep the most
 * important platform contracts discoverable when the connected platform is
 * older, offline, or missing a newly documented route.
 */

export interface EmbeddedDocTopic {
  id: string;
  title: string;
  category: string;
}

export const ABL_DOCS: Record<string, string> = {
  'mcp/platform-contract': `# Platform Contract for MCP Repair Tools

The MCP package can inspect local folders, zip archives, or import payloads without requiring callers to manually build a file map.

Package inputs accepted by repair tools:
- path: absolute or relative path to a project folder or .zip file.
- files: object mapping relative file paths to UTF-8 file content.
- data.files: import-style payload file map. This is normalized the same way as files.

Normalization rules:
- Backslashes are converted to forward slashes.
- Absolute paths, null bytes, and .. path traversal are rejected.
- Common archive wrappers, including nested wrappers such as repo-main/src/, are stripped when they contain project.json, abl.lock, or a supported package content directory.
- Supported content directories include agents, tools, behavior_profiles, config, core, connections, prompts, guardrails, workflows, evals, search, channels, vocabulary, locales, deployments, and environment.
- Skipped directories: .git, node_modules, dist, build, .turbo, __MACOSX.
- Skipped files: .DS_Store.
- Limits: 500 files and 1 MB per file in local MCP assembly.

Recommended Arch loop:
1. Build with platform_import_export, platform_projects, platform_agents, platform_tools, and platform_config.
2. Optimize with platform_validate_package, platform_package_model, and debug_lint_abl.
3. Evaluate with platform_eval_* tools to run persona/scenario/evaluator/set/run workflows.
4. Debug with platform_connect, debug_traces, debug_get_errors, and debug_why_transcript_failed.
5. Analyze with debug_diagnose and debug_analyze_session, then patch and repeat until validation/evals are clean.`,

  'mcp/import-contract': `# Import Preview and Apply Contract

Import endpoints are mounted under Studio project routes:
- POST /api/projects/:projectId/import/preview
- POST /api/projects/:projectId/import/apply

Payload fields:
- files: required file map after local MCP assembly.
- layers: optional array of supported layer names. Unsupported names return INVALID_LAYERS.
- deleteUnmatched: optional boolean. false maps to merge; true maps to replace.
- bindingResolutions: optional object keyed by resolution id.
- previewDigest: apply acknowledgement digest from preview.
- acknowledgedIssueIds: non-blocking preview issue ids acknowledged by the caller.

Apply acknowledgement rules:
- Blocking preview issues must be fixed before apply.
- Non-blocking issues require acknowledgement.
- The safe apply payload includes previewDigest and all non-blocking issue ids.
- platform_import_export auto-previews and auto-acknowledges non-blocking issues when confirm: true and no complete manual acknowledgement is supplied.
- Partial manual acknowledgement is treated as stale by default and replaced by a fresh preview unless autoAcknowledgeNonBlocking is false.

platform_validate_package with projectId returns importPreview details:
- previewDigest
- acknowledgedIssueIdsNeeded
- requiresAcknowledgement
- acknowledgementReady
- canApply
- missingAcknowledgementIssueIdCount
- suggestedApplyArgs

Use suggestedApplyArgs with platform_import_export import when you want explicit manual apply control.`,

  'mcp/behavior-profiles': `# Behavior Profile Package Contract

Agents attach standalone behavior profiles with:

USE BEHAVIOR_PROFILE: profile_name

Behavior profile files should be standalone ABL documents, typically under:

behavior_profiles/<name>.behavior_profile.abl

project.json should declare behavior profiles by name with a path, for example:

{
  "format_version": "2.0",
  "behavior_profiles": {
    "shared_voice": {
      "path": "behavior_profiles/shared_voice.behavior_profile.abl",
      "priority": 10
    }
  }
}

Compiler/import expectations:
- The profile document must exist in the package files.
- The agent USE BEHAVIOR_PROFILE name must match a declared/available profile.
- Preview diagnostics may report PROFILE_NOT_FOUND when the profile is referenced but not supplied as a package file.
- Behavior profile documents compile before agent attachment; invalid profile DSL is a package validation issue.

Repair workflow:
1. Use platform_package_model to list behaviorProfiles, profile references, and unresolvedRefs.
2. If an agent references a missing profile, add the profile file and project.json declaration or remove the USE BEHAVIOR_PROFILE line.
3. Use debug_lint_abl and platform_validate_package to catch syntax, dependency, and design issues before import apply.`,

  'mcp/abl-repair-loop': `# Arch ABL Repair and Eval Loop

Arch's MCP tools are designed for iterative ABL repair, not only import troubleshooting.

Suggested workflow:
1. platform_package_model: inspect what the compiler sees.
2. debug_lint_abl: find design risks such as empty RESPOND, empty finalize steps, undeclared handoff-condition variables, side-effect tool chains, and tool-call plus customer-text reasoning risks.
3. debug_why_transcript_failed (or alias debug_diagnose_transcript): correlate transcript symptoms to ABL file/line causes, including finalize -> COMPLETE -> RESPOND: "".
4. platform_validate_package: run platform validation and import preview when projectId is available.
5. platform_eval_personas, platform_eval_scenarios, platform_eval_evaluators, platform_eval_sets, and platform_eval_runs: generate or run eval assets.
6. platform_eval_runs with action "cases": drill from a failing heatmap cell into diagnosticTranscript, conversation, traceEvents, toolCalls, trajectory, and evaluator scores.
7. Patch the local package and repeat until validation and evals agree.

The key debugging question is: what does the compiler see?

Use platform_package_model for:
- agents
- tools
- handoffs and delegates
- memory variables
- behavior profile references
- compiled flow steps
- unresolved references
- compiler diagnostics`,
};

export const DOC_TOPICS: EmbeddedDocTopic[] = [
  { id: 'mcp/platform-contract', title: 'MCP Platform Contract', category: 'MCP Fallback' },
  {
    id: 'mcp/import-contract',
    title: 'Import Preview and Apply Contract',
    category: 'MCP Fallback',
  },
  {
    id: 'mcp/behavior-profiles',
    title: 'Behavior Profile Package Contract',
    category: 'MCP Fallback',
  },
  {
    id: 'mcp/abl-repair-loop',
    title: 'Arch ABL Repair and Eval Loop',
    category: 'MCP Fallback',
  },
];

export function searchDocumentation(query: string): Array<{
  id: string;
  topic: string;
  title: string;
  category: string;
  excerpt: string;
}> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const results: Array<{
    id: string;
    topic: string;
    title: string;
    category: string;
    excerpt: string;
  }> = [];

  for (const topic of DOC_TOPICS) {
    const content = ABL_DOCS[topic.id] ?? '';
    const titleMatch = topic.title.toLowerCase().includes(normalized);
    const contentIndex = content.toLowerCase().indexOf(normalized);
    if (!titleMatch && contentIndex === -1) {
      continue;
    }

    const start = contentIndex === -1 ? 0 : Math.max(0, contentIndex - 80);
    const end =
      contentIndex === -1
        ? Math.min(content.length, 180)
        : Math.min(content.length, contentIndex + normalized.length + 180);
    results.push({
      id: topic.id,
      topic: topic.id,
      title: topic.title,
      category: topic.category,
      excerpt: `${start > 0 ? '...' : ''}${content.slice(start, end).trim()}${end < content.length ? '...' : ''}`,
    });
  }

  return results;
}

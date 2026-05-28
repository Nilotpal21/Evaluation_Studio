import { createHash } from 'node:crypto';
import { validateABL } from '@abl/compiler';
import type { ImportIssue, ImportPreviewV2, ProjectManifest, ProjectManifestV2 } from '../types.js';
import {
  extractAgentName,
  getManifestBehaviorProfilePaths,
  isBehaviorProfileImportPath,
} from './folder-reader.js';

function makeIssueId(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

function sortStrings(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort((left, right) => left.localeCompare(right));
}

function readProjectManifest(
  files: Map<string, string>,
): ProjectManifest | ProjectManifestV2 | null {
  const manifestContent = files.get('project.json');
  if (!manifestContent) {
    return null;
  }

  try {
    return JSON.parse(manifestContent) as ProjectManifest | ProjectManifestV2;
  } catch {
    return null;
  }
}

export function explainImportCompileDiagnostic(message: string): string {
  const workflowBinding = message.match(
    /^Tool "([^"]+)" \[workflow_binding\]: Workflow tool must have workflow_binding$/,
  );
  if (workflowBinding) {
    return `Tool "${workflowBinding[1]}" is missing workflow binding metadata. Why: workflow tools need workflow_id, trigger_id, and workflow_version so runtime can invoke the target workflow. What to do: import the workflows layer, map the tool to an existing target workflow trigger, or edit the tool to include workflow binding fields.`;
  }

  const httpBinding = message.match(
    /^Tool "([^"]+)" \[http_binding\]: HTTP tool must have http_binding$/,
  );
  if (httpBinding) {
    return `HTTP tool "${httpBinding[1]}" is missing http_binding metadata. Why: HTTP tools need method, URL or connection, and request mapping metadata before runtime can call them. What to do: import the related connection/tool binding or edit the tool to include an http_binding.`;
  }

  const mcpBinding = message.match(
    /^Tool "([^"]+)" \[mcp_binding\]: MCP tool must have mcp_binding$/,
  );
  if (mcpBinding) {
    return `MCP tool "${mcpBinding[1]}" is missing mcp_binding metadata. Why: MCP tools need the target server and tool binding before runtime can invoke them. What to do: import the MCP server config or edit the tool to include an mcp_binding.`;
  }

  const unreachableStep = message.match(
    /^Step "([^"]+)" is unreachable from entry point "([^"]+)"/,
  );
  if (unreachableStep) {
    return `Step "${unreachableStep[1]}" is unreachable from entry point "${unreachableStep[2]}". Why: no transition from the entry step can reach it, so it will never execute. What to do: add a route/transition to this step or remove it if it is intentionally unused.`;
  }

  const requiredParameter = message.match(
    /^Required parameter "([^"]+)" of tool "([^"]+)" has no description\.$/,
  );
  if (requiredParameter) {
    return `Required parameter "${requiredParameter[1]}" of tool "${requiredParameter[2]}" has no description. Why: required tool inputs need descriptions so the model can fill them reliably. What to do: add a short parameter description in the tool definition.`;
  }

  const sideEffects = message.match(
    /^Tool "([^"]+)" declares side_effects: true but has no explicit confirm policy\./,
  );
  if (sideEffects) {
    return `Tool "${sideEffects[1]}" declares side_effects: true but has no explicit confirm policy. Why: runtime needs an intentional confirmation rule before side-effecting calls. What to do: add confirm: when_side_effects, confirm: always, or confirm: never.`;
  }

  const reasoningModel = message.match(
    /^Flow step "([^"]+)" has REASONING enabled but no model is specified/,
  );
  if (reasoningModel) {
    return `Flow step "${reasoningModel[1]}" has reasoning enabled but no explicit model in the agent execution config. Why: the step must resolve a project or inherited model at runtime. What to do: import/create a project model config or set an agent/step execution model; if inheritance is expected, acknowledge this warning.`;
  }

  const emptyStep = message.match(
    /^Flow step "([^"]+)" has no reasoning zone, gather, respond, call, set, transform, or human approval\./,
  );
  if (emptyStep) {
    return `Flow step "${emptyStep[1]}" has no action. Why: the step will exit immediately because it has no reasoning, gather, response, call, set, transform, or human approval. What to do: add an action/transition or remove the step.`;
  }

  const missingVariable = message.match(/^Variable "([^"]+)" in condition is not found/);
  if (missingVariable) {
    return `Variable "${missingVariable[1]}" in a condition is not declared. Why: the condition references a name that is not a gather field, session variable, or built-in, so it may fail unless supplied dynamically. What to do: declare/populate the variable, or quote it if it was intended as literal text.`;
  }

  const missingPopulation = message.match(
    /W801: Session variable "([^"]+)" has no population source/,
  );
  if (missingPopulation) {
    return `Session variable "${missingPopulation[1]}" has no visible population source. Why: the compiler cannot find a gather field, tool result mapping, set assignment, remember trigger, or handoff/delegate return that fills it. What to do: add one of those population paths, or acknowledge it if a parent agent/runtime context always supplies the value.`;
  }

  return message;
}

function buildPreviewDigestPayload(preview: ImportPreviewV2) {
  return {
    formatVersion: preview.formatVersion,
    valid: preview.valid,
    layers: sortStrings(preview.layers),
    layerChanges: Object.fromEntries(
      Object.entries(preview.layerChanges)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([layer, counts]) => [layer, counts]),
    ),
    agentChanges: {
      added: sortStrings(preview.agentChanges.added),
      modified: [...preview.agentChanges.modified]
        .map((change) => ({
          name: change.name,
          diff: change.diff,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      removed: sortStrings(preview.agentChanges.removed),
      unchanged: sortStrings(preview.agentChanges.unchanged),
    },
    toolChanges: {
      added: sortStrings(preview.toolChanges.added),
      modified: sortStrings(preview.toolChanges.modified),
      removed: sortStrings(preview.toolChanges.removed),
    },
    profileChanges: preview.profileChanges
      ? {
          added: sortStrings(preview.profileChanges.added),
          modified: sortStrings(preview.profileChanges.modified),
          removed: sortStrings(preview.profileChanges.removed),
        }
      : undefined,
    shaIntegrity: {
      valid: preview.shaIntegrity.valid,
      integrityMatch: preview.shaIntegrity.integrityMatch,
      layerResults: Object.fromEntries(
        Object.entries(preview.shaIntegrity.layerResults)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([layer, result]) => [
            layer,
            {
              valid: result.valid,
              mismatchedFiles: sortStrings(result.mismatchedFiles),
            },
          ]),
      ),
      errors: sortStrings(preview.shaIntegrity.errors),
      warnings: sortStrings(preview.shaIntegrity.warnings),
    },
    crossLayerDeps: {
      valid: preview.crossLayerDeps.valid,
      missingDependencies: [...preview.crossLayerDeps.missingDependencies].sort((left, right) =>
        `${left.source}:${left.target}:${left.type}`.localeCompare(
          `${right.source}:${right.target}:${right.type}`,
        ),
      ),
      warnings: sortStrings(preview.crossLayerDeps.warnings),
    },
    syntaxErrors: [...preview.syntaxErrors]
      .map((entry) => ({
        file: entry.file,
        errors: [...entry.errors].sort((left, right) =>
          `${left.line}:${left.message}`.localeCompare(`${right.line}:${right.message}`),
        ),
      }))
      .sort((left, right) => left.file.localeCompare(right.file)),
    issues: [...preview.issues]
      .map((issue) => ({
        id: issue.id,
        severity: issue.severity,
        blocking: issue.blocking,
        category: issue.category,
        code: issue.code,
        message: issue.message,
        file: issue.file,
        line: issue.line,
        agent: issue.agent,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    hasBlockingIssues: preview.hasBlockingIssues,
    requiresAcknowledgement: preview.requiresAcknowledgement,
    blockingIssueCount: preview.blockingIssueCount,
    nonBlockingIssueCount: preview.nonBlockingIssueCount,
    entryAgentResolution: preview.entryAgentResolution,
    warnings: sortStrings(preview.warnings),
  };
}

function buildCompileIssues(files: Map<string, string>): ImportIssue[] {
  const compileDocs: Array<{ filename: string; source: string }> = [];
  const agentPathByName = new Map<string, string>();
  const issues: ImportIssue[] = [];
  const manifestProfilePaths = getManifestBehaviorProfilePaths(readProjectManifest(files));

  for (const [path, content] of files) {
    if (path.endsWith('.agent.abl') || path.endsWith('.agent.yaml')) {
      compileDocs.push({ filename: path, source: content });
      const agentName = extractAgentName(content);
      if (agentName) {
        agentPathByName.set(agentName, path);
      }
    } else if (isBehaviorProfileImportPath(path, manifestProfilePaths)) {
      compileDocs.push({ filename: path, source: content });
    }
  }

  if (compileDocs.length === 0) {
    return issues;
  }

  const diagnostics = validateABL(compileDocs);
  const allDiagnostics = [
    ...diagnostics.errors.map((diagnostic) => ({
      ...diagnostic,
      severity: 'error' as const,
      code: 'E_IMPORT_COMPILE',
    })),
    ...diagnostics.warnings.map((diagnostic) => ({
      ...diagnostic,
      severity: 'warning' as const,
      code: 'W_IMPORT_COMPILE',
    })),
  ];

  for (const diagnostic of allDiagnostics) {
    const file =
      agentPathByName.get(diagnostic.agent) ??
      (compileDocs.some((doc) => doc.filename === diagnostic.agent) ? diagnostic.agent : undefined);
    const message = explainImportCompileDiagnostic(diagnostic.message);

    issues.push({
      id: makeIssueId(
        JSON.stringify({
          category: 'compile',
          severity: diagnostic.severity,
          agent: diagnostic.agent,
          file,
          message,
          code: diagnostic.code,
        }),
      ),
      severity: diagnostic.severity,
      blocking: false,
      category: 'compile',
      code: diagnostic.code,
      agent: diagnostic.agent,
      file,
      message,
    });
  }

  return issues;
}

function computePreviewDigest(preview: ImportPreviewV2): string {
  return createHash('sha256')
    .update(JSON.stringify(buildPreviewDigestPayload(preview)))
    .digest('hex');
}

export function enrichImportPreview(
  preview: ImportPreviewV2,
  files: Map<string, string>,
): ImportPreviewV2 {
  const extraIssues = buildCompileIssues(files);
  const mergedIssues = new Map<string, ImportIssue>();

  for (const issue of [...preview.issues, ...extraIssues]) {
    mergedIssues.set(issue.id, issue);
  }

  const issues = [...mergedIssues.values()];
  const blockingIssueCount = issues.filter((issue) => issue.blocking).length;
  const nonBlockingIssueCount = issues.length - blockingIssueCount;
  const enrichedPreview: ImportPreviewV2 = {
    ...preview,
    issues,
    valid: blockingIssueCount === 0,
    hasBlockingIssues: blockingIssueCount > 0,
    requiresAcknowledgement: nonBlockingIssueCount > 0,
    blockingIssueCount,
    nonBlockingIssueCount,
  };

  return {
    ...enrichedPreview,
    previewDigest: computePreviewDigest(enrichedPreview),
  };
}

export function validatePreviewAcknowledgement(
  preview: ImportPreviewV2,
  previewDigest: string | null | undefined,
  acknowledgedIssueIds: string[] | null | undefined,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (!preview.requiresAcknowledgement) {
    return { ok: true };
  }

  if (!previewDigest) {
    return {
      ok: false,
      status: 400,
      code: 'PREVIEW_ACK_REQUIRED',
      message: 'Preview acknowledgement is required before applying this import',
    };
  }

  if (preview.previewDigest !== previewDigest) {
    return {
      ok: false,
      status: 409,
      code: 'PREVIEW_STALE',
      message: 'Import preview is stale. Please preview again before applying.',
    };
  }

  const acknowledged = new Set(acknowledgedIssueIds ?? []);
  const missing = preview.issues
    .filter((issue) => !issue.blocking)
    .map((issue) => issue.id)
    .filter((id) => !acknowledged.has(id));

  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'PREVIEW_ACK_REQUIRED',
      message: 'All non-blocking import issues must be acknowledged before applying.',
    };
  }

  return { ok: true };
}

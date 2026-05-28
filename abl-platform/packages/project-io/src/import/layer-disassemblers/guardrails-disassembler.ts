/**
 * GuardrailsDisassembler — converts exported guardrail policy files back into StagedRecords.
 *
 * Handles: guardrail policies with scope rebinding to target project.
 * WebhookSecret was stripped on export — user must re-provision post-import.
 *
 * Pure function — no DB access. All ownership fields injected from server context.
 */

import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';
import {
  injectOwnership,
  buildRecord,
  buildSuperseded,
  buildMatchingSuperseded,
} from './disassembler-utils.js';
import {
  extractGuardrailArchiveName,
  isGuardrailArchivePath,
  parseGuardrailArchive,
} from '../../guardrail-projection.js';

/** Check if a record with matching field value exists in the existing record list. */
function existsInExisting(
  existing: Array<{ _id: string; [key: string]: unknown }> | undefined,
  matchField: string,
  matchValue: string,
): boolean {
  if (!existing) return false;
  return existing.some((r) => r[matchField] === matchValue);
}

function normalizeGuardrailScope(parsed: Record<string, unknown>, targetProjectId: string): void {
  const scopeInput = parsed.scope;
  if (!scopeInput || typeof scopeInput !== 'object' || Array.isArray(scopeInput)) {
    return;
  }

  const scope = { ...(scopeInput as Record<string, unknown>) };

  if (scope.type === 'project' || scope.type === 'agent') {
    scope.projectId = targetProjectId;
  }

  const agentName = scope.agentName;
  const canonicalAgentDefId = scope.agentDefId;
  const legacyAgentId = scope.agentId;

  if (typeof agentName === 'string' && agentName.length > 0) {
    // Portable imports anchor agent-scoped guardrails by agent name, then let the
    // cross-ref phase remap to the staged project_agents _id in the target project.
    parsed._guardrailAgentName = agentName;
    delete scope.agentName;
    delete scope.agentDefId;
    delete scope.agentId;
  } else {
    if (typeof canonicalAgentDefId !== 'string' && typeof legacyAgentId === 'string') {
      scope.agentDefId = legacyAgentId;
    }
    delete scope.agentId;
  }

  parsed.scope = scope;
}

export class GuardrailsDisassembler implements LayerDisassembler {
  readonly layer = 'guardrails' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: StagedRecord[] = [];
    const superseded: SupersededRecord[] = [];
    const warnings: string[] = [];

    const existingPolicies = ctx.existingRecordIds?.get('guardrail_policies');

    for (const [filePath, content] of ctx.files) {
      if (!isGuardrailArchivePath(filePath)) {
        continue;
      }

      const parsed = parseGuardrailArchive(filePath, content, warnings);
      if (!parsed) continue;

      // Derive name from parsed data or filename
      const name =
        (typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null) ??
        extractGuardrailArchiveName(filePath);
      if (!name) {
        warnings.push(`Skipping ${filePath}: could not determine guardrail name`);
        continue;
      }

      // Skip if conflict strategy is 'skip' and a matching policy already exists
      if (ctx.conflictStrategy === 'skip' && existsInExisting(existingPolicies, 'name', name)) {
        continue;
      }

      normalizeGuardrailScope(parsed, ctx.projectId);

      const data = injectOwnership(parsed, ctx);
      records.push(buildRecord('guardrails', 'guardrail_policies', data));
    }

    // Build superseded records for replacement strategies
    if (ctx.conflictStrategy === 'replace') {
      superseded.push(...buildSuperseded('guardrails', 'guardrail_policies', existingPolicies));
    } else if (ctx.conflictStrategy === 'merge') {
      superseded.push(
        ...buildMatchingSuperseded(
          'guardrails',
          'guardrail_policies',
          existingPolicies,
          records.filter((record) => record.collection === 'guardrail_policies'),
          'name',
        ),
      );
    }

    return { records, superseded, warnings };
  }
}

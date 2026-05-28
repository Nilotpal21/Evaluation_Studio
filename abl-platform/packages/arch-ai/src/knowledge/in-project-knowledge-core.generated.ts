/**
 * In-project Knowledge Core.
 *
 * Despite the generated suffix, this module intentionally renders from the
 * compiler-owned Knowledge Spine at runtime so the prompt stays aligned with
 * the committed catalog instead of duplicating construct facts.
 */

import { getCatalogVersion, listAllConstructs, listFeasibilityChecks } from './spine.js';

const MAX_CONSTRUCT_FIELDS = 5;

function renderConstructLine(name: string, fieldNames: readonly string[]): string {
  const fields = fieldNames.slice(0, MAX_CONSTRUCT_FIELDS).join(', ');
  return fields ? `- ${name}: ${fields}` : `- ${name}`;
}

export function renderInProjectKnowledgeCore(): string {
  const constructs = listAllConstructs()
    .map((construct) =>
      renderConstructLine(
        construct.name,
        construct.fields.map((field) => field.name),
      ),
    )
    .join('\n');
  const feasibilityChecks = listFeasibilityChecks()
    .map((check) => `- ${check.name}: ${check.description}`)
    .join('\n');

  return `## Knowledge Spine Core

Catalog version: ${getCatalogVersion()}

Use this compiler-backed catalog before proposing agent changes. If a requested block, field, validation code, or feasibility check is not represented here or in a retrieved Knowledge Spine citation, treat it as uncertain and verify with tools/docs before proposing.

### Canonical ABL Constructs
${constructs}

### Proposal Analysis Contract
- Read the target agent and full topology before editing.
- For topology work, inspect incoming callers, outgoing targets, return paths, and sibling agents before planning.
- For tool, auth, KB, model, channel, memory, flow, gather, completion, handoff, or delegate changes, inspect the matching project resources before planning.
- Every plan must cite real construct specs, validation codes, reference analysis, or feasibility checks. Do not cite legacy or invented DSL blocks.
- Supervisor routing is expressed with HANDOFF targets and project topology. Project membership does not belong inside agent DSL.

### Runtime Feasibility Checks
${feasibilityChecks}`;
}

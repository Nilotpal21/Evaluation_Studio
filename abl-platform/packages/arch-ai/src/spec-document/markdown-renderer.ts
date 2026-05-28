/**
 * Markdown renderer for Arch AI spec documents.
 *
 * Converts an `IArchSpecDocument` (DB model) into a clean Markdown document
 * suitable for display in the UI or export. Empty sections are omitted.
 */

import type { IArchSpecDocumentRecord as IArchSpecDocument } from '../models/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return 'N/A';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(date.getTime())) return 'N/A';
  return date.toISOString().slice(0, 10);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ─── Renderer ───────────────────────────────────────────────────────────────

/**
 * Render a spec document as a Markdown string.
 * Skips empty sections to keep the output clean.
 */
export function renderMarkdown(spec: IArchSpecDocument): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────

  const projectName = spec.business.projectName || 'Untitled Project';
  lines.push(`# ${projectName} -- Project Specification`);
  lines.push('');
  lines.push(`**Version:** ${spec.version}`);
  lines.push(`**Created:** ${formatDate(spec.createdAt)}`);
  lines.push(`**Updated:** ${formatDate(spec.updatedAt)}`);
  lines.push('');

  // ── Business Context ────────────────────────────────────────────────────

  const biz = spec.business;
  const hasBizContent =
    biz.objective ||
    biz.channels.length > 0 ||
    biz.compliance.length > 0 ||
    biz.constraints.length > 0 ||
    biz.personas.length > 0 ||
    biz.slas.length > 0 ||
    biz.edgeCases.length > 0;

  if (hasBizContent) {
    lines.push('## Business Context');
    lines.push('');

    if (biz.objective) {
      lines.push(`**Objective:** ${biz.objective}`);
      lines.push('');
    }

    if (biz.channels.length > 0) {
      lines.push(`**Channels:** ${biz.channels.join(', ')}`);
      lines.push('');
    }

    if (biz.language && biz.language !== 'English') {
      lines.push(`**Language:** ${biz.language}`);
      lines.push('');
    }

    if (biz.compliance.length > 0) {
      lines.push('### Compliance');
      lines.push('');
      lines.push('| Standard | Severity | Detail |');
      lines.push('| --- | --- | --- |');
      for (const c of biz.compliance) {
        lines.push(
          `| ${escapeCell(c.standard)} | ${escapeCell(c.severity)} | ${escapeCell(c.detail)} |`,
        );
      }
      lines.push('');
    }

    if (biz.constraints.length > 0) {
      lines.push('### Constraints');
      lines.push('');
      for (const c of biz.constraints) {
        lines.push(`- ${c}`);
      }
      lines.push('');
    }

    if (biz.personas.length > 0) {
      lines.push('### Personas');
      lines.push('');
      for (const p of biz.personas) {
        lines.push(`- **${p.name}** -- ${p.description}`);
      }
      lines.push('');
    }

    if (biz.slas.length > 0) {
      lines.push('### SLAs');
      lines.push('');
      lines.push('| Metric | Target | Unit |');
      lines.push('| --- | --- | --- |');
      for (const s of biz.slas) {
        lines.push(`| ${escapeCell(s.metric)} | ${escapeCell(s.target)} | ${escapeCell(s.unit)} |`);
      }
      lines.push('');
    }

    if (biz.edgeCases.length > 0) {
      lines.push('### Edge Cases');
      lines.push('');
      for (const e of biz.edgeCases) {
        lines.push(`- ${e}`);
      }
      lines.push('');
    }
  }

  // ── Architecture ────────────────────────────────────────────────────────

  const arch = spec.architecture;
  const hasArchContent = arch.agents.length > 0 || arch.pattern || arch.rationale;

  if (hasArchContent) {
    lines.push('## Architecture');
    lines.push('');

    if (arch.pattern) {
      lines.push(`**Pattern:** ${arch.pattern}`);
      lines.push('');
    }

    if (arch.entryPoint) {
      lines.push(`**Entry Point:** ${arch.entryPoint}`);
      lines.push('');
    }

    if (arch.agentCount > 0) {
      lines.push(`**Agent Count:** ${arch.agentCount}`);
      lines.push('');
    }

    if (arch.agents.length > 0) {
      lines.push('### Agents');
      lines.push('');
      lines.push('| Name | Role | Execution Mode | Model | Compile Status |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const a of arch.agents) {
        lines.push(
          `| ${escapeCell(a.name)} | ${escapeCell(a.role)} | ${escapeCell(a.executionMode)} | ${escapeCell(a.model)} | ${escapeCell(a.compileStatus)} |`,
        );
      }
      lines.push('');
    }

    if (arch.edges.length > 0) {
      lines.push('### Topology');
      lines.push('');
      lines.push('| From | To | Type | Condition |');
      lines.push('| --- | --- | --- | --- |');
      for (const e of arch.edges) {
        lines.push(
          `| ${escapeCell(e.from)} | ${escapeCell(e.to)} | ${escapeCell(e.type)} | ${escapeCell(e.condition)} |`,
        );
      }
      lines.push('');
    }

    if (arch.rationale) {
      lines.push('### Rationale');
      lines.push('');
      lines.push(arch.rationale);
      lines.push('');
    }
  }

  // ── Implementation ──────────────────────────────────────────────────────

  const impl = spec.implementation;
  const hasImplContent = impl.tools.length > 0 || impl.guardrails.length > 0 || impl.buildStatus;

  if (hasImplContent) {
    lines.push('## Implementation');
    lines.push('');

    if (impl.tools.length > 0) {
      lines.push('### Tools');
      lines.push('');
      lines.push('| Name | Type | Agent | Description |');
      lines.push('| --- | --- | --- | --- |');
      for (const t of impl.tools) {
        lines.push(
          `| ${escapeCell(t.name)} | ${escapeCell(t.type)} | ${escapeCell(t.agent)} | ${escapeCell(t.description)} |`,
        );
      }
      lines.push('');
    }

    if (impl.guardrails.length > 0) {
      lines.push('### Guardrails');
      lines.push('');
      lines.push('| Rule | Agent | Severity | On Fail |');
      lines.push('| --- | --- | --- | --- |');
      for (const g of impl.guardrails) {
        lines.push(
          `| ${escapeCell(g.rule)} | ${escapeCell(g.agent)} | ${escapeCell(g.severity)} | ${escapeCell(g.onFail)} |`,
        );
      }
      lines.push('');
    }

    if (impl.buildStatus) {
      lines.push(`**Build Status:** ${impl.buildStatus}`);
      lines.push('');
    }
  }

  // ── Key Decisions ───────────────────────────────────────────────────────

  if (spec.decisions.length > 0) {
    lines.push('## Key Decisions');
    lines.push('');
    lines.push('| Date | Decision | Rationale | Phase |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of spec.decisions) {
      lines.push(
        `| ${escapeCell(d.date)} | ${escapeCell(d.what)} | ${escapeCell(d.why)} | ${escapeCell(d.phase)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

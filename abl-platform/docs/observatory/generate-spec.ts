#!/usr/bin/env npx tsx
/**
 * generate-spec.ts
 *
 * Reads all observatory JSON files and generates the derived markdown spec.
 * JSON is the single source of truth; markdown is always regenerated.
 *
 * Usage: npx tsx docs/observatory-spec/generate-spec.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(join(__dirname, name), 'utf-8'));

// ── Load all JSON sources ────────────────────────────────────────────────────

const apis = read('apis.json');
const dataElements = read('data-elements.json');
const views = read('views.json');
const dataFlows = read('data-flows.json');
const gaps = read('gaps.json');
const eventTypes = read('event-types.json');
const stores = read('stores.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function table(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => '---');
  const lines = [headers, sep, ...rows].map((r) => '| ' + r.join(' | ') + ' |');
  return lines.join('\n');
}

function statusBadge(s: string): string {
  if (s === 'exists') return 'exists';
  if (s === 'partial') return 'partial';
  return s;
}

function severityLabel(s: string): string {
  const map: Record<string, string> = {
    critical: '**Critical**',
    high: '**High**',
    medium: 'Medium',
    low: 'Low',
  };
  return map[s] || s;
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildHeader(): string {
  return [
    '# Observatory API <-> View Specification',
    '',
    `**Generated:** ${new Date().toISOString().split('T')[0]}`,
    '**Source:** JSON files in `docs/observatory-spec/`',
    '**Regenerate:** `npx tsx docs/observatory-spec/generate-spec.ts`',
    '',
    '---',
    '',
  ].join('\n');
}

function buildApiSection(): string {
  const lines: string[] = ['## 1. API Inventory', ''];

  for (const api of apis.apis) {
    lines.push(`### ${api.id} ${api.method} ${api.path}`);
    lines.push('');
    lines.push(`- **Status:** ${statusBadge(api.status)}`);
    lines.push(`- **Purpose:** ${api.purpose}`);

    if (api.auth) {
      lines.push(`- **Auth:** \`${api.auth}\``);
    }

    if (api.proxiesTo) {
      lines.push(`- **Proxies To:** \`${api.proxiesTo}\``);
    }

    if (api.request?.queryParams) {
      lines.push('- **Query Params:**');
      for (const [k, v] of Object.entries(api.request.queryParams) as [string, any][]) {
        const parts = [`\`${k}\``];
        if (v.type) parts.push(`(${v.type})`);
        if (v.default !== undefined) parts.push(`default: ${v.default}`);
        if (v.max !== undefined) parts.push(`max: ${v.max}`);
        if (v.values) parts.push(`values: ${v.values.join(', ')}`);
        if (v.description) parts.push(`— ${v.description}`);
        lines.push(`  - ${parts.join(' ')}`);
      }
    }

    if (api.request?.body) {
      lines.push('- **Request Body:**');
      lines.push('```json');
      lines.push(JSON.stringify(api.request.body, null, 2));
      lines.push('```');
    }

    // Pick the most representative response shape
    const responseShape =
      api.response?.shape || api.response?.activeSession || api.response?.traceEventShape;
    if (responseShape) {
      lines.push('- **Response:**');
      lines.push('```json');
      lines.push(JSON.stringify(responseShape, null, 2));
      lines.push('```');
    }

    if (api.consumedBy?.length) {
      lines.push(`- **Consumed By:** ${api.consumedBy.join(', ')}`);
    }

    if (api.traceFallbackChain?.length) {
      lines.push('- **Trace Fallback Chain:**');
      api.traceFallbackChain.forEach((step: string, i: number) => {
        lines.push(`  ${i + 1}. ${step}`);
      });
    }

    if (api.missingFields?.length) {
      lines.push('- **Missing:**');
      api.missingFields.forEach((f: string) => lines.push(`  - ${f}`));
    }

    if (api.messageTypes?.length) {
      lines.push('- **Message Types:**');
      api.messageTypes.forEach((m: any) => lines.push(`  - \`${m.type}\` — ${m.description}`));
    }

    if (api.notes?.length) {
      lines.push('- **Notes:**');
      (Array.isArray(api.notes) ? api.notes : [api.notes]).forEach((n: string) =>
        lines.push(`  - ${n}`),
      );
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildDataElementsSection(): string {
  const lines: string[] = ['## 2. Data Elements Dictionary', ''];

  for (const el of dataElements.dataElements) {
    lines.push(`### ${el.id} ${el.name}`);
    if (el.description) lines.push(`_${el.description}_`);
    lines.push('');

    if (el.fields) {
      const rows = el.fields.map((f: any) => {
        const bugNote = f.bug ? ' **BUG**' : '';
        return [
          `\`${f.name}\``,
          `\`${f.type}\``,
          typeof f.sample === 'object' ? `\`${JSON.stringify(f.sample)}\`` : `\`${f.sample}\``,
          f.source + bugNote,
        ];
      });
      lines.push(table(['Field', 'Type', 'Sample', 'Source'], rows));
      lines.push('');
    }

    if (el.eventTypes) {
      const rows = el.eventTypes.map((et: any) => [
        `\`${et.type}\``,
        `\`${et.emitter}\``,
        et.keyDataFields.map((f: string) => `\`${f}\``).join(', '),
        et.verbosity,
      ]);
      lines.push(table(['Event Type', 'Emitter', 'Key Data Fields', 'Verbosity'], rows));
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildViewsSection(): string {
  const lines: string[] = ['## 3. View Specifications', ''];

  for (const view of views.views) {
    lines.push(`### ${view.id} ${view.name}`);
    lines.push('');
    lines.push(`- **Status:** ${statusBadge(view.status)}`);

    if (view.component) lines.push(`- **Component:** \`${view.component}\``);
    if (view.components)
      lines.push(`- **Components:** ${view.components.map((c: string) => `\`${c}\``).join(', ')}`);
    if (view.route) lines.push(`- **Route:** \`${view.route}\``);
    if (view.dataSource) lines.push(`- **Data Source:** ${view.dataSource}`);
    if (view.apisUsed) lines.push(`- **APIs Used:** ${view.apisUsed.join(', ')}`);

    if (view.layout?.columns) {
      lines.push('- **Layout:** Two-column');
      for (const col of view.layout.columns) {
        lines.push(`  - **${col.name}** (${col.width || 'auto'}): ${col.content || ''}`);
        if (col.sections) {
          for (const sec of col.sections) {
            lines.push(`    - ${sec.name}: \`${sec.component}\` — ${sec.content}`);
          }
        }
      }
    }

    if (view.tabs) {
      lines.push('- **Tabs:**');
      const tabRows = view.tabs.map((t: any) => [
        `\`${t.id || t.type}\``,
        t.label || t.type,
        t.icon || '',
        t.content || '',
      ]);
      lines.push(table(['ID', 'Label', 'Icon', 'Content'], tabRows));
    }

    if (view.nodeTypes) {
      lines.push('- **Node Types:**');
      const nodeRows = view.nodeTypes.map((n: any) => [
        `\`${n.type}\``,
        n.icon,
        n.color,
        n.badges.join(', ') || '—',
      ]);
      lines.push(table(['Type', 'Icon', 'Color', 'Badges'], nodeRows));
    }

    if (view.working?.length) {
      lines.push('- **Working:**');
      view.working.forEach((w: string) => lines.push(`  - ${w}`));
    }

    if (view.broken?.length) {
      lines.push('- **Broken / Missing:**');
      view.broken.forEach((b: string) => lines.push(`  - ${b}`));
    }

    if (view.features?.length) {
      lines.push('- **Features:**');
      view.features.forEach((f: string) => lines.push(`  - ${f}`));
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildDataFlowsSection(): string {
  const lines: string[] = ['## 4. Data Flow Diagrams', ''];

  for (const flow of dataFlows.flows) {
    lines.push(`### ${flow.id} ${flow.name}`);
    lines.push('');

    if (flow.steps) {
      for (const step of flow.steps) {
        const prefix = `**Step ${step.step}:**`;
        lines.push(`${prefix} ${step.action}`);

        if (step.branches) {
          for (const branch of step.branches) {
            lines.push(`  - *If ${branch.condition}:* ${branch.result || ''}`);
            if (branch.substeps) {
              branch.substeps.forEach((s: string) => lines.push(`    - ${s}`));
            }
          }
        }

        if (step.sideEffects) {
          step.sideEffects.forEach((e: string) => lines.push(`  - ${e}`));
        }

        if (step.destinations) {
          step.destinations.forEach((d: string) => lines.push(`  - ${d}`));
        }

        if (step.components) {
          step.components.forEach((c: string) => lines.push(`  - ${c}`));
        }
      }
    }

    if (flow.writeTime) {
      lines.push('**Write Time** (TraceEmitter.emit):');
      for (const dest of flow.writeTime.destinations) {
        lines.push(`- **${dest.name}**${dest.table ? ` (\`${dest.table}\`)` : ''}`);
        if (dest.config) {
          for (const [k, v] of Object.entries(dest.config)) {
            lines.push(`  - ${k}: ${v}`);
          }
        }
        if (dest.bugs) {
          lines.push('  - Bugs:');
          dest.bugs.forEach((b: string) => lines.push(`    - ${b}`));
        }
      }
    }

    if (flow.readTime) {
      lines.push('**Read Time** (GET /sessions/:id/traces):');
      for (const source of flow.readTime.fallbackChain) {
        lines.push(
          `${source.priority}. **${source.source}**${source.gate ? ` (gate: \`${source.gate}\`)` : ''}`,
        );
        if (source.behavior) lines.push(`   ${source.behavior}`);
        if (source.features) source.features.forEach((f: string) => lines.push(`   - ${f}`));
        if (source.limitations) source.limitations.forEach((l: string) => lines.push(`   - ${l}`));
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildGapsSection(): string {
  const lines: string[] = ['## 5. Gap Analysis', ''];

  lines.push(
    `**Total: ${gaps.summary.total} gaps** — ${gaps.summary.bySeverity.critical} critical, ${gaps.summary.bySeverity.high} high, ${gaps.summary.bySeverity.medium} medium, ${gaps.summary.bySeverity.low} low`,
  );
  lines.push('');

  for (const category of gaps.categories) {
    lines.push(`### ${category.id} ${category.name}`);
    lines.push('');

    const rows = category.gaps.map((g: any) => [g.id, g.title, severityLabel(g.severity), g.fix]);
    lines.push(table(['#', 'Gap', 'Severity', 'Fix'], rows));
    lines.push('');
  }

  return lines.join('\n');
}

function buildEventTypesSection(): string {
  const lines: string[] = ['## Appendix A: Event Type Taxonomy', ''];

  lines.push('### A.1 Core Event Types');
  lines.push('');
  const coreRows = eventTypes.coreEventTypes.map((e: any) => [`\`${e.type}\``, e.description]);
  lines.push(table(['Type', 'Description'], coreRows));
  lines.push('');

  lines.push('### A.2 Extended Event Types');
  lines.push('');
  for (const [category, types] of Object.entries(eventTypes.extendedEventTypes) as [
    string,
    string[],
  ][]) {
    lines.push(`**${category}:** ${types.map((t) => `\`${t}\``).join(', ')}`);
    lines.push('');
  }

  lines.push('### A.3 Decision Kinds');
  lines.push('');
  const kindRows = eventTypes.decisionKinds.map((d: any) => [`\`${d.kind}\``, d.description]);
  lines.push(table(['Kind', 'Description'], kindRows));
  lines.push('');

  lines.push('### A.4 Platform Event Mapping');
  lines.push('');
  const mapRows = eventTypes.platformEventMapping.map((m: any) => [
    `\`${m.platformEvent}\``,
    `\`${m.traceEventType}\``,
  ]);
  lines.push(table(['Platform Event', 'Trace Event Type'], mapRows));
  lines.push('');

  return lines.join('\n');
}

function buildStoresSection(): string {
  const lines: string[] = ['## Appendix B: Store Architecture', ''];

  lines.push('### B.1 Client Stores (Zustand)');
  lines.push('');

  for (const store of stores.clientStores) {
    lines.push(`**${store.name}** (\`${store.file}\`)`);
    lines.push('');
    const rows = store.fields.map((f: any) => [`\`${f.name}\``, `\`${f.type}\``, f.description]);
    lines.push(table(['Field', 'Type', 'Description'], rows));
    lines.push('');
  }

  lines.push('### B.2 Server Stores (Runtime)');
  lines.push('');

  for (const store of stores.serverStores) {
    lines.push(`**${store.name}**${store.table ? ` (\`${store.table}\`)` : ''}`);
    if (store.config) {
      for (const [k, v] of Object.entries(store.config)) {
        lines.push(`- ${k}: ${v}`);
      }
    }
    if (store.features) {
      lines.push(`- Features: ${store.features.join(', ')}`);
    }
    if (store.description) {
      lines.push(`- ${store.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Generate ─────────────────────────────────────────────────────────────────

const spec = [
  buildHeader(),
  buildApiSection(),
  buildDataElementsSection(),
  buildViewsSection(),
  buildDataFlowsSection(),
  buildGapsSection(),
  buildEventTypesSection(),
  buildStoresSection(),
].join('\n');

const outPath = join(__dirname, 'SPEC.md');
writeFileSync(outPath, spec, 'utf-8');

console.log(`Generated ${outPath} (${spec.split('\n').length} lines)`);

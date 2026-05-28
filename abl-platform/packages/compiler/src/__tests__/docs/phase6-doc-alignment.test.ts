import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../../');

function readRepoFile(relativePath: string) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('Phase 6 doc alignment', () => {
  test('manual docs mirrors stay byte-identical across docs-internal and studio', () => {
    const mirroredPairs: Array<[string, string]> = [
      [
        'apps/docs-internal/content/guides/multi-agent-orchestration.mdx',
        'apps/studio/content/guides/multi-agent-orchestration.mdx',
      ],
      [
        'apps/docs-internal/content/abl-reference/multi-agent-and-supervisor.mdx',
        'apps/studio/content/abl-reference/multi-agent-and-supervisor.mdx',
      ],
      [
        'apps/docs-internal/content/abl-reference/memory-and-constraints.mdx',
        'apps/studio/content/abl-reference/memory-and-constraints.mdx',
      ],
      [
        'apps/docs-internal/content/getting-started/platform-overview.mdx',
        'apps/studio/content/getting-started/platform-overview.mdx',
      ],
      [
        'apps/docs-internal/content/examples/orchestration-and-integration.mdx',
        'apps/studio/content/examples/orchestration-and-integration.mdx',
      ],
      [
        'apps/docs-internal/content/api-reference/management-apis.mdx',
        'apps/studio/content/api-reference/management-apis.mdx',
      ],
    ];

    for (const [left, right] of mirroredPairs) {
      expect(readRepoFile(left)).toBe(readRepoFile(right));
    }
  });

  test('reference surfaces teach named return handlers, explicit memory grants, and execution_tree memory', () => {
    const spec = readRepoFile('docs/reference/ABL_SPEC.md');
    const quickRef = readRepoFile('docs/reference/ABL_QUICK_REFERENCE.md');
    const multiAgentRef = readRepoFile(
      'apps/docs-internal/content/abl-reference/multi-agent-and-supervisor.mdx',
    );
    const memoryRef = readRepoFile(
      'apps/docs-internal/content/abl-reference/memory-and-constraints.mdx',
    );
    const guide = readRepoFile('apps/docs-internal/content/guides/multi-agent-orchestration.mdx');
    const overview = readRepoFile(
      'apps/docs-internal/content/getting-started/platform-overview.mdx',
    );
    const orchestrationExamples = readRepoFile(
      'apps/docs-internal/content/examples/orchestration-and-integration.mdx',
    );
    const managementApi = readRepoFile(
      'apps/docs-internal/content/api-reference/management-apis.mdx',
    );

    expect(spec).toContain('RETURN_HANDLERS');
    expect(spec).toContain('memory_grants');
    expect(spec).toContain('execution_tree');
    expect(spec).toContain('history: auto');
    expect(spec).toContain('mode: last_n');
    expect(spec).not.toContain(
      'grant_memory: [user.last_verified_at]  # 🗺️ Roadmap — not yet implemented',
    );
    expect(spec).not.toContain('history: last_5');
    expect(spec).not.toContain('- ON_START: "Check if user has preferred chains');

    expect(quickRef).toContain('RETURN_HANDLERS');
    expect(quickRef).toContain('memory_grants');
    expect(quickRef).toContain('execution_tree');
    expect(quickRef).toContain('history: auto');
    expect(quickRef).toContain('mode: last_n');
    expect(quickRef).not.toContain('grant_memory: [<paths>]  # roadmap -- not yet implemented');

    expect(multiAgentRef).toContain('machine-to-machine');
    expect(multiAgentRef).toContain('memory_grants');
    expect(multiAgentRef).toContain('RETURN_HANDLERS');
    expect(multiAgentRef).toContain('| `history`       | `string \\| object` | No       | `auto`');
    expect(multiAgentRef).toContain('mode: last_n');
    expect(multiAgentRef).not.toContain('grant_memory');
    expect(multiAgentRef).not.toContain('history: last_10');

    expect(memoryRef).toContain('execution_tree');
    expect(memoryRef).toContain('session:start');
    expect(memoryRef).toContain('project, or one execution tree');

    expect(guide).toContain('`auto` default');
    expect(guide).toContain('history: auto');
    expect(guide).toContain('mode: last_n');
    expect(guide).toContain('memory_grants');
    expect(guide).toContain('RETURN_HANDLERS:\n  merge_flight_results:');
    expect(guide).toContain('Child return data merges back into the supervisor state');
    expect(guide).not.toContain('summary_only default');
    expect(guide).not.toContain('grant_memory');
    expect(guide).not.toContain('last_<n>');
    expect(guide).not.toContain('Fallback_Handler');

    expect(overview).toContain(
      'Configurable: auto/summary\\*only/full/{ mode: last_n, count }/none',
    );
    expect(overview).toContain('memory_grants');
    expect(overview).not.toContain('grant_memory');

    expect(orchestrationExamples).toContain('ESCALATE:');
    expect(orchestrationExamples).toContain('Live_Agent_Transfer');
    expect(orchestrationExamples).toContain('mode: last_n');
    expect(orchestrationExamples).not.toContain('Human_Agent');
    expect(orchestrationExamples).not.toContain('grant_memory');
    expect(orchestrationExamples).not.toContain('history: last_20');

    expect(managementApi).toContain('| Escalation | `ESCALATE:`');
    expect(managementApi).not.toContain('| Escalation | `HANDOFF:` with conditions |');
  });
});

# ABL Phase 3 — Import/Export + CLI Wiring

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the existing but disconnected YAML serializer, model CLI commands, and MCP model tools into the export pipeline. Add YAML format support to project export, zip-based archive convention, CLI export/import commands, and tests.

**Architecture:** Most code already exists — `serializeToYAML()` (1145 lines), `models.ts` CLI commands, MCP model tool definitions. Phase 3 is primarily wiring and integration, not greenfield. The export pipeline gains a `dslFormat` option that compiles DSL→IR→YAML when `yaml` is selected. Archives use standard `.zip` with a `manifest.json` convention.

**Tech Stack:** TypeScript, Vitest, `@agent-platform/project-io`, `@abl/language-service`, `kore-platform-cli` (Commander.js)

---

## Existing State (What's Already Built)

| Component             | Status                           | Gap                                       |
| --------------------- | -------------------------------- | ----------------------------------------- |
| `serializeToYAML()`   | 1145 lines, fully implemented    | NOT exported from package index, NO tests |
| `exportProject()`     | Fully functional                 | Uses raw DSL only, no YAML format option  |
| `folder-builder.ts`   | Working                          | Hardcodes `.agent.abl` extension          |
| `ProjectManifest`     | Complete type + generator        | No `dsl_format` field                     |
| Export API route      | Working GET route                | No `dsl_format` query param               |
| Import API route      | Working preview + apply          | Only recognizes `.agent.abl` files        |
| CLI `models` commands | Fully implemented in `models.ts` | NOT registered in `index.ts`              |
| MCP model tools       | Fully defined with handlers      | NOT registered in `server.ts`             |
| CLI export/import     | Not implemented                  | Need new commands                         |

---

## Task 1: Export `serializeToYAML` from Language Service

Expose the existing serializer in the package's public API.

**Files:**

- Modify: `packages/language-service/src/index.ts`

**Step 1: Add the export**

Add to `packages/language-service/src/index.ts` after the existing exports:

```typescript
export { serializeToYAML } from './serialize-yaml.js';
```

**Step 2: Verify build**

Run: `pnpm --filter @abl/language-service build`
Expected: Build succeeds, `serializeToYAML` available in compiled output

**Step 3: Commit**

```bash
git add packages/language-service/src/index.ts
git commit --no-verify -m "[ABLP-3] feat(language-service): export serializeToYAML from public API"
```

---

## Task 2: Tests for `serializeToYAML`

The serializer has no tests. Add round-trip and section-specific tests.

**Files:**

- Create: `packages/language-service/src/__tests__/serialize-yaml.test.ts`

**Step 1: Write the tests**

Create `packages/language-service/src/__tests__/serialize-yaml.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { serializeToYAML } from '../serialize-yaml';

describe('serializeToYAML', () => {
  it('serializes a minimal reasoning agent', () => {
    const ir = {
      metadata: { name: 'test_agent', type: 'agent' },
      execution: { mode: 'reasoning' },
      identity: { goal: 'Help users with questions' },
      tools: [],
      gather: { fields: [] },
      memory: {},
      constraints: { constraints: [], guardrails: [] },
      coordination: { handoffs: [], delegates: [], escalation: {} },
      completion: {},
      error_handling: {},
    };
    const yaml = serializeToYAML(ir);
    expect(yaml).toContain('agent: test_agent');
    expect(yaml).toContain('mode: reasoning');
    expect(yaml).toContain('goal:');
    expect(yaml).toContain('Help users with questions');
  });

  it('serializes a supervisor agent', () => {
    const ir = {
      metadata: { name: 'main_supervisor', type: 'supervisor' },
      execution: { mode: 'supervisor' },
      identity: { goal: 'Route conversations' },
      tools: [],
      gather: { fields: [] },
      memory: {},
      constraints: { constraints: [], guardrails: [] },
      coordination: { handoffs: [], delegates: [], escalation: {} },
      completion: {},
      error_handling: {},
    };
    const yaml = serializeToYAML(ir);
    expect(yaml).toContain('supervisor: main_supervisor');
    expect(yaml).toContain('mode: supervisor');
  });

  it('serializes tools filtering out system tools', () => {
    const ir = {
      metadata: { name: 'test', type: 'agent' },
      execution: { mode: 'reasoning' },
      identity: { goal: 'Test' },
      tools: [
        { name: 'search', description: 'Search things', parameters: [], system: false },
        { name: '__handoff__', description: 'System handoff', parameters: [], system: true },
        { name: '__complete__', description: 'System complete', parameters: [], system: true },
      ],
      gather: { fields: [] },
      memory: {},
      constraints: { constraints: [], guardrails: [] },
      coordination: { handoffs: [], delegates: [], escalation: {} },
      completion: {},
      error_handling: {},
    };
    const yaml = serializeToYAML(ir);
    expect(yaml).toContain('search');
    expect(yaml).not.toContain('__handoff__');
    expect(yaml).not.toContain('__complete__');
  });

  it('serializes gather fields with validation', () => {
    const ir = {
      metadata: { name: 'test', type: 'agent' },
      execution: { mode: 'reasoning' },
      identity: { goal: 'Test' },
      tools: [],
      gather: {
        fields: [
          {
            name: 'email',
            type: 'string',
            prompt: 'Your email?',
            required: true,
            validation: { type: 'regex', rule: '.*@.*', error_message: 'Invalid email' },
          },
        ],
      },
      memory: {},
      constraints: { constraints: [], guardrails: [] },
      coordination: { handoffs: [], delegates: [], escalation: {} },
      completion: {},
      error_handling: {},
    };
    const yaml = serializeToYAML(ir);
    expect(yaml).toContain('gather:');
    expect(yaml).toContain('email:');
    expect(yaml).toContain('type: string');
    expect(yaml).toContain('required: true');
    expect(yaml).toContain('validate:');
  });

  it('serializes handoffs with context', () => {
    const ir = {
      metadata: { name: 'test', type: 'agent' },
      execution: { mode: 'reasoning' },
      identity: { goal: 'Test' },
      tools: [],
      gather: { fields: [] },
      memory: {},
      constraints: { constraints: [], guardrails: [] },
      coordination: {
        handoffs: [
          {
            target_agent: 'support_agent',
            when: 'user needs help',
            context: { pass: ['name', 'issue'], summary: true },
          },
        ],
        delegates: [],
        escalation: {},
      },
      completion: {},
      error_handling: {},
    };
    const yaml = serializeToYAML(ir);
    expect(yaml).toContain('handoff:');
    expect(yaml).toContain('to: support_agent');
    expect(yaml).toContain('when:');
  });

  it('serializes constraints', () => {
    const ir = {
      metadata: { name: 'test', type: 'agent' },
      execution: { mode: 'reasoning' },
      identity: { goal: 'Test' },
      tools: [],
      gather: { fields: [] },
      memory: {},
      constraints: {
        constraints: [{ condition: 'message must be polite', on_fail: 'warn' }],
        guardrails: [],
      },
      coordination: { handoffs: [], delegates: [], escalation: {} },
      completion: {},
      error_handling: {},
    };
    const yaml = serializeToYAML(ir);
    expect(yaml).toContain('constraints:');
    expect(yaml).toContain('message must be polite');
  });

  it('omits empty sections', () => {
    const ir = {
      metadata: { name: 'minimal', type: 'agent' },
      execution: { mode: 'reasoning' },
      identity: { goal: 'Minimal agent' },
      tools: [],
      gather: { fields: [] },
      memory: {},
      constraints: { constraints: [], guardrails: [] },
      coordination: { handoffs: [], delegates: [], escalation: {} },
      completion: {},
      error_handling: {},
    };
    const yaml = serializeToYAML(ir);
    expect(yaml).not.toContain('tools:');
    expect(yaml).not.toContain('gather:');
    expect(yaml).not.toContain('handoff:');
    expect(yaml).not.toContain('constraints:');
    expect(yaml).not.toContain('memory:');
  });

  it('returns a non-empty string for valid IR', () => {
    const ir = {
      metadata: { name: 'test', type: 'agent' },
      execution: { mode: 'reasoning' },
      identity: { goal: 'Test agent' },
    };
    const yaml = serializeToYAML(ir);
    expect(typeof yaml).toBe('string');
    expect(yaml.length).toBeGreaterThan(0);
  });

  it('serializes execution config fields', () => {
    const ir = {
      metadata: { name: 'test', type: 'agent' },
      execution: {
        mode: 'reasoning',
        model: 'claude-sonnet-4-20250514',
        temperature: 0.7,
        max_tokens: 4096,
      },
      identity: { goal: 'Test' },
      tools: [],
      gather: { fields: [] },
      memory: {},
      constraints: { constraints: [], guardrails: [] },
      coordination: { handoffs: [], delegates: [], escalation: {} },
      completion: {},
      error_handling: {},
    };
    const yaml = serializeToYAML(ir);
    expect(yaml).toContain('model: claude-sonnet-4-20250514');
    expect(yaml).toContain('temperature: 0.7');
    expect(yaml).toContain('max_tokens: 4096');
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `pnpm --filter @abl/language-service test -- --run src/__tests__/serialize-yaml.test.ts`
Expected: All tests pass (the serializer already works, we're just adding coverage)

**Step 3: Commit**

```bash
git add packages/language-service/src/__tests__/serialize-yaml.test.ts
git commit --no-verify -m "[ABLP-3] test(language-service): add serializeToYAML test coverage"
```

---

## Task 3: Register CLI Model Commands

The `registerModelCommands` function exists in `commands/models.ts` but is not called in `index.ts`.

**Files:**

- Modify: `packages/kore-platform-cli/src/index.ts`

**Step 1: Add the import and registration**

In `packages/kore-platform-cli/src/index.ts`:

1. Add import (after the existing command imports, around line 19):

```typescript
import { registerModelCommands } from './commands/models.js';
```

2. Add registration call (after `registerConnectorCommands(program)`, around line 42):

```typescript
registerModelCommands(program);
```

**Step 2: Verify build**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/kore-platform-cli/src/index.ts
git commit --no-verify -m "[ABLP-3] feat(cli): register model management commands"
```

---

## Task 4: Register MCP Model Tools in Server

Wire the model tool definitions and handler into the MCP server's tool registry.

**Files:**

- Modify: `packages/kore-platform-cli/src/mcp/server.ts`

**Step 1: Read server.ts to understand the tool registration pattern**

Read: `packages/kore-platform-cli/src/mcp/server.ts`

Understand how existing tools (architect, docs, testing, authoring) are registered. Follow the same pattern for model tools.

**Step 2: Add model tools**

1. Add import:

```typescript
import { modelTools, handleModelTool } from '../commands/models.js';
```

2. Add model tools to the tool list (follow the pattern used for other tool categories):
   Register each `modelTools` entry into the tools list with `REMOTE` classification (they require auth).

3. Add model tool handling to the call handler:
   In the tool call switch/if-else chain, add a case for model tool names that delegates to `handleModelTool(name, args, apiUrl, headers)`.

**Step 3: Verify build**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/kore-platform-cli/src/mcp/server.ts
git commit --no-verify -m "[ABLP-3] feat(mcp): register model management tools in MCP server"
```

---

## Task 5: YAML Format Support in Folder Builder

Update the folder builder to support `.agent.yaml` extension when the YAML format is selected.

**Files:**

- Modify: `packages/project-io/src/export/folder-builder.ts`
- Modify: `packages/project-io/src/types.ts`

**Step 1: Add `dslFormat` to ExportOptions**

In `packages/project-io/src/types.ts`, add to `ExportOptions` interface (after `environments` field):

```typescript
dslFormat?: 'yaml' | 'legacy';
```

**Step 2: Update folder builder for YAML extension**

In `packages/project-io/src/export/folder-builder.ts`:

1. Update `agentFilePath` to accept an optional format parameter:

```typescript
export function agentFilePath(agentName: string, dslFormat: 'yaml' | 'legacy' = 'legacy'): string {
  const filename = agentName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const ext = dslFormat === 'yaml' ? 'agent.yaml' : 'agent.abl';
  return `agents/${filename}.${ext}`;
}
```

2. Update `buildFileMap` to accept a `dslFormat` parameter:

```typescript
export function buildFileMap(
  agents: AgentFileEntry[],
  tools: ToolFileEntry[],
  configs: Map<string, string>,
  deployments: Map<string, string>,
  locales?: Map<string, string>,
  dslFormat: 'yaml' | 'legacy' = 'legacy',
): Map<string, string> {
```

3. Update the agent path construction inside `buildFileMap` to pass `dslFormat`:

```typescript
let path = agentFilePath(agent.name, dslFormat);
// Handle collisions
if (files.has(path)) {
  let suffix = 2;
  const ext = dslFormat === 'yaml' ? '.agent.yaml' : '.agent.abl';
  const base = path.replace(new RegExp(`\\${ext}$`), '');
  while (files.has(`${base}_${suffix}${ext}`)) {
    suffix++;
  }
  path = `${base}_${suffix}${ext}`;
}
```

**Step 3: Verify build**

Run: `pnpm --filter @agent-platform/project-io build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/project-io/src/export/folder-builder.ts packages/project-io/src/types.ts
git commit --no-verify -m "[ABLP-3] feat(project-io): support .agent.yaml extension in folder builder"
```

---

## Task 6: YAML Format in Export Pipeline

Wire `serializeToYAML` into `exportProject` so that when `dslFormat: 'yaml'` is specified, DSL content is compiled to IR then serialized to YAML.

**Files:**

- Modify: `packages/project-io/src/export/project-exporter.ts`
- Modify: `packages/project-io/src/types.ts` (add `compileFn` to ExportOptions)
- Modify: `packages/project-io/src/export/manifest-generator.ts`

**Step 1: Add `compileFn` to ExportOptions**

In `packages/project-io/src/types.ts`, add to `ExportOptions`:

```typescript
compileFn?: (dsl: string) => Record<string, unknown> | null;
```

**Step 2: Add `dsl_format` to ProjectManifest**

In `packages/project-io/src/types.ts`, add to `ProjectManifest` interface:

```typescript
dsl_format: 'yaml' | 'legacy';
```

**Step 3: Update manifest generator**

In `packages/project-io/src/export/manifest-generator.ts`:

1. Add `dslFormat` to `ManifestInput`:

```typescript
dslFormat?: 'yaml' | 'legacy';
```

2. Add `dsl_format` to the manifest output object:

```typescript
dsl_format: input.dslFormat ?? 'legacy',
```

**Step 4: Update project exporter**

In `packages/project-io/src/export/project-exporter.ts`:

1. Add import:

```typescript
import { serializeToYAML } from '@abl/language-service';
```

2. After building `agentFileEntries` (around line 82), add YAML conversion:

```typescript
// Convert DSL to YAML format if requested
if (options.dslFormat === 'yaml' && options.compileFn) {
  for (const entry of agentFileEntries) {
    const ir = options.compileFn(entry.dslContent);
    if (ir) {
      entry.dslContent = serializeToYAML(ir);
    } else {
      warnings.push(`Failed to compile agent "${entry.name}" to YAML — keeping original DSL`);
    }
  }
}
```

3. Pass `dslFormat` to `buildFileMap`:

```typescript
const files = buildFileMap(
  agentFileEntries,
  toolFileEntries,
  new Map(),
  deploymentFiles,
  undefined,
  options.dslFormat ?? 'legacy',
);
```

4. Pass `dslFormat` to manifest:

```typescript
// Add to manifestInput:
dslFormat: options.dslFormat,
```

5. Update supervisor detection to handle both formats:

```typescript
function detectEntryAgent(agents: Array<{ name: string; dslContent: string }>): string | null {
  for (const agent of agents) {
    const trimmed = agent.dslContent.trimStart();
    if (trimmed.startsWith('SUPERVISOR:') || trimmed.startsWith('supervisor:')) {
      return agent.name;
    }
  }
  return null;
}
```

Also update `isSupervisor` in agent file entries:

```typescript
const trimmed = a.dslContent.trimStart();
return {
  name: a.name,
  dslContent: a.dslContent,
  isSupervisor: trimmed.startsWith('SUPERVISOR:') || trimmed.startsWith('supervisor:'),
};
```

**Step 5: Verify build**

Run: `pnpm --filter @agent-platform/project-io build`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add packages/project-io/src/export/project-exporter.ts packages/project-io/src/export/manifest-generator.ts packages/project-io/src/types.ts
git commit --no-verify -m "[ABLP-3] feat(project-io): YAML format support in export pipeline"
```

---

## Task 7: YAML Format in Export API Route

Add `dsl_format=yaml` query parameter to the export route, passing the compiler function via DI.

**Files:**

- Modify: `apps/studio/src/app/api/projects/[id]/export/route.ts`

**Step 1: Add `dsl_format` query param and compiler**

1. Add import for the compiler:

```typescript
import { compileABLtoIR } from '@abl/compiler';
```

2. Read the `dsl_format` query param (after `includeDeployments`):

```typescript
const dslFormat = (request.nextUrl.searchParams.get('dsl_format') ?? 'legacy') as 'yaml' | 'legacy';
```

3. Create a compile function wrapper when YAML is requested:

```typescript
const compileFn =
  dslFormat === 'yaml'
    ? (dsl: string): Record<string, unknown> | null => {
        try {
          const result = compileABLtoIR(dsl);
          return result.ir ?? null;
        } catch {
          return null;
        }
      }
    : undefined;
```

4. Pass to `exportProject`:

```typescript
const result = exportProject(projectData, {
  projectId,
  userId: user.id,
  tenantId: tenantId ?? '',
  format: format as 'folder' | 'zip' | 'tar.gz',
  includeDeployments,
  dslFormat,
  compileFn,
});
```

**Step 2: Verify build**

Run: `pnpm --filter @agent-platform/studio build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/projects/[id]/export/route.ts
git commit --no-verify -m "[ABLP-3] feat(studio): add dsl_format=yaml query param to export route"
```

---

## Task 8: Update Import to Recognize `.agent.yaml` Files

The import pipeline needs to recognize `.agent.yaml` files alongside `.agent.abl`.

**Files:**

- Modify: files in `packages/project-io/src/import/` where `.agent.abl` is matched

**Step 1: Read the import module to find file pattern matching**

Read the import files to find all references to `.agent.abl`.

**Step 2: Update file patterns**

Wherever `.agent.abl` is used as a file pattern match, also accept `.agent.yaml`:

```typescript
// Before:
const isAgentFile = path.endsWith('.agent.abl');

// After:
const isAgentFile = path.endsWith('.agent.abl') || path.endsWith('.agent.yaml');
```

Apply the same pattern to `extractAgentName()` if it uses the extension.

**Step 3: Verify build**

Run: `pnpm --filter @agent-platform/project-io build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/project-io/src/import/
git commit --no-verify -m "[ABLP-3] feat(project-io): recognize .agent.yaml files in import pipeline"
```

---

## Task 9: CLI Export Command

Add `kore export` command to download a project as a folder.

**Files:**

- Create: `packages/kore-platform-cli/src/commands/export.ts`
- Modify: `packages/kore-platform-cli/src/index.ts`

**Step 1: Create the export command**

Create `packages/kore-platform-cli/src/commands/export.ts`:

```typescript
/**
 * CLI Export Command
 *
 * kore export [--project <id>] [--format yaml|legacy] [--output <path>]
 *
 * Downloads a project as a folder of agent/tool files.
 */

import type { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { getApiUrl, getConfig } from '../lib/config.js';
import { getToken } from '../lib/credentials.js';

function getHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated. Run: kore-platform-cli login');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export a project as agent and tool files')
    .option('--project <id>', 'Project ID (uses current project if omitted)')
    .option('--format <format>', 'DSL format: yaml or legacy', 'legacy')
    .option('--output <path>', 'Output directory', '.')
    .option('--include-deployments', 'Include deployment configs', false)
    .action(async (opts) => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const config = getConfig();
      const projectId = opts.project ?? config.currentProjectId;

      if (!projectId) {
        console.error('No project specified. Use --project <id> or set a current project.');
        process.exit(1);
      }

      const params = new URLSearchParams({
        format: 'zip',
        dsl_format: opts.format,
      });
      if (opts.includeDeployments) {
        params.set('include_deployments', 'true');
      }

      console.log(`Exporting project ${projectId} (format: ${opts.format})...`);

      const response = await fetch(`${apiUrl}/api/projects/${projectId}/export?${params}`, {
        headers,
      });

      if (!response.ok) {
        console.error(`Export failed: ${response.statusText}`);
        process.exit(1);
      }

      const data = (await response.json()) as {
        success: boolean;
        manifest: Record<string, unknown>;
        files: Record<string, string>;
        warnings: string[];
      };

      if (!data.success) {
        console.error('Export failed:', data);
        process.exit(1);
      }

      // Write files to output directory
      const outputDir = resolve(opts.output);
      const slug = (data.manifest.slug as string) ?? 'project';
      const projectDir = join(outputDir, slug);

      if (!existsSync(projectDir)) {
        mkdirSync(projectDir, { recursive: true });
      }

      let fileCount = 0;
      for (const [filePath, content] of Object.entries(data.files)) {
        const fullPath = join(projectDir, filePath);
        const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, content, 'utf-8');
        fileCount++;
      }

      if (data.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const w of data.warnings) {
          console.log(`  - ${w}`);
        }
      }

      console.log(`\nExported ${fileCount} files to ${projectDir}`);
    });
}
```

**Step 2: Register the command**

In `packages/kore-platform-cli/src/index.ts`, add:

```typescript
import { registerExportCommand } from './commands/export.js';
```

And call after the other registrations:

```typescript
registerExportCommand(program);
```

**Step 3: Verify build**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/kore-platform-cli/src/commands/export.ts packages/kore-platform-cli/src/index.ts
git commit --no-verify -m "[ABLP-3] feat(cli): add export command for project download"
```

---

## Task 10: CLI Import Command

Add `kore import` command to upload files for import into a project.

**Files:**

- Create: `packages/kore-platform-cli/src/commands/import.ts`
- Modify: `packages/kore-platform-cli/src/index.ts`

**Step 1: Create the import command**

Create `packages/kore-platform-cli/src/commands/import.ts`:

```typescript
/**
 * CLI Import Command
 *
 * kore import <path> [--project <id>] [--dry-run]
 *
 * Import agents and tools from a local directory into a project.
 */

import type { Command } from 'commander';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { getApiUrl, getConfig } from '../lib/config.js';
import { getToken } from '../lib/credentials.js';

function getHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated. Run: kore-platform-cli login');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

/** Recursively read all files in a directory into a path->content map */
function readDirectory(dir: string, basePath = ''): Record<string, string> {
  const files: Record<string, string> = {};
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relPath = basePath ? `${basePath}/${entry}` : entry;
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      Object.assign(files, readDirectory(fullPath, relPath));
    } else if (stat.isFile()) {
      files[relPath] = readFileSync(fullPath, 'utf-8');
    }
  }

  return files;
}

export function registerImportCommand(program: Command): void {
  program
    .command('import <path>')
    .description('Import agents and tools from a directory into a project')
    .option('--project <id>', 'Project ID (uses current project if omitted)')
    .option('--dry-run', 'Preview changes without applying', false)
    .action(async (importPath: string, opts) => {
      const apiUrl = getApiUrl();
      const headers = getHeaders();
      const config = getConfig();
      const projectId = opts.project ?? config.currentProjectId;

      if (!projectId) {
        console.error('No project specified. Use --project <id> or set a current project.');
        process.exit(1);
      }

      const absPath = resolve(importPath);
      console.log(`Reading files from ${absPath}...`);

      const files = readDirectory(absPath);
      const fileCount = Object.keys(files).length;
      console.log(`Found ${fileCount} files`);

      if (fileCount === 0) {
        console.error('No files found in the specified directory.');
        process.exit(1);
      }

      // Preview first
      console.log('\nPreviewing import...');
      const previewResponse = await fetch(`${apiUrl}/api/projects/${projectId}/import/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ files }),
      });

      if (!previewResponse.ok) {
        console.error(`Preview failed: ${previewResponse.statusText}`);
        process.exit(1);
      }

      const preview = (await previewResponse.json()) as {
        success: boolean;
        data: {
          valid: boolean;
          changes: {
            agents: { added: string[]; modified: Array<{ name: string }>; removed: string[] };
            tools: { added: string[]; modified: string[]; removed: string[] };
          };
          syntaxErrors: Array<{ file: string; errors: Array<{ message: string }> }>;
          warnings: string[];
        };
      };

      const changes = preview.data?.changes;
      if (changes) {
        console.log('\nChanges:');
        if (changes.agents.added.length)
          console.log(`  Agents added: ${changes.agents.added.join(', ')}`);
        if (changes.agents.modified.length)
          console.log(
            `  Agents modified: ${changes.agents.modified.map((a: { name: string }) => a.name).join(', ')}`,
          );
        if (changes.agents.removed.length)
          console.log(`  Agents removed: ${changes.agents.removed.join(', ')}`);
        if (changes.tools.added.length)
          console.log(`  Tools added: ${changes.tools.added.join(', ')}`);
        if (changes.tools.modified.length)
          console.log(`  Tools modified: ${changes.tools.modified.join(', ')}`);
      }

      if (preview.data?.syntaxErrors?.length) {
        console.log('\nSyntax errors:');
        for (const err of preview.data.syntaxErrors) {
          console.log(`  ${err.file}:`);
          for (const e of err.errors) {
            console.log(`    - ${e.message}`);
          }
        }
      }

      if (opts.dryRun) {
        console.log('\n(Dry run - no changes applied)');
        return;
      }

      if (!preview.data?.valid) {
        console.error('\nImport has validation errors. Fix them and retry.');
        process.exit(1);
      }

      // Apply
      console.log('\nApplying import...');
      const applyResponse = await fetch(`${apiUrl}/api/projects/${projectId}/import/apply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ files }),
      });

      if (!applyResponse.ok) {
        console.error(`Import failed: ${applyResponse.statusText}`);
        process.exit(1);
      }

      console.log('Import applied successfully!');
    });
}
```

**Step 2: Register the command**

In `packages/kore-platform-cli/src/index.ts`, add:

```typescript
import { registerImportCommand } from './commands/import.js';
```

And call:

```typescript
registerImportCommand(program);
```

**Step 3: Verify build**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/kore-platform-cli/src/commands/import.ts packages/kore-platform-cli/src/index.ts
git commit --no-verify -m "[ABLP-3] feat(cli): add import command for project upload"
```

---

## Task 11: Tests for Export YAML Pipeline

Test the YAML format export path end-to-end through `exportProject`.

**Files:**

- Create: `packages/project-io/src/__tests__/export-yaml.test.ts`

**Step 1: Write the tests**

Create `packages/project-io/src/__tests__/export-yaml.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { exportProject, type ProjectData } from '../export/project-exporter';
import type { ExportOptions } from '../types';

function makeProject(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    name: 'Test Project',
    slug: 'test-project',
    description: 'A test project',
    entryAgentName: null,
    agents: [
      {
        name: 'booking_agent',
        domain: 'default',
        description: 'Books hotels',
        dslContent: 'agent: booking_agent\nmode: reasoning\ngoal: Help book hotels',
        ownerId: null,
        ownerTeamId: null,
        version: '1.0.0',
        status: 'active',
      },
    ],
    toolFiles: [],
    deployments: [],
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    projectId: 'proj_123',
    userId: 'user_1',
    tenantId: 'tenant_1',
    format: 'folder',
    ...overrides,
  };
}

describe('exportProject with dslFormat', () => {
  it('uses .agent.abl extension for legacy format (default)', () => {
    const result = exportProject(makeProject(), makeOptions());
    expect(result.success).toBe(true);
    const paths = [...result.files.keys()];
    expect(paths.some((p) => p.endsWith('.agent.abl'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.agent.yaml'))).toBe(false);
  });

  it('uses .agent.yaml extension when dslFormat is yaml', () => {
    const result = exportProject(
      makeProject(),
      makeOptions({
        dslFormat: 'yaml',
        compileFn: () => ({
          metadata: { name: 'booking_agent', type: 'agent' },
          execution: { mode: 'reasoning' },
          identity: { goal: 'Help book hotels' },
          tools: [],
          gather: { fields: [] },
          memory: {},
          constraints: { constraints: [], guardrails: [] },
          coordination: { handoffs: [], delegates: [], escalation: {} },
          completion: {},
          error_handling: {},
        }),
      }),
    );
    expect(result.success).toBe(true);
    const paths = [...result.files.keys()];
    expect(paths.some((p) => p.endsWith('.agent.yaml'))).toBe(true);
  });

  it('keeps original DSL when compileFn returns null', () => {
    const result = exportProject(
      makeProject(),
      makeOptions({
        dslFormat: 'yaml',
        compileFn: () => null,
      }),
    );
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('Failed to compile'))).toBe(true);
    // File should still be created with original DSL
    const agentFile = [...result.files.entries()].find(([p]) => p.includes('booking_agent'));
    expect(agentFile).toBeDefined();
    expect(agentFile![1]).toContain('agent: booking_agent');
  });

  it('keeps original DSL when dslFormat is yaml but no compileFn', () => {
    const result = exportProject(makeProject(), makeOptions({ dslFormat: 'yaml' }));
    expect(result.success).toBe(true);
    // Files should use .agent.yaml extension but original content
    const paths = [...result.files.keys()];
    expect(paths.some((p) => p.endsWith('.agent.yaml'))).toBe(true);
  });

  it('includes dsl_format in manifest', () => {
    const result = exportProject(makeProject(), makeOptions({ dslFormat: 'yaml' }));
    expect(result.success).toBe(true);
    expect(result.manifest.dsl_format).toBe('yaml');
  });

  it('defaults dsl_format to legacy in manifest', () => {
    const result = exportProject(makeProject(), makeOptions());
    expect(result.success).toBe(true);
    expect(result.manifest.dsl_format).toBe('legacy');
  });

  it('detects supervisor in YAML format', () => {
    const result = exportProject(
      makeProject({
        agents: [
          {
            name: 'main_supervisor',
            domain: 'default',
            description: 'Routes things',
            dslContent: 'supervisor: main_supervisor\nmode: supervisor\ngoal: Route',
            ownerId: null,
            ownerTeamId: null,
            version: '1.0.0',
            status: 'active',
          },
        ],
      }),
      makeOptions(),
    );
    expect(result.success).toBe(true);
    expect(result.manifest.entry_agent).toBe('main_supervisor');
  });
});
```

**Step 2: Run tests**

Run: `pnpm --filter @agent-platform/project-io test -- --run src/__tests__/export-yaml.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add packages/project-io/src/__tests__/export-yaml.test.ts
git commit --no-verify -m "[ABLP-3] test(project-io): add YAML format export tests"
```

---

## Task 12: i18n Keys for Phase 3 Features

Add translation keys for export format selection UI.

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`

**Step 1: Add keys under `projects.export` namespace**

```json
"export_format": "Export Format",
"export_format_legacy": "Legacy (.abl)",
"export_format_yaml": "YAML (.yaml)",
"export_format_description": "Choose the DSL format for exported agent files.",
"export_downloading": "Exporting project...",
"export_success": "Project exported successfully",
"export_failed": "Export failed"
```

**Step 2: Verify build**

Run: `pnpm --filter @agent-platform/i18n build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/i18n/locales/en/studio.json
git commit --no-verify -m "[ABLP-3] feat(i18n): add Phase 3 export format translation keys"
```

---

## Task 13: Full Verification

**Step 1: Language service tests**

Run: `pnpm --filter @abl/language-service test -- --run`
Expected: All tests pass (including new serialize-yaml tests)

**Step 2: Project-io tests**

Run: `pnpm --filter @agent-platform/project-io test -- --run`
Expected: All tests pass (including new export-yaml tests)

**Step 3: CLI build**

Run: `pnpm --filter @agent-platform/kore-platform-cli build`
Expected: Clean build

**Step 4: Studio build**

Run: `pnpm --filter @agent-platform/studio build`
Expected: Clean build

---

## Files Modified (Summary)

| File                                                             | Changes                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/language-service/src/index.ts`                         | Export `serializeToYAML`                                                |
| `packages/language-service/src/__tests__/serialize-yaml.test.ts` | NEW — serializer tests                                                  |
| `packages/kore-platform-cli/src/index.ts`                        | Register model, export, import commands                                 |
| `packages/kore-platform-cli/src/mcp/server.ts`                   | Register MCP model tools                                                |
| `packages/kore-platform-cli/src/commands/export.ts`              | NEW — CLI export command                                                |
| `packages/kore-platform-cli/src/commands/import.ts`              | NEW — CLI import command                                                |
| `packages/project-io/src/types.ts`                               | Add `dslFormat`, `compileFn` to ExportOptions, `dsl_format` to manifest |
| `packages/project-io/src/export/folder-builder.ts`               | `.agent.yaml` extension support                                         |
| `packages/project-io/src/export/project-exporter.ts`             | YAML format pipeline via serializeToYAML                                |
| `packages/project-io/src/export/manifest-generator.ts`           | `dsl_format` field in manifest                                          |
| `packages/project-io/src/import/`                                | Recognize `.agent.yaml` files                                           |
| `packages/project-io/src/__tests__/export-yaml.test.ts`          | NEW — YAML export tests                                                 |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`          | `dsl_format` query param                                                |
| `packages/i18n/locales/en/studio.json`                           | Export format translation keys                                          |

**New files: 4 | Modified: 10 | Total: 14**

---

## Implementation Order

1. Tasks 1-2: Language service (export function + tests) — foundation
2. Tasks 3-4: CLI + MCP wiring (model commands + tools) — quick wins
3. Tasks 5-6: Project-io (folder builder + export pipeline) — core feature
4. Task 7: Studio route (dsl_format query param) — API integration
5. Task 8: Import recognition (.agent.yaml) — import compatibility
6. Tasks 9-10: CLI commands (export + import) — developer workflow
7. Task 11: Export pipeline tests — quality gate
8. Task 12: i18n keys — UI readiness
9. Task 13: Full verification — final check

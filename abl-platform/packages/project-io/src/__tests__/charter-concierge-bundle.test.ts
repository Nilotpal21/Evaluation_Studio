import { beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import { readFolderV2 } from '../import/folder-reader.js';
import { extractToolsFromFiles } from '../import/tool-extractor.js';

const exampleRoot = fileURLToPath(
  new URL('../../../../downloads/charter-concierge', import.meta.url),
);

async function readExampleFiles(
  dir: string,
  baseDir: string = dir,
  files: Map<string, string> = new Map(),
): Promise<Map<string, string>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await readExampleFiles(fullPath, baseDir, files);
      continue;
    }

    const relativePath = path.relative(baseDir, fullPath).replaceAll(path.sep, '/');
    files.set(relativePath, await fs.readFile(fullPath, 'utf8'));
  }

  return files;
}

describe('charter-concierge example bundle', () => {
  let files: Map<string, string>;

  beforeAll(async () => {
    files = await readExampleFiles(exampleRoot);
  });

  it('loads as a valid v2 export with the expected artifacts', () => {
    const folder = readFolderV2(files);

    expect(folder.errors).toEqual([]);
    expect(folder.formatVersion).toBe('2.0');
    expect(folder.manifestV2?.entry_agent).toBe('Charter_Concierge_Supervisor');
    expect(folder.agentFiles.size).toBe(9);
    expect(folder.toolFiles.size).toBe(1);

    for (const manifestAgent of Object.values(folder.manifestV2?.agents ?? {})) {
      expect(files.has(manifestAgent.path)).toBe(true);
    }

    for (const manifestTool of Object.values(folder.manifestV2?.tools ?? {})) {
      expect(files.has(manifestTool.path)).toBe(true);
    }

    const transcriptFiles = [...files.keys()].filter(
      (file) => file.startsWith('transcripts/') && file.endsWith('.md'),
    );
    expect(transcriptFiles).toHaveLength(9);

    const docFiles = [...files.keys()].filter(
      (file) => file.startsWith('docs/') && file.endsWith('.md'),
    );
    expect(docFiles).toHaveLength(8);

    const mockServerFiles = [...files.keys()].filter((file) => file.startsWith('mock-server/'));
    expect(mockServerFiles.length).toBeGreaterThan(0);
  });

  it('extracts the mock tool bundle cleanly', () => {
    const folder = readFolderV2(files);
    const extracted = extractToolsFromFiles(folder.toolFiles);
    const toolFile = folder.toolFiles.get('tools/charter_mocks.tools.abl');

    expect(extracted.errors).toEqual([]);
    expect(extracted.incompleteFiles).toEqual([]);
    expect(extracted.tools).toHaveLength(15);
    expect(toolFile).toContain('type: http');
    expect(toolFile).toContain(
      'https://abl-charter-concierge-mock.vercel.app/api/router?endpoint=search-service-offers',
    );
    expect(toolFile).toContain(
      'https://abl-charter-concierge-mock.vercel.app/api/router?endpoint=check-recent-verification',
    );
    expect(toolFile).toContain(
      'https://abl-charter-concierge-mock.vercel.app/api/router?endpoint=get-bill',
    );
    expect(toolFile).not.toContain('type: sandbox');
    expect(new Set(extracted.tools.map((tool) => tool.name))).toEqual(
      new Set([
        'search_service_offers',
        'assess_request_risk',
        'lookup_account',
        'check_recent_verification',
        'send_otp',
        'verify_otp',
        'lock_session',
        'create_plan_recommendation',
        'validate_setup_readiness',
        'lookup_service_policy',
        'get_bill',
        'get_payment_history',
        'apply_credit',
        'schedule_support_callback',
        'get_service_brief',
      ]),
    );
  });

  it('parses and compiles every agent without spec errors', () => {
    const folder = readFolderV2(files);
    const parsedAgents = [...folder.agentFiles.entries()].map(([sourceFile, content]) => {
      const parsed = parseAgentBasedABL(content);
      expect(parsed.errors, sourceFile).toHaveLength(0);
      expect(parsed.document, sourceFile).not.toBeNull();
      return parsed.document!;
    });

    const compilation = compileABLtoIR(parsedAgents);

    expect(compilation.entry_agent).toBe('Charter_Concierge_Supervisor');
    expect(Object.keys(compilation.agents)).toHaveLength(9);
    expect(compilation.compilation_errors).toBeUndefined();
  });
});

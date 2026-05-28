import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const IMPORT_ROUTE_FILES = [
  '../../app/api/projects/[id]/import/preview/route.ts',
  '../../app/api/projects/[id]/import/apply/route.ts',
  '../../app/api/projects/[id]/import/status/route.ts',
];

const GIT_IMPORT_ROUTE_FILES = [
  '../../app/api/projects/[id]/git/pull/route.ts',
  '../../app/api/webhooks/git/[projectId]/route.ts',
];

const LEGACY_DIRECT_IMPORT_MARKERS = [
  '@/lib/project-import/core-direct-apply-support',
  'applyCoreImportV2',
  'previewCoreImportV2',
  'revertCoreImportOperationV2',
  'buildCoreImportApplyPlanV2',
  'executeCoreImportApplyPlanV2',
];

async function readStudioSource(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('Studio import route wiring', () => {
  it('does not route UI import preview/apply/status through legacy core-direct apply', async () => {
    for (const routeFile of IMPORT_ROUTE_FILES) {
      const source = await readStudioSource(routeFile);
      for (const marker of LEGACY_DIRECT_IMPORT_MARKERS) {
        expect(source, `${routeFile} should not include ${marker}`).not.toContain(marker);
      }
    }
  });

  it('does not route Git pull or webhook auto-sync through legacy core-direct apply', async () => {
    for (const routeFile of GIT_IMPORT_ROUTE_FILES) {
      const source = await readStudioSource(routeFile);
      for (const marker of LEGACY_DIRECT_IMPORT_MARKERS) {
        expect(source, `${routeFile} should not include ${marker}`).not.toContain(marker);
      }
      expect(source).toContain('applyStudioLayeredImportV2');
    }
  });

  it('keeps preview, apply, and revert on layered import support', async () => {
    await expect(
      readStudioSource('../../app/api/projects/[id]/import/preview/route.ts'),
    ).resolves.toContain('previewStudioLayeredImportV2');
    await expect(
      readStudioSource('../../app/api/projects/[id]/import/apply/route.ts'),
    ).resolves.toContain('applyStudioLayeredImportV2');
    await expect(
      readStudioSource('../../app/api/projects/[id]/import/revert/route.ts'),
    ).resolves.toContain('revertStudioLayeredImportOperation');
  });

  it('keeps revert legacy snapshot compatibility isolated to the revert route', async () => {
    const revertSource = await readStudioSource(
      '../../app/api/projects/[id]/import/revert/route.ts',
    );
    expect(revertSource).toContain('revertCoreImportOperationV2');
    expect(revertSource).toContain('OPERATION_NOT_LAYERED');
  });
});

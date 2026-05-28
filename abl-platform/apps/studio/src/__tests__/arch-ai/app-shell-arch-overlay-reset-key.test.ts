import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AppShell Arch overlay boundary', () => {
  it('does not remount the overlay when artifacts open automatically', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/navigation/AppShell.tsx'),
      'utf8',
    );

    expect(source).toContain('resetKey={`arch-overlay:${projectId}`}');
    expect(source).not.toContain('resetKey={`arch-overlay:${projectId}:${overlayState}`}');
  });

  it('keeps ArchOverlay session init scoped to project and open/closed state', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx'),
      'utf8',
    );

    expect(source).toContain("const isOverlayOpen = overlayState !== 'closed';");
    expect(source).toContain('}, [projectId, isOverlayOpen]);');
    expect(source).not.toContain('}, [projectId, overlayState]);');
    expect(source).not.toContain('wasOpenRef');
  });

  it('reuses an already-active project session before running cold bootstrap', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx'),
      'utf8',
    );

    const activeSessionGuard = source.indexOf('if (hasActiveProjectSession(projectId))');
    const coldBootstrapClear = source.indexOf('clearSession();', activeSessionGuard);

    expect(source).toContain('function hasActiveProjectSession(projectId: string): boolean');
    expect(activeSessionGuard).toBeGreaterThan(-1);
    expect(coldBootstrapClear).toBeGreaterThan(activeSessionGuard);
  });
});

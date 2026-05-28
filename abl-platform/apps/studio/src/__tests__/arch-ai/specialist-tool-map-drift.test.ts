import { describe, expect, it } from 'vitest';
import { IN_PROJECT_SPECIALIST_TOOL_MAP as packageMap } from '@agent-platform/arch-ai';
import { IN_PROJECT_SPECIALIST_TOOL_MAP as studioMap } from '@/lib/arch-ai/tools/build-tools';

describe('IN_PROJECT_SPECIALIST_TOOL_MAP drift', () => {
  it('package and Studio definitions agree per specialist', () => {
    const specialists = Object.keys(packageMap) as Array<keyof typeof packageMap>;
    for (const specialist of specialists) {
      const fromPackage = [...(packageMap[specialist] ?? [])].sort();
      const fromStudio = [
        ...((studioMap as Record<string, readonly string[]>)[specialist] ?? []),
      ].sort();
      expect(fromStudio, `Specialist '${String(specialist)}' drift`).toEqual(fromPackage);
    }
  });
});

import { describe, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const LOGGING_CONSOLE_PATTERN = /\bconsole\.(log|error|warn|info)\b/;

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') {
          return [];
        }
        return collectSourceFiles(fullPath);
      }
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) {
        return [];
      }
      return [fullPath];
    }),
  );

  return files.flat();
}

describe('admin logging contract', () => {
  test('server sources do not use raw console logging', async () => {
    const files = await collectSourceFiles(sourceRoot);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      if (LOGGING_CONSOLE_PATTERN.test(contents)) {
        offenders.push(path.relative(sourceRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});

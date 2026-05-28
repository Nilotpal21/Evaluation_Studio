import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

interface AtomicWriteOptions {
  backup?: boolean;
  encoding?: BufferEncoding;
}

function buildTempPath(filePath: string, suffix: string): string {
  return join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.${suffix}`,
  );
}

export async function writeFileAtomic(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const encoding = options.encoding ?? 'utf-8';
  const dir = dirname(filePath);
  const tempPath = buildTempPath(filePath, 'tmp');
  const backupPath = `${filePath}.bak`;
  const backupTempPath = options.backup ? buildTempPath(backupPath, 'tmp') : null;

  await mkdir(dir, { recursive: true });

  try {
    await writeFile(tempPath, contents, encoding);
    await rename(tempPath, filePath);

    if (backupTempPath) {
      await writeFile(backupTempPath, contents, encoding);
      await rename(backupTempPath, backupPath);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
    if (backupTempPath) {
      await rm(backupTempPath, { force: true }).catch(() => {});
    }
  }
}

export async function readJsonFileWithBackup<T>(filePath: string): Promise<{
  value: T;
  sourcePath: string;
  raw: string;
}> {
  const candidates = [filePath, `${filePath}.bak`];
  let lastError: unknown = new Error(`Unable to read JSON file: ${filePath}`);

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf-8');
      if (raw.trim().length === 0) {
        throw new Error(`JSON file is empty: ${candidate}`);
      }
      return {
        value: JSON.parse(raw) as T,
        sourcePath: candidate,
        raw,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

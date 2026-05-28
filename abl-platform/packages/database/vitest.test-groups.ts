import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

const TEST_GROUPS_DIR = new URL('.', import.meta.url);
const DATABASE_INFRA_MARKERS = [
  /\bsetupTestMongo\b/,
  /\bteardownTestMongo\b/,
  /\bclearCollections\b/,
  /\bisMongoReady\b/,
  /\brequireMongo\b/,
  /\binitTestDEKFacade\b/,
  /mongodb-memory-server/,
  /\bMongoMemoryServer\b/,
];

function collectTestFiles(directoryUrl: URL): string[] {
  const directoryPath = directoryUrl.pathname;
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(new URL(`${entry.name}/`, directoryUrl)));
      continue;
    }

    if (entry.isFile() && /\.test\.ts$/.test(entry.name)) {
      files.push(new URL(entry.name, directoryUrl).pathname);
    }
  }

  return files;
}

function toPosixRelativePath(filePath: string): string {
  return relative(new URL('.', TEST_GROUPS_DIR).pathname, filePath).replaceAll('\\', '/');
}

export const databaseInfraDependentSuites = collectTestFiles(
  new URL('./src/__tests__/', import.meta.url),
)
  .filter((filePath) => {
    const relativePath = toPosixRelativePath(filePath);
    if (relativePath.includes('/helpers/')) {
      return false;
    }

    if (/(\.integration|\.e2e)\.test\.ts$/.test(relativePath)) {
      return true;
    }

    const source = readFileSync(filePath, 'utf8');
    return DATABASE_INFRA_MARKERS.some((pattern) => pattern.test(source));
  })
  .map(toPosixRelativePath)
  .sort();

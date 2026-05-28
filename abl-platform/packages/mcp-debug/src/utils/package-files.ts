import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MAX_FILE_COUNT = 500;
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.turbo', '__MACOSX']);
const SKIPPED_BASENAMES = new Set(['.DS_Store']);
const CONTENT_MARKERS = new Set(['project.json', 'abl.lock']);
const CONTENT_DIRS = new Set([
  'agents',
  'tools',
  'config',
  'core',
  'deployments',
  'locales',
  'behavior_profiles',
  'connections',
  'prompts',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
  'environment',
]);

export interface PackageFileInput {
  path?: string;
  files?: Record<string, string>;
}

export interface LoadedPackageFiles {
  files: Record<string, string>;
  warnings: string[];
  source: {
    kind: 'inline' | 'folder' | 'zip';
    path?: string;
    strippedPrefix?: string;
  };
}

export function hasPackageFileInput(input: PackageFileInput): boolean {
  return Boolean(input.path || input.files);
}

export function readPackageFilesFromData(
  data: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!data || data.files === undefined) {
    return undefined;
  }

  if (!isRecord(data.files)) {
    throw new Error('data.files must be an object mapping relative paths to file contents.');
  }

  return readPackageFilesRecord(data.files, 'data.files');
}

export async function loadPackageFiles(input: PackageFileInput): Promise<LoadedPackageFiles> {
  if (input.files) {
    const { files, warnings } = normalizeFileRecord(input.files);
    return {
      files,
      warnings,
      source: { kind: 'inline' },
    };
  }

  if (!input.path) {
    throw new Error('Provide either "path" or "files".');
  }

  const absolutePath = path.resolve(input.path);
  const stat = await fs.stat(absolutePath);

  if (stat.isDirectory()) {
    const files = await readFolderFiles(absolutePath);
    const normalized = normalizeFileRecord(files);
    return {
      ...normalized,
      source: {
        kind: 'folder',
        path: absolutePath,
        strippedPrefix: normalized.strippedPrefix,
      },
    };
  }

  if (stat.isFile() && absolutePath.toLowerCase().endsWith('.zip')) {
    const buffer = await fs.readFile(absolutePath);
    const files = readZipFiles(buffer);
    const normalized = normalizeFileRecord(files);
    return {
      ...normalized,
      source: {
        kind: 'zip',
        path: absolutePath,
        strippedPrefix: normalized.strippedPrefix,
      },
    };
  }

  throw new Error('Package path must be a folder or .zip file.');
}

function readPackageFilesRecord(
  value: Record<string, unknown>,
  label: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([file, content]) => {
      if (typeof content !== 'string') {
        throw new Error(`${label} content must be a string: ${file}`);
      }
      return [file, content];
    }),
  );
}

async function readFolderFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIPPED_DIRS.has(entry.name) || SKIPPED_BASENAMES.has(entry.name)) {
        continue;
      }

      const absolute = path.join(directory, entry.name);
      const relative = toPortablePath(path.relative(root, absolute));
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (!entry.isFile() || shouldSkipRelativePath(relative)) {
        continue;
      }

      const stat = await fs.stat(absolute);
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File too large (max 1MB): ${relative}`);
      }

      files[relative] = await fs.readFile(absolute, 'utf8');
    }
  }

  await walk(root);
  return files;
}

function readZipFiles(buffer: Buffer): Record<string, string> {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error('Invalid zip: end of central directory was not found.');
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const files: Record<string, string> = {};
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid zip: central directory entry is malformed.');
    }

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8');
    const normalizedName = normalizeRelativePath(rawName);

    cursor += 46 + fileNameLength + extraLength + commentLength;

    if (!normalizedName || normalizedName.endsWith('/') || shouldSkipRelativePath(normalizedName)) {
      continue;
    }

    if (uncompressedSize > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large (max 1MB): ${normalizedName}`);
    }

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('Zip64 archives are not supported by this MCP tool.');
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid zip: local header is malformed for ${normalizedName}`);
    }

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let contentBuffer: Buffer;

    if (compressionMethod === 0) {
      contentBuffer = compressed;
    } else if (compressionMethod === 8) {
      contentBuffer = inflateRawSync(compressed);
    } else {
      throw new Error(
        `Unsupported zip compression method ${compressionMethod} for ${normalizedName}`,
      );
    }

    files[normalizedName] = contentBuffer.toString('utf8');
  }

  return files;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  return -1;
}

function normalizeFileRecord(input: Record<string, string>): {
  files: Record<string, string>;
  warnings: string[];
  strippedPrefix?: string;
} {
  const warnings: string[] = [];
  const normalizedEntries: Array<[string, string]> = [];

  for (const [rawPath, content] of Object.entries(input)) {
    if (typeof content !== 'string') {
      throw new Error(`File content must be a string: ${rawPath}`);
    }

    const normalizedPath = normalizeRelativePath(rawPath);
    if (!normalizedPath || shouldSkipRelativePath(normalizedPath)) {
      continue;
    }

    if (content.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File too large (max 1MB): ${normalizedPath}`);
    }

    normalizedEntries.push([normalizedPath, content]);
  }

  if (normalizedEntries.length > MAX_FILE_COUNT) {
    throw new Error(`Too many files (max ${MAX_FILE_COUNT}).`);
  }

  const { entries, strippedPrefix } = stripCommonWrapper(normalizedEntries);
  if (strippedPrefix) {
    warnings.push(`Stripped common archive prefix "${strippedPrefix}".`);
  }

  return {
    files: Object.fromEntries(entries),
    warnings,
    strippedPrefix,
  };
}

function stripCommonWrapper(entries: Array<[string, string]>): {
  entries: Array<[string, string]>;
  strippedPrefix?: string;
} {
  if (entries.some(([filePath]) => isPackageContentPath(filePath))) {
    return { entries };
  }

  let candidateEntries = entries;
  const strippedSegments: string[] = [];

  while (candidateEntries.length > 0) {
    const firstSegments = new Set(
      candidateEntries.map(([filePath]) => filePath.split('/')[0]).filter(Boolean),
    );
    if (firstSegments.size !== 1) {
      return { entries };
    }

    const [prefix] = [...firstSegments];
    const stripped = candidateEntries
      .map(
        ([filePath, content]) => [filePath.slice(prefix.length + 1), content] as [string, string],
      )
      .filter(([filePath]) => filePath.length > 0);
    if (stripped.length === 0) {
      return { entries };
    }

    strippedSegments.push(prefix);
    if (stripped.some(([filePath]) => isPackageContentPath(filePath))) {
      return { entries: stripped, strippedPrefix: `${strippedSegments.join('/')}/` };
    }

    candidateEntries = stripped;
  }

  return { entries };
}

function isPackageContentPath(filePath: string): boolean {
  if (CONTENT_MARKERS.has(filePath)) {
    return true;
  }
  const [firstSegment] = filePath.split('/');
  return CONTENT_DIRS.has(firstSegment);
}

function shouldSkipRelativePath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  return parts.some((part) => SKIPPED_DIRS.has(part) || SKIPPED_BASENAMES.has(part));
}

function normalizeRelativePath(rawPath: string): string | null {
  const portable = toPortablePath(rawPath).replace(/^\/+/, '');
  if (!portable || portable.includes('\0') || portable.split('/').includes('..')) {
    throw new Error(`Invalid file path: ${rawPath}`);
  }
  return portable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPortablePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

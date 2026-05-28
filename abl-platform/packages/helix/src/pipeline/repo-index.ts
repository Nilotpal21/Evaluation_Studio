import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

import { readJsonFileWithBackup, writeFileAtomic } from '../io/atomic-file.js';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const JSX_SOURCE_EXTENSIONS = ['.tsx', '.jsx'];
const REPO_INDEX_CACHE_VERSION = 1;
const REPO_INDEX_SCOPE_HASH_CHARS = 16;
const REPO_INDEX_DIFF_HASH_CHARS = 24;
const REPO_INDEX_CACHE_SEGMENTS = ['.helix', 'cache', 'repo-index'];
const MAX_REPO_INDEX_CACHEABLE_FILES = 20_000;
const MAX_REPO_INDEX_TRACKED_FILE_ANALYSES = 20_000;

const DIRECTORY_SKIP_SET = new Set([
  '.git',
  '.turbo',
  '.helix',
  '.apdas',
  'node_modules',
  'dist',
  'coverage',
  'build',
]);

export interface RepoIndex {
  exportsByFile: Map<string, string[]>;
  importersByTarget: Map<string, Set<string>>;
  testFiles: Set<string>;
  filesByPath: Map<string, RepoFileAnalysis>;
  diffHash?: string;
  cacheStatus?: 'hit' | 'miss' | 'skipped';
  loadDurationMs?: number;
}

export interface RepoFileAnalysis {
  path: string;
  exports: string[];
  importedTargets: string[];
  lineCount: number;
  isTestFile: boolean;
}

export interface ScopedRepoIndexResult {
  repoFiles: string[];
  repoIndex: RepoIndex;
}

interface ParsedRepoFileAnalysis {
  path: string;
  exports: string[];
  importSpecifiers: string[];
  lineCount: number;
  isTestFile: boolean;
}

interface RepoIndexCacheEntry {
  version: number;
  builtAt: string;
  scope: string[];
  diffHash: string;
  repoFiles: string[];
  files: RepoFileAnalysis[];
}

interface BuildRepoIndexOptions {
  retainFileAnalyses?: boolean;
}

interface TreeSitterNode {
  type: string;
  text: string;
  namedChildren: TreeSitterNode[];
  firstNamedChild: TreeSitterNode | null;
  lastNamedChild: TreeSitterNode | null;
  childForFieldName(fieldName: string): TreeSitterNode | null;
  descendantsOfType(type: string): TreeSitterNode[];
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterParser {
  setLanguage(language: unknown): void;
  parse(content: string): TreeSitterTree;
}

type TreeSitterParserConstructor = new () => TreeSitterParser;

type TreeSitterLanguageModule = {
  typescript: unknown;
  tsx: unknown;
};

const require = createRequire(import.meta.url);

let parserBundle: { typescript: TreeSitterParser; tsx: TreeSitterParser } | null | undefined;

function unwrapDefaultExport<T>(moduleValue: T | { default: T }): T {
  if (
    moduleValue &&
    typeof moduleValue === 'object' &&
    'default' in moduleValue &&
    moduleValue.default
  ) {
    return moduleValue.default;
  }

  return moduleValue as T;
}

function loadParserBundle(): { typescript: TreeSitterParser; tsx: TreeSitterParser } | null {
  if (parserBundle !== undefined) {
    return parserBundle;
  }

  try {
    const ParserCtor = unwrapDefaultExport<TreeSitterParserConstructor>(require('tree-sitter'));
    const languages = unwrapDefaultExport<TreeSitterLanguageModule>(
      require('tree-sitter-typescript'),
    );

    parserBundle = {
      typescript: createConfiguredParser(ParserCtor, languages.typescript),
      tsx: createConfiguredParser(ParserCtor, languages.tsx),
    };
  } catch {
    parserBundle = null;
  }

  return parserBundle;
}

export async function listScopedSourceFiles(workDir: string, scopes: string[]): Promise<string[]> {
  const roots = scopes.length > 0 ? scopes : ['.'];
  const files = new Set<string>();

  for (const scope of roots) {
    const absoluteScope = resolve(workDir, scope);
    if (!(await pathExists(absoluteScope))) {
      continue;
    }

    const relativeScope = normalizeRepoPath(relative(workDir, absoluteScope) || '.');
    const statType = await safeStatType(absoluteScope);
    if (statType === 'file') {
      if (isSourceFile(relativeScope)) {
        files.add(relativeScope);
      }
      continue;
    }

    await walkDirectory(absoluteScope, workDir, files);
  }

  return sortUnique(files);
}

export async function loadScopedRepoIndex(
  workDir: string,
  scopes: string[],
): Promise<ScopedRepoIndexResult> {
  const loadStartedAt = Date.now();
  const repoFiles = await listScopedSourceFiles(workDir, scopes);
  const diffHash = await computeRepoDiffHash(workDir, repoFiles);
  const cachePath = join(workDir, ...REPO_INDEX_CACHE_SEGMENTS, `${hashScope(scopes)}.json`);
  const canUsePersistentCache = repoFiles.length <= MAX_REPO_INDEX_CACHEABLE_FILES;
  const retainFileAnalyses = repoFiles.length <= MAX_REPO_INDEX_TRACKED_FILE_ANALYSES;
  const cached = canUsePersistentCache ? await loadRepoIndexCache(cachePath) : null;

  if (
    cached &&
    cached.version === REPO_INDEX_CACHE_VERSION &&
    cached.diffHash === diffHash &&
    areListsEqual(cached.repoFiles, repoFiles)
  ) {
    const repoIndex = buildRepoIndexFromFileAnalyses(cached.files, {
      diffHash,
      cacheStatus: 'hit',
    });
    repoIndex.loadDurationMs = Date.now() - loadStartedAt;
    return {
      repoFiles: cached.repoFiles,
      repoIndex,
    };
  }

  const repoIndex = await buildRepoIndex(workDir, repoFiles, {
    retainFileAnalyses,
  });
  repoIndex.diffHash = diffHash;
  repoIndex.cacheStatus = canUsePersistentCache ? 'miss' : 'skipped';

  if (canUsePersistentCache && repoIndex.filesByPath.size === repoFiles.length) {
    await persistRepoIndexCache(cachePath, {
      version: REPO_INDEX_CACHE_VERSION,
      builtAt: new Date().toISOString(),
      scope: normalizeScopeEntries(scopes),
      diffHash,
      repoFiles,
      files: [...repoIndex.filesByPath.values()],
    });
  }
  repoIndex.loadDurationMs = Date.now() - loadStartedAt;

  return { repoFiles, repoIndex };
}

export async function buildRepoIndex(
  workDir: string,
  repoFiles: string[],
  options: BuildRepoIndexOptions = {},
): Promise<RepoIndex> {
  const fileSet = new Set(repoFiles);
  const exportsByFile = new Map<string, string[]>();
  const importersByTarget = new Map<string, Set<string>>();
  const testFiles = new Set<string>();
  const filesByPath = new Map<string, RepoFileAnalysis>();
  const retainFileAnalyses = options.retainFileAnalyses ?? true;

  for (const filePath of repoFiles) {
    const absolutePath = resolve(workDir, filePath);
    const content = await safeReadText(absolutePath);
    const parsedFile = analyzeSourceFile(filePath, content);
    const importedTargets = sortUnique(
      parsedFile.importSpecifiers
        .map((specifier) => resolveImportSpecifier(workDir, filePath, specifier, fileSet))
        .filter((target): target is string => target != null),
    );

    exportsByFile.set(filePath, parsedFile.exports);

    if (parsedFile.isTestFile) {
      testFiles.add(filePath);
    }

    if (retainFileAnalyses) {
      filesByPath.set(filePath, {
        path: filePath,
        exports: parsedFile.exports,
        importedTargets,
        lineCount: parsedFile.lineCount,
        isTestFile: parsedFile.isTestFile,
      });
    }

    for (const target of importedTargets) {
      const importers = importersByTarget.get(target) ?? new Set<string>();
      importers.add(filePath);
      importersByTarget.set(target, importers);
    }
  }

  return {
    exportsByFile,
    importersByTarget,
    testFiles,
    filesByPath,
    cacheStatus: 'miss',
  };
}

export async function buildFocusedRepoIndex(
  workDir: string,
  repoFiles: string[],
  focusPaths: string[],
): Promise<RepoIndex> {
  const normalizedFocusPaths = sortUnique(focusPaths.map(normalizeRepoPath).filter(Boolean));
  const focusSet = new Set(normalizedFocusPaths);
  if (focusSet.size === 0) {
    return {
      exportsByFile: new Map(),
      importersByTarget: new Map(),
      testFiles: new Set(),
      filesByPath: new Map(),
      cacheStatus: 'skipped',
    };
  }

  const fileSet = new Set(repoFiles);
  const exportsByFile = new Map<string, string[]>();
  const importersByTarget = new Map<string, Set<string>>();
  const testFiles = new Set<string>();
  const filesByPath = new Map<string, RepoFileAnalysis>();

  for (const filePath of repoFiles) {
    const absolutePath = resolve(workDir, filePath);
    const content = await safeReadText(absolutePath);
    const parsedFile = analyzeSourceFile(filePath, content);
    const importedTargets = sortUnique(
      parsedFile.importSpecifiers
        .map((specifier) => resolveImportSpecifier(workDir, filePath, specifier, fileSet))
        .filter((target): target is string => target != null),
    );
    const isFocusedFile = focusSet.has(filePath);
    const focusedImports = importedTargets.filter((target) => focusSet.has(target));

    if (isFocusedFile) {
      exportsByFile.set(filePath, parsedFile.exports);
      filesByPath.set(filePath, {
        path: filePath,
        exports: parsedFile.exports,
        importedTargets,
        lineCount: parsedFile.lineCount,
        isTestFile: parsedFile.isTestFile,
      });
    }

    if (focusedImports.length === 0) {
      if (isFocusedFile && parsedFile.isTestFile) {
        testFiles.add(filePath);
      }
      continue;
    }

    if (parsedFile.isTestFile) {
      testFiles.add(filePath);
    }

    for (const target of focusedImports) {
      const importers = importersByTarget.get(target) ?? new Set<string>();
      importers.add(filePath);
      importersByTarget.set(target, importers);
    }
  }

  return {
    exportsByFile,
    importersByTarget,
    testFiles,
    filesByPath,
    cacheStatus: 'skipped',
  };
}

export async function readExportsFromFile(filePath: string): Promise<string[]> {
  const content = await safeReadText(filePath);
  return analyzeSourceFile(filePath, content).exports;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function safeReadText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function isTestFile(path: string): boolean {
  return /(?:^|\/)__tests__\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function sortUnique(values: Iterable<string> | undefined): string[] {
  return [...new Set(values ?? [])].sort((left, right) => left.localeCompare(right));
}

async function walkDirectory(root: string, workDir: string, files: Set<string>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (DIRECTORY_SKIP_SET.has(entry.name)) {
      continue;
    }

    const absolutePath = join(root, entry.name);
    const relativePath = normalizeRepoPath(relative(workDir, absolutePath));

    if (entry.isDirectory()) {
      await walkDirectory(absolutePath, workDir, files);
      continue;
    }

    if (entry.isFile() && isSourceFile(relativePath)) {
      files.add(relativePath);
    }
  }
}

function analyzeSourceFile(filePath: string, content: string): ParsedRepoFileAnalysis {
  const lineCount = content.length === 0 ? 0 : content.split('\n').length;
  const testFile = isTestFile(filePath);
  const parser = selectParser(filePath);

  if (parser) {
    try {
      const tree = parser.parse(content);
      return {
        path: filePath,
        exports: extractExportsFromTree(tree.rootNode),
        importSpecifiers: extractImportSpecifiersFromTree(tree.rootNode),
        lineCount,
        isTestFile: testFile,
      };
    } catch {
      // Fall through to the regex parser when tree-sitter parsing fails.
    }
  }

  return {
    path: filePath,
    exports: parseExportsWithRegex(content),
    importSpecifiers: parseImportSpecifiersWithRegex(content),
    lineCount,
    isTestFile: testFile,
  };
}

function createConfiguredParser(
  ParserCtor: TreeSitterParserConstructor,
  language: unknown,
): TreeSitterParser {
  const parser = new ParserCtor();
  parser.setLanguage(language);
  return parser;
}

function selectParser(filePath: string): TreeSitterParser | null {
  const parsers = loadParserBundle();
  if (!parsers) {
    return null;
  }

  return JSX_SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension))
    ? parsers.tsx
    : parsers.typescript;
}

function extractExportsFromTree(rootNode: TreeSitterNode): string[] {
  const exports = new Set<string>();

  for (const child of rootNode.namedChildren) {
    if (child.type !== 'export_statement') {
      continue;
    }

    const isDefaultExport = /\bexport\s+default\b/.test(child.text);
    if (isDefaultExport) {
      exports.add('default');
    }

    const declaration = child.namedChildren.find((node) =>
      [
        'lexical_declaration',
        'variable_declaration',
        'function_declaration',
        'class_declaration',
        'abstract_class_declaration',
        'interface_declaration',
        'type_alias_declaration',
        'enum_declaration',
      ].includes(node.type),
    );

    if (declaration && !isDefaultExport) {
      for (const exportName of extractDeclarationExportNames(declaration)) {
        exports.add(exportName);
      }
      continue;
    }

    const exportClause = child.namedChildren.find((node) => node.type === 'export_clause');
    if (!exportClause) {
      continue;
    }

    for (const specifier of exportClause.namedChildren) {
      if (specifier.type !== 'export_specifier') {
        continue;
      }

      const aliasNode = specifier.lastNamedChild;
      if (aliasNode?.text) {
        exports.add(aliasNode.text);
      }
    }
  }

  return sortUnique(exports);
}

function extractDeclarationExportNames(node: TreeSitterNode): string[] {
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    return sortUnique(
      node.namedChildren.flatMap((child) => extractBindingNamesFromDeclarator(child)),
    );
  }

  const nameNode = node.childForFieldName('name') ?? node.firstNamedChild;
  if (!nameNode) {
    return [];
  }

  return [nameNode.text];
}

function extractBindingNamesFromDeclarator(node: TreeSitterNode): string[] {
  if (node.type === 'variable_declarator') {
    const nameNode = node.childForFieldName('name') ?? node.firstNamedChild;
    return collectBindingNames(nameNode);
  }

  return [];
}

function collectBindingNames(node: TreeSitterNode | null): string[] {
  if (!node) {
    return [];
  }

  switch (node.type) {
    case 'identifier':
    case 'property_identifier':
    case 'shorthand_property_identifier_pattern':
    case 'shorthand_property_identifier':
    case 'this':
      return [node.text];
    case 'object_pattern':
    case 'array_pattern':
      return sortUnique(node.namedChildren.flatMap((child) => collectBindingNames(child)));
    case 'pair_pattern':
    case 'object_assignment_pattern': {
      const valueNode = node.childForFieldName('value') ?? node.lastNamedChild;
      return collectBindingNames(valueNode);
    }
    case 'assignment_pattern': {
      const leftNode = node.childForFieldName('left') ?? node.firstNamedChild;
      return collectBindingNames(leftNode);
    }
    case 'rest_pattern':
      return collectBindingNames(node.lastNamedChild);
    default:
      return sortUnique(node.namedChildren.flatMap((child) => collectBindingNames(child)));
  }
}

function extractImportSpecifiersFromTree(rootNode: TreeSitterNode): string[] {
  const specifiers = new Set<string>();

  for (const child of rootNode.namedChildren) {
    if (child.type === 'import_statement' || child.type === 'export_statement') {
      const specifier = extractStaticModuleSpecifier(child);
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  for (const callExpression of rootNode.descendantsOfType('call_expression')) {
    const specifier = extractCallExpressionSpecifier(callExpression);
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  return sortUnique(specifiers);
}

function extractStaticModuleSpecifier(node: TreeSitterNode): string | null {
  const stringNode = node.namedChildren.find((child) => child.type === 'string');
  return stringNode ? extractStringLiteralValue(stringNode) : null;
}

function extractCallExpressionSpecifier(node: TreeSitterNode): string | null {
  const callee = node.firstNamedChild;
  if (!callee) {
    return null;
  }

  const isRequireCall = callee.type === 'identifier' && callee.text === 'require';
  const isDynamicImport = callee.type === 'import';
  if (!isRequireCall && !isDynamicImport) {
    return null;
  }

  const argumentsNode = node.namedChildren.find((child) => child.type === 'arguments');
  const stringNode = argumentsNode?.namedChildren.find((child) => child.type === 'string');
  return stringNode ? extractStringLiteralValue(stringNode) : null;
}

function extractStringLiteralValue(node: TreeSitterNode): string | null {
  const fragment = node.namedChildren.find((child) => child.type === 'string_fragment');
  if (fragment?.text) {
    return fragment.text;
  }

  return node.text.length >= 2 ? node.text.slice(1, -1) : null;
}

function parseImportSpecifiersWithRegex(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bimport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers];
}

function resolveImportSpecifier(
  workDir: string,
  importer: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const importerDir = dirname(resolve(workDir, importer));
  const targetBase = resolve(importerDir, specifier);
  const candidateBases = new Set<string>([targetBase]);
  const transpiledExtensionMatch = targetBase.match(/\.(?:[cm]?js|jsx)$/);
  if (transpiledExtensionMatch) {
    candidateBases.add(targetBase.slice(0, -transpiledExtensionMatch[0].length));
  }
  const candidates = [
    ...[...candidateBases],
    ...[...candidateBases].flatMap((base) =>
      SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ),
    ...[...candidateBases].flatMap((base) =>
      SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
    ),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeRepoPath(relative(workDir, candidate));
    if (fileSet.has(normalized)) {
      return normalized;
    }
  }

  return null;
}

function parseExportsWithRegex(content: string): string[] {
  const exports = new Set<string>();

  for (const match of content.matchAll(
    /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) {
      exports.add(match[1]);
    }
  }

  for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    const group = match[1] ?? '';
    for (const entry of group.split(',')) {
      const aliasMatch = entry.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!aliasMatch) {
        continue;
      }
      exports.add(aliasMatch[2] ?? aliasMatch[1]);
    }
  }

  if (/\bexport\s+default\b/.test(content)) {
    exports.add('default');
  }

  return sortUnique(exports);
}

function buildRepoIndexFromFileAnalyses(
  fileAnalyses: RepoFileAnalysis[],
  metadata: { diffHash?: string; cacheStatus?: 'hit' | 'miss' | 'skipped' } = {},
): RepoIndex {
  const exportsByFile = new Map<string, string[]>();
  const importersByTarget = new Map<string, Set<string>>();
  const testFiles = new Set<string>();
  const filesByPath = new Map<string, RepoFileAnalysis>();

  for (const analysis of fileAnalyses) {
    filesByPath.set(analysis.path, analysis);
    exportsByFile.set(analysis.path, analysis.exports);

    if (analysis.isTestFile) {
      testFiles.add(analysis.path);
    }

    for (const target of analysis.importedTargets) {
      const importers = importersByTarget.get(target) ?? new Set<string>();
      importers.add(analysis.path);
      importersByTarget.set(target, importers);
    }
  }

  return {
    exportsByFile,
    importersByTarget,
    testFiles,
    filesByPath,
    diffHash: metadata.diffHash,
    cacheStatus: metadata.cacheStatus,
  };
}

async function computeRepoDiffHash(workDir: string, repoFiles: string[]): Promise<string> {
  const hash = createHash('sha256');
  hash.update(String(repoFiles.length));

  for (const filePath of repoFiles) {
    const entry = await stat(resolve(workDir, filePath));
    hash.update(filePath);
    hash.update(':');
    hash.update(String(entry.size));
    hash.update(':');
    hash.update(String(Math.trunc(entry.mtimeMs)));
    hash.update('\n');
  }

  return hash.digest('hex').slice(0, REPO_INDEX_DIFF_HASH_CHARS);
}

function hashScope(scopes: string[]): string {
  return createHash('sha256')
    .update(normalizeScopeEntries(scopes).join('\n'))
    .digest('hex')
    .slice(0, REPO_INDEX_SCOPE_HASH_CHARS);
}

function normalizeScopeEntries(scopes: string[]): string[] {
  return sortUnique(scopes.length > 0 ? scopes.map(normalizeRepoPath) : ['.']);
}

function areListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function loadRepoIndexCache(cachePath: string): Promise<RepoIndexCacheEntry | null> {
  try {
    const { value } = await readJsonFileWithBackup<RepoIndexCacheEntry>(cachePath);
    return isRepoIndexCacheEntry(value) ? value : null;
  } catch {
    return null;
  }
}

async function persistRepoIndexCache(cachePath: string, entry: RepoIndexCacheEntry): Promise<void> {
  await writeFileAtomic(cachePath, JSON.stringify(entry, null, 2));
}

function isRepoIndexCacheEntry(value: unknown): value is RepoIndexCacheEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<RepoIndexCacheEntry>;
  return (
    candidate.version === REPO_INDEX_CACHE_VERSION &&
    typeof candidate.builtAt === 'string' &&
    typeof candidate.diffHash === 'string' &&
    Array.isArray(candidate.scope) &&
    Array.isArray(candidate.repoFiles) &&
    Array.isArray(candidate.files) &&
    candidate.files.every(isRepoFileAnalysis)
  );
}

function isRepoFileAnalysis(value: unknown): value is RepoFileAnalysis {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<RepoFileAnalysis>;
  return (
    typeof candidate.path === 'string' &&
    Array.isArray(candidate.exports) &&
    Array.isArray(candidate.importedTargets) &&
    typeof candidate.lineCount === 'number' &&
    typeof candidate.isTestFile === 'boolean'
  );
}

export async function safeStatType(path: string): Promise<'file' | 'directory' | 'missing'> {
  try {
    const entry = await stat(path);
    return entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'missing';
  } catch {
    return 'missing';
  }
}

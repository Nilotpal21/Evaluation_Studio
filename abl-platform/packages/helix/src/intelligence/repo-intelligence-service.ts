import { dirname, relative, resolve } from 'node:path';

import { Node, Project, ts, type ReferenceFindableNode, type SourceFile } from 'ts-morph';

import { extractExportSignatures } from './export-signatures.js';
import {
  findImpactedTestsInWorkspace,
  type RepoImpactedTestSearchResult,
} from './impacted-tests.js';
import {
  listScopedSourceFiles,
  loadScopedRepoIndex,
  normalizeRepoPath,
  safeReadText,
  sortUnique,
} from '../pipeline/repo-index.js';

const DEFAULT_SYMBOL_MATCH_LIMIT = 12;
const DEFAULT_REFERENCE_LIMIT = 20;
const DEFAULT_ROUTE_LIMIT = 20;
const DEFAULT_SCHEMA_LIMIT = 12;
const MAX_SYMBOL_SCOPE_FILES = 20_000;
const MAX_REFERENCE_SCOPE_FILES = 2_500;
const MAX_ROUTE_SCOPE_FILES = 4_000;
const MAX_SCHEMA_SCOPE_FILES = 4_000;
const MAX_RESULT_EXCERPT_CHARS = 180;
const MAX_ROUTE_EXPRESSION_CHARS = 120;
const MAX_SCHEMA_FIELD_COUNT = 25;
const MAX_SCHEMA_ENUM_VALUES = 10;
const EXPRESS_ROUTE_METHOD_NAMES = [
  'all',
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'use',
] as const;
const AUTH_SIGNAL_PATTERN = /auth|permission|ownership|tenant|projectscope|internalauth|rbac/i;

type ReferenceableDeclaration = Node & ReferenceFindableNode & { getName(): string | undefined };

export interface RepoIntelligenceServiceOptions {
  workDir?: string;
}

export interface RepoSymbolMatch {
  symbol: string;
  path: string;
  line?: number;
  column?: number;
  kind?: string;
  exported: boolean;
  signature?: string;
  matchType: 'exact' | 'prefix' | 'substring';
}

export interface RepoSymbolSearchResult {
  query: string;
  scope: string[];
  scannedFiles: number;
  matches: RepoSymbolMatch[];
  truncated: boolean;
  message?: string;
}

export interface RepoSymbolReference {
  path: string;
  line: number;
  column: number;
  excerpt: string;
  isDefinition: boolean;
}

export interface RepoReferenceSearchResult {
  filePath: string;
  symbol: string;
  scope: string[];
  scannedFiles: number;
  references: RepoSymbolReference[];
  truncated: boolean;
  message?: string;
}

export type RepoRouteMethod = (typeof EXPRESS_ROUTE_METHOD_NAMES)[number];

export interface RepoRouteInfo {
  filePath: string;
  routerName: string;
  kind: 'route' | 'middleware';
  method: RepoRouteMethod;
  path: string;
  line: number;
  column: number;
  handler: string;
  middleware: string[];
  inheritedMiddleware: string[];
  authSignals: string[];
  schema?: string;
}

export interface RepoRouteSearchResult {
  filePath?: string;
  scope: string[];
  scannedFiles: number;
  routes: RepoRouteInfo[];
  truncated: boolean;
  message?: string;
}

export interface RepoSchemaField {
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  defaultValue?: string;
  enumValues?: string[];
}

export type RepoSchemaKind =
  | 'zod-object'
  | 'zod-enum'
  | 'zod-array'
  | 'zod-schema'
  | 'mongoose-schema';

export interface RepoSchemaInfo {
  filePath: string;
  symbol: string;
  line: number;
  column: number;
  schemaKind: RepoSchemaKind;
  summary: string;
  fields: RepoSchemaField[];
}

export interface RepoSchemaSearchResult {
  filePath?: string;
  symbol?: string;
  scope: string[];
  scannedFiles: number;
  schemas: RepoSchemaInfo[];
  truncated: boolean;
  message?: string;
}

export type { RepoImpactedTest, RepoImpactedTestSearchResult } from './impacted-tests.js';

export class RepoIntelligenceService {
  private readonly workDir: string;

  constructor(options: RepoIntelligenceServiceOptions = {}) {
    this.workDir = options.workDir ?? process.cwd();
  }

  async findSymbol(
    symbol: string,
    options: {
      scope?: string[];
      limit?: number;
    } = {},
  ): Promise<RepoSymbolSearchResult> {
    const query = symbol.trim();
    const limit = clampLimit(options.limit, DEFAULT_SYMBOL_MATCH_LIMIT);
    const scope = normalizeScopeEntries(options.scope);

    if (!query) {
      return {
        query,
        scope,
        scannedFiles: 0,
        matches: [],
        truncated: false,
        message: 'Provide a non-empty symbol query.',
      };
    }

    const repoFiles = await listScopedSourceFiles(this.workDir, scope);
    if (repoFiles.length > MAX_SYMBOL_SCOPE_FILES) {
      return {
        query,
        scope,
        scannedFiles: repoFiles.length,
        matches: [],
        truncated: false,
        message: `Scope is too large (${repoFiles.length} files). Narrow the search to a package or directory before using helix_find_symbol.`,
      };
    }

    const { repoIndex } = await loadScopedRepoIndex(this.workDir, scope);
    const candidates = [...repoIndex.exportsByFile.entries()]
      .flatMap(([path, exports]) =>
        exports
          .map((exportName) => ({
            path,
            exportName,
            matchType: classifySymbolMatch(exportName, query),
          }))
          .filter(
            (
              candidate,
            ): candidate is {
              path: string;
              exportName: string;
              matchType: RepoSymbolMatch['matchType'];
            } => candidate.matchType != null,
          ),
      )
      .sort((left, right) => compareSymbolCandidates(left, right));

    const limitedCandidates = candidates.slice(0, limit);
    const matches = await Promise.all(
      limitedCandidates.map(async (candidate) => {
        const content = await safeReadText(resolve(this.workDir, candidate.path));
        const signatures = extractExportSignatures(candidate.path, content);
        const declaration = locateNamedDeclaration(candidate.path, content, candidate.exportName);

        return {
          symbol: candidate.exportName,
          path: candidate.path,
          line: declaration?.line,
          column: declaration?.column,
          kind: declaration?.kind,
          exported: true,
          signature: signatures[candidate.exportName],
          matchType: candidate.matchType,
        } satisfies RepoSymbolMatch;
      }),
    );

    return {
      query,
      scope,
      scannedFiles: repoFiles.length,
      matches,
      truncated: candidates.length > limit,
      message:
        matches.length === 0
          ? `No exported symbol matches found for "${query}" in the requested scope.`
          : undefined,
    };
  }

  async findReferences(
    filePath: string,
    symbol: string,
    options: {
      scope?: string[];
      limit?: number;
      includeDefinition?: boolean;
    } = {},
  ): Promise<RepoReferenceSearchResult> {
    const normalizedFilePath = normalizeRepoPath(filePath);
    const normalizedSymbol = symbol.trim();
    const scope = normalizeReferenceScope(options.scope, normalizedFilePath);
    const limit = clampLimit(options.limit, DEFAULT_REFERENCE_LIMIT);
    const includeDefinition = options.includeDefinition ?? false;

    if (!normalizedFilePath || !normalizedSymbol) {
      return {
        filePath: normalizedFilePath,
        symbol: normalizedSymbol,
        scope,
        scannedFiles: 0,
        references: [],
        truncated: false,
        message: 'Provide both filePath and symbol when using helix_find_references.',
      };
    }

    const repoFiles = await listScopedSourceFiles(this.workDir, scope);
    if (!repoFiles.includes(normalizedFilePath)) {
      repoFiles.push(normalizedFilePath);
    }

    if (repoFiles.length > MAX_REFERENCE_SCOPE_FILES) {
      return {
        filePath: normalizedFilePath,
        symbol: normalizedSymbol,
        scope,
        scannedFiles: repoFiles.length,
        references: [],
        truncated: false,
        message: `Scope is too large (${repoFiles.length} files). Narrow the search to a package or directory before using helix_find_references.`,
      };
    }

    const project = createRepoProject();
    project.addSourceFilesAtPaths(repoFiles.map((repoPath) => resolve(this.workDir, repoPath)));
    project.resolveSourceFileDependencies();

    const sourceFile = project.getSourceFile(resolve(this.workDir, normalizedFilePath));
    if (!sourceFile) {
      return {
        filePath: normalizedFilePath,
        symbol: normalizedSymbol,
        scope,
        scannedFiles: repoFiles.length,
        references: [],
        truncated: false,
        message: `Could not load ${normalizedFilePath} inside the requested scope.`,
      };
    }

    const declaration = findNamedDeclarationNode(sourceFile, normalizedSymbol);
    if (!declaration) {
      return {
        filePath: normalizedFilePath,
        symbol: normalizedSymbol,
        scope,
        scannedFiles: repoFiles.length,
        references: [],
        truncated: false,
        message: `Could not find a declaration named "${normalizedSymbol}" in ${normalizedFilePath}.`,
      };
    }

    const references = declaration
      .findReferences()
      .flatMap((entry) => entry.getReferences())
      .map((reference) => {
        const node = reference.getNode();
        const source = node.getSourceFile();
        const repoPath = normalizeRepoPath(relative(this.workDir, source.getFilePath()));
        const location = source.getLineAndColumnAtPos(node.getStart());
        const excerpt = readReferenceExcerpt(source.getFullText(), location.line);
        const isDefinition = Boolean(reference.isDefinition());
        return {
          path: repoPath,
          line: location.line,
          column: location.column,
          excerpt,
          isDefinition,
        } satisfies RepoSymbolReference;
      })
      .filter((reference) => (includeDefinition ? true : !reference.isDefinition))
      .filter((reference) => reference.path.length > 0);

    const uniqueReferences = dedupeReferences(references);
    return {
      filePath: normalizedFilePath,
      symbol: normalizedSymbol,
      scope,
      scannedFiles: repoFiles.length,
      references: uniqueReferences.slice(0, limit),
      truncated: uniqueReferences.length > limit,
      message:
        uniqueReferences.length === 0
          ? `No references found for "${normalizedSymbol}" in the requested scope.`
          : undefined,
    };
  }

  async getRouteInfo(
    options: {
      filePath?: string;
      scope?: string[];
      method?: string;
      pathContains?: string;
      limit?: number;
    } = {},
  ): Promise<RepoRouteSearchResult> {
    const normalizedFilePath = options.filePath ? normalizeRepoPath(options.filePath) : undefined;
    const normalizedScope = normalizeScopeEntries(
      normalizedFilePath ? [normalizedFilePath, ...(options.scope ?? [])] : options.scope,
    );
    const method = normalizeRouteMethod(options.method);
    const pathContains = options.pathContains?.trim();
    const limit = clampLimit(options.limit, DEFAULT_ROUTE_LIMIT);

    if (!normalizedFilePath && normalizedScope.length === 0) {
      return {
        filePath: normalizedFilePath,
        scope: normalizedScope,
        scannedFiles: 0,
        routes: [],
        truncated: false,
        message: 'Provide filePath or scope when using helix_get_route_info.',
      };
    }

    const repoFiles = await listScopedSourceFiles(this.workDir, normalizedScope);
    if (repoFiles.length > MAX_ROUTE_SCOPE_FILES) {
      return {
        filePath: normalizedFilePath,
        scope: normalizedScope,
        scannedFiles: repoFiles.length,
        routes: [],
        truncated: false,
        message: `Scope is too large (${repoFiles.length} files). Narrow the search to a route file or package before using helix_get_route_info.`,
      };
    }

    const project = createRepoProject();
    const discoveredRoutes: RepoRouteInfo[] = [];

    for (const repoPath of repoFiles) {
      const content = await safeReadText(resolve(this.workDir, repoPath));
      if (!looksLikeRouteFile(content)) {
        continue;
      }

      const sourceFile = project.createSourceFile(repoPath, content, { overwrite: true });
      discoveredRoutes.push(...analyzeRouteRegistrations(sourceFile, repoPath));
    }

    const filteredRoutes = discoveredRoutes
      .filter((route) => (normalizedFilePath ? route.filePath === normalizedFilePath : true))
      .filter((route) => (method ? route.method === method : true))
      .filter((route) => (pathContains ? route.path.includes(pathContains) : true))
      .sort(compareRoutes);

    return {
      filePath: normalizedFilePath,
      scope: normalizedScope,
      scannedFiles: repoFiles.length,
      routes: filteredRoutes.slice(0, limit),
      truncated: filteredRoutes.length > limit,
      message:
        filteredRoutes.length === 0
          ? 'No matching Express route registrations were found in the requested scope.'
          : undefined,
    };
  }

  async getSchemaInfo(
    options: {
      filePath?: string;
      symbol?: string;
      scope?: string[];
      limit?: number;
    } = {},
  ): Promise<RepoSchemaSearchResult> {
    const normalizedFilePath = options.filePath ? normalizeRepoPath(options.filePath) : undefined;
    const normalizedScope = normalizeScopeEntries(
      normalizedFilePath ? [normalizedFilePath, ...(options.scope ?? [])] : options.scope,
    );
    const symbolQuery = options.symbol?.trim();
    const limit = clampLimit(options.limit, DEFAULT_SCHEMA_LIMIT);

    if (!normalizedFilePath && normalizedScope.length === 0) {
      return {
        filePath: normalizedFilePath,
        symbol: symbolQuery,
        scope: normalizedScope,
        scannedFiles: 0,
        schemas: [],
        truncated: false,
        message: 'Provide filePath or scope when using helix_get_schema_info.',
      };
    }

    const repoFiles = await listScopedSourceFiles(this.workDir, normalizedScope);
    if (repoFiles.length > MAX_SCHEMA_SCOPE_FILES) {
      return {
        filePath: normalizedFilePath,
        symbol: symbolQuery,
        scope: normalizedScope,
        scannedFiles: repoFiles.length,
        schemas: [],
        truncated: false,
        message: `Scope is too large (${repoFiles.length} files). Narrow the search to a schema file or package before using helix_get_schema_info.`,
      };
    }

    const project = createRepoProject();
    const discoveredSchemas: RepoSchemaInfo[] = [];

    for (const repoPath of repoFiles) {
      const content = await safeReadText(resolve(this.workDir, repoPath));
      if (!looksLikeSchemaFile(content)) {
        continue;
      }

      const sourceFile = project.createSourceFile(repoPath, content, { overwrite: true });
      discoveredSchemas.push(...discoverSchemaDeclarations(sourceFile, repoPath));
    }

    const filteredSchemas = discoveredSchemas
      .filter((schema) => (normalizedFilePath ? schema.filePath === normalizedFilePath : true))
      .filter((schema) =>
        symbolQuery ? classifySchemaSymbolMatch(schema.symbol, symbolQuery) != null : true,
      )
      .sort(compareSchemas);

    return {
      filePath: normalizedFilePath,
      symbol: symbolQuery,
      scope: normalizedScope,
      scannedFiles: repoFiles.length,
      schemas: filteredSchemas.slice(0, limit),
      truncated: filteredSchemas.length > limit,
      message:
        filteredSchemas.length === 0
          ? 'No matching Zod or Mongoose schemas were found in the requested scope.'
          : undefined,
    };
  }

  async getImpactedTests(options: {
    paths: string[];
    scope?: string[];
    limit?: number;
  }): Promise<RepoImpactedTestSearchResult> {
    return findImpactedTestsInWorkspace(this.workDir, options);
  }
}

function createRepoProject(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
    },
  });
}

function normalizeScopeEntries(scope: string[] | undefined): string[] {
  return sortUnique((scope ?? []).map((entry) => normalizeRepoPath(entry)).filter(Boolean));
}

function normalizeReferenceScope(scope: string[] | undefined, filePath: string): string[] {
  const normalized = normalizeScopeEntries(scope);
  if (normalized.length > 0) {
    return normalized;
  }

  const packageMatch = filePath.match(/^((?:apps|packages)\/[^/]+)/)?.[1];
  if (packageMatch) {
    return [packageMatch];
  }

  return [dirname(filePath)];
}

function normalizeRouteMethod(method: string | undefined): RepoRouteMethod | undefined {
  const normalizedMethod = method?.trim().toLowerCase();
  if (
    normalizedMethod &&
    EXPRESS_ROUTE_METHOD_NAMES.some((candidate) => candidate === normalizedMethod)
  ) {
    return normalizedMethod as RepoRouteMethod;
  }

  return undefined;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value == null || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(50, Math.trunc(value)));
}

function classifySymbolMatch(
  candidate: string,
  query: string,
): RepoSymbolMatch['matchType'] | null {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedQuery = query.toLowerCase();

  if (normalizedCandidate === normalizedQuery) {
    return 'exact';
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 'prefix';
  }

  if (normalizedCandidate.includes(normalizedQuery)) {
    return 'substring';
  }

  return null;
}

function compareSymbolCandidates(
  left: { path: string; exportName: string; matchType: RepoSymbolMatch['matchType'] },
  right: { path: string; exportName: string; matchType: RepoSymbolMatch['matchType'] },
): number {
  return (
    rankMatchType(left.matchType) - rankMatchType(right.matchType) ||
    left.exportName.localeCompare(right.exportName) ||
    left.path.localeCompare(right.path)
  );
}

function rankMatchType(matchType: RepoSymbolMatch['matchType']): number {
  switch (matchType) {
    case 'exact':
      return 0;
    case 'prefix':
      return 1;
    case 'substring':
      return 2;
  }
}

function looksLikeRouteFile(content: string): boolean {
  return (
    /\b(?:router|app)\.(?:all|delete|get|head|options|patch|post|put|use)\s*\(/.test(content) ||
    /\bopenapi\.route\s*\(/.test(content) ||
    /\bcreateOpenAPIRouter\s*\(/.test(content)
  );
}

function looksLikeSchemaFile(content: string): boolean {
  return /\bz\.(?:object|enum|array|string|number|boolean|date|literal|union|record)\s*\(/.test(
    content,
  )
    ? true
    : /\bnew\s+(?:mongoose\.)?Schema\s*\(/.test(content);
}

function classifySchemaSymbolMatch(
  symbol: string,
  query: string,
): RepoSymbolMatch['matchType'] | null {
  return classifySymbolMatch(symbol, query);
}

interface ParsedSchemaDescriptor {
  schemaKind: RepoSchemaKind;
  summary: string;
  fields: RepoSchemaField[];
}

interface ParsedSchemaType {
  type: string;
  schemaKind?: RepoSchemaKind;
  fields?: RepoSchemaField[];
  enumValues?: string[];
  required?: boolean;
  optional?: boolean;
  nullable?: boolean;
  defaultValue?: string;
}

function discoverSchemaDeclarations(sourceFile: SourceFile, repoPath: string): RepoSchemaInfo[] {
  const schemas: RepoSchemaInfo[] = [];

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer) {
      continue;
    }

    const parsed = parseSchemaInitializer(initializer);
    if (!parsed) {
      continue;
    }

    const location = sourceFile.getLineAndColumnAtPos(declaration.getStart());
    schemas.push({
      filePath: repoPath,
      symbol: declaration.getName(),
      line: location.line,
      column: location.column,
      schemaKind: parsed.schemaKind,
      summary: parsed.summary,
      fields: parsed.fields,
    });
  }

  return schemas;
}

function parseSchemaInitializer(node: Node): ParsedSchemaDescriptor | undefined {
  return parseZodSchemaDefinition(node) ?? parseMongooseSchemaDefinition(node);
}

function parseZodSchemaDefinition(node: Node): ParsedSchemaDescriptor | undefined {
  const parsed = parseZodSchemaType(node);
  if (!parsed) {
    return undefined;
  }

  const schemaKind = parsed.schemaKind ?? 'zod-schema';
  return {
    schemaKind,
    summary: buildZodSchemaSummary(parsed),
    fields: parsed.fields ?? [],
  };
}

function parseZodSchemaType(node: Node): ParsedSchemaType | undefined {
  if (Node.isIdentifier(node)) {
    return { type: node.getText(), required: true };
  }

  if (!Node.isCallExpression(node)) {
    return undefined;
  }

  const expression = node.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) {
    return undefined;
  }

  const method = expression.getName();
  const target = expression.getExpression();
  const argumentsList = node.getArguments();

  switch (method) {
    case 'optional': {
      const base = parseZodSchemaType(target);
      return base ? { ...base, optional: true } : undefined;
    }
    case 'nullable': {
      const base = parseZodSchemaType(target);
      return base ? { ...base, nullable: true } : undefined;
    }
    case 'default': {
      const base = parseZodSchemaType(target);
      return base
        ? {
            ...base,
            optional: true,
            defaultValue: summarizeSchemaValue(argumentsList[0]),
          }
        : undefined;
    }
    case 'array': {
      if (isZodNamespaceTarget(target)) {
        const item = argumentsList[0] ? parseZodSchemaType(argumentsList[0]) : undefined;
        return {
          type: `Array<${item?.type ?? 'unknown'}>`,
          schemaKind: 'zod-array',
          required: true,
        };
      }

      const base = parseZodSchemaType(target);
      return base
        ? {
            type: `Array<${base.type}>`,
            schemaKind: 'zod-array',
            required: true,
          }
        : undefined;
    }
    case 'object':
      if (isZodNamespaceTarget(target)) {
        const shapeArg = argumentsList[0];
        return {
          type: 'object',
          schemaKind: 'zod-object',
          required: true,
          fields: Node.isObjectLiteralExpression(shapeArg) ? parseZodObjectFields(shapeArg) : [],
        };
      }
      break;
    case 'enum':
      if (isZodNamespaceTarget(target)) {
        const enumValues = extractStringArrayValues(argumentsList[0]);
        return {
          type:
            enumValues.length > 0
              ? enumValues.map((value) => JSON.stringify(value)).join(' | ')
              : 'enum',
          schemaKind: 'zod-enum',
          required: true,
          enumValues,
        };
      }
      break;
    case 'string':
      if (isZodPrimitiveFactoryTarget(target)) {
        return { type: 'string', required: true };
      }
      break;
    case 'number':
      if (isZodPrimitiveFactoryTarget(target)) {
        return { type: 'number', required: true };
      }
      break;
    case 'boolean':
      if (isZodPrimitiveFactoryTarget(target)) {
        return { type: 'boolean', required: true };
      }
      break;
    case 'date':
      if (isZodPrimitiveFactoryTarget(target)) {
        return { type: 'Date', required: true };
      }
      break;
    case 'literal':
      if (isZodNamespaceTarget(target)) {
        return { type: summarizeSchemaValue(argumentsList[0]) ?? 'literal', required: true };
      }
      break;
    case 'union':
      if (isZodNamespaceTarget(target) && Node.isArrayLiteralExpression(argumentsList[0])) {
        const memberTypes = argumentsList[0]
          .getElements()
          .map(
            (element) =>
              parseZodSchemaType(element)?.type ?? summarizeSchemaValue(element) ?? 'unknown',
          );
        return {
          type: memberTypes.join(' | '),
          required: true,
        };
      }
      break;
    case 'record':
      if (isZodNamespaceTarget(target)) {
        const valueNode = argumentsList.length > 1 ? argumentsList[1] : argumentsList[0];
        const valueType = valueNode
          ? (parseZodSchemaType(valueNode)?.type ?? summarizeSchemaValue(valueNode) ?? 'unknown')
          : 'unknown';
        return {
          type: `Record<string, ${valueType}>`,
          required: true,
        };
      }
      break;
  }

  return parseZodSchemaType(target);
}

function parseZodObjectFields(
  objectLiteral: import('ts-morph').ObjectLiteralExpression,
): RepoSchemaField[] {
  const fields: RepoSchemaField[] = [];

  for (const property of objectLiteral.getProperties()) {
    if (fields.length >= MAX_SCHEMA_FIELD_COUNT) {
      break;
    }

    if (Node.isPropertyAssignment(property)) {
      const initializer = property.getInitializer();
      const parsed = initializer ? parseZodSchemaType(initializer) : undefined;
      fields.push(
        buildSchemaField(
          property.getName(),
          parsed,
          initializer ? summarizeSchemaValue(initializer) : undefined,
        ),
      );
      continue;
    }

    if (Node.isShorthandPropertyAssignment(property)) {
      fields.push({
        name: property.getName(),
        type: property.getName(),
        required: true,
        nullable: false,
      });
    }
  }

  return fields;
}

function parseMongooseSchemaDefinition(node: Node): ParsedSchemaDescriptor | undefined {
  if (!Node.isNewExpression(node) || !isMongooseSchemaExpression(node.getExpression())) {
    return undefined;
  }

  const shapeArgument = node.getArguments()[0];
  if (!shapeArgument || !Node.isObjectLiteralExpression(shapeArgument)) {
    return undefined;
  }

  const fields = parseMongooseObjectFields(shapeArgument);
  return {
    schemaKind: 'mongoose-schema',
    summary: `Mongoose schema with ${fields.length} field${fields.length === 1 ? '' : 's'}`,
    fields,
  };
}

function parseMongooseObjectFields(
  objectLiteral: import('ts-morph').ObjectLiteralExpression,
): RepoSchemaField[] {
  const fields: RepoSchemaField[] = [];

  for (const property of objectLiteral.getProperties()) {
    if (fields.length >= MAX_SCHEMA_FIELD_COUNT) {
      break;
    }

    if (!Node.isPropertyAssignment(property)) {
      continue;
    }

    const initializer = property.getInitializer();
    if (!initializer) {
      continue;
    }

    const parsed = parseMongooseFieldType(initializer);
    fields.push(buildSchemaField(property.getName(), parsed, summarizeSchemaValue(initializer)));
  }

  return fields;
}

function parseMongooseFieldType(node: Node): ParsedSchemaType | undefined {
  if (Node.isArrayLiteralExpression(node)) {
    const firstElement = node.getElements()[0];
    const itemType = firstElement
      ? (parseMongooseFieldType(firstElement)?.type ??
        summarizeSchemaValue(firstElement) ??
        'unknown')
      : 'unknown';
    return {
      type: `Array<${itemType}>`,
      required: false,
    };
  }

  if (Node.isNewExpression(node) && isMongooseSchemaExpression(node.getExpression())) {
    return {
      type: 'object',
      required: false,
    };
  }

  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    return {
      type: normalizeMongooseTypeName(node.getText()),
      required: false,
    };
  }

  if (Node.isObjectLiteralExpression(node)) {
    const typeProperty = getObjectPropertyAssignment(node, 'type');
    const parsedType = typeProperty
      ? (parseMongooseFieldType(typeProperty.getInitializerOrThrow()) ?? {
          type: 'object',
          required: false,
        })
      : { type: 'object', required: false };
    return {
      ...parsedType,
      required: readBooleanObjectProperty(node, 'required'),
      nullable:
        summarizeSchemaValue(getObjectPropertyAssignment(node, 'default')?.getInitializer()) ===
        'null',
      defaultValue: summarizeSchemaValue(
        getObjectPropertyAssignment(node, 'default')?.getInitializer(),
      ),
      enumValues: extractEnumValues(getObjectPropertyAssignment(node, 'enum')?.getInitializer()),
    };
  }

  return undefined;
}

function buildSchemaField(
  name: string,
  parsed: ParsedSchemaType | undefined,
  fallbackType: string | undefined,
): RepoSchemaField {
  return {
    name,
    type: parsed?.type ?? fallbackType ?? 'unknown',
    required: !(parsed?.optional ?? false) && Boolean(parsed?.required),
    nullable: Boolean(parsed?.nullable),
    ...(parsed?.defaultValue ? { defaultValue: parsed.defaultValue } : {}),
    ...(parsed?.enumValues && parsed.enumValues.length > 0
      ? { enumValues: parsed.enumValues }
      : {}),
  };
}

function buildZodSchemaSummary(parsed: ParsedSchemaType): string {
  switch (parsed.schemaKind) {
    case 'zod-object':
      return `Zod object with ${(parsed.fields ?? []).length} field${(parsed.fields ?? []).length === 1 ? '' : 's'}`;
    case 'zod-enum':
      return `Zod enum with ${(parsed.enumValues ?? []).length} value${(parsed.enumValues ?? []).length === 1 ? '' : 's'}`;
    case 'zod-array':
      return `Zod array schema (${parsed.type})`;
    default:
      return `Zod schema (${parsed.type})`;
  }
}

function isZodNamespaceTarget(node: Node): boolean {
  return Node.isIdentifier(node) && node.getText() === 'z';
}

function isZodPrimitiveFactoryTarget(node: Node): boolean {
  return (
    isZodNamespaceTarget(node) ||
    (Node.isPropertyAccessExpression(node) && node.getText() === 'z.coerce')
  );
}

function isMongooseSchemaExpression(node: Node): boolean {
  return (
    (Node.isIdentifier(node) && node.getText() === 'Schema') ||
    (Node.isPropertyAccessExpression(node) && node.getText() === 'mongoose.Schema')
  );
}

function getObjectPropertyAssignment(
  objectLiteral: import('ts-morph').ObjectLiteralExpression,
  propertyName: string,
): import('ts-morph').PropertyAssignment | undefined {
  for (const property of objectLiteral.getProperties()) {
    if (Node.isPropertyAssignment(property) && property.getName() === propertyName) {
      return property;
    }
  }

  return undefined;
}

function readBooleanObjectProperty(
  objectLiteral: import('ts-morph').ObjectLiteralExpression,
  propertyName: string,
): boolean | undefined {
  const property = getObjectPropertyAssignment(objectLiteral, propertyName);
  const value = property?.getInitializer()?.getText();
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return undefined;
}

function extractEnumValues(node: Node | undefined): string[] | undefined {
  const values = extractStringArrayValues(node);
  return values.length > 0 ? values : undefined;
}

function extractStringArrayValues(node: Node | undefined): string[] {
  if (!node || !Node.isArrayLiteralExpression(node)) {
    return [];
  }

  return node
    .getElements()
    .map((element) => {
      if (Node.isStringLiteral(element) || Node.isNoSubstitutionTemplateLiteral(element)) {
        return element.getLiteralText();
      }

      const text = summarizeSchemaValue(element);
      return text ? text.replace(/^"|"$/g, '') : '';
    })
    .filter(Boolean)
    .slice(0, MAX_SCHEMA_ENUM_VALUES);
}

function summarizeSchemaValue(node: Node | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return JSON.stringify(node.getLiteralText());
  }

  const text = normalizeWhitespace(node.getText());
  if (!text) {
    return undefined;
  }

  return truncateSchemaText(text);
}

function truncateSchemaText(value: string): string {
  return value.length <= MAX_ROUTE_EXPRESSION_CHARS
    ? value
    : `${value.slice(0, MAX_ROUTE_EXPRESSION_CHARS - 3)}...`;
}

function normalizeMongooseTypeName(value: string): string {
  switch (value) {
    case 'String':
      return 'string';
    case 'Number':
      return 'number';
    case 'Boolean':
      return 'boolean';
    case 'Date':
      return 'Date';
    case 'Schema.Types.Mixed':
      return 'mixed';
    default:
      return value;
  }
}

function compareSchemas(left: RepoSchemaInfo, right: RepoSchemaInfo): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.line - right.line ||
    left.column - right.column ||
    left.symbol.localeCompare(right.symbol)
  );
}

function locateNamedDeclaration(
  filePath: string,
  content: string,
  symbolName: string,
): { line: number; column: number; kind: string } | undefined {
  if (!content.trim()) {
    return undefined;
  }

  const project = createRepoProject();
  const sourceFile = project.createSourceFile(filePath, content, { overwrite: true });
  const declaration = findNamedDeclarationNode(sourceFile, symbolName);
  if (!declaration) {
    return undefined;
  }

  const location = sourceFile.getLineAndColumnAtPos(declaration.getStart());
  return {
    line: location.line,
    column: location.column,
    kind: declaration.getKindName(),
  };
}

function findNamedDeclarationNode(
  sourceFile: SourceFile,
  symbolName: string,
): ReferenceableDeclaration | undefined {
  for (const node of sourceFile.getDescendants()) {
    if (isReferenceableDeclaration(node) && node.getName() === symbolName) {
      return node;
    }
  }

  return undefined;
}

function isReferenceableDeclaration(node: Node): node is ReferenceableDeclaration {
  return (
    Node.isReferenceFindable(node) &&
    (Node.isFunctionDeclaration(node) ||
      Node.isVariableDeclaration(node) ||
      Node.isClassDeclaration(node) ||
      Node.isInterfaceDeclaration(node) ||
      Node.isTypeAliasDeclaration(node) ||
      Node.isEnumDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isPropertyDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node))
  );
}

function analyzeRouteRegistrations(sourceFile: SourceFile, repoPath: string): RepoRouteInfo[] {
  const openApiSurfaces = findOpenApiSurfaceBindings(sourceFile);
  const routeSurfaceBindings = findRouteSurfaceBindings(sourceFile, openApiSurfaces);
  const inheritedMiddlewareBySurface = new Map<string, RouteMiddlewareMount[]>();
  const routes: RepoRouteInfo[] = [];
  const callExpressions = sourceFile
    .getDescendantsOfKind(ts.SyntaxKind.CallExpression)
    .sort((left, right) => left.getStart() - right.getStart());

  for (const callExpression of callExpressions) {
    const expression = callExpression.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) {
      continue;
    }

    const rootName = expression.getExpression().getText().trim();
    const expressionName = expression.getName();
    if (expressionName === 'route') {
      const openApiBinding = openApiSurfaces.get(rootName);
      if (!openApiBinding) {
        continue;
      }

      const routeEntry = buildOpenApiRouteInfo(
        callExpression,
        repoPath,
        rootName,
        sourceFile,
        openApiBinding.basePath,
      );
      if (!routeEntry) {
        continue;
      }

      const inheritedEntries = inheritedMiddlewareBySurface.get(openApiBinding.surfaceId) ?? [];
      routeEntry.inheritedMiddleware = flattenInheritedMiddleware(
        inheritedEntries.filter((entry) => routePathMatchesMount(routeEntry.path, entry.path)),
      );
      routeEntry.authSignals = sortUnique(
        [...routeEntry.inheritedMiddleware, ...routeEntry.middleware, routeEntry.handler].filter(
          (value) => AUTH_SIGNAL_PATTERN.test(value),
        ),
      );
      routes.push(routeEntry);
      continue;
    }

    const method = normalizeRouteMethod(expressionName);
    if (!method) {
      continue;
    }

    const routeBinding = routeSurfaceBindings.get(rootName) ?? {
      surfaceId: rootName,
      basePath: undefined,
    };
    const routeEntry = buildExpressRouteInfo(
      callExpression,
      repoPath,
      rootName,
      method,
      sourceFile,
      routeBinding.basePath,
    );
    if (!routeEntry) {
      continue;
    }

    const inheritedEntries = inheritedMiddlewareBySurface.get(routeBinding.surfaceId) ?? [];
    routeEntry.inheritedMiddleware = flattenInheritedMiddleware(
      inheritedEntries.filter((entry) => routePathMatchesMount(routeEntry.path, entry.path)),
    );
    routeEntry.authSignals = sortUnique(
      [...routeEntry.inheritedMiddleware, ...routeEntry.middleware, routeEntry.handler].filter(
        (value) => AUTH_SIGNAL_PATTERN.test(value),
      ),
    );
    routes.push(routeEntry);

    if (method === 'use') {
      inheritedEntries.push({
        path: routeEntry.path,
        middleware: dedupeMiddleware([routeEntry.handler, ...routeEntry.middleware]),
      });
      inheritedMiddlewareBySurface.set(routeBinding.surfaceId, inheritedEntries);
    }
  }

  return routes;
}

function buildExpressRouteInfo(
  callExpression: import('ts-morph').CallExpression,
  repoPath: string,
  routerName: string,
  method: RepoRouteMethod,
  sourceFile: SourceFile,
  basePath: string | undefined,
): RepoRouteInfo | undefined {
  const argumentsList = callExpression.getArguments();
  if (argumentsList.length === 0) {
    return undefined;
  }

  const literalPath = extractLiteralPath(argumentsList[0]);
  const hasExplicitPath = literalPath != null;
  const localPath = literalPath ?? (method === 'use' ? '/' : '(dynamic)');
  const handlerArguments = argumentsList.slice(hasExplicitPath ? 1 : 0);
  const chain = handlerArguments.map(describeRouteExpression).filter(Boolean);
  if (chain.length === 0) {
    return undefined;
  }

  const location = sourceFile.getLineAndColumnAtPos(callExpression.getStart());
  return {
    filePath: repoPath,
    routerName,
    kind: method === 'use' ? 'middleware' : 'route',
    method,
    path: joinRoutePath(basePath, localPath),
    line: location.line,
    column: location.column,
    handler: chain.at(-1) ?? 'inline-handler',
    middleware: dedupeMiddleware(chain.slice(0, -1)),
    inheritedMiddleware: [],
    authSignals: [],
  };
}

function buildOpenApiRouteInfo(
  callExpression: import('ts-morph').CallExpression,
  repoPath: string,
  routerName: string,
  sourceFile: SourceFile,
  basePath: string | undefined,
): RepoRouteInfo | undefined {
  const argumentsList = callExpression.getArguments();
  if (argumentsList.length < 4) {
    return undefined;
  }

  const method = normalizeRouteMethod(extractLiteralPath(argumentsList[0]));
  if (!method) {
    return undefined;
  }

  const localPath = extractLiteralPath(argumentsList[1]) ?? '(dynamic)';
  const schema = describeSchemaArgument(argumentsList[2]);
  const handlerArguments = argumentsList.slice(3);
  const chain = handlerArguments.map(describeRouteExpression).filter(Boolean);
  if (chain.length === 0) {
    return undefined;
  }

  const location = sourceFile.getLineAndColumnAtPos(callExpression.getStart());
  return {
    filePath: repoPath,
    routerName,
    kind: 'route',
    method,
    path: joinRoutePath(basePath, localPath),
    line: location.line,
    column: location.column,
    handler: chain.at(-1) ?? 'inline-handler',
    middleware: dedupeMiddleware(chain.slice(0, -1)),
    inheritedMiddleware: [],
    authSignals: [],
    schema,
  };
}

function findOpenApiSurfaceBindings(sourceFile: SourceFile): Map<string, RouteSurfaceBinding> {
  const bindings = new Map<string, RouteSurfaceBinding>();

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) {
      continue;
    }

    const expression = initializer.getExpression();
    if (
      (Node.isIdentifier(expression) && expression.getText() === 'createOpenAPIRouter') ||
      (Node.isPropertyAccessExpression(expression) &&
        expression.getName() === 'createOpenAPIRouter')
    ) {
      bindings.set(declaration.getName(), {
        surfaceId: declaration.getName(),
        basePath: extractOpenApiBasePath(initializer.getArguments()[1]),
      });
    }
  }

  return bindings;
}

function findRouteSurfaceBindings(
  sourceFile: SourceFile,
  openApiSurfaces: Map<string, RouteSurfaceBinding>,
): Map<string, RouteSurfaceBinding> {
  const bindings = new Map<string, RouteSurfaceBinding>();

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer) {
      continue;
    }

    if (Node.isCallExpression(initializer)) {
      const expression = initializer.getExpression();
      if (
        (Node.isIdentifier(expression) && expression.getText() === 'Router') ||
        (Node.isPropertyAccessExpression(expression) && expression.getName() === 'Router')
      ) {
        bindings.set(declaration.getName(), {
          surfaceId: declaration.getName(),
          basePath: undefined,
        });
      }
      continue;
    }

    if (Node.isPropertyAccessExpression(initializer) && initializer.getName() === 'router') {
      const openApiBinding = openApiSurfaces.get(initializer.getExpression().getText());
      if (openApiBinding) {
        bindings.set(declaration.getName(), openApiBinding);
      }
    }
  }

  return bindings;
}

function extractLiteralPath(argument: Node): string | undefined {
  if (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.getLiteralText();
  }

  return undefined;
}

function describeSchemaArgument(argument: Node): string | undefined {
  const value = normalizeWhitespace(argument.getText());
  if (value === 'undefined') {
    return undefined;
  }

  if (Node.isIdentifier(argument)) {
    return argument.getText();
  }

  if (Node.isObjectLiteralExpression(argument)) {
    return 'inline-route-schema';
  }

  return truncateRouteExpression(value);
}

function extractOpenApiBasePath(argument: Node | undefined): string | undefined {
  if (!argument || !Node.isObjectLiteralExpression(argument)) {
    return undefined;
  }

  for (const property of argument.getProperties()) {
    if (Node.isPropertyAssignment(property) && property.getName() === 'basePath') {
      return extractLiteralPath(property.getInitializerOrThrow());
    }
  }

  return undefined;
}

function describeRouteExpression(argument: Node): string {
  if (Node.isIdentifier(argument)) {
    return argument.getText();
  }

  if (Node.isPropertyAccessExpression(argument)) {
    return argument.getText();
  }

  if (Node.isCallExpression(argument)) {
    return truncateRouteExpression(`${argument.getExpression().getText()}()`);
  }

  if (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) {
    return 'inline-handler';
  }

  return truncateRouteExpression(normalizeWhitespace(argument.getText()));
}

function truncateRouteExpression(value: string): string {
  return value.length <= MAX_ROUTE_EXPRESSION_CHARS
    ? value
    : `${value.slice(0, MAX_ROUTE_EXPRESSION_CHARS - 3)}...`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

interface RouteMiddlewareMount {
  path: string;
  middleware: string[];
}

interface RouteSurfaceBinding {
  surfaceId: string;
  basePath?: string;
}

function routePathMatchesMount(routePath: string, mountPath: string): boolean {
  const normalizedRoutePath = normalizeMountPath(routePath);
  const normalizedMountPath = normalizeMountPath(mountPath);
  if (normalizedMountPath === '/') {
    return true;
  }

  return (
    normalizedRoutePath === normalizedMountPath ||
    normalizedRoutePath.startsWith(`${normalizedMountPath}/`)
  );
}

function normalizeMountPath(value: string): string {
  if (!value || value === '/') {
    return '/';
  }

  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function joinRoutePath(basePath: string | undefined, routePath: string): string {
  if (!basePath) {
    return routePath;
  }

  if (!routePath || routePath === '/') {
    return basePath;
  }

  if (basePath.endsWith('/')) {
    return `${basePath.slice(0, -1)}${routePath}`;
  }

  return `${basePath}${routePath}`;
}

function flattenInheritedMiddleware(entries: RouteMiddlewareMount[]): string[] {
  return dedupeMiddleware(entries.flatMap((entry) => entry.middleware));
}

function dedupeMiddleware(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compareRoutes(left: RepoRouteInfo, right: RepoRouteInfo): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.line - right.line ||
    left.column - right.column
  );
}

function dedupeReferences(references: RepoSymbolReference[]): RepoSymbolReference[] {
  const seen = new Set<string>();
  const unique: RepoSymbolReference[] = [];

  for (const reference of references.sort(compareReferences)) {
    const key = `${reference.path}:${reference.line}:${reference.column}:${reference.isDefinition}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(reference);
  }

  return unique;
}

function compareReferences(left: RepoSymbolReference, right: RepoSymbolReference): number {
  return (
    left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column
  );
}

function readReferenceExcerpt(content: string, lineNumber: number): string {
  const line = content.split(/\r?\n/)[Math.max(0, lineNumber - 1)] ?? '';
  const trimmed = line.trim();
  if (trimmed.length <= MAX_RESULT_EXCERPT_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_RESULT_EXCERPT_CHARS - 3)}...`;
}

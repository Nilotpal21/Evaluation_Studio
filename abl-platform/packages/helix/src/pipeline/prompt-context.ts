import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import type {
  BootstrapMeta,
  EmbeddingRecord,
  HelixConfig,
  PromptCodeMapDirectorySummary,
  PromptCodeMapFile,
  PromptCodeMapSnapshot,
  PromptContextDocument,
  PromptContextSnapshot,
  Session,
  StageType,
} from '../types.js';
import type { EmbeddingStore } from '../intelligence/embedding-store.js';
import { createEmbeddingShardLogger } from './embedding-shard-store.js';
import {
  isTestFile,
  listScopedSourceFiles,
  loadScopedRepoIndex,
  normalizeRepoPath,
  pathExists,
  readExportsFromFile,
  safeReadText,
  safeStatType,
} from './repo-index.js';
import { extractExportSignatures } from '../intelligence/export-signatures.js';

const ROOT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const SCOPED_INSTRUCTION_FILES = ['agents.md', 'AGENTS.md', 'CLAUDE.md'];
const ROOT_RULE_SECTIONS = [
  'Quick Reference',
  'JIRA Workflow',
  'Core Invariants',
  'Type Safety',
  'Key Rules',
  'E2E Test Principles',
  'E2E Test Standards',
  'Debugging Runtime Issues',
  'Commit Discipline',
];
const FEATURE_SPEC_SECTIONS = [
  'Introduction',
  'Summary',
  'Scope',
  'Goals',
  'Goal',
  'User Stories',
  'Requirements',
  'Architecture',
];
const TEST_SPEC_SECTIONS = [
  'Summary',
  'Scope',
  'Acceptance Criteria',
  'Acceptance',
  'Coverage',
  'Integration',
  'E2E',
  'Negative Cases',
  'Negative Tests',
  'Security',
];
const HLD_SECTIONS = [
  'Summary',
  'Goals',
  'Architecture',
  'Trust Boundaries',
  'Security',
  'Observability',
  'Risks',
];
const LLD_SECTIONS = [
  'Summary',
  'Scope',
  'Implementation Plan',
  'Phases',
  'Acceptance Criteria',
  'Exit Criteria',
  'Verification',
];
const MAX_ROOT_DOC_CHARS = 4800;
const MAX_PACKAGE_DOC_CHARS = 4000;
const MAX_FEATURE_SPEC_CHARS = 6000;
const MAX_TEST_SPEC_CHARS = 6000;
const MAX_HLD_SPEC_CHARS = 5200;
const MAX_LLD_PLAN_CHARS = 5200;
const MAX_PRIOR_CONTEXT_CHARS = 3200;
const MAX_DOC_LINES = 200;
const MAX_CODE_MAP_SOURCE_FILES = 25;
const MAX_CODE_MAP_TEST_FILES = 10;
const MAX_PLAN_STAGE_ROOT_DOC_CHARS = 1400;
const MAX_PLAN_STAGE_PACKAGE_DOC_CHARS = 750;
const MAX_PLAN_STAGE_ROOT_DOC_LINES = 60;
const MAX_PLAN_STAGE_PACKAGE_DOC_LINES = 28;
const MAX_PLAN_STAGE_CODE_MAP_FILES = 16;
const MAX_CODE_MAP_DEPENDENT_SAMPLES = 12;
const MAX_PERSISTED_CODE_MAP_ALL_FILES = 256;
const MAX_FULL_REPO_INDEX_PROMPT_SCOPE_FILES = 20_000;
const MAX_FULL_STAGE_FILE_TREE_FILES = 80;
const MAX_TRUNCATED_STAGE_FILE_TREE_FILES = 160;
const MAX_TRUNCATED_STAGE_FILE_TREE_LINES = 80;
const MAX_STAGE_DIRECTORY_SUMMARY_DIRS = 16;
const log = createEmbeddingShardLogger('helix.prompt-context');

export async function buildPromptContext(
  session: Session,
  config: HelixConfig,
  embeddingStore?: EmbeddingStore | null,
): Promise<PromptContextSnapshot> {
  const buildStartedAt = Date.now();
  const instructionDocs = await loadInstructionDocs(session, config);
  const featureSpecDoc = await loadFeatureSpecDoc(session, config);
  const testSpecDoc = await loadStructuredWorkItemDoc(
    session,
    config,
    session.workItem.testSpec,
    'Test Spec',
    TEST_SPEC_SECTIONS,
    MAX_TEST_SPEC_CHARS,
  );
  const hldSpecDoc = await loadStructuredWorkItemDoc(
    session,
    config,
    session.workItem.hldSpec,
    'HLD',
    HLD_SECTIONS,
    MAX_HLD_SPEC_CHARS,
  );
  const lldPlanDoc = await loadStructuredWorkItemDoc(
    session,
    config,
    session.workItem.lldPlan,
    'LLD / Implementation Plan',
    LLD_SECTIONS,
    MAX_LLD_PLAN_CHARS,
  );
  const priorContext = await loadRelevantPriorContext(session, config, embeddingStore);
  const codeMap = await buildPromptCodeMap(session, config);

  const snapshot: PromptContextSnapshot = {
    builtAt: new Date().toISOString(),
    buildDurationMs: Date.now() - buildStartedAt,
    instructionDocs,
    featureSpecDoc,
    testSpecDoc,
    hldSpecDoc,
    lldPlanDoc,
    priorFindingsDoc: priorContext.priorFindingsDoc,
    priorDecisionsDoc: priorContext.priorDecisionsDoc,
    retrievalTelemetry: priorContext.retrievalTelemetry,
    codeMap,
  };

  // Thread BootstrapMeta from the session into the context snapshot so
  // deep-scan and planning prompts can surface the Jira issue title,
  // description, acceptance criteria, and linked key. (Slice 4 / D-L3.)
  if (session.bootstrapMeta) {
    snapshot.bootstrapMeta = session.bootstrapMeta;
  }

  return snapshot;
}

export async function loadRelevantPriorContext(
  session: Session,
  config: HelixConfig,
  embeddingStore?: EmbeddingStore | null,
): Promise<{
  priorFindingsDoc?: PromptContextDocument;
  priorDecisionsDoc?: PromptContextDocument;
  retrievalTelemetry?: PromptContextSnapshot['retrievalTelemetry'];
}> {
  if (!embeddingStore) {
    return {
      priorFindingsDoc: await loadPriorDoc(session, config, 'findings.md', 'Prior Findings'),
      priorDecisionsDoc: await loadPriorDoc(session, config, 'decisions.md', 'Prior Decisions'),
      retrievalTelemetry: {
        queriedAt: new Date().toISOString(),
        topNReturned: 0,
        latencyMs: 0,
        fallback: true,
        embeddingSource: 'fallback-slug',
      },
    };
  }

  const startedAt = Date.now();
  const projectId = resolveRetrievalProjectId(session);
  const queryText = buildPriorContextQuery(session);

  try {
    const [findings, decisions] = await Promise.all([
      embeddingStore.query(queryText, { projectId }, { kind: 'finding', topN: 5 }),
      embeddingStore.query(queryText, { projectId }, { kind: 'decision', topN: 3 }),
    ]);
    const includedCount = findings.length + decisions.length;

    return {
      priorFindingsDoc: buildEmbeddingContextDoc(
        'Prior Findings',
        findings.map((r) => r.record),
      ),
      priorDecisionsDoc: buildEmbeddingContextDoc(
        'Prior Decisions',
        decisions.map((r) => r.record),
      ),
      retrievalTelemetry: {
        queriedAt: new Date().toISOString(),
        topNReturned: includedCount,
        latencyMs: Date.now() - startedAt,
        fallback: false,
        embeddingSource: 'bge-m3',
        candidateCount: includedCount,
        includedCount,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Embedding retrieval failed; falling back to slug prior docs', { error: message });
    return {
      priorFindingsDoc: await loadPriorDoc(session, config, 'findings.md', 'Prior Findings'),
      priorDecisionsDoc: await loadPriorDoc(session, config, 'decisions.md', 'Prior Decisions'),
      retrievalTelemetry: {
        queriedAt: new Date().toISOString(),
        topNReturned: 0,
        latencyMs: Date.now() - startedAt,
        fallback: true,
        embeddingSource: 'fallback-slug',
      },
    };
  }
}

export function renderPromptContext(
  stageType: StageType,
  promptContext?: PromptContextSnapshot,
): string {
  if (!promptContext) {
    return '';
  }

  const sections: string[] = [];

  if (promptContext.instructionDocs.length > 0) {
    sections.push(
      renderDocumentList('Repository Instructions', promptContext.instructionDocs, {
        compact: stageType === 'plan-generation',
      }),
    );
  }

  if (shouldIncludeFeatureSpec(stageType) && promptContext.featureSpecDoc) {
    sections.push(renderSingleDocument('Feature Spec Excerpt', promptContext.featureSpecDoc));
  }

  if (shouldIncludePlanningDocs(stageType) && promptContext.testSpecDoc) {
    sections.push(renderSingleDocument('Test Spec Excerpt', promptContext.testSpecDoc));
  }

  if (shouldIncludePlanningDocs(stageType) && promptContext.hldSpecDoc) {
    sections.push(renderSingleDocument('HLD Excerpt', promptContext.hldSpecDoc));
  }

  if (shouldIncludePlanningDocs(stageType) && promptContext.lldPlanDoc) {
    sections.push(
      renderSingleDocument('LLD / Implementation Plan Excerpt', promptContext.lldPlanDoc),
    );
  }

  if (shouldIncludePriorFindings(stageType) && promptContext.priorFindingsDoc) {
    sections.push(renderSingleDocument('Prior HELIX Findings', promptContext.priorFindingsDoc));
  }

  if (shouldIncludePriorFindings(stageType) && promptContext.priorDecisionsDoc) {
    sections.push(renderSingleDocument('Prior HELIX Decisions', promptContext.priorDecisionsDoc));
  }

  if (shouldIncludeCodeMap(stageType) && promptContext.codeMap) {
    sections.push(renderCodeMap(promptContext.codeMap, stageType));
  }

  // Render BootstrapMeta at deep-scan and planning stages so the model has the
  // Jira work-item title, acceptance criteria, and linked key in context.
  if (shouldIncludeBootstrapMeta(stageType) && promptContext.bootstrapMeta) {
    const rendered = renderBootstrapMeta(promptContext.bootstrapMeta);
    if (rendered) sections.push(rendered);
  }

  return sections.filter(Boolean).join('\n\n');
}

function shouldIncludeBootstrapMeta(stageType: StageType): boolean {
  return (
    stageType === 'deep-scan' ||
    stageType === 'plan-generation' ||
    stageType === 'oracle-analysis' ||
    stageType === 'implementation'
  );
}

function renderBootstrapMeta(meta: BootstrapMeta): string {
  const lines: string[] = [];
  if (meta.jiraKey) lines.push(`**Jira Key**: ${meta.jiraKey}`);
  if (meta.acceptanceCriteria && meta.acceptanceCriteria.length > 0) {
    lines.push('**Acceptance Criteria** (from Jira):');
    for (const ac of meta.acceptanceCriteria) {
      lines.push(`  - ${ac}`);
    }
  }
  if (meta.inferredScope.length > 0) {
    lines.push(`**Inferred Scope**: ${meta.inferredScope.join(', ')}`);
  }
  if (!meta.jiraFetchSuccess && meta.fallbackReason) {
    lines.push(
      `**Bootstrap Note**: Jira fetch unavailable (${meta.fallbackReason}); work item assembled from CLI inputs only.`,
    );
  }
  if (lines.length === 0) return '';
  return `## Jira Work Item Bootstrap\n${lines.join('\n')}`;
}

function resolveRetrievalProjectId(session: Session): string {
  return (
    session.bootstrapMeta?.jiraKey ??
    session.workItem.jiraKey ??
    slugifyTitle(session.workItem.title)
  );
}

function buildPriorContextQuery(session: Session): string {
  const parts = [
    session.workItem.title,
    session.workItem.description,
    session.workItem.scope.join(' '),
    session.bootstrapMeta?.acceptanceCriteria?.join(' '),
  ];
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

function buildEmbeddingContextDoc(
  title: 'Prior Findings' | 'Prior Decisions',
  records: EmbeddingRecord[],
): PromptContextDocument | undefined {
  if (records.length === 0) {
    return undefined;
  }

  const lines = records.map((record) => formatEmbeddingRecord(record));
  const excerpt = truncateForPrompt(lines.join('\n'), MAX_PRIOR_CONTEXT_CHARS, MAX_DOC_LINES);
  if (!excerpt) {
    return undefined;
  }

  return {
    path: `embedding://${title === 'Prior Findings' ? 'findings' : 'decisions'}`,
    title,
    excerpt,
  };
}

function formatEmbeddingRecord(record: EmbeddingRecord): string {
  const metadata = record.metadata;
  const label = record.kind === 'finding' ? 'Finding' : 'Decision';
  const details = [
    metadata.severity ? `severity=${metadata.severity}` : undefined,
    metadata.category ? `category=${metadata.category}` : undefined,
    metadata.classification ? `classification=${metadata.classification}` : undefined,
    metadata.files.length > 0 ? `files=${metadata.files.join(', ')}` : undefined,
    `session=${metadata.sessionId}`,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join('; ');

  return `- ${label} ${record.id}: ${metadata.featureSlug}${details ? ` (${details})` : ''}`;
}

async function loadInstructionDocs(
  session: Session,
  config: HelixConfig,
): Promise<PromptContextDocument[]> {
  const instructionPaths = await discoverInstructionPaths(config.workDir, session.workItem.scope);
  const docs: PromptContextDocument[] = [];

  for (const absolutePath of instructionPaths) {
    const relativePath = normalizeRepoPath(relative(config.workDir, absolutePath));
    const content = await safeReadText(absolutePath);
    if (!content) {
      continue;
    }

    const excerpt = buildInstructionExcerpt(relativePath, content);
    if (!excerpt) {
      continue;
    }

    docs.push({
      path: relativePath,
      title: relativePath,
      excerpt,
    });
  }

  return docs;
}

async function loadFeatureSpecDoc(
  session: Session,
  config: HelixConfig,
): Promise<PromptContextDocument | undefined> {
  return loadStructuredWorkItemDoc(
    session,
    config,
    session.workItem.featureSpec,
    'Feature Spec',
    FEATURE_SPEC_SECTIONS,
    MAX_FEATURE_SPEC_CHARS,
  );
}

async function loadStructuredWorkItemDoc(
  session: Session,
  config: HelixConfig,
  docPath: string | undefined,
  title: string,
  headings: string[],
  maxChars: number,
): Promise<PromptContextDocument | undefined> {
  void session;
  if (!docPath) {
    return undefined;
  }

  const absolutePath = resolveExecutionWorkspacePath(config, docPath);
  if (!(await pathExists(absolutePath))) {
    return undefined;
  }

  const content = await safeReadText(absolutePath);
  const excerpt = buildStructuredDocExcerpt(content, headings, maxChars);
  if (!excerpt) {
    return undefined;
  }

  return {
    path: normalizeRepoPath(relative(config.workDir, absolutePath)),
    title,
    excerpt,
  };
}

function resolveExecutionWorkspacePath(config: HelixConfig, targetPath: string): string {
  if (!isAbsolute(targetPath)) {
    return resolve(config.workDir, targetPath);
  }

  const sourceWorkDir = config.workspaceContext?.sourceWorkDir?.trim();
  const worktreeDir = config.workspaceContext?.worktreeDir?.trim();
  if (!sourceWorkDir || !worktreeDir || sourceWorkDir === worktreeDir) {
    return targetPath;
  }

  const normalizedSourceWorkDir = normalize(resolve(sourceWorkDir));
  const normalizedTargetPath = normalize(targetPath);
  if (!isPathWithinRoot(normalizedTargetPath, normalizedSourceWorkDir)) {
    return targetPath;
  }

  return resolve(worktreeDir, relative(normalizedSourceWorkDir, normalizedTargetPath));
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

async function loadPriorDoc(
  session: Session,
  config: HelixConfig,
  fileName: 'findings.md' | 'decisions.md',
  title: string,
): Promise<PromptContextDocument | undefined> {
  // Scope to the specific session's journal directory first (session-scoped lookup).
  // This avoids non-deterministic matches when the same work-item title (slug)
  // appears in multiple sessions. The session-scoped path is preferred; fall back
  // to the slug-only path when the session-scoped file does not exist.
  //
  // Session-scoped path: journalDir/<slug>/<sessionId>/<fileName>
  // Slug-only path (legacy fallback): journalDir/<slug>/<fileName>
  const slug = slugifyTitle(session.workItem.title);
  const sessionScopedPath = join(config.journalDir, slug, session.id, fileName);
  const slugOnlyPath = join(config.journalDir, slug, fileName);

  const absolutePath = (await pathExists(sessionScopedPath)) ? sessionScopedPath : slugOnlyPath;
  if (!(await pathExists(absolutePath))) {
    return undefined;
  }

  const content = await safeReadText(absolutePath);
  const excerpt = truncateForPrompt(
    stripFrontmatter(content),
    MAX_PRIOR_CONTEXT_CHARS,
    MAX_DOC_LINES,
  );
  if (!excerpt) {
    return undefined;
  }

  return {
    path: normalizeRepoPath(relative(config.workDir, absolutePath)),
    title,
    excerpt,
  };
}

async function buildPromptCodeMap(
  session: Session,
  config: HelixConfig,
): Promise<PromptCodeMapSnapshot | undefined> {
  const repoFiles = await listScopedSourceFiles(config.workDir, session.workItem.scope);
  if (repoFiles.length === 0) {
    return undefined;
  }

  if (repoFiles.length > MAX_FULL_REPO_INDEX_PROMPT_SCOPE_FILES) {
    return buildLightweightPromptCodeMap(session, config, repoFiles);
  }

  const { repoIndex } = await loadScopedRepoIndex(config.workDir, session.workItem.scope);
  let totalSourceFiles = 0;
  let totalTestFiles = 0;
  const sourceEntries: PromptCodeMapFile[] = [];
  const testEntries: PromptCodeMapFile[] = [];
  const includeAllFiles = repoFiles.length <= MAX_PERSISTED_CODE_MAP_ALL_FILES;
  const directorySummary = includeAllFiles ? undefined : buildDirectorySummarySnapshot(repoFiles);

  for (const filePath of repoFiles) {
    const fileAnalysis = repoIndex.filesByPath.get(filePath);
    const dependents = repoIndex.importersByTarget.get(filePath);
    const entry: PromptCodeMapFile = {
      path: filePath,
      exports: fileAnalysis?.exports ?? repoIndex.exportsByFile.get(filePath) ?? [],
      dependents: [],
      dependentCount: dependents?.size ?? 0,
      isTestFile: fileAnalysis?.isTestFile ?? repoIndex.testFiles.has(filePath),
      lineCount: fileAnalysis?.lineCount,
    };

    if (entry.isTestFile) {
      totalTestFiles += 1;
      if (shouldInsertCodeMapEntry(testEntries, entry, MAX_CODE_MAP_TEST_FILES)) {
        entry.dependents = buildDependentSample(dependents);
        insertCodeMapEntry(testEntries, entry, MAX_CODE_MAP_TEST_FILES);
      }
    } else {
      totalSourceFiles += 1;
      if (shouldInsertCodeMapEntry(sourceEntries, entry, MAX_CODE_MAP_SOURCE_FILES)) {
        entry.dependents = buildDependentSample(dependents);
        insertCodeMapEntry(sourceEntries, entry, MAX_CODE_MAP_SOURCE_FILES);
      }
    }
  }

  await hydrateCodeMapEntrySignatures(config.workDir, [...sourceEntries, ...testEntries]);

  return {
    scope: [...session.workItem.scope],
    totalSourceFiles,
    totalTestFiles,
    keyFiles: [...sourceEntries, ...testEntries],
    allFiles: includeAllFiles ? repoFiles : undefined,
    directorySummary,
    repoIndex: {
      cacheStatus: repoIndex.cacheStatus ?? 'miss',
      diffHash: repoIndex.diffHash,
      scopedFileCount: repoFiles.length,
      loadDurationMs: repoIndex.loadDurationMs ?? 0,
    },
  };
}

async function buildLightweightPromptCodeMap(
  session: Session,
  config: HelixConfig,
  repoFiles: string[],
): Promise<PromptCodeMapSnapshot> {
  const loadStartedAt = Date.now();
  let totalSourceFiles = 0;
  let totalTestFiles = 0;
  const sourceEntries: PromptCodeMapFile[] = [];
  const testEntries: PromptCodeMapFile[] = [];
  const directorySummary = buildDirectorySummarySnapshot(repoFiles);

  for (const filePath of repoFiles) {
    const testFile = isTestFile(filePath);
    if (testFile) {
      totalTestFiles += 1;
      if (testEntries.length < MAX_CODE_MAP_TEST_FILES) {
        testEntries.push(await buildLightweightPromptCodeMapEntry(config.workDir, filePath, true));
      }
      continue;
    }

    totalSourceFiles += 1;
    if (sourceEntries.length < MAX_CODE_MAP_SOURCE_FILES) {
      sourceEntries.push(await buildLightweightPromptCodeMapEntry(config.workDir, filePath, false));
    }
  }

  await hydrateCodeMapEntrySignatures(config.workDir, [...sourceEntries, ...testEntries]);

  return {
    scope: [...session.workItem.scope],
    totalSourceFiles,
    totalTestFiles,
    keyFiles: [...sourceEntries, ...testEntries],
    directorySummary,
    repoIndex: {
      cacheStatus: 'skipped',
      scopedFileCount: repoFiles.length,
      loadDurationMs: Date.now() - loadStartedAt,
    },
  };
}

async function buildLightweightPromptCodeMapEntry(
  workDir: string,
  filePath: string,
  testFile: boolean,
): Promise<PromptCodeMapFile> {
  const absolutePath = resolve(workDir, filePath);
  const [exports, content] = await Promise.all([
    readExportsFromFile(absolutePath),
    safeReadText(absolutePath),
  ]);

  return {
    path: filePath,
    exports,
    dependents: [],
    dependentCount: 0,
    isTestFile: testFile,
    lineCount: content.length === 0 ? 0 : content.split('\n').length,
  };
}

async function hydrateCodeMapEntrySignatures(
  workDir: string,
  entries: PromptCodeMapFile[],
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.exports.length === 0) {
        return;
      }

      const content = await safeReadText(resolve(workDir, entry.path));
      const signatures = extractExportSignatures(entry.path, content);
      if (Object.keys(signatures).length > 0) {
        entry.exportSignatures = signatures;
      }
    }),
  );
}

async function discoverInstructionPaths(workDir: string, scope: string[]): Promise<string[]> {
  const discovered = new Set<string>();

  for (const fileName of ROOT_INSTRUCTION_FILES) {
    const absolutePath = join(workDir, fileName);
    if (await pathExists(absolutePath)) {
      discovered.add(absolutePath);
    }
  }

  for (const scopeEntry of scope) {
    const absoluteEntry = resolve(workDir, scopeEntry);
    const statType = await safeStatType(absoluteEntry);
    if (statType === 'missing') {
      continue;
    }

    let currentDir = statType === 'file' ? dirname(absoluteEntry) : absoluteEntry;
    while (currentDir.startsWith(workDir)) {
      for (const fileName of SCOPED_INSTRUCTION_FILES) {
        const candidate = join(currentDir, fileName);
        if (await pathExists(candidate)) {
          discovered.add(candidate);
        }
      }

      if (currentDir === workDir) {
        break;
      }

      const parent = dirname(currentDir);
      if (parent === currentDir) {
        break;
      }
      currentDir = parent;
    }
  }

  return [...discovered].sort(compareInstructionPath);
}

function buildInstructionExcerpt(relativePath: string, content: string): string {
  const stripped = stripFrontmatter(content);
  const fileName = basename(relativePath);

  if (fileName === 'AGENTS.md' || fileName === 'CLAUDE.md') {
    return extractMarkdownSections(stripped, ROOT_RULE_SECTIONS, MAX_ROOT_DOC_CHARS);
  }

  return truncateForPrompt(stripped, MAX_PACKAGE_DOC_CHARS, MAX_DOC_LINES);
}

function buildFeatureSpecExcerpt(content: string): string {
  const stripped = stripFrontmatter(content);
  return extractMarkdownSections(stripped, FEATURE_SPEC_SECTIONS, MAX_FEATURE_SPEC_CHARS);
}

function buildStructuredDocExcerpt(content: string, headings: string[], maxChars: number): string {
  const stripped = stripFrontmatter(content);
  return extractMarkdownSections(stripped, headings, maxChars);
}

function renderDocumentList(
  title: string,
  docs: PromptContextDocument[],
  options: { compact?: boolean } = {},
): string {
  const lines = [
    `## ${title}`,
    'Follow these docs as preloaded context. More specific package-local guidance overrides repo-root guidance when they conflict.',
  ];

  for (const doc of docs) {
    const excerpt = options.compact ? compactInstructionExcerpt(doc) : doc.excerpt;
    if (!excerpt) {
      continue;
    }
    lines.push('');
    lines.push(`### ${doc.title}`);
    lines.push(excerpt);
  }

  return lines.join('\n');
}

function renderSingleDocument(title: string, doc: PromptContextDocument): string {
  return [`## ${title}`, `Source: ${doc.path}`, doc.excerpt].join('\n');
}

function renderCodeMap(codeMap: PromptCodeMapSnapshot, stageType: StageType): string {
  const compactForPlanning = stageType === 'plan-generation';
  const scopeLines =
    codeMap.scope.length > 0 ? codeMap.scope.map((entry) => `- ${entry}`) : ['- (repo root)'];
  const highSignalFiles = compactForPlanning
    ? codeMap.keyFiles.slice(0, MAX_PLAN_STAGE_CODE_MAP_FILES)
    : codeMap.keyFiles;
  const fileLines =
    highSignalFiles.length > 0
      ? highSignalFiles.map((file) => {
          const annotations: string[] = [];
          if (file.lineCount != null) {
            annotations.push(`${file.lineCount}L`);
          }
          if (file.exports.length > 0) {
            annotations.push(`exports: ${buildExportSurfaceSummary(file)}`);
          }
          if (file.dependents.length > 0) {
            const dependentCount = file.dependentCount ?? file.dependents.length;
            annotations.push(
              dependentCount > file.dependents.length
                ? `dependents (${dependentCount}): ${file.dependents.join(', ')}`
                : `dependents: ${file.dependents.join(', ')}`,
            );
          }
          if (file.isTestFile) {
            annotations.push('test');
          }
          return `- ${file.path}${annotations.length > 0 ? ` | ${annotations.join(' | ')}` : ''}`;
        })
      : ['- (no scoped source files found)'];

  if (compactForPlanning) {
    return [
      '## Scoped Code Map',
      'Pre-indexed dependency snapshot for the scoped packages. The complete file tree is omitted for plan generation to keep the prompt lean; use Read/Grep/Glob if you need additional files while planning.',
      '### Scope Roots',
      ...scopeLines,
      '',
      `Summary: ${codeMap.totalSourceFiles} source files, ${codeMap.totalTestFiles} test files`,
      '',
      '### High-Signal Files (top dependents/exports)',
      ...fileLines,
    ].join('\n');
  }

  const allFiles = codeMap.allFiles ?? [];
  const totalFileCount = codeMap.totalSourceFiles + codeMap.totalTestFiles;
  const detailMode = allFiles.length > 0 ? selectCodeMapDetailMode(allFiles.length) : 'summary';
  const treeLines = allFiles.length > 0 ? buildFileTreeLines(allFiles, detailMode) : [];
  const directorySummaryLines =
    detailMode === 'summary'
      ? allFiles.length > 0
        ? buildDirectorySummaryLines(allFiles)
        : buildDirectorySummaryLinesFromSnapshot(codeMap.directorySummary)
      : [];
  const overviewDescription =
    detailMode === 'full'
      ? 'Pre-indexed file tree and dependency graph for the scoped packages. Use this as your starting topology — explore beyond scope as needed when tracing imports or shared types.'
      : 'Pre-indexed dependency snapshot for the scoped packages. File-tree detail is adapted to scope size to keep prompts lean; use Read/Grep/Glob to inspect specific files as you verify findings or wiring.';
  const directorySection =
    detailMode === 'summary' ? ['', '### Directory Summary', ...directorySummaryLines] : [];
  const fileTreeSection =
    detailMode === 'summary'
      ? [
          '',
          `Complete file tree omitted for prompt size (${totalFileCount} scoped files). Use Read/Grep/Glob to inspect specific paths.`,
        ]
      : [
          '',
          detailMode === 'full'
            ? '### Complete File Tree'
            : `### Scoped File Tree (first ${treeLines.length} of ${allFiles.length} files)`,
          ...treeLines,
          ...(detailMode === 'truncated'
            ? [`  ... ${allFiles.length - treeLines.length} more files omitted for prompt size`]
            : []),
        ];

  return [
    '## Scoped Code Map',
    overviewDescription,
    '### Scope Roots',
    ...scopeLines,
    '',
    `Summary: ${codeMap.totalSourceFiles} source files, ${codeMap.totalTestFiles} test files`,
    ...directorySection,
    ...fileTreeSection,
    '',
    '### High-Signal Files (by dependents/exports)',
    ...fileLines,
  ].join('\n');
}

function buildExportSurfaceSummary(file: PromptCodeMapFile): string {
  if (!file.exportSignatures || Object.keys(file.exportSignatures).length === 0) {
    return file.exports.join(', ');
  }

  const visibleExports = file.exports.slice(0, 3).map((exportName) => {
    return file.exportSignatures?.[exportName] ?? exportName;
  });
  const remainder = file.exports.length - visibleExports.length;

  return `${visibleExports.join(' ; ')}${remainder > 0 ? ` ; +${remainder} more` : ''}`;
}

function selectCodeMapDetailMode(fileCount: number): 'full' | 'truncated' | 'summary' {
  if (fileCount <= MAX_FULL_STAGE_FILE_TREE_FILES) {
    return 'full';
  }

  if (fileCount <= MAX_TRUNCATED_STAGE_FILE_TREE_FILES) {
    return 'truncated';
  }

  return 'summary';
}

function buildFileTreeLines(allFiles: string[], mode: 'full' | 'truncated' | 'summary'): string[] {
  if (allFiles.length === 0) {
    return ['  (use Glob/Read to discover files)'];
  }

  if (mode === 'full') {
    return allFiles.map((file) => `  ${file}`);
  }

  if (mode === 'truncated') {
    return allFiles.slice(0, MAX_TRUNCATED_STAGE_FILE_TREE_LINES).map((file) => `  ${file}`);
  }

  return [];
}

function buildDirectorySummaryLines(allFiles: string[]): string[] {
  return buildDirectorySummaryLinesFromSnapshot(buildDirectorySummarySnapshot(allFiles));
}

function buildDirectorySummarySnapshot(allFiles: string[]): PromptCodeMapDirectorySummary {
  if (allFiles.length === 0) {
    return { entries: [] };
  }

  const directoryCounts: Record<string, number> = {};

  for (const file of allFiles) {
    const directory = dirname(file);
    const label = directory === '.' ? '(repo root)' : directory;
    directoryCounts[label] = (directoryCounts[label] ?? 0) + 1;
  }

  const entries = Object.entries(directoryCounts).sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }

    return left[0].localeCompare(right[0]);
  });

  const visibleEntries = entries.slice(0, MAX_STAGE_DIRECTORY_SUMMARY_DIRS);
  const omittedEntries = entries.slice(visibleEntries.length);

  return {
    entries: visibleEntries.map(([directory, fileCount]) => ({ directory, fileCount })),
    omittedDirectoryCount: omittedEntries.length || undefined,
    omittedFileCount:
      omittedEntries.length > 0
        ? omittedEntries.reduce((sum, [, fileCount]) => sum + fileCount, 0)
        : undefined,
  };
}

function buildDirectorySummaryLinesFromSnapshot(summary?: PromptCodeMapDirectorySummary): string[] {
  if (!summary || summary.entries.length === 0) {
    return ['- (no scoped source files found)'];
  }

  const lines = summary.entries.map(
    (entry) => `- ${entry.directory} (${entry.fileCount} file${entry.fileCount === 1 ? '' : 's'})`,
  );

  if ((summary.omittedDirectoryCount ?? 0) > 0) {
    lines.push(
      `- ... ${summary.omittedFileCount ?? 0} additional files across ${summary.omittedDirectoryCount} more directories`,
    );
  }

  return lines;
}

function compactInstructionExcerpt(doc: PromptContextDocument): string {
  const isRootDoc = isRootInstructionDocument(doc.path);
  return truncateForPrompt(
    doc.excerpt,
    isRootDoc ? MAX_PLAN_STAGE_ROOT_DOC_CHARS : MAX_PLAN_STAGE_PACKAGE_DOC_CHARS,
    isRootDoc ? MAX_PLAN_STAGE_ROOT_DOC_LINES : MAX_PLAN_STAGE_PACKAGE_DOC_LINES,
  );
}

function shouldIncludeFeatureSpec(stageType: StageType): boolean {
  return [
    'deep-scan',
    'oracle-analysis',
    'plan-generation',
    'implementation',
    'review',
    'bulk-review',
    'doc-sync',
  ].includes(stageType);
}

function shouldIncludePlanningDocs(stageType: StageType): boolean {
  return [
    'deep-scan',
    'oracle-analysis',
    'plan-generation',
    'implementation',
    'testing',
    'review',
    'bulk-review',
    'regression',
    'doc-sync',
  ].includes(stageType);
}

function shouldIncludePriorFindings(stageType: StageType): boolean {
  return ['deep-scan', 'oracle-analysis', 'plan-generation'].includes(stageType);
}

function shouldIncludeCodeMap(stageType: StageType): boolean {
  return [
    'deep-scan',
    'oracle-analysis',
    'plan-generation',
    'implementation',
    'testing',
    'review',
    'bulk-review',
    'reproduce',
    'root-cause',
  ].includes(stageType);
}

function compareCodeMapEntry(left: PromptCodeMapFile, right: PromptCodeMapFile): number {
  const leftDependentCount = left.dependentCount ?? left.dependents.length;
  const rightDependentCount = right.dependentCount ?? right.dependents.length;

  if (rightDependentCount !== leftDependentCount) {
    return rightDependentCount - leftDependentCount;
  }
  if (right.exports.length !== left.exports.length) {
    return right.exports.length - left.exports.length;
  }
  return left.path.localeCompare(right.path);
}

function insertCodeMapEntry(
  entries: PromptCodeMapFile[],
  entry: PromptCodeMapFile,
  limit: number,
): void {
  entries.push(entry);
  entries.sort(compareCodeMapEntry);

  if (entries.length > limit) {
    entries.length = limit;
  }
}

function shouldInsertCodeMapEntry(
  entries: PromptCodeMapFile[],
  candidate: PromptCodeMapFile,
  limit: number,
): boolean {
  if (entries.length < limit) {
    return true;
  }

  const currentWorstEntry = entries[entries.length - 1];
  return compareCodeMapEntry(candidate, currentWorstEntry) < 0;
}

function buildDependentSample(dependents: Set<string> | undefined): string[] {
  if (!dependents || dependents.size === 0) {
    return [];
  }

  const sample: string[] = [];
  for (const dependent of dependents) {
    sample.push(dependent);
    if (sample.length >= MAX_CODE_MAP_DEPENDENT_SAMPLES) {
      break;
    }
  }

  return sample.sort((left, right) => left.localeCompare(right));
}

function compareInstructionPath(left: string, right: string): number {
  const leftRelative = normalizeRepoPath(left);
  const rightRelative = normalizeRepoPath(right);
  const leftDepth = leftRelative.split('/').length;
  const rightDepth = rightRelative.split('/').length;

  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth;
  }

  return leftRelative.localeCompare(rightRelative);
}

function isRootInstructionDocument(relativePath: string): boolean {
  const fileName = basename(relativePath);
  return !relativePath.includes('/') && (fileName === 'AGENTS.md' || fileName === 'CLAUDE.md');
}

function extractMarkdownSections(content: string, headings: string[], maxChars: number): string {
  const stripped = content.trim();
  if (!stripped) {
    return '';
  }

  const sections = splitMarkdownSections(stripped);
  const normalizedHeadings = new Set(headings.map((heading) => heading.toLowerCase()));
  const matches = sections.filter((section) =>
    normalizedHeadings.has(section.heading.toLowerCase()),
  );

  if (matches.length === 0) {
    return truncateForPrompt(stripped, maxChars, MAX_DOC_LINES);
  }

  const parts: string[] = [];
  const preamble = sections.find((section) => section.heading === '');
  if (preamble?.body.trim()) {
    parts.push(truncateForPrompt(preamble.body, Math.min(maxChars, 900), 40));
  }

  for (const section of matches) {
    const next = [`## ${section.heading}`, section.body.trim()].join('\n');
    const candidate = parts.length > 0 ? [...parts, next].join('\n\n') : next;
    if (candidate.length > maxChars) {
      break;
    }
    parts.push(next);
  }

  const combined = parts.join('\n\n').trim();
  return combined || truncateForPrompt(stripped, maxChars, MAX_DOC_LINES);
}

function splitMarkdownSections(content: string): Array<{ heading: string; body: string }> {
  const lines = content.split('\n');
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (match) {
      sections.push({ heading: currentHeading, body: currentLines.join('\n').trim() });
      currentHeading = match[1].trim();
      currentLines = [];
      continue;
    }

    currentLines.push(line);
  }

  sections.push({ heading: currentHeading, body: currentLines.join('\n').trim() });
  return sections;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function truncateForPrompt(content: string, maxChars: number, maxLines: number): string {
  const normalizedLines = content
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1].length > 0))
    .slice(0, maxLines);
  const candidate = normalizedLines.join('\n').trim();

  if (candidate.length <= maxChars) {
    return candidate;
  }

  return `${candidate.slice(0, Math.max(maxChars - 14, 0)).trimEnd()}\n[truncated]`;
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

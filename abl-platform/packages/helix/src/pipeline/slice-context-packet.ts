import { basename, dirname, extname, resolve } from 'node:path';

import type { PromptContextDocument, Session, Slice } from '../types.js';
import { extractExportSignatures } from '../intelligence/export-signatures.js';
import {
  RepoIntelligenceService,
  type RepoSchemaField,
  type RepoSchemaInfo,
} from '../intelligence/repo-intelligence-service.js';
import {
  isTestFile,
  loadScopedRepoIndex,
  normalizeRepoPath,
  pathExists,
  safeReadText,
} from './repo-index.js';
import {
  buildSliceVerificationCommandPacket,
  type SliceVerificationCommandPacket,
} from './quality-gate.js';
import { getSliceVerificationScopeEntries } from './slice-view.js';

const MAX_SLICE_CONTEXT_PACKET_BYTES = 140_000;
const MAX_ARCHITECTURE_REVIEW_PACKET_BYTES = 180_000;
const MAX_DIRECT_FILE_COUNT = 6;
const MAX_REQUIRED_TEST_FILE_COUNT = 4;
const MAX_DEPENDENT_EXCERPT_COUNT = 6;
const MAX_IMPORTED_SIGNATURE_FILE_COUNT = 6;
const MAX_SCHEMA_CONTEXT_FILE_COUNT = 8;
const MAX_SCHEMA_COUNT = 6;
const MAX_SCHEMA_FIELDS = 8;
const MAX_DIRECT_FILE_CHARS = 12_000;
const MAX_TEST_FILE_CHARS = 10_000;
const MAX_DEPENDENT_EXCERPT_CHARS = 2_400;
const MAX_SCHEMA_SUMMARY_CHARS = 240;
const MAX_SIGNATURES_PER_FILE = 6;
const DEPENDENT_EXCERPT_BEFORE_LINES = 4;
const DEPENDENT_EXCERPT_AFTER_LINES = 8;
const MAX_RELEVANT_DOCS = 3;
const MAX_RELEVANT_DOC_CHARS = 1_400;

interface FilePacket {
  path: string;
  title: string;
  body: string;
}

interface DependentExcerpt {
  path: string;
  reason: string;
  excerpt: string;
}

interface ImportedSignaturePacket {
  path: string;
  signatures: Array<{ exportName: string; signature: string }>;
  omittedSignatureCount: number;
}

interface SchemaPacket {
  filePath: string;
  symbol: string;
  schemaKind: RepoSchemaInfo['schemaKind'];
  summary: string;
  fields: RepoSchemaField[];
  omittedFieldCount: number;
}

export interface ArchitectureReviewWorkspaceSnapshot {
  reviewScopeEntries: string[];
  actualChangedFiles: string[];
  outOfScopeChanges: string[];
  ignoredOutOfScopeChanges: string[];
  diffStat: string;
  workspaceReconcileSummary?: string;
}

export async function buildSliceContextPacket(
  workDir: string,
  session: Session,
  slice: Slice,
): Promise<string> {
  const directPaths = uniquePaths(slice.manifest.fileContracts.map((contract) => contract.path));
  const requiredTestPaths = uniquePaths(
    slice.testLock.requiredTests.map((requirement) => requirement.testFile),
  );
  const dependentPaths = uniquePaths([
    ...slice.impactAnalysis.dependentFiles,
    ...slice.manifest.fileContracts.flatMap((contract) => contract.dependents ?? []),
    ...slice.manifest.exportContracts.flatMap((contract) => contract.consumers),
  ]).filter((path) => !directPaths.includes(path) && !requiredTestPaths.includes(path));
  const importedTargets = await collectDirectImportedTargets(workDir, directPaths);

  const directPackets = await Promise.all(
    directPaths
      .slice(0, MAX_DIRECT_FILE_COUNT)
      .map(async (path) =>
        buildFullFilePacket(workDir, path, 'direct file', MAX_DIRECT_FILE_CHARS),
      ),
  );
  const testPackets = await Promise.all(
    requiredTestPaths
      .slice(0, MAX_REQUIRED_TEST_FILE_COUNT)
      .map(async (path) =>
        buildFullFilePacket(workDir, path, 'required test', MAX_TEST_FILE_CHARS),
      ),
  );
  const dependentExcerpts = await Promise.all(
    dependentPaths
      .slice(0, MAX_DEPENDENT_EXCERPT_COUNT)
      .map(async (path) =>
        buildDependentExcerpt(workDir, path, collectFocusTerms(slice, directPaths)),
      ),
  );
  const importedSignaturePackets = await buildImportedSignaturePackets(workDir, importedTargets);
  const { packets: schemaPackets, omittedSchemaCount } = await buildRelevantSchemaPackets(
    workDir,
    directPaths,
    importedTargets,
  );
  const verificationCommands = await buildSliceVerificationCommandPacket(workDir, session, {
    typecheckScopeEntries: directPaths,
    formatScopeEntries: getSliceVerificationScopeEntries(slice),
    requiredTestFiles: requiredTestPaths,
    regressionTestFiles: slice.testLock.regressionSuite,
  });
  const relevantDocs = selectRelevantInstructionDocs(
    session.promptContext?.instructionDocs ?? [],
    directPaths,
  );
  const relevantWorkItemDocs = selectRelevantWorkItemDocs(session);

  const sections: string[] = [
    '## SLICE CONTEXT PACKET',
    'HELIX preloaded the highest-signal files for this slice so implementation can start from evidence instead of rediscovery.',
  ];

  if (relevantDocs.length > 0) {
    sections.push(renderRelevantDocsSection(relevantDocs));
  }

  if (relevantWorkItemDocs.length > 0) {
    sections.push(renderWorkItemDocsSection(relevantWorkItemDocs));
  }

  sections.push(renderAcceptanceObligationsSection(slice, session));

  sections.push(
    renderFullFileSection(
      'Direct Files (full source)',
      directPackets,
      directPaths.length - directPackets.length,
    ),
  );
  sections.push(renderVerificationCommandSection(verificationCommands));
  sections.push(renderSchemaSection(schemaPackets, omittedSchemaCount));
  sections.push(
    renderFullFileSection(
      'Required Tests (full source)',
      testPackets,
      requiredTestPaths.length - testPackets.length,
    ),
  );
  sections.push(
    renderDependentExcerptSection(
      dependentExcerpts.filter((entry): entry is DependentExcerpt => entry != null),
      dependentPaths.length - dependentExcerpts.length,
    ),
  );
  sections.push(renderImportedSignatureSection(importedSignaturePackets));

  return trimPacketToBudget(sections.filter(Boolean).join('\n\n'), MAX_SLICE_CONTEXT_PACKET_BYTES);
}

export async function buildSliceArchitectureReviewPacket(
  workDir: string,
  session: Session,
  slice: Slice,
  workspaceState: ArchitectureReviewWorkspaceSnapshot,
): Promise<string> {
  const contextPacket = await buildSliceContextPacket(workDir, session, slice);
  const sections = [
    '## ARCHITECTURE REVIEW PACKET',
    'HELIX preloaded the current slice workspace, proof results, and highest-signal source files so architecture review can verify the implementation without rediscovering the repo.',
    '',
    renderArchitectureProofSection(slice),
    renderArchitectureWorkspaceSection(workspaceState),
    contextPacket,
  ];

  return trimPacketToBudget(
    sections.filter(Boolean).join('\n\n'),
    MAX_ARCHITECTURE_REVIEW_PACKET_BYTES,
  );
}

async function buildFullFilePacket(
  workDir: string,
  repoPath: string,
  title: string,
  maxChars: number,
): Promise<FilePacket> {
  const absolutePath = resolve(workDir, repoPath);
  const exists = await pathExists(absolutePath);
  if (!exists) {
    return {
      path: repoPath,
      title,
      body: '_File does not exist in the workspace yet._',
    };
  }

  const content = await safeReadText(absolutePath);
  if (!content.trim()) {
    return {
      path: repoPath,
      title,
      body: '_File is empty._',
    };
  }

  return {
    path: repoPath,
    title,
    body: renderCodeBlock(repoPath, truncateForPrompt(content, maxChars)),
  };
}

async function buildDependentExcerpt(
  workDir: string,
  repoPath: string,
  focusTerms: string[],
): Promise<DependentExcerpt | undefined> {
  const absolutePath = resolve(workDir, repoPath);
  if (!(await pathExists(absolutePath))) {
    return undefined;
  }

  const content = await safeReadText(absolutePath);
  if (!content.trim()) {
    return undefined;
  }

  const lines = content.split('\n');
  const normalizedTerms = focusTerms.filter(Boolean);
  const matchIndex = findRelevantLineIndex(lines, normalizedTerms);
  const excerpt = renderLineWindow(lines, matchIndex, MAX_DEPENDENT_EXCERPT_CHARS);
  if (!excerpt) {
    return undefined;
  }

  return {
    path: repoPath,
    reason:
      matchIndex >= 0
        ? `Includes the nearest consumer/import site for ${normalizedTerms[0] ?? basename(repoPath)}`
        : 'Includes the top of the dependent file because no direct import/export match was found',
    excerpt,
  };
}

function collectFocusTerms(slice: Slice, directPaths: string[]): string[] {
  const terms = new Set<string>();
  for (const directPath of directPaths) {
    terms.add(basename(directPath));
    terms.add(stripExtension(basename(directPath)));
  }
  for (const contract of slice.manifest.fileContracts) {
    for (const exportName of contract.expectedExports ?? []) {
      terms.add(exportName);
    }
  }
  for (const exportContract of slice.manifest.exportContracts) {
    terms.add(exportContract.exportName);
  }
  return [...terms].filter((term) => term.trim().length > 0);
}

function selectRelevantInstructionDocs(
  docs: PromptContextDocument[],
  directPaths: string[],
): PromptContextDocument[] {
  const packageRoots = new Set(
    directPaths
      .map((path) => path.match(/^((?:packages|apps)\/[^/]+)/)?.[1])
      .filter((path): path is string => Boolean(path)),
  );

  return docs
    .filter((doc) => {
      for (const packageRoot of packageRoots) {
        if (normalizeRepoPath(doc.path).startsWith(`${packageRoot}/`)) {
          return true;
        }
      }
      return false;
    })
    .slice(0, MAX_RELEVANT_DOCS);
}

function renderRelevantDocsSection(docs: PromptContextDocument[]): string {
  const rendered = docs
    .map(
      (doc) => `### ${doc.path}\n${truncateForPrompt(doc.excerpt.trim(), MAX_RELEVANT_DOC_CHARS)}`,
    )
    .join('\n\n');
  return `### Relevant Package Instructions\n${rendered}`;
}

function selectRelevantWorkItemDocs(session: Session): PromptContextDocument[] {
  return [
    session.promptContext?.featureSpecDoc,
    session.promptContext?.testSpecDoc,
    session.promptContext?.hldSpecDoc,
    session.promptContext?.lldPlanDoc,
  ].filter((doc): doc is PromptContextDocument => Boolean(doc));
}

function renderWorkItemDocsSection(docs: PromptContextDocument[]): string {
  const rendered = docs
    .map(
      (doc) =>
        `### ${doc.title}\nSource: ${doc.path}\n${truncateForPrompt(doc.excerpt.trim(), MAX_RELEVANT_DOC_CHARS)}`,
    )
    .join('\n\n');
  return `### Work Item Design Inputs\n${rendered}`;
}

function renderAcceptanceObligationsSection(slice: Slice, session: Session): string {
  const sliceFindings = session.findings.filter((finding) => slice.findings.includes(finding.id));
  const activeFindings = sliceFindings.filter(
    (finding) =>
      finding.horizon == null || finding.horizon === 'immediate' || finding.horizon === 'next',
  );
  const categories = new Set(activeFindings.map((finding) => finding.category));
  const directPaths = uniquePaths(slice.manifest.fileContracts.map((contract) => contract.path));
  const routeOrApiTouched = directPaths.some(
    (path) =>
      path.includes('/app/api/') ||
      path.includes('/routes/') ||
      path.includes('middleware') ||
      path.includes('auth'),
  );
  const schemaOrModelTouched = directPaths.some(
    (path) =>
      path.includes('.schema.') ||
      path.includes('/models/') ||
      path.includes('/repos/') ||
      path.includes('validation'),
  );

  const obligations = [
    '- Discharge every immediate/next finding at the shared seam, not only in the nearest caller.',
    '- For every changed invariant or contract, prove at least one happy-path and one negative-path regression.',
  ];

  if (categories.has('missing-test') || slice.testLock.requiredTests.length > 0) {
    obligations.push(
      '- Required tests are minimum coverage. Add missing negative, integration, or E2E proof when needed to show the invariant actually holds.',
    );
  }

  if (routeOrApiTouched || categories.has('security') || categories.has('isolation')) {
    obligations.push(
      '- Verify auth, tenant/project/user isolation, and middleware-chain behavior through the public boundary. Missing negative authorization/isolation proof keeps the slice incomplete.',
    );
  }

  if (schemaOrModelTouched || categories.has('bug') || categories.has('security')) {
    obligations.push(
      '- If validation, schema, repo, or model contracts are involved, prove the invariant at the persistence/contract layer as well as the service/route layer.',
    );
  }

  if (
    slice.manifest.exportContracts.length > 0 ||
    slice.impactAnalysis.dependentFiles.length > 0 ||
    categories.has('wiring-gap')
  ) {
    obligations.push(
      '- Verify export/import wiring and downstream consumers. Local proof is insufficient if dependents or exported contracts remain partially wired.',
    );
  }

  if ((session.replayContext?.changedFiles?.length ?? 0) > 0) {
    obligations.push(
      `- Historical replay seam obligations: ${session.replayContext?.changedFiles?.join(', ')}. Missing target seam files must either be updated or explicitly justified before replay can be called successful.`,
    );
  }

  return `### Invariant, Coverage, and Acceptance Obligations\n${obligations.join('\n')}`;
}

function renderFullFileSection(title: string, packets: FilePacket[], omittedCount: number): string {
  if (packets.length === 0) {
    return `### ${title}\n(None preloaded)`;
  }

  const blocks = packets
    .map((packet) => `#### ${packet.path} (${packet.title})\n${packet.body}`)
    .join('\n\n');
  const omittedNote =
    omittedCount > 0
      ? `\n\n- Omitted ${omittedCount} additional file(s) to keep the slice packet compact.`
      : '';
  return `### ${title}\n${blocks}${omittedNote}`;
}

function renderDependentExcerptSection(excerpts: DependentExcerpt[], omittedCount: number): string {
  if (excerpts.length === 0) {
    return '### Dependent Excerpts\n(None preloaded)';
  }

  const blocks = excerpts
    .map(
      (excerpt) =>
        `#### ${excerpt.path}\n- Why this is here: ${excerpt.reason}\n${renderCodeBlock(excerpt.path, excerpt.excerpt)}`,
    )
    .join('\n\n');
  const omittedNote =
    omittedCount > 0
      ? `\n\n- Omitted ${omittedCount} additional dependent excerpt(s) to stay within the prompt budget.`
      : '';
  return `### Dependent Excerpts\n${blocks}${omittedNote}`;
}

function renderVerificationCommandSection(commands: SliceVerificationCommandPacket): string {
  const lines = [
    '### Verification Commands',
    '- Treat these commands as the authoritative minimal proof set for this slice. Do not widen them unless a command fails and you can explain the missing contract.',
    '- Once these commands are green, stop and hand control back to HELIX instead of spending extra turns on status sweeps, line numbers, or generated-file cleanup.',
    '- Run the build/typecheck command before any test command.',
    `- Build / typecheck: \`${commands.buildOrTypecheckCommand}\``,
    `- Format / prettier: \`${commands.formatCommand}\``,
  ];

  if (commands.requiredTestCommand) {
    lines.push(`- Required tests: \`${commands.requiredTestCommand}\``);
  }

  if (commands.regressionCommand) {
    lines.push(`- Regression suite: \`${commands.regressionCommand}\``);
  }

  if (commands.combinedTestLockCommand) {
    lines.push(`- Combined test lock: \`${commands.combinedTestLockCommand}\``);
  }

  return lines.join('\n');
}

function renderArchitectureProofSection(slice: Slice): string {
  const relevantCriteria = slice.exitCriteria.filter((criterion) =>
    ['typecheck', 'lint', 'test-lock', 'impact-reviewed', 'exports-wired'].includes(criterion.type),
  );
  const lines = ['### Verified Proof Status'];

  if (relevantCriteria.length === 0) {
    lines.push('- No deterministic proof checks have been recorded yet.');
    return lines.join('\n');
  }

  for (const criterion of relevantCriteria) {
    const status = criterion.passed ? 'PASS' : 'FAIL';
    const detail = criterion.detail ? ` — ${criterion.detail}` : '';
    lines.push(`- ${criterion.id}: ${status}${detail}`);
  }

  return lines.join('\n');
}

function renderArchitectureWorkspaceSection(
  workspaceState: ArchitectureReviewWorkspaceSnapshot,
): string {
  const lines = ['### Workspace Review Snapshot'];

  lines.push(
    `- Actual changed files (${workspaceState.actualChangedFiles.length}): ${
      workspaceState.actualChangedFiles.length > 0
        ? workspaceState.actualChangedFiles.join(', ')
        : '(none)'
    }`,
  );
  lines.push(
    `- Ignored tool-owned noise (${workspaceState.ignoredOutOfScopeChanges.length}): ${
      workspaceState.ignoredOutOfScopeChanges.length > 0
        ? workspaceState.ignoredOutOfScopeChanges.join(', ')
        : '(none)'
    }`,
  );
  lines.push(
    `- Out-of-scope changes (${workspaceState.outOfScopeChanges.length}): ${
      workspaceState.outOfScopeChanges.length > 0
        ? workspaceState.outOfScopeChanges.join(', ')
        : '(none)'
    }`,
  );
  lines.push(
    `- Review scope entries (${workspaceState.reviewScopeEntries.length}): ${
      workspaceState.reviewScopeEntries.length > 0
        ? workspaceState.reviewScopeEntries.join(', ')
        : '(none)'
    }`,
  );
  if (workspaceState.workspaceReconcileSummary?.trim()) {
    lines.push(`- Workspace reconcile summary: ${workspaceState.workspaceReconcileSummary.trim()}`);
  }
  lines.push('- Changed diff stat:');
  lines.push(workspaceState.diffStat?.trim() ? workspaceState.diffStat.trim() : '(unavailable)');

  return lines.join('\n');
}

async function collectDirectImportedTargets(
  workDir: string,
  directPaths: string[],
): Promise<string[]> {
  if (directPaths.length === 0) {
    return [];
  }

  const repoIndexScopes = uniquePaths(directPaths.map((path) => dirname(path)));
  const { repoIndex } = await loadScopedRepoIndex(workDir, repoIndexScopes);
  return uniquePaths(
    directPaths.flatMap((path) => repoIndex.filesByPath.get(path)?.importedTargets ?? []),
  )
    .filter((path) => !directPaths.includes(path))
    .filter((path) => !isTestFile(path));
}

async function buildImportedSignaturePackets(
  workDir: string,
  importedTargets: string[],
): Promise<ImportedSignaturePacket[]> {
  if (importedTargets.length === 0) {
    return [];
  }

  const packets = await Promise.all(
    importedTargets.slice(0, MAX_IMPORTED_SIGNATURE_FILE_COUNT).map(async (path) => {
      const content = await safeReadText(resolve(workDir, path));
      if (!content.trim()) {
        return undefined;
      }

      const allSignatures = Object.entries(extractExportSignatures(path, content));
      if (allSignatures.length === 0) {
        return undefined;
      }

      const signatures = allSignatures
        .slice(0, MAX_SIGNATURES_PER_FILE)
        .map(([exportName, signature]) => ({
          exportName,
          signature,
        }));

      return {
        path,
        signatures,
        omittedSignatureCount: Math.max(0, allSignatures.length - signatures.length),
      };
    }),
  );

  return packets.filter((packet): packet is ImportedSignaturePacket => packet != null);
}

async function buildRelevantSchemaPackets(
  workDir: string,
  directPaths: string[],
  importedTargets: string[],
): Promise<{ packets: SchemaPacket[]; omittedSchemaCount: number }> {
  const candidatePaths = uniquePaths([...directPaths, ...importedTargets]).slice(
    0,
    MAX_SCHEMA_CONTEXT_FILE_COUNT,
  );
  if (candidatePaths.length === 0) {
    return {
      packets: [],
      omittedSchemaCount: 0,
    };
  }

  const intelligence = new RepoIntelligenceService({ workDir });
  const schemaResults = await Promise.all(
    candidatePaths.map(async (filePath) =>
      intelligence.getSchemaInfo({ filePath, limit: MAX_SCHEMA_COUNT }),
    ),
  );
  const packets = uniqueSchemaPackets(
    schemaResults
      .flatMap((result) => result.schemas)
      .map((schema) => ({
        filePath: schema.filePath,
        symbol: schema.symbol,
        schemaKind: schema.schemaKind,
        summary: truncateForPrompt(schema.summary, MAX_SCHEMA_SUMMARY_CHARS),
        fields: schema.fields.slice(0, MAX_SCHEMA_FIELDS),
        omittedFieldCount: Math.max(0, schema.fields.length - MAX_SCHEMA_FIELDS),
      })),
  );

  return {
    packets: packets.slice(0, MAX_SCHEMA_COUNT),
    omittedSchemaCount: Math.max(0, packets.length - MAX_SCHEMA_COUNT),
  };
}

function renderImportedSignatureSection(packets: ImportedSignaturePacket[]): string {
  if (packets.length === 0) {
    return '### Imported Signatures\n(None preloaded)';
  }

  const blocks = packets
    .map((packet) => {
      const signatureLines = packet.signatures
        .map((entry) => `- ${entry.exportName}: ${entry.signature}`)
        .join('\n');
      const omittedNote =
        packet.omittedSignatureCount > 0
          ? `\n- Omitted ${packet.omittedSignatureCount} additional export signature(s) for compactness.`
          : '';
      return `#### ${packet.path}\n${signatureLines}${omittedNote}`;
    })
    .join('\n\n');

  return `### Imported Signatures\n${blocks}`;
}

function renderSchemaSection(packets: SchemaPacket[], omittedSchemaCount: number): string {
  if (packets.length === 0) {
    return '### Relevant Schemas and Validation Contracts\n(None preloaded)';
  }

  const blocks = packets
    .map((packet) => {
      const fields =
        packet.fields.length > 0
          ? packet.fields.map((field) => `  ${formatSchemaField(field)}`).join('\n')
          : '  - No top-level fields extracted.';
      const omittedFieldNote =
        packet.omittedFieldCount > 0
          ? `\n  - Omitted ${packet.omittedFieldCount} additional field(s) for compactness.`
          : '';
      return [
        `#### ${packet.filePath} :: ${packet.symbol}`,
        `- Kind: ${packet.schemaKind}`,
        `- Summary: ${packet.summary}`,
        '- Key fields:',
        fields,
        omittedFieldNote,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  const omittedSchemaNote =
    omittedSchemaCount > 0
      ? `\n\n- Omitted ${omittedSchemaCount} additional schema contract(s) to stay within the prompt budget.`
      : '';

  return `### Relevant Schemas and Validation Contracts\n${blocks}${omittedSchemaNote}`;
}

function renderCodeBlock(path: string, content: string): string {
  const ext = extname(path).replace(/^\./, '');
  const language = ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx' ? ext : 'text';
  return ['```' + language, content.trimEnd(), '```'].join('\n');
}

function formatSchemaField(field: RepoSchemaField): string {
  const qualifiers: string[] = [];
  qualifiers.push(field.required ? 'required' : 'optional');
  if (field.nullable) {
    qualifiers.push('nullable');
  }
  if (field.defaultValue) {
    qualifiers.push(`default ${field.defaultValue}`);
  }
  if ((field.enumValues?.length ?? 0) > 0) {
    qualifiers.push(`enum ${field.enumValues?.join(', ')}`);
  }

  return `- ${field.name}: ${field.type}${qualifiers.length > 0 ? ` (${qualifiers.join('; ')})` : ''}`;
}

function findRelevantLineIndex(lines: string[], focusTerms: string[]): number {
  if (focusTerms.length === 0) {
    return -1;
  }

  const lowerTerms = focusTerms.map((term) => term.toLowerCase());
  return lines.findIndex((line) => {
    const lowerLine = line.toLowerCase();
    return lowerTerms.some((term) => lowerLine.includes(term));
  });
}

function renderLineWindow(
  lines: string[],
  matchIndex: number,
  maxChars: number,
): string | undefined {
  const safeMatchIndex = matchIndex >= 0 ? matchIndex : 0;
  const start = Math.max(0, safeMatchIndex - DEPENDENT_EXCERPT_BEFORE_LINES);
  const end = Math.min(lines.length, safeMatchIndex + DEPENDENT_EXCERPT_AFTER_LINES + 1);
  const window = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join('\n')
    .trim();

  if (!window) {
    return undefined;
  }

  return truncateForPrompt(window, maxChars);
}

function trimPacketToBudget(packet: string, maxBytes: number): string {
  if (utf8Bytes(packet) <= maxBytes) {
    return packet;
  }

  const note =
    '\n\n_...[HELIX compacted the slice context packet to stay within the prompt budget. Use workspace tools for any omitted detail.]_';
  const availableBytes = Math.max(0, maxBytes - utf8Bytes(note));
  let trimmed = packet;
  while (utf8Bytes(trimmed) > availableBytes && trimmed.length > 0) {
    trimmed = trimmed.slice(0, Math.max(0, trimmed.length - 512));
  }
  return `${trimmed.trimEnd()}${note}`;
}

function truncateForPrompt(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, Math.max(0, maxChars - 98)).trimEnd()}\n...[truncated by HELIX for prompt compactness]`;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalizedPaths: string[] = [];
  for (const path of paths) {
    const normalized = normalizeRepoPath(path);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedPaths.push(normalized);
  }
  return normalizedPaths;
}

function stripExtension(fileName: string): string {
  const extension = extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function uniqueSchemaPackets(packets: SchemaPacket[]): SchemaPacket[] {
  const seen = new Set<string>();
  const unique: SchemaPacket[] = [];
  for (const packet of packets) {
    const key = `${packet.filePath}::${packet.symbol}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(packet);
  }
  return unique;
}

/**
 * Filesystem loader for the concerns registry.
 *
 * Reads `.helix/concerns/<tier>/*.yaml`, validates each file against the
 * zod schema, and produces a typed registry keyed by concern id.
 *
 * This loader is intentionally standalone. It is not wired into the
 * pipeline engine or quality gate yet — those integrations happen in later
 * steps of the audit+autonomy plan.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { concernFileSchema, type ConcernDetectorRaw, type ConcernFileRaw } from './schema.js';
import type {
  Concern,
  ConcernDetector,
  ConcernLoadError,
  ConcernLoadResult,
  ConcernsRegistry,
} from './types.js';

const ENFORCED_DIR = 'enforced';
const ADVISORY_DIR = 'advisory';

export interface ConcernsLoaderOptions {
  /**
   * Repo root. Relative `rootDir` is resolved against this. Defaults to cwd.
   */
  readonly repoRoot?: string;
  /**
   * Concerns root directory. Defaults to `.helix/concerns` relative to repoRoot.
   */
  readonly rootDir?: string;
}

function toDetector(raw: ConcernDetectorRaw): ConcernDetector {
  const base = {
    id: raw.id,
    kind: raw.kind,
    severity: raw.severity,
    message: raw.message,
    fixHint: raw.fix_hint,
  };

  switch (raw.kind) {
    case 'grep':
      return {
        ...base,
        kind: 'grep',
        pattern: raw.pattern,
        glob: raw.glob,
        multiline: raw.multiline,
      };
    case 'ast':
      return { ...base, kind: 'ast', query: raw.query, assertion: raw.assertion };
    case 'symbol-ref':
      return {
        ...base,
        kind: 'symbol-ref',
        symbol: raw.symbol,
        assertion: raw.assertion,
      };
    case 'route':
      return {
        ...base,
        kind: 'route',
        routePattern: raw.route_pattern,
        assertion: raw.assertion,
        glob: raw.glob,
      };
    case 'schema':
      return {
        ...base,
        kind: 'schema',
        schemaName: raw.schema_name,
        assertion: raw.assertion,
      };
    case 'impacted-test':
      return { ...base, kind: 'impacted-test', assertion: raw.assertion };
    case 'script':
      return { ...base, kind: 'script', script: raw.script };
    case 'model-review':
      return {
        ...base,
        kind: 'model-review',
        guidanceRef: raw.guidance_ref,
        outputSchema: {
          ruleId: raw.output_schema.rule_id,
          severity: raw.output_schema.severity,
          location: raw.output_schema.location,
          claim: raw.output_schema.claim,
          reality: raw.output_schema.reality,
          options: raw.output_schema.options,
        },
      };
  }
}

function toConcern(raw: ConcernFileRaw, sourcePath: string): Concern {
  return {
    id: raw.id,
    title: raw.title,
    enforcement: raw.enforcement,
    severityDefault: raw.severity_default,
    rubricConcern: raw.rubric_concern as Concern['rubricConcern'],
    protects: raw.protects,
    reviewWhen: raw.review_when,
    reviewQuestions: raw.review_questions,
    proofExpected: raw.proof_expected,
    scope: {
      globs: raw.scope.globs,
      exclude: raw.scope.exclude,
    },
    references: raw.references
      ? {
          docs: raw.references.docs,
          tests: raw.references.tests,
          relatedConcerns: raw.references.related_concerns,
        }
      : undefined,
    detectors: raw.detectors.map(toDetector),
    stageHooks: raw.stage_hooks?.map((hook) => ({
      stage: hook.stage,
      injectChecklist: hook.inject_checklist,
      asReviewLens: hook.as_review_lens,
    })),
    acceptance: raw.acceptance?.map((entry) => ({
      when: entry.when,
      requires: entry.requires,
    })),
    sourcePath,
  };
}

async function readYamlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    const stats = await stat(full);
    if (!stats.isFile()) continue;
    const ext = extname(entry);
    if (ext !== '.yaml' && ext !== '.yml') continue;
    files.push(full);
  }
  return files;
}

async function loadSingle(filePath: string, errors: ConcernLoadError[]): Promise<Concern | null> {
  const body = await readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch (err) {
    errors.push({
      sourcePath: filePath,
      message: `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return null;
  }

  const result = concernFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    errors.push({ sourcePath: filePath, message: `schema validation failed: ${issues}` });
    return null;
  }

  const raw = result.data;
  const filename = basename(filePath, extname(filePath));
  if (raw.id !== filename) {
    errors.push({
      sourcePath: filePath,
      message: `id "${raw.id}" does not match filename "${filename}"`,
    });
    return null;
  }

  return toConcern(raw, filePath);
}

export async function loadConcernsRegistry(
  options: ConcernsLoaderOptions = {},
): Promise<ConcernLoadResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const rootDir = options.rootDir
    ? isAbsolute(options.rootDir)
      ? options.rootDir
      : resolve(repoRoot, options.rootDir)
    : resolve(repoRoot, '.helix/concerns');

  const enforcedDir = join(rootDir, ENFORCED_DIR);
  const advisoryDir = join(rootDir, ADVISORY_DIR);

  const errors: ConcernLoadError[] = [];
  const byId = new Map<string, Concern>();
  const enforced: Concern[] = [];
  const advisory: Concern[] = [];

  const [enforcedFiles, advisoryFiles] = await Promise.all([
    readYamlFiles(enforcedDir),
    readYamlFiles(advisoryDir),
  ]);

  for (const filePath of enforcedFiles) {
    const concern = await loadSingle(filePath, errors);
    if (!concern) continue;
    if (concern.enforcement !== 'blocking') {
      errors.push({
        sourcePath: filePath,
        message: `enforced/ directory requires enforcement: blocking (got "${concern.enforcement}")`,
      });
      continue;
    }
    if (byId.has(concern.id)) {
      errors.push({
        sourcePath: filePath,
        message: `duplicate concern id "${concern.id}" (also defined in ${byId.get(concern.id)!.sourcePath})`,
      });
      continue;
    }
    byId.set(concern.id, concern);
    enforced.push(concern);
  }

  for (const filePath of advisoryFiles) {
    const concern = await loadSingle(filePath, errors);
    if (!concern) continue;
    if (concern.enforcement !== 'advisory') {
      errors.push({
        sourcePath: filePath,
        message: `advisory/ directory requires enforcement: advisory (got "${concern.enforcement}")`,
      });
      continue;
    }
    if (byId.has(concern.id)) {
      errors.push({
        sourcePath: filePath,
        message: `duplicate concern id "${concern.id}" (also defined in ${byId.get(concern.id)!.sourcePath})`,
      });
      continue;
    }
    byId.set(concern.id, concern);
    advisory.push(concern);
  }

  const all = [...enforced, ...advisory];
  const registry: ConcernsRegistry = { byId, enforced, advisory, all };

  return { registry, errors };
}

export type { ConcernLoadResult, ConcernsRegistry };

/**
 * Vocabulary Layer Disassembler — converts exported vocabulary files back into StagedRecord[].
 *
 * Handles domain vocabularies (array file), lookup tables (per-table array files),
 * canonical schemas (per-file), and facts (array file).
 *
 * Vocabulary/SearchAI records are exported by source IDs. Preserve those IDs in
 * temp fields so the staged cross-reference resolver can remap them when the
 * matching knowledge bases are imported into a new project.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import {
  safeParseJSON,
  safeParseJSONArray,
  injectOwnership,
  buildRecord,
  buildSuperseded,
  buildMatchingSuperseded,
  extractNameFromPath,
} from './disassembler-utils.js';

const log = createLogger('vocabulary-disassembler');

// ─── Collections ──────────────────────────────────────────────────────────

const DOMAIN_VOCABULARIES = 'domain_vocabularies';
const LOOKUP_ENTRIES = 'lookup_entries';
const CANONICAL_SCHEMAS = 'canonical_schemas';
const FACTS = 'facts';

// ─── Path Patterns ────────────────────────────────────────────────────────

const DOMAIN_VOCAB_PATH = 'vocabulary/domain-vocabulary.json';
const LOOKUP_PATTERN = /^vocabulary\/lookup-tables\/([^/]+)\.lookup\.json$/;
const SCHEMA_PATTERN = /^vocabulary\/schemas\/([^/]+)\.schema\.json$/;
const FACTS_PATH = 'vocabulary/facts.json';

// ─── Disassembler ─────────────────────────────────────────────────────────

export class VocabularyDisassembler implements LayerDisassembler {
  readonly layer = 'vocabulary' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: DisassembleResult['records'] = [];
    const superseded: DisassembleResult['superseded'] = [];
    const warnings: string[] = [];
    const ownership = {
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    };

    // ── PHASE 1: Parse domain vocabularies (array file) ─────────────────

    const vocabContent = ctx.files.get(DOMAIN_VOCAB_PATH);
    if (vocabContent) {
      const vocabs = safeParseJSONArray(DOMAIN_VOCAB_PATH, vocabContent, warnings);
      for (const vocab of vocabs) {
        if (typeof vocab.projectKnowledgeBaseId === 'string') {
          vocab._vocabularyKnowledgeBaseId = vocab.projectKnowledgeBaseId;
        }
        const data = injectOwnership(vocab, ownership);
        records.push(buildRecord('vocabulary', DOMAIN_VOCABULARIES, data));
      }
    }

    // ── PHASE 2: Parse lookup tables (per-table array files) ────────────

    for (const [filePath, content] of ctx.files) {
      const match = filePath.match(LOOKUP_PATTERN);
      if (!match) continue;

      const tableName = extractNameFromPath(filePath, '.lookup.json') ?? match[1];
      const entries = safeParseJSONArray(filePath, content, warnings);

      for (const entry of entries) {
        // Ensure tableName is set on each entry
        entry.tableName = tableName;
        const data = injectOwnership(entry, ownership);
        records.push(buildRecord('vocabulary', LOOKUP_ENTRIES, data));
      }
    }

    // ── PHASE 3: Parse canonical schemas ────────────────────────────────

    for (const [filePath, content] of ctx.files) {
      const match = filePath.match(SCHEMA_PATTERN);
      if (!match) continue;

      const parsed = safeParseJSON(filePath, content, warnings);
      if (!parsed) continue;

      if (typeof parsed.knowledgeBaseId === 'string') {
        parsed._schemaKnowledgeBaseId = parsed.knowledgeBaseId;
      }
      const data = injectOwnership(parsed, ownership);
      records.push(buildRecord('vocabulary', CANONICAL_SCHEMAS, data));
    }

    // ── PHASE 4: Parse facts (array file) ───────────────────────────────

    const factsContent = ctx.files.get(FACTS_PATH);
    if (factsContent) {
      const facts = safeParseJSONArray(FACTS_PATH, factsContent, warnings);
      for (const fact of facts) {
        // Ensure project scope (assembler filters by scope: 'project')
        fact.scope = 'project';
        const data = injectOwnership(fact, ownership);
        records.push(buildRecord('vocabulary', FACTS, data));
      }
    }

    // ── Superseded records ──────────────────────────────────────────────

    if (ctx.conflictStrategy === 'replace' && ctx.existingRecordIds) {
      superseded.push(
        ...buildSuperseded(
          'vocabulary',
          DOMAIN_VOCABULARIES,
          ctx.existingRecordIds.get(DOMAIN_VOCABULARIES),
        ),
      );
      superseded.push(
        ...buildSuperseded('vocabulary', LOOKUP_ENTRIES, ctx.existingRecordIds.get(LOOKUP_ENTRIES)),
      );
      superseded.push(
        ...buildSuperseded(
          'vocabulary',
          CANONICAL_SCHEMAS,
          ctx.existingRecordIds.get(CANONICAL_SCHEMAS),
        ),
      );
      superseded.push(...buildSuperseded('vocabulary', FACTS, ctx.existingRecordIds.get(FACTS)));
    } else if (ctx.conflictStrategy === 'merge' && ctx.existingRecordIds) {
      superseded.push(
        ...buildMatchingSuperseded(
          'vocabulary',
          DOMAIN_VOCABULARIES,
          ctx.existingRecordIds.get(DOMAIN_VOCABULARIES),
          records.filter((record) => record.collection === DOMAIN_VOCABULARIES),
          'projectKnowledgeBaseId',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'vocabulary',
          LOOKUP_ENTRIES,
          ctx.existingRecordIds.get(LOOKUP_ENTRIES),
          records.filter((record) => record.collection === LOOKUP_ENTRIES),
          ['tableName', 'key'],
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'vocabulary',
          CANONICAL_SCHEMAS,
          ctx.existingRecordIds.get(CANONICAL_SCHEMAS),
          records.filter((record) => record.collection === CANONICAL_SCHEMAS),
          'knowledgeBaseId',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'vocabulary',
          FACTS,
          ctx.existingRecordIds.get(FACTS),
          records.filter((record) => record.collection === FACTS),
          ['scope', 'key'],
        ),
      );
    }

    log.info('Vocabulary layer disassembled', {
      projectId: ctx.projectId,
      vocabularies: records.filter((r) => r.collection === DOMAIN_VOCABULARIES).length,
      lookupEntries: records.filter((r) => r.collection === LOOKUP_ENTRIES).length,
      schemas: records.filter((r) => r.collection === CANONICAL_SCHEMAS).length,
      facts: records.filter((r) => r.collection === FACTS).length,
    });

    return { records, superseded, warnings };
  }
}

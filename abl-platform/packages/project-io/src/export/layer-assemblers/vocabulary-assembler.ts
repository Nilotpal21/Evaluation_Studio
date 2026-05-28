import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  KnowledgeBase,
  DomainVocabulary,
  LookupEntry,
  CanonicalSchema,
  Fact,
} from '@agent-platform/database/models';
import { sanitizeName, stripInternalFields } from './assembler-utils.js';
import { assignCollisionSafePath } from '../folder-builder.js';

const log = createLogger('vocabulary-assembler');

export class VocabularyAssembler implements LayerAssembler {
  readonly layer = 'vocabulary' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    let entityCount = 0;

    const knowledgeBases = await KnowledgeBase.find({ projectId, tenantId }).lean().select('_id');
    const knowledgeBaseIds = knowledgeBases.map((kb: Record<string, unknown>) => String(kb._id));

    const [vocabularies, lookupEntries, schemas, facts] = await Promise.all([
      knowledgeBaseIds.length > 0
        ? DomainVocabulary.find({
            tenantId,
            projectKnowledgeBaseId: { $in: knowledgeBaseIds },
          })
            .lean()
            .select('projectKnowledgeBaseId version status entries')
        : Promise.resolve([]),
      LookupEntry.find({ projectId, tenantId }).lean().select('tableName value field metadata'),
      knowledgeBaseIds.length > 0
        ? CanonicalSchema.find({ tenantId, knowledgeBaseId: { $in: knowledgeBaseIds } })
            .lean()
            .select('knowledgeBaseId version fields status')
        : Promise.resolve([]),
      Fact.find({ projectId, tenantId, scope: 'project' })
        .lean()
        .select('key value sourceType sourceAgentName expiresAt metadata'),
    ]);

    // Domain vocabularies
    if (vocabularies.length > 0) {
      const cleanVocabs = vocabularies.map((v: Record<string, unknown>) => {
        const clean = stripInternalFields(v as unknown as Record<string, unknown>);
        return clean;
      });
      files.set('vocabulary/domain-vocabulary.json', JSON.stringify(cleanVocabs, null, 2));
      entityCount += vocabularies.length;
    }

    // Lookup entries grouped by table name
    const lookupTables = new Map<string, Record<string, unknown>[]>();
    for (const entry of lookupEntries) {
      const tableName = entry.tableName;
      if (!lookupTables.has(tableName)) {
        lookupTables.set(tableName, []);
      }
      const clean = stripInternalFields(entry as unknown as Record<string, unknown>);
      lookupTables.get(tableName)!.push(clean);
      entityCount++;
    }

    for (const [tableName, entries] of lookupTables) {
      const safeName = sanitizeName(tableName);
      const path = assignCollisionSafePath(
        `vocabulary/lookup-tables/${safeName}.lookup.json`,
        files,
      );
      files.set(path, JSON.stringify(entries, null, 2));
    }

    // Canonical schemas
    for (const schema of schemas) {
      const clean = stripInternalFields(schema as unknown as Record<string, unknown>);
      const schemaName = sanitizeName(schema.knowledgeBaseId);
      const path = assignCollisionSafePath(`vocabulary/schemas/${schemaName}.schema.json`, files);
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    // Project-scoped facts (exclude user-scoped)
    if (facts.length > 0) {
      const cleanFacts = facts.map((f: Record<string, unknown>) => {
        const clean = stripInternalFields(f as unknown as Record<string, unknown>);
        // Strip user-identifying fields
        delete clean.userId;
        delete clean.sourceSessionId;
        delete clean.sourceTraceId;
        return clean;
      });
      files.set('vocabulary/facts.json', JSON.stringify(cleanFacts, null, 2));
      entityCount += facts.length;
    }

    log.info('Vocabulary layer assembled', {
      projectId,
      vocabularies: vocabularies.length,
      lookupEntries: lookupEntries.length,
      schemas: schemas.length,
      facts: facts.length,
    });

    return { layer: 'vocabulary', files, entityCount, warnings };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    const { projectId, tenantId } = ctx;
    const knowledgeBases = await KnowledgeBase.find({ projectId, tenantId }).lean().select('_id');
    const knowledgeBaseIds = knowledgeBases.map((kb: Record<string, unknown>) => String(kb._id));
    const [vocabCount, lookupCount, schemaCount, factCount] = await Promise.all([
      knowledgeBaseIds.length > 0
        ? DomainVocabulary.countDocuments({
            tenantId,
            projectKnowledgeBaseId: { $in: knowledgeBaseIds },
          })
        : Promise.resolve(0),
      LookupEntry.countDocuments({ projectId, tenantId }),
      knowledgeBaseIds.length > 0
        ? CanonicalSchema.countDocuments({ tenantId, knowledgeBaseId: { $in: knowledgeBaseIds } })
        : Promise.resolve(0),
      Fact.countDocuments({ projectId, tenantId, scope: 'project' }),
    ]);
    return vocabCount + lookupCount + schemaCount + factCount;
  }
}

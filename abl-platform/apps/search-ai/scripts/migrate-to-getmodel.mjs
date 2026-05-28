#!/usr/bin/env node
/**
 * Migration Script: Update SearchAI routes/workers to use getModel()
 *
 * Converts direct model imports from @agent-platform/database/models
 * to getModel() calls from ../db/index.js for dual-database support.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../../..');

// Files to migrate (relative to project root)
const filesToMigrate = [
  'apps/search-ai/src/routes/document-upload.ts',
  'apps/search-ai/src/routes/documents.ts',
  'apps/search-ai/src/routes/jobs.ts',
  'apps/search-ai/src/routes/kg-enrichment.ts',
  'apps/search-ai/src/routes/kg-taxonomy.ts',
  'apps/search-ai/src/routes/sources.ts',
  'apps/search-ai/src/workers/canonical-mapper-worker.ts',
  'apps/search-ai/src/workers/docling-extraction-worker.ts',
  'apps/search-ai/src/workers/document-visual-enrichment-worker.ts',
  'apps/search-ai/src/workers/embedding-worker.ts',
  'apps/search-ai/src/workers/enrichment-worker.ts',
  'apps/search-ai/src/workers/extraction-worker.ts',
  'apps/search-ai/src/workers/ingestion-worker.ts',
  'apps/search-ai/src/workers/kg-enrichment-worker.ts',
  'apps/search-ai/src/workers/multimodal-worker.ts',
  'apps/search-ai/src/workers/page-processing-worker.ts',
  'apps/search-ai/src/workers/question-synthesis-worker.ts',
  'apps/search-ai/src/workers/scope-classification-worker.ts',
  'apps/search-ai/src/workers/tree-building-worker.ts',
  'apps/search-ai/src/workers/visual-enrichment-worker.ts',
  'apps/search-ai/src/services/document-classifier.service.ts',
  'apps/search-ai/src/services/entity-extractor.service.ts',
  'apps/search-ai/src/services/llm-config/metadata.ts',
  'apps/search-ai/src/services/question-synthesis/index.ts',
  'apps/search-ai/src/services/taxonomy-loader.service.ts',
  'apps/search-ai/src/services/tree-builder/constrained-balancer.ts',
  'apps/search-ai/src/services/vision/index.ts',
];

// SearchAI content models (go to search_ai database)
const contentModels = new Set([
  'SearchChunk',
  'SearchDocument',
  'SearchSource',
  'ChunkHierarchy',
  'ChunkQuestion',
  'ChunkScope',
  'DocumentPage',
  'KnowledgeGraphTaxonomy',
]);

// Platform models (go to abl_platform database)
const platformModels = new Set([
  'KnowledgeBase',
  'SearchIndex',
  'CanonicalSchema',
  'FieldMapping',
  'ConnectorSchema',
  'DomainVocabulary',
]);

function getRelativeDbPath(filePath) {
  const parts = filePath.split('/');
  const srcIndex = parts.indexOf('src');
  const depth = parts.length - srcIndex - 2; // -2 for src and filename
  return '../'.repeat(depth) + 'db/index.js';
}

function migrateFile(filePath) {
  const fullPath = resolve(projectRoot, filePath);
  console.log(`\n📝 Migrating: ${filePath}`);

  let content = readFileSync(fullPath, 'utf8');
  const originalContent = content;

  // Pattern: import { Model1, type IModel, ... } from '@agent-platform/database' or '@agent-platform/database/models';
  const importRegex =
    /import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]@agent-platform\/database(?:\/models)?['"]\s*;?/g;

  const matches = [...content.matchAll(importRegex)];
  if (matches.length === 0) {
    console.log('  ⏭️  No model imports found, skipping');
    return;
  }

  const importedModels = new Set();
  const importedTypes = new Set();
  const otherImports = [];

  // Parse imports - separate models, types, and other imports
  matches.forEach((match) => {
    const imports = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    imports.forEach((imp) => {
      // Handle "type IModel" syntax
      if (imp.startsWith('type ')) {
        importedTypes.add(imp.substring(5).trim());
        return;
      }

      // Handle "Model as Alias" or just "Model"
      const modelName = imp.includes(' as ') ? imp.split(' as ')[0].trim() : imp;

      // Check if it's a SearchAI model
      if (platformModels.has(modelName) || contentModels.has(modelName)) {
        importedModels.add(modelName);
      } else {
        // Keep other imports (like IKGDomain, IKGCategory, etc.)
        otherImports.push(imp);
      }
    });
  });

  if (importedModels.size === 0) {
    console.log('  ⏭️  No SearchAI models found, skipping');
    return;
  }

  // Build new import statements
  const dbPath = getRelativeDbPath(filePath);

  // getModel import
  let newImports = `import { getModel } from '${dbPath}';\n`;

  // Type imports for model interfaces
  const modelTypeImports = Array.from(importedModels).map((model) => `I${model}`);
  const allTypeImports = [...modelTypeImports, ...Array.from(importedTypes), ...otherImports];

  if (allTypeImports.length > 0) {
    newImports += `import type { ${allTypeImports.join(', ')} } from '@agent-platform/database/models';\n`;
  }

  // Model definitions using getModel()
  const modelDefinitions = Array.from(importedModels)
    .map((model) => {
      const dbComment = contentModels.has(model) ? '→ search_ai' : '→ abl_platform';
      return `const ${model} = getModel<I${model}>('${model}'); // ${dbComment}`;
    })
    .join('\n');

  newImports += `\n// Models bound to correct databases (platform vs content)\n${modelDefinitions}`;

  // Remove old imports
  content = content.replace(importRegex, '');

  // Find first non-comment, non-import line to insert new imports
  const lines = content.split('\n');
  let insertIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line &&
      !line.startsWith('/*') &&
      !line.startsWith('*') &&
      !line.startsWith('//') &&
      !line.startsWith('import ')
    ) {
      insertIndex = i;
      break;
    }
  }

  lines.splice(insertIndex, 0, newImports);
  content = lines.join('\n');

  // Clean up multiple blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  if (content !== originalContent) {
    writeFileSync(fullPath, content, 'utf8');
    console.log(`  ✅ Updated with getModel() for ${importedModels.size} models`);
  } else {
    console.log('  ⏭️  No changes needed');
  }
}

// Main execution
console.log('🚀 Starting SearchAI model import migration\n');
console.log(`Migrating ${filesToMigrate.length} files...\n`);

let successCount = 0;
let errorCount = 0;

filesToMigrate.forEach((file) => {
  try {
    migrateFile(file);
    successCount++;
  } catch (error) {
    console.error(`  ❌ Error migrating ${file}:`, error.message);
    errorCount++;
  }
});

console.log(`\n${'='.repeat(60)}`);
console.log(`✅ Migration complete: ${successCount} files updated, ${errorCount} errors`);
console.log(`${'='.repeat(60)}\n`);

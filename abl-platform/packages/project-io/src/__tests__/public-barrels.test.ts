import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as projectIo from '../index.js';
import * as exportBarrel from '../export/index.js';
import * as importBarrel from '../import/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '../../');

describe('project-io public barrels', () => {
  it('exposes direct apply, preview, revert, and post-import validators from the root barrel', () => {
    expect(projectIo.validateManifest).toBeTypeOf('function');
    expect(projectIo.previewCoreImportV2).toBeTypeOf('function');
    expect(projectIo.applyCoreImportV2).toBeTypeOf('function');
    expect(projectIo.revertCoreImportOperationV2).toBeTypeOf('function');
    expect(projectIo.validatePostImport).toBeTypeOf('function');
  });

  it('exposes layer assembler and disassembler constructors through stable public barrels', () => {
    expect(exportBarrel.CoreAssembler).toBeTypeOf('function');
    expect(exportBarrel.ConnectionsAssembler).toBeTypeOf('function');
    expect(exportBarrel.PromptsAssembler).toBeTypeOf('function');
    expect(exportBarrel.GuardrailsAssembler).toBeTypeOf('function');
    expect(exportBarrel.WorkflowsAssembler).toBeTypeOf('function');
    expect(exportBarrel.EvalsAssembler).toBeTypeOf('function');
    expect(exportBarrel.SearchAssembler).toBeTypeOf('function');
    expect(exportBarrel.ChannelsAssembler).toBeTypeOf('function');
    expect(exportBarrel.VocabularyAssembler).toBeTypeOf('function');

    expect(importBarrel.CoreDisassembler).toBeTypeOf('function');
    expect(importBarrel.ConnectionsDisassembler).toBeTypeOf('function');
    expect(importBarrel.PromptsDisassembler).toBeTypeOf('function');
    expect(importBarrel.GuardrailsDisassembler).toBeTypeOf('function');
    expect(importBarrel.WorkflowsDisassembler).toBeTypeOf('function');
    expect(importBarrel.EvalsDisassembler).toBeTypeOf('function');
    expect(importBarrel.SearchDisassembler).toBeTypeOf('function');
    expect(importBarrel.ChannelsDisassembler).toBeTypeOf('function');
    expect(importBarrel.VocabularyDisassembler).toBeTypeOf('function');
  });

  it('keeps package subpath exports available for layer assembler and disassembler users', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as {
      exports: Record<string, { import: string; types: string }>;
    };

    expect(packageJson.exports['./export/layer-assemblers']).toEqual({
      import: './dist/export/layer-assemblers/index.js',
      types: './dist/export/layer-assemblers/index.d.ts',
    });
    expect(packageJson.exports['./import/layer-disassemblers']).toEqual({
      import: './dist/import/layer-disassemblers/index.js',
      types: './dist/import/layer-disassemblers/index.d.ts',
    });
    expect(packageJson.exports['./project-agent-draft-metadata']).toEqual({
      import: './dist/project-agent-draft-metadata.js',
      types: './dist/project-agent-draft-metadata.d.ts',
    });
  });
});

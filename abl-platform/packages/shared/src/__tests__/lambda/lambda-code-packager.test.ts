import { describe, it, expect } from 'vitest';
import { LambdaCodePackager } from '../../services/lambda/lambda-code-packager.js';
import JSZip from 'jszip';

const testTemplates = {
  nodejsRunnerHandler: `
const { MemoryManager } = require('./memory_manager');
exports.handler = async (event) => {
  const mm = new MemoryManager();
  return { statusCode: 200 };
};`,
  nodejsMemoryManager: `
class MemoryManager { constructor() {} }
module.exports = { MemoryManager };`,
  pythonRunnerHandler: `
_BLOCKED_IMPORT_ROOTS = ['os', 'subprocess']
def lambda_handler(event, context):
    return {'statusCode': 200}`,
};

describe('LambdaCodePackager', () => {
  const packager = new LambdaCodePackager(testTemplates);

  it('creates a valid ZIP for javascript runtime', async () => {
    const buffer = await packager.createRunnerPackage('javascript');
    expect(buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files)).toContain('index.js');
    expect(Object.keys(zip.files)).toContain('memory_manager.js');
  });

  it('creates a valid ZIP for python runtime', async () => {
    const buffer = await packager.createRunnerPackage('python');
    expect(buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files)).toContain('index.py');
  });

  it('javascript handler contains MemoryManager setup', async () => {
    const buffer = await packager.createRunnerPackage('javascript');
    const zip = await JSZip.loadAsync(buffer);
    const handler = await zip.file('index.js')!.async('string');
    expect(handler).toContain('MemoryManager');
    expect(handler).toContain('exports.handler');
  });

  it('python handler contains security sandbox', async () => {
    const buffer = await packager.createRunnerPackage('python');
    const zip = await JSZip.loadAsync(buffer);
    const handler = await zip.file('index.py')!.async('string');
    expect(handler).toContain('_BLOCKED_IMPORT_ROOTS');
    expect(handler).toContain('lambda_handler');
  });
});

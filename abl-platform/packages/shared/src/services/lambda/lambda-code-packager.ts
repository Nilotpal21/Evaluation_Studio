/**
 * Lambda Code Packager
 *
 * Builds ZIP archives for runner Lambda functions.
 * JavaScript: index.js (handler) + memory_manager.js (MemoryManager class)
 * Python: index.py (handler with embedded security sandbox + MockMemoryManager)
 *
 * Handler templates are injected via constructor to avoid a cyclic dependency
 * on @abl/compiler (which depends on @agent-platform/shared).
 */

import JSZip from 'jszip';

export interface LambdaHandlerTemplates {
  nodejsRunnerHandler: string;
  nodejsMemoryManager: string;
  pythonRunnerHandler: string;
}

export class LambdaCodePackager {
  constructor(private readonly templates: LambdaHandlerTemplates) {}

  async createRunnerPackage(runtime: 'javascript' | 'python'): Promise<Buffer> {
    const zip = new JSZip();

    if (runtime === 'javascript') {
      zip.file('index.js', this.templates.nodejsRunnerHandler);
      zip.file('memory_manager.js', this.templates.nodejsMemoryManager);
    } else {
      zip.file('index.py', this.templates.pythonRunnerHandler);
    }

    return zip.generateAsync({ type: 'nodebuffer' }) as Promise<Buffer>;
  }
}

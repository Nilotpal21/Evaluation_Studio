import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_ROOT = path.resolve(__dirname, '../');

function readRuntimeFile(relativePath: string): string {
  return fs.readFileSync(path.join(RUNTIME_ROOT, relativePath), 'utf8');
}

describe('runtime production wiring', () => {
  it('mounts the project-io router on the production project route surface', () => {
    const server = readRuntimeFile('server.ts');

    expect(server).toContain("import projectIORouter from './routes/project-io.js'");
    expect(server).toContain("app.use('/api/projects/:projectId/project-io', projectIORouter)");
  });

  it('starts and stops every channel queue processor through the shared lifecycle', () => {
    const server = readRuntimeFile('server.ts');
    const queueLifecycle = readRuntimeFile('services/queues/index.ts');

    expect(server).toContain("await import('./services/queues/index.js')");
    expect(server).toContain('startChannelQueues');
    expect(server).toContain('stopChannelQueues');

    for (const worker of ['InboundWorker', 'DeliveryWorker', 'PromoteContextWorker'] as const) {
      expect(queueLifecycle).toContain(`start${worker}`);
      expect(queueLifecycle).toContain(`stop${worker}`);
    }

    expect(queueLifecycle).toContain('initPromoteContextQueue');
    expect(queueLifecycle).toContain('closePromoteContextQueue');
    expect(queueLifecycle).toContain('initChannelQueues');
    expect(queueLifecycle).toContain('closeChannelQueues');
  });
});

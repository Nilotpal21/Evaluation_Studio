import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockPublisherCtor, mockPublisherInstance } = vi.hoisted(() => {
  const publisherInstance = {
    publish: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const PublisherMock = vi.fn(
    class {
      publish = publisherInstance.publish;
      close = publisherInstance.close;
    },
  );

  return {
    mockPublisherCtor: PublisherMock,
    mockPublisherInstance: publisherInstance,
  };
});

vi.mock('@abl/eventstore', () => ({
  BufferedKafkaTopicPublisher: mockPublisherCtor,
  parsePositiveIntEnv: (raw: unknown, fallback: number) => {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  },
}));

describe('studio audit pipeline writer', () => {
  const shutdownHookKey = '__abl_studio_audit_pipeline_shutdown_hook__';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete (globalThis as Record<string, unknown>)[shutdownHookKey];
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[shutdownHookKey];
    vi.restoreAllMocks();
  });

  test('registers shutdown hooks once and reuses a single publisher', async () => {
    const processOnceSpy = vi.spyOn(process, 'once').mockImplementation(() => process);
    const { publishStudioAuditPipelineEvent, closeStudioAuditPipelineWriter } =
      await import('../lib/studio-audit-pipeline-writer');

    publishStudioAuditPipelineEvent({ auditId: 'audit-1' }, 'tenant-1');
    publishStudioAuditPipelineEvent({ auditId: 'audit-2' }, 'tenant-1');

    expect(mockPublisherCtor).toHaveBeenCalledTimes(1);
    expect(processOnceSpy).toHaveBeenCalledTimes(3);
    expect(mockPublisherInstance.publish).toHaveBeenCalledTimes(2);

    await closeStudioAuditPipelineWriter();
    expect(mockPublisherInstance.close).toHaveBeenCalledTimes(1);
  });
});

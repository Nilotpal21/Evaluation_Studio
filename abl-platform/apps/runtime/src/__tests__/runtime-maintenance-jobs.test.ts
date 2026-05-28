import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStartKMSRotationJob = vi.fn();
const mockStopKMSRotationJob = vi.fn();
const mockStartAuthProfileRotationJob = vi.fn();
const mockStopAuthProfileRotationJob = vi.fn();
const mockStartBillingUsageMaterializationScheduler = vi.fn();
const mockStopBillingUsageMaterializationScheduler = vi.fn();
const mockStartBillingUsagePublicationScheduler = vi.fn();
const mockStopBillingUsagePublicationScheduler = vi.fn();
const mockShutdownReencryptionQueue = vi.fn();

vi.mock('../services/kms/kms-rotation-job.js', () => ({
  startKMSRotationJob: (...args: unknown[]) => mockStartKMSRotationJob(...args),
  stopKMSRotationJob: (...args: unknown[]) => mockStopKMSRotationJob(...args),
}));

vi.mock('../services/auth-profile/auth-profile-rotation-scheduler.js', () => ({
  startAuthProfileRotationJob: (...args: unknown[]) => mockStartAuthProfileRotationJob(...args),
  stopAuthProfileRotationJob: (...args: unknown[]) => mockStopAuthProfileRotationJob(...args),
}));

vi.mock('../services/billing/billing-usage-materialization-scheduler.js', () => ({
  startBillingUsageMaterializationScheduler: (...args: unknown[]) =>
    mockStartBillingUsageMaterializationScheduler(...args),
  stopBillingUsageMaterializationScheduler: (...args: unknown[]) =>
    mockStopBillingUsageMaterializationScheduler(...args),
}));

vi.mock('../services/billing/billing-usage-publication-scheduler.js', () => ({
  startBillingUsagePublicationScheduler: (...args: unknown[]) =>
    mockStartBillingUsagePublicationScheduler(...args),
  stopBillingUsagePublicationScheduler: (...args: unknown[]) =>
    mockStopBillingUsagePublicationScheduler(...args),
}));

vi.mock('../services/kms/reencryption-queue.js', () => ({
  shutdownReencryptionQueue: (...args: unknown[]) => mockShutdownReencryptionQueue(...args),
}));

import {
  startRuntimeMaintenanceJobs,
  stopRuntimeMaintenanceJobs,
} from '../services/runtime-maintenance-jobs.js';

describe('runtime maintenance jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts KMS and auth profile rotation jobs from the shared server helper', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    process.env.KMS_ROTATION_INTERVAL_MINUTES = '15';
    process.env.BILLING_MATERIALIZATION_ENABLED = 'true';
    process.env.BILLING_MATERIALIZATION_INTERVAL_MS = '45000';
    process.env.BILLING_MATERIALIZATION_TENANT_BATCH_SIZE = '25';
    process.env.BILLING_PUBLICATION_ENABLED = 'true';
    process.env.BILLING_PUBLICATION_INTERVAL_MS = '1800000';
    process.env.BILLING_PUBLICATION_TENANT_BATCH_SIZE = '20';
    process.env.BILLING_PUBLICATION_BATCH_LIMIT = '5';

    await startRuntimeMaintenanceJobs(logger);

    expect(mockStartKMSRotationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        intervalMinutes: 15,
        dekRetentionDays: null,
        kekRotationPeriodDays: 365,
        enableReencryption: true,
      }),
    );
    expect(mockStartAuthProfileRotationJob).toHaveBeenCalledOnce();
    expect(mockStartBillingUsageMaterializationScheduler).toHaveBeenCalledWith({
      enabled: true,
      intervalMs: 45000,
      tenantBatchSize: 25,
    });
    expect(mockStartBillingUsagePublicationScheduler).toHaveBeenCalledWith({
      enabled: true,
      intervalMs: 1800000,
      tenantBatchSize: 20,
      batchLimit: 5,
    });
    expect(logger.info).toHaveBeenCalledWith('Auth profile rotation job started');
    expect(logger.info).toHaveBeenCalledWith('Billing materialization scheduler started');
    expect(logger.info).toHaveBeenCalledWith('Billing publication scheduler started');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stops KMS and auth profile rotation jobs and drains reencryption work', async () => {
    await stopRuntimeMaintenanceJobs();

    expect(mockStopKMSRotationJob).toHaveBeenCalledOnce();
    expect(mockStopAuthProfileRotationJob).toHaveBeenCalledOnce();
    expect(mockStopBillingUsageMaterializationScheduler).toHaveBeenCalledOnce();
    expect(mockStopBillingUsagePublicationScheduler).toHaveBeenCalledOnce();
    expect(mockShutdownReencryptionQueue).toHaveBeenCalledOnce();
  });
});

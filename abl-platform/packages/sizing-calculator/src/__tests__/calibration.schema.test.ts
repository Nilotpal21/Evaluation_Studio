import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CalibrationProfileSchema } from '../schemas/calibration.schema.js';

describe('CalibrationProfileSchema', () => {
  it('validates a well-formed calibration profile', async () => {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    const result = CalibrationProfileSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it('rejects missing version field', () => {
    const result = CalibrationProfileSchema.safeParse({
      tier: 'M',
      timestamp: '2026-03-25T00:00:00Z',
      environment: 'staging',
      services: {},
      dataStores: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid version', () => {
    const result = CalibrationProfileSchema.safeParse({
      version: '2.0',
      tier: 'M',
      timestamp: '2026-03-25T00:00:00Z',
      environment: 'staging',
      services: {},
      dataStores: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid tier', () => {
    const result = CalibrationProfileSchema.safeParse({
      version: '1.0',
      tier: 'XXXL',
      timestamp: '2026-03-25T00:00:00Z',
      environment: 'staging',
      services: {},
      dataStores: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty environment', () => {
    const result = CalibrationProfileSchema.safeParse({
      version: '1.0',
      tier: 'M',
      timestamp: '2026-03-25T00:00:00Z',
      environment: '',
      services: {},
      dataStores: {},
    });
    expect(result.success).toBe(false);
  });

  it('validates service with null Coroot fields (graceful degradation)', async () => {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    const profile = JSON.parse(raw);
    profile.services.runtime.measured.cpuPeak = null;
    profile.services.runtime.measured.memoryPeak = null;

    const result = CalibrationProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it('validates service with websocket: null (HTTP-only service)', async () => {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    const profile = JSON.parse(raw);
    expect(profile.services['search-ai'].websocket).toBeNull();

    const result = CalibrationProfileSchema.safeParse(profile);
    expect(result.success).toBe(true);
  });

  it('rejects negative maxRpsPerPod', async () => {
    const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
    const profile = JSON.parse(raw);
    profile.services.runtime.saturation.maxRpsPerPod = -10;

    const result = CalibrationProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
  });
});

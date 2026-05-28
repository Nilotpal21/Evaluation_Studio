/**
 * Settings Resolution Chain Tests
 *
 * Tests the resolution priority for enableThinking/thinkingBudget:
 *   1. Agent IR (highest) — EXECUTION: enable_thinking in DSL
 *   2. Agent DB (AgentModelConfig.hyperParams) — per-agent UI override
 *   3. Pinned settingsVersionId — deployment-specific
 *   4. Active ProjectSettingsVersion — promoted project version
 *   5. ProjectSettings working copy — fallback
 *   6. false — platform default
 *
 * This file tests the repo-level resolution function (findProjectEnableThinking)
 * which covers levels 3-6. Levels 1-2 are tested via model-resolution integration.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────

const mockProjectSettingsVersionFindOne = vi.fn();
const mockProjectSettingsFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  ProjectSettingsVersion: {
    findOne: (...args: any[]) => ({
      lean: () => mockProjectSettingsVersionFindOne(...args),
    }),
  },
  ProjectSettings: {
    findOne: (...args: any[]) => ({
      lean: () => mockProjectSettingsFindOne(...args),
    }),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { findProjectEnableThinking } from '../repos/llm-resolution-repo.js';

// ─── Tests ───────────────────────────────────────────────────────────────

describe('findProjectEnableThinking — settings resolution chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =======================================================================
  // Level 3: Pinned settingsVersionId
  // =======================================================================

  test('uses pinned settingsVersionId when provided', async () => {
    mockProjectSettingsVersionFindOne.mockResolvedValue({
      settings: { enableThinking: true, thinkingBudget: 8192 },
    });

    const result = await findProjectEnableThinking('proj-1', 'ver-pinned', 'tenant-A');

    expect(result).toEqual({
      enableThinking: true,
      thinkingBudget: 8192,
      thoughtDescription: null,
      compactionThreshold: null,
    });
    // Should query by _id and tenantId
    expect(mockProjectSettingsVersionFindOne).toHaveBeenCalledTimes(1);
  });

  test('falls through when pinned version not found', async () => {
    // Pinned version lookup returns null
    mockProjectSettingsVersionFindOne
      .mockResolvedValueOnce(null) // pinned version not found
      .mockResolvedValueOnce(null); // active version not found
    mockProjectSettingsFindOne.mockResolvedValue({
      enableThinking: false,
      thinkingBudget: null,
    });

    const result = await findProjectEnableThinking('proj-1', 'ver-missing', 'tenant-A');

    expect(result).toEqual({
      enableThinking: false,
      thinkingBudget: null,
      thoughtDescription: null,
      compactionThreshold: null,
    });
    // Pinned lookup + active lookup + working copy
    expect(mockProjectSettingsVersionFindOne).toHaveBeenCalledTimes(2);
    expect(mockProjectSettingsFindOne).toHaveBeenCalledTimes(1);
  });

  // =======================================================================
  // Level 4: Active ProjectSettingsVersion
  // =======================================================================

  test('uses active version when no pinned version', async () => {
    mockProjectSettingsVersionFindOne.mockResolvedValue({
      settings: { enableThinking: true, thinkingBudget: 4096 },
    });

    const result = await findProjectEnableThinking('proj-1', undefined, 'tenant-A');

    expect(result).toEqual({
      enableThinking: true,
      thinkingBudget: 4096,
      thoughtDescription: null,
      compactionThreshold: null,
    });
    // Should query for active version (status: 'active')
    expect(mockProjectSettingsVersionFindOne).toHaveBeenCalledTimes(1);
  });

  test('falls through when no active version exists', async () => {
    mockProjectSettingsVersionFindOne.mockResolvedValue(null);
    mockProjectSettingsFindOne.mockResolvedValue({
      enableThinking: true,
      thinkingBudget: 2048,
    });

    const result = await findProjectEnableThinking('proj-1', undefined, 'tenant-A');

    expect(result).toEqual({
      enableThinking: true,
      thinkingBudget: 2048,
      thoughtDescription: null,
      compactionThreshold: null,
    });
  });

  // =======================================================================
  // Level 5: ProjectSettings working copy
  // =======================================================================

  test('uses working copy when no versions exist', async () => {
    mockProjectSettingsFindOne.mockResolvedValue({
      enableThinking: false,
      thinkingBudget: null,
    });

    // No tenantId → skips version lookups entirely
    const result = await findProjectEnableThinking('proj-1');

    expect(result).toEqual({
      enableThinking: false,
      thinkingBudget: null,
      thoughtDescription: null,
      compactionThreshold: null,
    });
    expect(mockProjectSettingsVersionFindOne).not.toHaveBeenCalled();
    expect(mockProjectSettingsFindOne).toHaveBeenCalledTimes(1);
  });

  // =======================================================================
  // Level 6: Platform default (undefined)
  // =======================================================================

  test('returns undefined when no record exists at any level', async () => {
    mockProjectSettingsFindOne.mockResolvedValue(null);

    const result = await findProjectEnableThinking('proj-1');

    expect(result).toBeUndefined();
  });

  test('returns undefined when all levels miss (with tenantId)', async () => {
    mockProjectSettingsVersionFindOne.mockResolvedValue(null);
    mockProjectSettingsFindOne.mockResolvedValue(null);

    const result = await findProjectEnableThinking('proj-1', undefined, 'tenant-A');

    expect(result).toBeUndefined();
  });

  // =======================================================================
  // Edge cases
  // =======================================================================

  test('handles thinkingBudget: null correctly in pinned version', async () => {
    mockProjectSettingsVersionFindOne.mockResolvedValue({
      settings: { enableThinking: true, thinkingBudget: undefined },
    });

    const result = await findProjectEnableThinking('proj-1', 'ver-1', 'tenant-A');

    expect(result).toEqual({
      enableThinking: true,
      thinkingBudget: null,
      thoughtDescription: null,
      compactionThreshold: null,
    });
  });

  test('skips version lookups when tenantId not provided', async () => {
    mockProjectSettingsFindOne.mockResolvedValue({
      enableThinking: true,
      thinkingBudget: 1024,
    });

    const result = await findProjectEnableThinking('proj-1');

    // Should not query ProjectSettingsVersion at all
    expect(mockProjectSettingsVersionFindOne).not.toHaveBeenCalled();
    expect(result).toEqual({
      enableThinking: true,
      thinkingBudget: 1024,
      thoughtDescription: null,
      compactionThreshold: null,
    });
  });

  test('working copy with enableThinking undefined returns undefined for that field', async () => {
    mockProjectSettingsFindOne.mockResolvedValue({
      thinkingBudget: null,
    });

    const result = await findProjectEnableThinking('proj-1');

    expect(result).toEqual({
      enableThinking: undefined,
      thinkingBudget: null,
      thoughtDescription: null,
      compactionThreshold: null,
    });
  });
});

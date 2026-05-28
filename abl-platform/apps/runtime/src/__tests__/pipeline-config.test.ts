/**
 * Tests for pipeline config resolution.
 */

import { describe, it, expect } from 'vitest';
import { resolvePipelineConfig } from '../services/pipeline/config.js';
import { DEFAULT_PIPELINE_CONFIG } from '../services/pipeline/types.js';
import type { IRExecutionConfig as ExecutionConfig } from '@abl/compiler';

describe('resolvePipelineConfig', () => {
  it('returns defaults when no overrides provided', () => {
    const config = resolvePipelineConfig();
    expect(config).toEqual(DEFAULT_PIPELINE_CONFIG);
  });

  it('returns defaults when agent execution has no pipeline field', () => {
    const config = resolvePipelineConfig({ hints: {} as any, timeouts: {} as any });
    expect(config).toEqual(DEFAULT_PIPELINE_CONFIG);
  });

  it('agent-level enabled overrides default', () => {
    const config = resolvePipelineConfig({
      hints: {} as any,
      timeouts: {} as any,
      pipeline: { enabled: true },
    });
    expect(config.enabled).toBe(true);
    expect(config.mode).toBe('parallel'); // default
    expect(config.modelSource).toBe('default');
  });

  it('project-level overrides defaults', () => {
    const config = resolvePipelineConfig(undefined, {
      enabled: true,
      mode: 'sequential',
      modelSource: 'tenant',
      tenantModelId: 'tm-123',
    });
    expect(config.enabled).toBe(true);
    expect(config.mode).toBe('sequential');
    expect(config.modelSource).toBe('tenant');
    expect(config.tenantModelId).toBe('tm-123');
  });

  it('agent-level overrides project-level', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: { enabled: true, modelSource: 'tenant', tenantModelId: 'tm-agent' } as any,
      },
      {
        enabled: false,
        modelSource: 'tenant',
        tenantModelId: 'tm-project',
        mode: 'sequential',
      },
    );
    expect(config.enabled).toBe(true); // agent wins
    expect(config.modelSource).toBe('tenant'); // agent wins
    expect(config.tenantModelId).toBe('tm-agent'); // agent wins
    expect(config.mode).toBe('sequential'); // project fills in
  });

  it('nested shortCircuit overrides work correctly', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: {
          shortCircuit: { confidenceThreshold: 0.95 },
        },
      },
      {
        shortCircuit: { enabled: false, confidenceThreshold: 0.7 },
      },
    );
    // Agent overrides confidenceThreshold
    expect(config.shortCircuit.confidenceThreshold).toBe(0.95);
    // Project overrides enabled (agent didn't set it)
    expect(config.shortCircuit.enabled).toBe(false);
  });

  it('nested toolFilter overrides work correctly', () => {
    const config = resolvePipelineConfig(undefined, {
      toolFilter: { maxTools: 10 },
    });
    expect(config.toolFilter.maxTools).toBe(10);
    expect(config.toolFilter.enabled).toBe(true); // default
  });

  it('keywordVeto agent-level keywords override project', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: {
          keywordVeto: { keywords: ['refund', 'cancel'] },
        },
      },
      {
        keywordVeto: { keywords: ['help'] },
      },
    );
    expect(config.keywordVeto.keywords).toEqual(['refund', 'cancel']);
    expect(config.keywordVeto.enabled).toBe(true); // default
  });

  it('agent can disable pipeline even if project enables it', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: { enabled: false },
      },
      { enabled: true },
    );
    expect(config.enabled).toBe(false);
  });

  // ─── intentBridge resolution ────────────────────────────────────────────

  it('TC-CFG-01: agent-level intentBridge overrides project-level', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: {
          intentBridge: { programmaticThreshold: 0.9 },
        },
      },
      {
        intentBridge: { programmaticThreshold: 0.7 },
      },
    );
    expect(config.intentBridge.programmaticThreshold).toBe(0.9);
  });

  it('TC-CFG-02: project-level fills gaps when agent has no intentBridge', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: { enabled: true },
      },
      {
        intentBridge: { guidedThreshold: 0.6 },
      },
    );
    expect(config.intentBridge.guidedThreshold).toBe(0.6);
  });

  it('TC-CFG-03: defaults used when neither agent nor project set', () => {
    const config = resolvePipelineConfig();
    expect(config.intentBridge).toEqual(DEFAULT_PIPELINE_CONFIG.intentBridge);
  });

  it('TC-CFG-04: partial agent intentBridge — missing fields use project or default', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: {
          intentBridge: { enabled: true },
        },
      },
      {
        intentBridge: { guidedThreshold: 0.6 },
      },
    );
    expect(config.intentBridge.enabled).toBe(true); // agent
    expect(config.intentBridge.guidedThreshold).toBe(0.6); // project
    expect(config.intentBridge.programmaticThreshold).toBe(0.85); // default
  });

  it('TC-CFG-05: full pipeline modelSource resolution — agent > project > default', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: { modelSource: 'tenant', tenantModelId: 'tm-agent' } as any,
      },
      { modelSource: 'tenant', tenantModelId: 'tm-project' },
    );
    expect(config.modelSource).toBe('tenant');
    expect(config.tenantModelId).toBe('tm-agent');
  });

  it('TC-CFG-06: project-level modelSource when agent does not specify', () => {
    const config = resolvePipelineConfig(undefined, {
      modelSource: 'tenant',
      tenantModelId: 'tm-project',
    });
    expect(config.modelSource).toBe('tenant');
    expect(config.tenantModelId).toBe('tm-project');
  });

  it('modelSource defaults to default when not set', () => {
    const config = resolvePipelineConfig(undefined, { enabled: true });
    expect(config.modelSource).toBe('default');
    expect(config.tenantModelId).toBeUndefined();
  });

  it('tenantModelId from project fills in when agent does not set it', () => {
    const config = resolvePipelineConfig(
      {
        hints: {} as any,
        timeouts: {} as any,
        pipeline: { modelSource: 'tenant' } as any,
      },
      { tenantModelId: 'tm-project-fallback' },
    );
    expect(config.modelSource).toBe('tenant');
    expect(config.tenantModelId).toBe('tm-project-fallback');
  });

  it('backward compat: old config with model string is ignored', () => {
    const config = resolvePipelineConfig(undefined, {
      model: 'qwen3-30b',
    } as any);
    expect(config.modelSource).toBe('default');
    expect(config.tenantModelId).toBeUndefined();
  });
});

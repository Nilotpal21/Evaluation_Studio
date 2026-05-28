import { describe, expect, it } from 'vitest';

import { bugFixPipeline } from '../pipeline/templates/bug-fix.js';
import { focusedChangePipeline } from '../pipeline/templates/focused-change.js';
import { holisticAuditPipeline } from '../pipeline/templates/holistic-audit.js';
import { selectPipelineForWorkItem } from '../pipeline/templates/index.js';

describe('pipeline templates', () => {
  it('assigns aggressive recovery-friendly deadlines to the holistic audit pipeline', () => {
    const timeoutByStage = new Map(
      holisticAuditPipeline.stages.map((stage) => [stage.name, stage.timeoutMs]),
    );

    expect(timeoutByStage.get('Verification Bootstrap')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Deep Scan')).toBe(15 * 60_000);
    expect(timeoutByStage.get('Oracle Analysis')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Plan Generation')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Manifest Compilation')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Implementation')).toBeGreaterThan(0);
    expect(timeoutByStage.get('E2E Testing')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Regression')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Deferred Bulk Review')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Doc Sync')).toBeGreaterThan(0);
    expect(
      holisticAuditPipeline.stages.find((stage) => stage.name === 'Plan Generation')?.model.primary
        .maxTurns,
    ).toBe(25);
    expect(
      holisticAuditPipeline.stages.find((stage) => stage.name === 'Plan Generation')?.qualityGate
        ?.checks[0]?.model?.primary.maxTurns,
    ).toBe(15);

    expect(
      holisticAuditPipeline.stages.find((stage) => stage.name === 'Plan Generation')?.qualityGate
        ?.timeoutMs,
    ).toBeGreaterThan(0);
    expect(
      holisticAuditPipeline.stages.find((stage) => stage.name === 'E2E Testing')?.qualityGate
        ?.timeoutMs,
    ).toBeGreaterThan(0);
    expect(
      holisticAuditPipeline.stages.find((stage) => stage.name === 'Regression')?.qualityGate
        ?.timeoutMs,
    ).toBeGreaterThan(0);
  });

  it('assigns aggressive recovery-friendly deadlines to the bug-fix pipeline', () => {
    const timeoutByStage = new Map(
      bugFixPipeline.stages.map((stage) => [stage.name, stage.timeoutMs]),
    );
    const implementFixStage = bugFixPipeline.stages.find((stage) => stage.name === 'Implement Fix');

    expect(timeoutByStage.get('Verification Bootstrap')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Reproduce')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Root Cause Analysis')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Implement Fix')).toBe(35 * 60_000);
    expect(timeoutByStage.get('Regression Test')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Code Review')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Full Regression')).toBeGreaterThan(0);

    expect(implementFixStage?.qualityGate?.timeoutMs).toBe(8 * 60_000);
    expect(
      (implementFixStage?.timeoutMs ?? 0) - (implementFixStage?.qualityGate?.timeoutMs ?? 0),
    ).toBe(27 * 60_000);
    expect(
      bugFixPipeline.stages.find((stage) => stage.name === 'Regression Test')?.qualityGate
        ?.timeoutMs,
    ).toBeGreaterThan(0);
    expect(
      bugFixPipeline.stages.find((stage) => stage.name === 'Full Regression')?.qualityGate
        ?.timeoutMs,
    ).toBeGreaterThan(0);
  });

  it('assigns aggressive recovery-friendly deadlines to the focused change pipeline', () => {
    const timeoutByStage = new Map(
      focusedChangePipeline.stages.map((stage) => [stage.name, stage.timeoutMs]),
    );

    expect(timeoutByStage.get('Verification Bootstrap')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Focused Analysis')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Implement Focused Change')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Focused Review')).toBeGreaterThan(0);
    expect(timeoutByStage.get('Focused Regression')).toBeGreaterThan(0);

    expect(
      focusedChangePipeline.stages.find((stage) => stage.name === 'Implement Focused Change')
        ?.qualityGate?.timeoutMs,
    ).toBeGreaterThan(0);
    expect(
      focusedChangePipeline.stages.find((stage) => stage.name === 'Focused Regression')?.qualityGate
        ?.timeoutMs,
    ).toBeGreaterThan(0);
  });

  it('adds SDLC-aligned invariant, acceptance, and replay-coverage gates to the pipelines', () => {
    const holisticImplementationChecks =
      holisticAuditPipeline.stages.find((stage) => stage.name === 'Implementation')?.qualityGate
        ?.checks ?? [];
    const holisticRegressionChecks =
      holisticAuditPipeline.stages.find((stage) => stage.name === 'Regression')?.qualityGate
        ?.checks ?? [];
    const focusedImplementationChecks =
      focusedChangePipeline.stages.find((stage) => stage.name === 'Implement Focused Change')
        ?.qualityGate?.checks ?? [];
    const focusedRegressionChecks =
      focusedChangePipeline.stages.find((stage) => stage.name === 'Focused Regression')?.qualityGate
        ?.checks ?? [];
    const bugFixImplementationChecks =
      bugFixPipeline.stages.find((stage) => stage.name === 'Implement Fix')?.qualityGate?.checks ??
      [];
    const bugFixRegressionChecks =
      bugFixPipeline.stages.find((stage) => stage.name === 'Full Regression')?.qualityGate
        ?.checks ?? [];

    expect(holisticImplementationChecks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'Wiring and consumer verification',
        'Security and isolation verification',
      ]),
    );
    expect(holisticRegressionChecks.map((check) => check.type)).toContain('replay-target-coverage');

    expect(focusedImplementationChecks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'Wiring and consumer verification',
        'Security and isolation verification',
      ]),
    );
    expect(focusedRegressionChecks.map((check) => check.name)).toEqual(
      expect.arrayContaining(['Acceptance verification', 'Production readiness verification']),
    );
    expect(focusedRegressionChecks.map((check) => check.type)).toContain('replay-target-coverage');

    expect(bugFixImplementationChecks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'Wiring and consumer verification',
        'Security and isolation verification',
      ]),
    );
    expect(bugFixRegressionChecks.map((check) => check.name)).toEqual(
      expect.arrayContaining(['Acceptance verification', 'Production readiness verification']),
    );
    expect(bugFixRegressionChecks.map((check) => check.type)).toContain('replay-target-coverage');
  });

  it('adds a Codex fallback to blocking quality-gate model reviews and scans the live E2E locations for mocks', () => {
    const pipelines = [holisticAuditPipeline, focusedChangePipeline, bugFixPipeline];

    for (const pipeline of pipelines) {
      const reviewChecks = pipeline.stages.flatMap((stage) =>
        (stage.qualityGate?.checks ?? []).filter((check) => check.type === 'model-review'),
      );

      expect(reviewChecks.length).toBeGreaterThan(0);
      for (const check of reviewChecks) {
        expect(check.model?.fallback).toEqual(
          expect.objectContaining({
            engine: 'codex-cli',
            model: 'gpt-5.4',
            permissionMode: 'bypassPermissions',
          }),
        );
      }
    }

    const e2eMockCheck = holisticAuditPipeline.stages
      .find((stage) => stage.name === 'E2E Testing')
      ?.qualityGate?.checks.find((check) => check.name === 'No mocks in E2E');

    expect(e2eMockCheck?.command).toContain('src/__tests__');
    expect(e2eMockCheck?.command).toContain('--glob "*e2e*.test.ts"');
    expect(e2eMockCheck?.command).toContain('vi\\.mock|jest\\.mock');
  });

  it('adds dedicated security and UX audit stages that run on Claude Opus 4.7 in relevant pipelines', () => {
    const holisticSecurityStage = holisticAuditPipeline.stages.find(
      (stage) => stage.name === 'Security Audit',
    );
    const holisticUxStage = holisticAuditPipeline.stages.find(
      (stage) => stage.name === 'UX Design Audit',
    );
    const focusedSecurityStage = focusedChangePipeline.stages.find(
      (stage) => stage.name === 'Security Audit',
    );
    const focusedUxStage = focusedChangePipeline.stages.find(
      (stage) => stage.name === 'UX Design Audit',
    );
    const bugFixSecurityStage = bugFixPipeline.stages.find(
      (stage) => stage.name === 'Security Audit',
    );
    const bugFixUxStage = bugFixPipeline.stages.find((stage) => stage.name === 'UX Design Audit');

    for (const stage of [
      holisticSecurityStage,
      holisticUxStage,
      focusedSecurityStage,
      focusedUxStage,
      bugFixSecurityStage,
      bugFixUxStage,
    ]) {
      expect(stage).toBeDefined();
      expect(stage?.type).toBe('review');
      expect(stage?.model.primary.engine).toBe('claude-code');
      expect(stage?.model.primary.model).toBe('claude-opus-4-7');
      expect(stage?.qualityGate?.checks).toEqual([
        expect.objectContaining({ type: 'analysis-report-clear' }),
      ]);
    }
  });

  it('routes small explicit fix-like feature audits to the focused change pipeline', () => {
    const selection = selectPipelineForWorkItem({
      id: 'work-1',
      type: 'feature-audit',
      title: 'Fix runtime timeout regression',
      description: 'Fix the scoped runtime timeout regression in the chat handler',
      scope: ['apps/runtime/src/routes/chat.ts'],
      targetBranch: 'current',
      createdAt: '2026-04-10T00:00:00.000Z',
    });

    expect(selection.pipeline.name).toBe(focusedChangePipeline.name);
    expect(selection.reason).toContain('Focused Change fast path');
  });

  it('exposes HELIX repo-native lookup tools in the fast-path analysis and implementation stages', () => {
    const focusedAnalysisTools =
      focusedChangePipeline.stages.find((stage) => stage.name === 'Focused Analysis')?.tools ?? [];
    const implementationTools =
      focusedChangePipeline.stages.find((stage) => stage.name === 'Implement Focused Change')
        ?.tools ?? [];

    expect(focusedAnalysisTools).toEqual(
      expect.arrayContaining([
        'helix_find_symbol',
        'helix_find_references',
        'helix_get_route_info',
        'helix_get_schema_info',
        'helix_get_impacted_tests',
      ]),
    );
    expect(implementationTools).toEqual(
      expect.arrayContaining([
        'helix_find_symbol',
        'helix_find_references',
        'helix_get_route_info',
        'helix_get_schema_info',
        'helix_get_impacted_tests',
      ]),
    );
  });

  it('keeps holistic audits for broad or spec-driven feature audits', () => {
    const broadSelection = selectPipelineForWorkItem({
      id: 'work-2',
      type: 'feature-audit',
      title: 'RBAC Management',
      description: 'Audit the end-to-end RBAC management workflow',
      scope: [],
      targetBranch: 'current',
      createdAt: '2026-04-10T00:00:00.000Z',
    });
    const specDrivenSelection = selectPipelineForWorkItem({
      id: 'work-3',
      type: 'feature-audit',
      title: 'Custom Project Roles',
      description: 'Implement the planned custom project roles feature',
      scope: ['apps/studio/src/features/roles', 'apps/runtime/src/routes/projects'],
      featureSpec: 'docs/features/custom-project-roles.md',
      targetBranch: 'current',
      createdAt: '2026-04-10T00:00:00.000Z',
    });

    expect(broadSelection.pipeline.name).toBe(holisticAuditPipeline.name);
    expect(specDrivenSelection.pipeline.name).toBe(holisticAuditPipeline.name);
  });

  it('keeps holistic audits when any SDLC design inputs are attached to the work item', () => {
    const selection = selectPipelineForWorkItem({
      id: 'work-4',
      type: 'feature-audit',
      title: 'Project RBAC hardening',
      description: 'Strengthen project member validation',
      scope: ['apps/studio/src/services/project-member-service.ts'],
      testSpec: 'docs/testing/custom-project-roles.md',
      targetBranch: 'current',
      createdAt: '2026-04-10T00:00:00.000Z',
    });

    expect(selection.pipeline.name).toBe(holisticAuditPipeline.name);
  });
});

/**
 * Workflow Version Resolution
 *
 * Single implementation of the fire-time version cascade used by every
 * trigger path (webhook, cron, polling, connector). Keeps all trigger-fired
 * executions in lock-step so the same workflow runs the same definition
 * regardless of what fired it.
 *
 * Cascade (in order; first hit wins):
 *   1. Pinned version ID      — trigger/caller pinned a specific WorkflowVersion._id
 *   2. Deployment manifest    — active deployment for (projectId, environment) names
 *                               a version via `workflowVersionManifest[workflowName]`
 *   3. Semver-desc default    — highest semver among active published versions
 *   4. Draft version row      — the `draft` WorkflowVersion row (authoritative for
 *                               canvas saves; the Workflow doc lags it)
 *   5. Working copy fallback  — legacy Workflow doc `.steps`/`.nodes`/`.edges`
 *                               (pre-versioning workflows)
 *
 * Before this helper existed, `trigger-scheduler.ts` only implemented tiers
 * 1 and 5 — cron-fired executions would silently run the stale working copy
 * even when webhook-fired executions for the same workflow correctly resolved
 * to the active published version. This helper closes that gap.
 */
import { createLogger } from '@abl/compiler/platform';
import {
  convertVersionDocToSteps,
  convertWorkflowDocToSteps,
  type OutputMapping,
  type StartInputVariable,
  type EdgeDescriptor,
} from '../handlers/canvas-to-steps.js';
import { compareSemverDesc } from './semver-compare.js';

const log = createLogger('workflow-engine:version-resolution');

export type VersionResolutionTier =
  | 'pinned'
  | 'deployment'
  | 'semver-desc'
  | 'draft'
  | 'working-copy-steps'
  | 'working-copy-canvas';

export interface VersionResolutionDeps {
  workflowVersionModel?: {
    findOne(filter: Record<string, unknown>): {
      lean(): Promise<Record<string, unknown> | null>;
    };
    find?(filter: Record<string, unknown>): {
      lean(): Promise<Record<string, unknown>[]>;
    };
  };
  deploymentModel?: {
    findOne(filter: Record<string, unknown>): {
      sort(sort: Record<string, number>): {
        lean(): Promise<Record<string, unknown> | null>;
      };
    };
  };
}

/** Minimal shape of the Workflow doc needed by the working-copy fallback. */
export interface WorkflowLike {
  _id?: string;
  name: string;
  steps?: unknown[];
  nodes?: unknown;
  edges?: unknown;
}

export interface ResolveWorkflowDefinitionInput {
  workflow: WorkflowLike;
  tenantId: string;
  projectId: string;
  /** Optional pinned version id from the trigger registration or caller. */
  pinnedVersionId?: string | null;
  /** Environment used for deployment-based resolution. */
  environment?: string | null;
  /** Tag for structured logs (e.g. registrationId for triggers). */
  logContext?: Record<string, unknown>;
}

export interface ResolvedWorkflowDefinition {
  steps: unknown[];
  nameToIdMap: Record<string, string>;
  outputMappings: OutputMapping[];
  outputMappingsByEndNodeId: Record<string, OutputMapping[]>;
  /**
   * Input variables declared on the canvas start node. Forwarded from the
   * `CanvasConversionResult` so the engine can validate + coerce trigger
   * payloads at workflow start (see workflow-handler Start phase). Every tier
   * of `resolveWorkflowDefinition` must propagate this field — dropping it at
   * any tier silently reverts to unvalidated execution for that fire path.
   */
  startInputVariables: StartInputVariable[];
  /**
   * Pre-computed in-degree map from canvas-to-steps conversion. Present for
   * all canvas-originated tiers; `{}` for legacy working-copy-steps tiers
   * (triggers sequential fallback in the workflow executor).
   */
  inDegreeMap: Record<string, number>;
  /** Edge descriptor map for backend-authoritative edge pathState computation. */
  edgeMap: Record<string, EdgeDescriptor[]>;
  workflowVersion: string | null;
  workflowVersionId: string | null;
  deploymentId: string | null;
  tier: VersionResolutionTier;
}

/**
 * Resolve the steps + routing metadata for a workflow at fire time.
 *
 * Always returns a `ResolvedWorkflowDefinition`. When all cascaded sources
 * return empty, the result carries empty arrays and a working-copy tier —
 * callers decide whether that is a fail-fast or accept-empty situation.
 */
export async function resolveWorkflowDefinition(
  input: ResolveWorkflowDefinitionInput,
  deps: VersionResolutionDeps,
): Promise<ResolvedWorkflowDefinition> {
  const { workflow, tenantId, projectId, pinnedVersionId, environment, logContext = {} } = input;
  const workflowId = (workflow._id as string | undefined) ?? '';

  // Tier 1 — pinned version id
  if (pinnedVersionId && deps.workflowVersionModel) {
    const versionDoc = await deps.workflowVersionModel
      .findOne({
        _id: pinnedVersionId,
        workflowId,
        tenantId,
        projectId,
        deleted: { $ne: true },
      })
      .lean();
    if (versionDoc) {
      const conversion = convertVersionDocToSteps(versionDoc);
      log.info('Resolved pinned workflow version', {
        ...logContext,
        workflowVersionId: pinnedVersionId,
        version: (versionDoc.version as string) ?? null,
      });
      return {
        steps: conversion.steps,
        nameToIdMap: conversion.nameToIdMap,
        outputMappings: conversion.outputMappings,
        outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
        startInputVariables: conversion.startInputVariables,
        inDegreeMap: conversion.inDegreeMap,
        edgeMap: conversion.edgeMap,
        workflowVersion: (versionDoc.version as string) ?? null,
        workflowVersionId: (versionDoc._id as string) ?? pinnedVersionId,
        deploymentId: null,
        tier: 'pinned',
      };
    }
    log.warn('Pinned workflow version not found, falling through cascade', {
      ...logContext,
      workflowVersionId: pinnedVersionId,
    });
  }

  // Tier 2 — deployment manifest
  if (environment && deps.deploymentModel && deps.workflowVersionModel) {
    const deployment = await deps.deploymentModel
      .findOne({
        projectId,
        tenantId,
        environment,
        status: 'active',
      })
      .sort({ createdAt: -1 })
      .lean();
    if (deployment) {
      const manifest = (deployment.workflowVersionManifest ?? {}) as Record<string, string>;
      const pinnedVersion = manifest[workflow.name];
      if (pinnedVersion) {
        const versionDoc = await deps.workflowVersionModel
          .findOne({
            workflowId,
            version: pinnedVersion,
            tenantId,
            projectId,
            deleted: { $ne: true },
          })
          .lean();
        if (versionDoc) {
          const conversion = convertVersionDocToSteps(versionDoc);
          const deploymentId = (deployment._id as string) ?? null;
          log.info('Resolved workflow version via deployment', {
            ...logContext,
            workflowId,
            version: pinnedVersion,
            deploymentId,
          });
          return {
            steps: conversion.steps,
            nameToIdMap: conversion.nameToIdMap,
            outputMappings: conversion.outputMappings,
            outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
            startInputVariables: conversion.startInputVariables,
            inDegreeMap: conversion.inDegreeMap,
            edgeMap: conversion.edgeMap,
            workflowVersion: pinnedVersion,
            workflowVersionId: (versionDoc._id as string) ?? null,
            deploymentId,
            tier: 'deployment',
          };
        }
        log.warn('Deployment-pinned workflow version not found, falling through cascade', {
          ...logContext,
          workflowId,
          version: pinnedVersion,
        });
      }
    }
  }

  // Tier 3 — semver-desc default among active published versions
  if (deps.workflowVersionModel?.find) {
    const candidates = await deps.workflowVersionModel
      .find({
        workflowId,
        tenantId,
        projectId,
        state: 'active',
        deleted: false,
        version: { $ne: 'draft' },
      })
      .lean();
    if (candidates.length > 0) {
      const sorted = [...candidates].sort((a, b) =>
        compareSemverDesc(a.version as string, b.version as string),
      );
      const best = sorted[0];
      const conversion = convertVersionDocToSteps(best);
      log.info('Resolved workflow version via semver-desc default', {
        ...logContext,
        workflowId,
        version: (best.version as string) ?? null,
        candidateCount: candidates.length,
      });
      return {
        steps: conversion.steps,
        nameToIdMap: conversion.nameToIdMap,
        outputMappings: conversion.outputMappings,
        outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
        startInputVariables: conversion.startInputVariables,
        inDegreeMap: conversion.inDegreeMap,
        edgeMap: conversion.edgeMap,
        workflowVersion: (best.version as string) ?? null,
        workflowVersionId: (best._id as string) ?? null,
        deploymentId: null,
        tier: 'semver-desc',
      };
    }
  }

  // Tier 4 — draft WorkflowVersion row (authoritative for canvas saves)
  if (deps.workflowVersionModel) {
    const draftDoc = await deps.workflowVersionModel
      .findOne({
        workflowId,
        tenantId,
        projectId,
        version: 'draft',
        deleted: false,
      })
      .lean();
    if (draftDoc) {
      const conversion = convertVersionDocToSteps(draftDoc);
      log.info('Resolved workflow via draft WorkflowVersion', {
        ...logContext,
        workflowId,
      });
      return {
        steps: conversion.steps,
        nameToIdMap: conversion.nameToIdMap,
        outputMappings: conversion.outputMappings,
        outputMappingsByEndNodeId: conversion.outputMappingsByEndNodeId,
        startInputVariables: conversion.startInputVariables,
        inDegreeMap: conversion.inDegreeMap,
        edgeMap: conversion.edgeMap,
        workflowVersion: 'draft',
        workflowVersionId: (draftDoc._id as string) ?? null,
        deploymentId: null,
        tier: 'draft',
      };
    }
  }

  // Tier 5 — working copy (legacy pre-versioning workflows)
  if (Array.isArray(workflow.steps) && workflow.steps.length > 0) {
    // Legacy .steps array is authoritative. Still convert any canvas data on
    // the same doc so `nameToIdMap` and `outputMappings` (which only exist in
    // canvas form) are available to downstream executors.
    const canvasConversion = convertWorkflowDocToSteps(workflow);
    return {
      steps: workflow.steps,
      nameToIdMap: canvasConversion.nameToIdMap,
      outputMappings: canvasConversion.outputMappings,
      outputMappingsByEndNodeId: canvasConversion.outputMappingsByEndNodeId,
      startInputVariables: canvasConversion.startInputVariables,
      inDegreeMap: canvasConversion.inDegreeMap,
      edgeMap: canvasConversion.edgeMap,
      workflowVersion: null,
      workflowVersionId: null,
      deploymentId: null,
      tier: 'working-copy-steps',
    };
  }

  const canvasConversion = convertWorkflowDocToSteps(workflow);
  return {
    steps: canvasConversion.steps,
    nameToIdMap: canvasConversion.nameToIdMap,
    outputMappings: canvasConversion.outputMappings,
    outputMappingsByEndNodeId: canvasConversion.outputMappingsByEndNodeId,
    startInputVariables: canvasConversion.startInputVariables,
    inDegreeMap: canvasConversion.inDegreeMap,
    edgeMap: canvasConversion.edgeMap,
    workflowVersion: null,
    workflowVersionId: null,
    deploymentId: null,
    tier: 'working-copy-canvas',
  };
}

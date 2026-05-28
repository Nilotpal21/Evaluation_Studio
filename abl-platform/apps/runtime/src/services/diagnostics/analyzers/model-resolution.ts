/**
 * Model Resolution Analyzer
 *
 * Walks the 5-level model resolution chain and reports which levels
 * were checked, matched, or skipped. Produces findings when no model
 * or no credential can be resolved for the target agent.
 */

import { createLogger } from '@abl/compiler/platform';
import type { Analyzer, DiagnosticContext, DiagnosticFinding } from '../types.js';

const log = createLogger('diag-model-resolution');

interface ChainStep {
  level: number;
  name: string;
  checked: boolean;
  matched: boolean;
  value?: string;
  reason: string;
}

export class ModelResolutionAnalyzer implements Analyzer {
  name = 'model-resolution';
  category = 'infra' as const;

  async analyze(context: DiagnosticContext): Promise<DiagnosticFinding[]> {
    const findings: DiagnosticFinding[] = [];
    const chain: ChainStep[] = [];

    const { tenantId, projectId, agentName } = context;

    if (!agentName) {
      findings.push({
        analyzer: this.name,
        severity: 'info',
        code: 'NO_AGENT_NAME',
        title: 'No agent name provided',
        detail: 'Model resolution analysis requires an agent name.',
        suggestion: 'Provide an agent name to check model resolution.',
        evidence: [],
      });
      return findings;
    }

    try {
      // Level 1: Agent IR — we cannot check this without loading DSL, skip in diagnostic
      chain.push({
        level: 1,
        name: 'Agent IR (DSL)',
        checked: false,
        matched: false,
        reason: 'Agent IR model is only available at session time; skipped in static analysis.',
      });

      // Level 2: Agent DB (AgentModelConfig)
      let agentModelConfig: Record<string, unknown> | null = null;
      try {
        const { findAgentModelConfig } = await import('../../../repos/llm-resolution-repo.js');
        agentModelConfig = await findAgentModelConfig(projectId, agentName, tenantId);

        chain.push({
          level: 2,
          name: 'Agent DB (AgentModelConfig)',
          checked: true,
          matched: !!agentModelConfig,
          value: agentModelConfig
            ? ((agentModelConfig.defaultModel as string | null | undefined) ?? 'configured')
            : undefined,
          reason: agentModelConfig
            ? 'Agent-level model override found.'
            : 'No agent-level model override configured.',
        });
      } catch (err) {
        log.warn('Failed to check AgentModelConfig', {
          error: err instanceof Error ? err.message : String(err),
        });
        chain.push({
          level: 2,
          name: 'Agent DB (AgentModelConfig)',
          checked: false,
          matched: false,
          reason: `Database query failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Level 3: Project DB (ModelConfig)
      let projectModelConfig: Record<string, unknown> | null = null;
      try {
        const { findAnyModelConfig } = await import('../../../repos/llm-resolution-repo.js');
        projectModelConfig = await findAnyModelConfig(projectId, tenantId);

        chain.push({
          level: 3,
          name: 'Project DB (ModelConfig)',
          checked: true,
          matched: !!projectModelConfig,
          value: projectModelConfig
            ? ((projectModelConfig.modelId as string) ?? 'configured')
            : undefined,
          reason: projectModelConfig
            ? 'Project-level model configuration found.'
            : 'No project-level model configuration.',
        });
      } catch (err) {
        log.warn('Failed to check ModelConfig', {
          error: err instanceof Error ? err.message : String(err),
        });
        chain.push({
          level: 3,
          name: 'Project DB (ModelConfig)',
          checked: false,
          matched: false,
          reason: `Database query failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Level 4: Tenant Model (TenantModel)
      let tenantModel: Record<string, unknown> | null = null;
      try {
        const { TenantModel } = await import('@agent-platform/database/models');
        tenantModel = await TenantModel.findOne({
          tenantId,
          isActive: true,
          inferenceEnabled: true,
        }).lean();

        chain.push({
          level: 4,
          name: 'Tenant Model (TenantModel)',
          checked: true,
          matched: !!tenantModel,
          value: tenantModel ? ((tenantModel.modelId as string) ?? 'configured') : undefined,
          reason: tenantModel
            ? 'Active tenant model with inference enabled found.'
            : 'No active tenant model with inference enabled.',
        });
      } catch (err) {
        log.warn('Failed to check TenantModel', {
          error: err instanceof Error ? err.message : String(err),
        });
        chain.push({
          level: 4,
          name: 'Tenant Model (TenantModel)',
          checked: false,
          matched: false,
          reason: `Database query failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Level 5: Credential check
      let credentialAvailable = false;
      let credentialInfo: { provider?: string; scope?: string; isActive?: boolean } = {};
      try {
        const { LLMCredential } = await import('@agent-platform/database/models');
        const credential = await LLMCredential.findOne({
          tenantId,
          isActive: true,
        }).lean();

        credentialAvailable = !!credential;
        if (credential) {
          credentialInfo = {
            provider: credential.provider as string | undefined,
            scope: credential.credentialScope as string | undefined,
            isActive: true,
          };
        }

        chain.push({
          level: 5,
          name: 'LLM Credential',
          checked: true,
          matched: credentialAvailable,
          value: credentialAvailable ? (credentialInfo.provider ?? 'available') : undefined,
          reason: credentialAvailable
            ? `Active credential found (provider: ${credentialInfo.provider ?? 'unknown'}).`
            : 'No active LLM credential found for tenant.',
        });
      } catch (err) {
        log.warn('Failed to check LLMCredential', {
          error: err instanceof Error ? err.message : String(err),
        });
        chain.push({
          level: 5,
          name: 'LLM Credential',
          checked: false,
          matched: false,
          reason: `Database query failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Determine if any model was resolved
      const anyModelResolved = !!agentModelConfig || !!projectModelConfig || !!tenantModel;

      if (!anyModelResolved) {
        findings.push({
          analyzer: this.name,
          severity: 'error',
          code: 'NO_MODEL_RESOLVED',
          title: 'No model could be resolved',
          detail:
            'The model resolution chain checked Agent DB, Project DB, and Tenant Model levels — none had a configured model.',
          suggestion:
            'Configure a model at the project level (Project Settings > LLM Config) or ensure a default TenantModel is active with inferenceEnabled=true.',
          evidence: chain.map((step) => ({
            type: 'config' as const,
            label: `Level ${step.level}: ${step.name}`,
            data: step as unknown as Record<string, unknown>,
          })),
        });
      }

      if (!credentialAvailable) {
        findings.push({
          analyzer: this.name,
          severity: 'error',
          code: 'NO_CREDENTIAL',
          title: 'No active LLM credential found',
          detail:
            'No active LLM credential exists for this tenant. Without a credential, the runtime cannot make LLM API calls.',
          suggestion:
            'Add an LLM credential in Workspace Settings > Models & Credentials, or ensure an existing credential is marked as active.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Credential check',
              data: { tenantId, credentialAvailable: false },
            },
          ],
        });
      }

      // If everything looks good, emit an info finding with the chain
      if (anyModelResolved && credentialAvailable) {
        const resolvedLevel = chain.find((s) => s.matched && s.level >= 2 && s.level <= 4);
        findings.push({
          analyzer: this.name,
          severity: 'info',
          code: 'MODEL_RESOLVED',
          title: 'Model resolution successful',
          detail: `Model resolved at ${resolvedLevel?.name ?? 'unknown level'}. Credential available.`,
          suggestion: 'No action needed.',
          evidence: chain.map((step) => ({
            type: 'config' as const,
            label: `Level ${step.level}: ${step.name}`,
            data: step as unknown as Record<string, unknown>,
          })),
        });
      }
    } catch (err) {
      log.error('Model resolution analysis failed', {
        error: err instanceof Error ? err.message : String(err),
        agentName,
        projectId,
      });
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        code: 'ANALYSIS_ERROR',
        title: 'Model resolution analysis encountered an error',
        detail: err instanceof Error ? err.message : String(err),
        suggestion: 'Check database connectivity and try again.',
        evidence: [],
      });
    }

    return findings;
  }
}

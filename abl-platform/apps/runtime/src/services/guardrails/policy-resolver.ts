import type { Guardrail, GuardrailAction } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { formatErrorSync } from '@agent-platform/i18n';

const log = createLogger('guardrail-policy-resolver');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolicyRule {
  guardrailName: string;
  override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
  threshold?: number;
  action?: Record<string, unknown>;
  severityActions?: Record<string, unknown>;
  // Define-mode fields (used when override === 'define')
  kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
  tier?: 'local' | 'model' | 'llm';
  provider?: string;
  category?: string;
  check?: string;
  llmCheck?: string;
  description?: string;
  priority?: number;
  message?: string;
  // ─── Sensitive Data Block additions (ABLP-723) ───────────────────────
  entities?: string[];
  enabled?: boolean;
  presetKey?: string;
  actionMessage?: string;
}

export interface StreamingSettings {
  enabled: boolean;
  defaultInterval: 'token' | 'sentence' | 'chunk_size';
  chunkSize: number;
  maxLatencyMs: number;
  earlyTermination: boolean;
}

export interface PolicySettings {
  failMode: 'open' | 'closed';
  timeouts?: { local: number; model: number; llm: number };
  /** @deprecated Not yet consumed. Reserved for future webhook notification support. */
  webhookUrl?: string;
  webhookSecret?: string;
  /** Streaming guardrail evaluation config resolved from DB policy. */
  streaming?: StreamingSettings;
}

export interface PolicyCaching {
  enabled: boolean;
  exactMatch: boolean;
  semanticMatch: boolean;
  semanticThreshold: number;
  defaultTtlSeconds: number;
}

export interface PolicyBudget {
  monthlyLimitUsd: number;
  currentSpendUsd: number;
  overspendAction: 'downgrade' | 'disable_model_checks' | 'alert_only';
}

export interface ProviderOverride {
  providerName: string;
  endpoint?: string;
  apiKeyCredentialId?: string;
  defaultCategory?: string;
  defaultThreshold?: number;
  costPerEvalUsd?: number;
  isActive?: boolean;
  circuitBreaker?: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
    failMode?: 'open' | 'closed';
  };
  retry?: { maxRetries?: number; backoffBaseMs?: number };
}

export interface ConstitutionPrinciple {
  principle: string;
  weight: number;
  examples?: string[];
}

export interface PolicyData {
  name: string;
  rules: PolicyRule[];
  settings: PolicySettings;
  caching?: PolicyCaching;
  budget?: PolicyBudget;
  providerOverrides?: ProviderOverride[];
  constitution?: ConstitutionPrinciple[];
}

export interface PolicyInput {
  tenantId: string;
  projectId: string;
  agentDefId: string;
  agentGuardrails: Guardrail[];
  tenantPolicies: PolicyData[];
  projectPolicies: PolicyData[];
}

export interface ResolvedGuardrailPolicy {
  guardrails: Guardrail[];
  disabledGuardrails: string[];
  ruleOverrides: PolicyRule[];
  settings: PolicySettings;
  caching?: PolicyCaching;
  budget?: PolicyBudget;
  providerOverrides: ProviderOverride[];
  constitution: ConstitutionPrinciple[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: PolicySettings = {
  failMode: 'open',
  timeouts: { local: 100, model: 5000, llm: 15000 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSyntheticGuardrail(rule: PolicyRule): Guardrail {
  const provider = rule.provider?.trim();
  const llmCheck = rule.llmCheck?.trim();
  const check = rule.check?.trim();
  const action: GuardrailAction =
    rule.action && typeof rule.action === 'object' && 'type' in rule.action
      ? (rule.action as unknown as GuardrailAction)
      : {
          type: 'block',
          message:
            rule.actionMessage ??
            rule.message ??
            formatErrorSync('GUARDRAIL_POLICY_BLOCKED').message,
        };

  return {
    name: rule.guardrailName,
    description: rule.description ?? `Policy-defined: ${rule.guardrailName}`,
    kind: rule.kind ?? 'output',
    priority: rule.priority ?? 50,
    tier: rule.tier ?? (provider ? 'model' : llmCheck ? 'llm' : 'local'),
    provider,
    category: rule.category,
    threshold: rule.threshold,
    check,
    llmCheck,
    action,
    severityActions: rule.severityActions as Guardrail['severityActions'],
    entities: rule.entities,
    presetKey: rule.presetKey,
  };
}

function hasExecutableDefineRule(rule: PolicyRule): boolean {
  return Boolean(rule.provider?.trim() || rule.llmCheck?.trim() || rule.check?.trim());
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves the effective guardrail configuration by merging policies from
 * multiple scopes.
 *
 * Resolution chain (lowest to highest priority):
 *   1. Platform defaults
 *   2. Tenant-scoped policies
 *   3. Project-scoped policies
 *   4. Agent DSL guardrails (always included as-is)
 *
 * Settings are merged with higher-priority scopes overriding lower ones.
 * Rules are merged per-guardrail name: project rules override tenant rules
 * for the same guardrail. Disable rules from any scope are respected.
 *
 * Constitution principles are replaced (not merged) by higher-priority scopes:
 * project-scoped constitution fully overrides tenant-scoped constitution.
 */
export class GuardrailPolicyResolver {
  resolve(input: PolicyInput): ResolvedGuardrailPolicy {
    const guardrails = [...input.agentGuardrails];
    const dslNames = new Set(input.agentGuardrails.map((g) => g.name));
    const disabledGuardrails: string[] = [];
    const ruleOverrides: PolicyRule[] = [];
    const providerOverrides: ProviderOverride[] = [];
    let constitution: ConstitutionPrinciple[] = [];
    let caching: PolicyCaching | undefined;
    let budget: PolicyBudget | undefined;

    // Start with platform defaults
    let settings: PolicySettings = { ...DEFAULT_SETTINGS };

    // Layer 1: Apply tenant policies (base layer)
    for (const policy of input.tenantPolicies) {
      settings = this.mergeSettings(settings, policy.settings);
      caching = this.mergeCaching(caching, policy.caching);
      budget = policy.budget ?? budget;
      this.applyRules(policy.rules, guardrails, dslNames, disabledGuardrails, ruleOverrides);
      if (policy.providerOverrides) {
        providerOverrides.push(...policy.providerOverrides);
      }
      if (policy.constitution?.length) {
        constitution = policy.constitution;
      }
    }

    // Layer 2: Apply project policies (overrides tenant)
    for (const policy of input.projectPolicies) {
      settings = this.mergeSettings(settings, policy.settings);
      caching = this.mergeCaching(caching, policy.caching);
      budget = policy.budget ?? budget;
      this.applyRules(policy.rules, guardrails, dslNames, disabledGuardrails, ruleOverrides);
      if (policy.providerOverrides) {
        providerOverrides.push(...policy.providerOverrides);
      }
      if (policy.constitution?.length) {
        constitution = policy.constitution;
      }
    }

    log.debug('resolved guardrail policy', {
      tenantId: input.tenantId,
      projectId: input.projectId,
      agentDefId: input.agentDefId,
      guardrailCount: guardrails.length,
      disabledCount: disabledGuardrails.length,
      overrideCount: ruleOverrides.length,
      cachingEnabled: caching?.enabled ?? false,
      hasBudget: Boolean(budget),
      providerOverrideCount: providerOverrides.length,
      constitutionCount: constitution.length,
    });

    return {
      guardrails,
      disabledGuardrails,
      ruleOverrides,
      settings,
      caching,
      budget,
      providerOverrides,
      constitution,
    };
  }

  /**
   * Merge incoming settings over the base, including nested timeouts.
   */
  private mergeSettings(base: PolicySettings, incoming: PolicySettings): PolicySettings {
    const merged: PolicySettings = {
      ...base,
      ...incoming,
    };
    // Only merge timeouts if at least one side has them
    if (base.timeouts || incoming.timeouts) {
      merged.timeouts = {
        ...base.timeouts,
        ...incoming.timeouts,
      } as PolicySettings['timeouts'];
    }
    return merged;
  }

  private mergeCaching(base?: PolicyCaching, incoming?: PolicyCaching): PolicyCaching | undefined {
    if (!base && !incoming) {
      return undefined;
    }

    return {
      ...(base ?? {}),
      ...(incoming ?? {}),
    } as PolicyCaching;
  }

  /**
   * Apply rules from a single policy: disable rules go to the disabled list,
   * define rules create synthetic guardrails (never overwriting DSL-defined ones),
   * and other rules go to the overrides list (replacing any existing override for
   * the same guardrail name).
   */
  private applyRules(
    rules: PolicyRule[],
    guardrails: Guardrail[],
    dslNames: Set<string>,
    disabledGuardrails: string[],
    ruleOverrides: PolicyRule[],
  ): void {
    for (const rule of rules) {
      if (rule.enabled === false) {
        // Auto-deactivated or explicitly disabled by user; skip without warning.
        continue;
      }

      if (rule.override === 'disable') {
        if (!disabledGuardrails.includes(rule.guardrailName)) {
          disabledGuardrails.push(rule.guardrailName);
        }
      } else if (rule.override === 'define') {
        if (!hasExecutableDefineRule(rule)) {
          log.warn('Ignoring malformed policy define rule with no executable check', {
            guardrailName: rule.guardrailName,
          });
          continue;
        }

        // Never overwrite DSL-defined guardrails
        if (dslNames.has(rule.guardrailName)) continue;
        // Replace previous scope's define, or add new
        const existingIdx = guardrails.findIndex((g) => g.name === rule.guardrailName);
        if (existingIdx >= 0) {
          guardrails[existingIdx] = toSyntheticGuardrail(rule);
        } else {
          guardrails.push(toSyntheticGuardrail(rule));
        }
      } else {
        const existingIdx = ruleOverrides.findIndex((r) => r.guardrailName === rule.guardrailName);
        if (existingIdx >= 0) {
          ruleOverrides[existingIdx] = rule;
        } else {
          ruleOverrides.push(rule);
        }
      }
    }
  }
}

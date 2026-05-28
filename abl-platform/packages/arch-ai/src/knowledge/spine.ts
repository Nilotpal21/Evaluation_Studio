/**
 * Knowledge Spine query API.
 *
 * Read-only access to the compiler-generated Knowledge Catalog. Arch uses this
 * layer instead of hand-maintained construct facts when it needs current ABL
 * construct, CEL, validation-code, or feasibility knowledge.
 */

import type {
  CelContext,
  CelFunctionSpec,
  CombinationRule,
  ConstructSpec,
  FeasibilityCheckSpec,
  MandatoryRule,
  ValidationCodeMeta,
} from '@abl/compiler/platform';
import { KNOWLEDGE_CATALOG } from '@abl/compiler/platform';

export function getCatalogVersion(): string {
  return KNOWLEDGE_CATALOG?.version ?? 'unknown';
}

export function listAllConstructs(): readonly ConstructSpec[] {
  return KNOWLEDGE_CATALOG?.constructs ?? [];
}

export function getConstructSpec(name: string): ConstructSpec | null {
  const normalized = name.trim().toUpperCase();
  return listAllConstructs().find((construct) => construct.name === normalized) ?? null;
}

export function listValidCombinations(constructName?: string): readonly CombinationRule[] {
  const combinations = KNOWLEDGE_CATALOG?.validCombinations ?? [];
  if (!constructName) {
    return combinations;
  }

  const normalized = constructName.trim().toUpperCase();
  return combinations.filter(
    (rule) => rule.constructA === normalized || rule.constructB === normalized,
  );
}

export function getCelGrammar(context: CelContext): readonly string[] {
  return KNOWLEDGE_CATALOG?.cel?.perContextAllowlist?.[context] ?? [];
}

export function listCelFunctions(): readonly CelFunctionSpec[] {
  return KNOWLEDGE_CATALOG?.cel?.functions ?? [];
}

export function lookupValidationCode(code: string): ValidationCodeMeta | null {
  return KNOWLEDGE_CATALOG?.validationCodes?.[code] ?? null;
}

export function listFeasibilityChecks(): readonly FeasibilityCheckSpec[] {
  return KNOWLEDGE_CATALOG?.runtimeFeasibilityChecks ?? [];
}

export function getCrossConstructMandatories(constructName?: string): readonly MandatoryRule[] {
  const rules = KNOWLEDGE_CATALOG?.crossConstructMandatories ?? [];
  if (!constructName) {
    return rules;
  }

  const normalized = constructName.trim().toUpperCase();
  return rules.filter((rule) => rule.appliesToConstruct === normalized);
}

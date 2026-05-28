/**
 * classifyDataSensitivity() — Scans agent tools for sensitive data patterns.
 * B23: Constraint & Guardrail Design Coaching
 */

// =============================================================================
// TYPES
// =============================================================================

export type SensitivityCategory = 'payment' | 'pii' | 'health' | 'financial' | 'general';

export interface SensitivityResult {
  categories: SensitivityCategory[];
  evidence: {
    category: SensitivityCategory;
    source: 'tool_name' | 'parameter' | 'description';
    match: string;
  }[];
}

export interface AgentTool {
  name: string;
  parameters?: Record<string, unknown>;
  description?: string;
}

// =============================================================================
// PATTERN TABLES
// =============================================================================

const TOOL_NAME_PATTERNS: [RegExp, SensitivityCategory][] = [
  [/payment|refund|charge|invoice|billing|checkout|credit_card|debit/i, 'payment'],
  [/ssn|social_security|identity_verify|kyc|passport/i, 'pii'],
  [/diagnosis|prescription|medical|patient|health|clinical|pharmacy|lab_result/i, 'health'],
  [/transaction|balance|account_.*statement|tax|revenue|ledger/i, 'financial'],
];

const PARAMETER_PATTERNS: [RegExp, SensitivityCategory][] = [
  [/credit_card|card_number|cvv|expiry|bank_account|routing_number/i, 'payment'],
  [/ssn|social_security|passport_number|date_of_birth|dob|national_id/i, 'pii'],
  [/diagnosis|prescription_id|patient_id|medical_record|icd_code/i, 'health'],
  [/account_number|tax_id|ein|iban|swift/i, 'financial'],
];

const DESCRIPTION_KEYWORDS: [RegExp, SensitivityCategory][] = [
  [/payment|credit card|refund|billing|invoice|charge/i, 'payment'],
  [/personal.*data|PII|personally identifiable|social security|passport/i, 'pii'],
  [/medical|diagnosis|prescription|health.*record|HIPAA|patient/i, 'health'],
  [/financial|transaction|balance|tax|banking/i, 'financial'],
];

// =============================================================================
// MAIN ENTRY
// =============================================================================

export function classifyDataSensitivity(tools: AgentTool[]): SensitivityResult {
  const evidence: SensitivityResult['evidence'] = [];

  for (const tool of tools) {
    // Check tool name
    for (const [pattern, category] of TOOL_NAME_PATTERNS) {
      if (pattern.test(tool.name)) {
        evidence.push({ category, source: 'tool_name', match: tool.name });
      }
    }

    // Check parameter names
    if (tool.parameters) {
      for (const paramName of Object.keys(tool.parameters)) {
        for (const [pattern, category] of PARAMETER_PATTERNS) {
          if (pattern.test(paramName)) {
            evidence.push({ category, source: 'parameter', match: paramName });
          }
        }
      }
    }

    // Check description
    if (tool.description) {
      for (const [pattern, category] of DESCRIPTION_KEYWORDS) {
        if (pattern.test(tool.description)) {
          evidence.push({ category, source: 'description', match: tool.description.slice(0, 80) });
        }
      }
    }
  }

  // Deduplicate categories
  const categories = [...new Set(evidence.map((e) => e.category))];

  // If no sensitive data detected, classify as general
  if (categories.length === 0) {
    return { categories: ['general'], evidence: [] };
  }

  return { categories, evidence };
}

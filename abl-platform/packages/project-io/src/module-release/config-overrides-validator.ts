/**
 * Config Overrides Validator
 *
 * Validates consumer-provided configOverrides against the module contract.
 * Prevents template injection, control character smuggling, and secret leaks.
 *
 * LLD Section 11.2
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of config override keys */
const MAX_OVERRIDE_KEYS = 50;

/** Maximum byte size per override value (UTF-8) */
const MAX_VALUE_BYTES = 1024;

/** Template injection pattern */
const TEMPLATE_INJECTION_RE = /\{\{/;

/** Control characters (excluding tab \x09, newline \x0A, carriage return \x0D) */
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConfigOverrideValidationResult {
  blocking: string[];
  warnings: string[];
}

/** Minimal contract config key shape needed for validation */
export interface ContractConfigKey {
  key: string;
  isSecret?: boolean;
  description?: string;
}

// ─── Validator ───────────────────────────────────────────────────────────────

/**
 * Validate consumer-provided config overrides against a module contract.
 *
 * @param overrides - Key-value pairs the consumer wants to set
 * @param contractConfigKeys - Declared config slots from the module contract
 * @returns Blocking errors and warnings
 */
export function validateConfigOverrides(
  overrides: Record<string, string>,
  contractConfigKeys: ContractConfigKey[],
): ConfigOverrideValidationResult {
  const blocking: string[] = [];
  const warnings: string[] = [];

  const keys = Object.keys(overrides);

  // 1. Max key count
  if (keys.length > MAX_OVERRIDE_KEYS) {
    blocking.push(
      `Too many config overrides: ${keys.length} exceeds maximum of ${MAX_OVERRIDE_KEYS}`,
    );
    // Still validate individual keys for useful error reporting
  }

  // Build lookup for contract keys
  const contractKeyMap = new Map(contractConfigKeys.map((k) => [k.key, k]));
  const declaredKeys = new Set(contractConfigKeys.map((k) => k.key));

  for (const key of keys) {
    const value = overrides[key];

    // 2. Key must be declared in contract
    if (!declaredKeys.has(key)) {
      blocking.push(
        `Config key "${key}" is not declared in the module contract — it cannot be set`,
      );
      continue;
    }

    // 3. Reject secret key overrides
    const contractKey = contractKeyMap.get(key);
    if (contractKey?.isSecret) {
      blocking.push(
        `Config key "${key}" is declared as secret — secrets cannot be set via config overrides`,
      );
      continue;
    }

    // 4. Value size check
    const byteLength = Buffer.byteLength(value, 'utf-8');
    if (byteLength > MAX_VALUE_BYTES) {
      blocking.push(
        `Config value for "${key}" is ${byteLength} bytes — exceeds maximum of ${MAX_VALUE_BYTES} bytes`,
      );
    }

    // 5. Template injection
    if (TEMPLATE_INJECTION_RE.test(value)) {
      blocking.push(
        `Config value for "${key}" contains template syntax "{{" — template injection is not allowed`,
      );
    }

    // 6. Control characters
    if (CONTROL_CHAR_RE.test(value)) {
      blocking.push(
        `Config value for "${key}" contains control characters — only printable characters, tabs, and newlines are allowed`,
      );
    }
  }

  return { blocking, warnings };
}

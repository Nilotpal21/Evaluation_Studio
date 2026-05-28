/**
 * Guardrail Adapter Type Constants
 *
 * Single source of truth for adapter types recognised by the DB schema
 * and the subset that have working runtime implementations.
 *
 * Mongoose-free — safe to import in tests and client code without
 * pulling in database dependencies.
 */

/** All adapter types recognised by the DB schema. */
export const GUARDRAIL_ADAPTER_TYPES = [
  'openai_compatible',
  'openai_moderation',
  'custom_http',
  'custom_webhook',
  'custom_llm',
  'huggingface_inference',
  'anthropic',
  'google_cloud',
  'vertex_ai',
  'bedrock',
  'azure_content_safety',
  'lakera',
  'aporia',
  'builtin_pii',
  'other',
] as const;

export type GuardrailAdapterType = (typeof GUARDRAIL_ADAPTER_TYPES)[number];

/**
 * Adapter types wired end-to-end: factory implementation, runtime routes,
 * and Studio UI. Only these may be created via the tenant provider API.
 * `builtin_pii` is auto-registered separately and is not tenant-configurable.
 */
export const IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES = [
  'openai_moderation',
  'custom_http',
  'custom_webhook',
  'custom_llm',
] as const;

export type ImplementedGuardrailAdapterType = (typeof IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES)[number];

/**
 * Runtime built-ins are executable without tenant provider configuration.
 * They are read-only from Studio/admin surfaces and must be treated as
 * available anywhere runtime guardrail evaluation can run.
 */
export const BUILTIN_GUARDRAIL_PROVIDERS = [
  {
    name: 'builtin-pii',
    displayName: 'Built-in PII',
    adapterType: 'builtin_pii',
    defaultCategory: 'pii',
  },
] as const;

export type BuiltinGuardrailProvider = (typeof BUILTIN_GUARDRAIL_PROVIDERS)[number];

export const BUILTIN_GUARDRAIL_PROVIDER_NAMES = BUILTIN_GUARDRAIL_PROVIDERS.map(
  (provider) => provider.name,
);

export function isBuiltinGuardrailProviderName(name: string): boolean {
  return (BUILTIN_GUARDRAIL_PROVIDER_NAMES as readonly string[]).includes(name);
}

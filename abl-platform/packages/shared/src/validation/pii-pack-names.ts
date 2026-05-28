/**
 * Canonical recognizer-pack name list shared by the runtime config Zod
 * schema and the compiler-side recognizer-packs dispatcher.
 *
 * Lives in @agent-platform/shared because @abl/compiler already depends
 * on @agent-platform/shared (not the reverse) — re-exporting from compiler
 * back into shared would create a circular dep. (LLD §1.2 deviation note.)
 */

export const PACK_NAMES = [
  'core',
  'us',
  'eu',
  'apac',
  'financial',
  'medical',
  'network',
  'international-phone',
] as const;

export type PackName = (typeof PACK_NAMES)[number];

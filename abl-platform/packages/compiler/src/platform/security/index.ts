/**
 * Security Module Exports
 */

export {
  detectPII,
  redactPII,
  containsPII,
  detectPIISelective,
  createSafePIIDetection,
  getPIIRedactLabel,
  type PIIDetection,
  type PIIDetectionResult,
  type PIIType,
  type SelectivePIIResult,
} from './pii-detector.js';

export {
  PIIVault,
  maskValue,
  applyMask,
  generateRandomReplacement,
  getRandomReplacement,
  clearRandomCache,
  resolveRenderMode,
  DEFAULT_MASK_CONFIGS,
  CHARSETS,
  type PIIToken,
  type PIIConsumer,
  type TokenizeResult,
  type MaskConfig,
  type RedactionType,
  type RandomRedactionConfig,
  type PIIConsumerBuiltin,
  type PIIRenderMode,
  type PIIConsumerAccessRule,
  type PIIPatternConfig,
} from './pii-vault.js';

export { renderSensitiveValue } from './sensitive-display.js';

export { encryptVault, decryptVault, type VaultEncryptionService } from './encrypted-vault.js';

export {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
  getDefaultPIIRecognizerRegistry,
  resetDefaultRegistry,
  luhnCheck,
  type PIIRecognizer,
  type RecognizerTier,
  type RegexPIIRecognizerConfig,
} from './pii-recognizer-registry.js';

export { registerPacks, type RegisterPacksOptions } from './recognizer-packs/index.js';

export { listEnabledPIIEntities, type EntityCatalogEntry } from './recognizer-packs/catalog.js';

export { applyContextBoost } from './context-enhancer.js';
export { withTimeout } from './_with-timeout.js';
export { isPIIBypassFixEnabled } from './_pii-bypass-fix.js';

export { PIIAuditLogger, type PIIAuditEntry, type PIIAuditStore } from './pii-audit.js';

export { StreamingPIIBuffer, type StreamingPIIChunkResult } from './streaming-pii-buffer.js';

export {
  renderSessionMessagesForPIIBoundary,
  renderTraceEventsForPIIBoundary,
  renderValueForPIIBoundary,
  type PIIBoundaryConsumer,
  type PIIBoundaryContext,
  type PIIBoundaryMessage,
  type PIIBoundaryRenderOptions,
  type PIIBoundaryTraceEvent,
  type PIIRedactionBoundaryConfig,
} from './pii-boundary.js';

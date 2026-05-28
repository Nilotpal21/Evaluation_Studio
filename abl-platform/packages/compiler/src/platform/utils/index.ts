/**
 * Platform Utilities
 */

export * from './entity-extraction.js';
export { extractDatesFromText } from './date-extraction.js';
export type { ExtractedDate, DateExtractionOptions } from './date-extraction.js';
export { extractPhoneFromText } from './phone-extraction.js';
export type { ExtractedPhone } from './phone-extraction.js';
export {
  convertValue,
  isConversionSupported,
  listSupportedConversions,
} from './unit-conversion.js';

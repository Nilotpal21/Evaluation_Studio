/**
 * Canonical Mapping Service
 *
 * Exports the CanonicalMapperService for applying three-layer schema architecture.
 */

export {
  getCanonicalMapperService,
  CanonicalMapperService,
  cacheMetrics,
  type TransformContext,
  type MappingResult,
} from './canonical-mapper.service.js';

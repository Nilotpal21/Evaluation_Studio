/**
 * Crawl Intelligence Module
 *
 * 4-phase intelligence loop for autonomous web content extraction:
 * 1. MAP+INTENT — filter URLs by user intent
 * 2. UNDERSTAND — browse and analyze page structure
 * 3. BUILD HANDLER — generate extraction recipe
 * 4. REPLAY — mechanically execute handler
 */

export * from './types.js';
export * from './prompts.js';
export {
  CrawlIntelligenceService,
  type CrawlIntelligenceServiceDeps,
} from './crawl-intelligence-service.js';
// Re-export algorithms
export {
  FailureScorer,
  type FailureSignal,
  type FailureScoreResult,
  type FailureSignalName,
  type FailureScorerConfig,
} from './algorithms/failure-scorer.js';
export {
  TemplateFingerprinter,
  type TemplateFingerprint,
  type TemplateCluster,
  type TemplateMatchResult,
  type ClusteringResult,
  type NormalizationConfig,
} from './algorithms/template-fingerprinter.js';
export {
  IntentDecomposer,
  type SubIntent,
  type UrlCluster,
  type DecompositionResult,
  type IntentDecomposerConfig,
} from './algorithms/intent-decomposer.js';
export {
  HandlerReuser,
  type TemplateHandlerEntry,
  type HandlerReuserConfig,
  type HandlerMatchResult,
  type ExtractionQuality,
  type HandlerReuseResult,
} from './algorithms/handler-reuser.js';
export {
  QualityGate,
  type QualityGateConfig,
  type QualityGateResult,
  type QualitySignal,
} from './algorithms/quality-gate.js';
export {
  UrlClusterer,
  type UrlGroup,
  type UrlClusterConfig,
  type UrlClusterResult,
} from './algorithms/url-clusterer.js';
export {
  PaginationDetector,
  type PaginationResult,
  type PaginationDetectorConfig,
} from './algorithms/pagination-detector.js';
export {
  HttpAdapter,
  type HttpFetchConfig,
  type HttpFetchResult,
} from './algorithms/http-adapter.js';
export {
  LinkScorer,
  type ScoredLink,
  type LinkSignal,
  type LinkScorerConfig,
} from './algorithms/link-scorer.js';
export {
  InteractiveDetector,
  type InteractiveDetectorConfig,
  type InteractiveResult,
  type InteractiveElement,
} from './algorithms/interactive-detector.js';
export {
  JsonLdExtractor,
  type JsonLdData,
  type JsonLdExtractionResult,
  type JsonLdExtractorConfig,
} from './algorithms/jsonld-extractor.js';
export { type CrawlResult, type CrawlResultLink, createCrawlResult } from './algorithms/types.js';
export {
  PlatformDetector,
  type PlatformDetectorConfig,
  type PlatformResult,
  type PlatformSignal,
} from './algorithms/platform-detector.js';
export {
  DiscoveryChain,
  type DiscoveryResult,
  type DiscoveryStep,
  type DiscoveryChainConfig,
} from './algorithms/discovery-chain.js';

// Re-export shared utils
export * from './utils/index.js';

// Handler store
export {
  type IHandlerStore,
  type SaveHandlerInput,
  type StoredHandler,
  HandlerStoreError,
  MongoHandlerStore,
  type HandlerTemplateModel,
  type HandlerTemplateDoc,
} from './handler-store/index.js';

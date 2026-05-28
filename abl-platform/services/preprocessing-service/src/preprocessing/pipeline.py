"""
Preprocessing Pipeline

Orchestrates language detection, spell correction, synonym expansion,
and entity extraction stages.
"""

import time
import logging
from typing import Dict, Any, Optional

from .models import PreprocessingConfig, PreprocessingResult
from .language_detector import LanguageDetector
from .spell_corrector import SpellCorrector
from .synonym_expander import SynonymExpander
from .entity_extractor import EntityExtractor
from ..cache.redis_cache import RedisCache

logger = logging.getLogger(__name__)


class PreprocessingPipeline:
    """
    Multilingual query preprocessing pipeline

    Stages:
    1. Language Detection (langdetect - 55 languages)
    2. Spell Correction (pyspellchecker - 20+ languages)
    3. Synonym Expansion (NLTK OMW - 30+ languages)
    4. Entity Extraction (regex + dateutil)
    """

    def __init__(self, cache: Optional[RedisCache] = None):
        """Initialize pipeline with all stages"""
        self.cache = cache

        # Initialize stages
        self.language_detector = LanguageDetector()
        self.spell_corrector = SpellCorrector()
        self.synonym_expander = SynonymExpander()
        self.entity_extractor = EntityExtractor()

        logger.info("Preprocessing pipeline initialized")

    def process(
        self,
        query: str,
        tenant_id: str,
        config: Optional[Dict[str, Any]] = None
    ) -> PreprocessingResult:
        """
        Process a query through all enabled stages

        Args:
            query: Input query string
            tenant_id: Tenant identifier
            config: Optional preprocessing configuration

        Returns:
            PreprocessingResult with processed query and metadata
        """
        start_time = time.time()

        # Parse config
        config_obj = PreprocessingConfig(**(config or {}))

        # Check cache
        cache_key = f"preprocess:{tenant_id}:{hash(query)}:{hash(str(config))}"
        if self.cache:
            cached = self.cache.get(cache_key)
            if cached:
                logger.info(f"Cache hit for query: {query[:50]}")
                return PreprocessingResult(**cached)

        # Initialize result
        result = PreprocessingResult(
            processedQuery=query,
            language='en',
            confidence=0.0,
            stages={
                'spellCorrection': [],
                'synonymExpansion': [],
                'entities': []
            },
            metadata={
                'originalQuery': query,
                'processingTimeMs': 0.0,
                'stagesExecuted': []
            }
        )

        processed_query = query
        stages_executed = []

        try:
            # Stage 1: Language Detection (always executed)
            language, confidence = self.language_detector.detect(query)
            result.language = language
            result.confidence = confidence
            stages_executed.append('language_detection')
            logger.debug(f"Detected language: {language} (confidence: {confidence})")

            # Load tenant dictionary (if available)
            tenant_dict = self._load_tenant_dictionary(tenant_id)

            # Stage 2: Spell Correction
            if config_obj.enable_spell_correction:
                corrections = self.spell_corrector.correct(
                    text=processed_query,
                    language=language,
                    tenant_corrections=tenant_dict.get('corrections') if tenant_dict else None
                )
                result.stages['spellCorrection'] = [c.model_dump() for c in corrections]

                # Apply corrections to query
                for correction in corrections:
                    processed_query = processed_query.replace(
                        correction.original,
                        correction.corrected
                    )

                stages_executed.append('spell_correction')
                logger.debug(f"Applied {len(corrections)} spell corrections")

            # Stage 3: Synonym Expansion
            if config_obj.enable_synonym_expansion:
                expansions = self.synonym_expander.expand(
                    text=processed_query,
                    language=language,
                    max_synonyms=config_obj.max_synonyms,
                    tenant_synonyms=tenant_dict.get('synonyms') if tenant_dict else None,
                    tenant_abbreviations=tenant_dict.get('abbreviations') if tenant_dict else None
                )
                result.stages['synonymExpansion'] = [e.model_dump() for e in expansions]
                stages_executed.append('synonym_expansion')
                logger.debug(f"Found {len(expansions)} synonym expansions")

            # Stage 4: Entity Extraction
            if config_obj.enable_entity_extraction:
                entities = self.entity_extractor.extract(
                    text=processed_query,
                    language=language,
                    custom_patterns=tenant_dict.get('entity_patterns') if tenant_dict else None
                )
                result.stages['entities'] = [e.model_dump() for e in entities]
                stages_executed.append('entity_extraction')
                logger.debug(f"Extracted {len(entities)} entities")

            # Update result
            result.processed_query = processed_query
            result.metadata['stagesExecuted'] = stages_executed

        except Exception as e:
            logger.error(f"Pipeline processing error: {e}", exc_info=True)
            # Return partial result with error metadata
            result.metadata['error'] = str(e)
            result.metadata['stagesExecuted'] = stages_executed

        # Record processing time
        processing_time_ms = (time.time() - start_time) * 1000
        result.metadata['processingTimeMs'] = round(processing_time_ms, 2)

        # Cache result
        if self.cache and not result.metadata.get('error'):
            self.cache.set(cache_key, result.model_dump(), ttl=3600)  # 1 hour TTL

        return result

    def _load_tenant_dictionary(self, tenant_id: str) -> Optional[Dict[str, Any]]:
        """Load tenant-specific dictionary from cache or database"""
        if not self.cache:
            return None

        cache_key = f"tenant_dict:{tenant_id}"
        tenant_dict = self.cache.get(cache_key)

        if tenant_dict:
            logger.debug(f"Loaded tenant dictionary for {tenant_id}")
            return tenant_dict

        # TODO: Load from database if not in cache
        # For now, return None (will use platform defaults)
        return None

"""
High-quality language detection with mixed-language content handling.

Implements hierarchical detection strategy:
1. Quick detection with fasttext (if >95% confident, done)
2. Multi-sample analysis for mixed content (10 chunks, weighted voting)
3. High-accuracy lingua detection for uncertain cases
4. Unicode script analysis as fallback

Handles documents with foreign words (e.g., English terms in Chinese documents).
"""

import re
import logging
import hashlib
import unicodedata
from collections import Counter
from functools import lru_cache
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Conditional imports for language detection libraries
FASTTEXT_AVAILABLE = False
LINGUA_AVAILABLE = False

try:
    import fasttext
    FASTTEXT_AVAILABLE = True
except ImportError:
    logger.warning("fasttext not available - language detection will be limited")

try:
    from lingua import Language, LanguageDetectorBuilder
    LINGUA_AVAILABLE = True
except ImportError:
    logger.warning("lingua-language-detector not available - using fallback detection only")


class LanguageDetector:
    """
    High-quality language detection with mixed-language content handling.

    Uses hierarchical strategy:
    - fasttext for quick detection
    - Multi-sample voting for mixed content
    - lingua for high-accuracy definitive detection
    - Unicode script analysis as fallback
    """

    # Confidence thresholds
    CONFIDENT_THRESHOLD = 0.95   # If fasttext is this confident, skip lingua
    MIN_TEXT_LENGTH = 50         # Minimum text length for reliable detection
    SECONDARY_THRESHOLD = 0.10   # Minimum confidence for secondary languages

    def __init__(self):
        """Initialize language detection models."""
        self.fasttext_model = None
        self.lingua_detector = None

        # Try to load fasttext model (fast detection)
        if FASTTEXT_AVAILABLE:
            try:
                import os
                # Load from baked path first (Docker image pre-downloads to /opt/models/fasttext/)
                # Falls back to CWD for local development
                lid_model_path = os.environ.get(
                    'FASTTEXT_LID_MODEL_PATH',
                    '/opt/models/fasttext/lid.176.bin'
                )
                if os.path.exists(lid_model_path):
                    self.fasttext_model = fasttext.load_model(lid_model_path)
                    logger.info(f"fasttext model loaded from: {lid_model_path}")
                elif os.path.exists('lid.176.bin'):
                    self.fasttext_model = fasttext.load_model('lid.176.bin')
                    logger.info("fasttext model loaded from CWD")
                else:
                    logger.warning(
                        f"fasttext lid.176.bin not found at {lid_model_path} or CWD. "
                        "Language detection will use lingua/fallback only."
                    )
            except Exception as e:
                logger.warning(f"Failed to load fasttext model: {e}")

        # Build lingua detector (high accuracy, slower)
        if LINGUA_AVAILABLE:
            try:
                # Build detector with common languages for faster initialization
                # Full list: from_all_languages(), but that's slow to initialize
                self.lingua_detector = LanguageDetectorBuilder.from_languages(
                    Language.ENGLISH,
                    Language.SPANISH,
                    Language.FRENCH,
                    Language.GERMAN,
                    Language.ITALIAN,
                    Language.PORTUGUESE,
                    Language.CHINESE,
                    Language.JAPANESE,
                    Language.KOREAN,
                    Language.ARABIC,
                    Language.RUSSIAN,
                    Language.HINDI,
                    Language.DUTCH,
                    Language.POLISH,
                    Language.TURKISH,
                    Language.SWEDISH,
                    Language.INDONESIAN,
                    Language.THAI,
                    Language.VIETNAMESE,
                    Language.HEBREW,
                ).build()
                logger.info("lingua detector initialized successfully")
            except Exception as e:
                logger.error(f"Failed to initialize lingua detector: {e}")

    def detect_document_language(
        self,
        text: str,
        sample_chunks: bool = True
    ) -> Dict:
        """
        Detect document language with mixed-content handling.

        Args:
            text: Full document text
            sample_chunks: If True, sample multiple chunks for voting

        Returns:
            {
                "primary": "en",
                "confidence": 0.97,
                "secondary": [{"lang": "fr", "confidence": 0.15}],
                "script": "Latin",
                "method": "fasttext-confident" | "sampling-voted" | "lingua-definitive" | "script-fallback"
            }
        """
        if len(text) < self.MIN_TEXT_LENGTH:
            return self._fallback_detection(text)

        # Preprocess text (remove code blocks, URLs, etc.)
        text_clean = self._preprocess_for_detection(text)

        if len(text_clean) < self.MIN_TEXT_LENGTH:
            return self._fallback_detection(text)

        # Step 1: Quick detection with fasttext
        if self.fasttext_model:
            fasttext_result = self._detect_fasttext(text_clean[:1000])

            if fasttext_result['confidence'] > self.CONFIDENT_THRESHOLD:
                # High confidence - use fasttext result
                return {
                    "primary": fasttext_result['lang'],
                    "confidence": round(fasttext_result['confidence'], 3),
                    "secondary": [],
                    "script": self._detect_script(text[:500]),
                    "method": "fasttext-confident"
                }

        # Step 2: Multi-sample analysis for mixed content
        if sample_chunks and len(text_clean) > 5000:
            return self._detect_with_sampling(text_clean)

        # Step 3: High-accuracy detection with lingua
        if self.lingua_detector:
            return self._detect_with_lingua(text_clean)

        # Step 4: Fallback to script detection
        return self._fallback_detection(text)

    @lru_cache(maxsize=1000)
    def detect_cached(self, text_hash: str, text_sample: str) -> Dict:
        """
        Cached detection based on content hash.

        Args:
            text_hash: MD5 hash of text for cache key
            text_sample: Sample text to detect (first 5000 chars)

        Returns:
            Detection result dict
        """
        return self.detect_document_language(text_sample, sample_chunks=True)

    def detect_with_cache(self, text: str) -> Dict:
        """
        Detect language with caching.

        Args:
            text: Full document text

        Returns:
            Detection result dict
        """
        # Hash first 5000 chars for cache key
        sample = text[:5000]
        text_hash = hashlib.md5(sample.encode()).hexdigest()
        return self.detect_cached(text_hash, sample)

    def _preprocess_for_detection(self, text: str) -> str:
        """
        Remove code blocks and other non-prose content before detection.

        Args:
            text: Raw text

        Returns:
            Cleaned text suitable for language detection
        """
        # Remove code fences (```...```)
        text = re.sub(r'```[\s\S]*?```', ' ', text)

        # Remove inline code (`...`)
        text = re.sub(r'`[^`]+`', ' ', text)

        # Remove URLs
        text = re.sub(r'https?://\S+', ' ', text)

        # Remove email addresses
        text = re.sub(r'\S+@\S+', ' ', text)

        # Normalize whitespace
        text = re.sub(r'\s+', ' ', text)

        return text.strip()

    def _detect_fasttext(self, text: str) -> Dict:
        """
        Fast detection using fasttext.

        Args:
            text: Text sample to detect

        Returns:
            {"lang": "en", "confidence": 0.95}
        """
        if not self.fasttext_model:
            return {"lang": "unknown", "confidence": 0.0}

        text_clean = text.replace('\n', ' ').strip()
        if not text_clean:
            return {"lang": "unknown", "confidence": 0.0}

        try:
            predictions = self.fasttext_model.predict(text_clean, k=1)
            labels, confidences = predictions

            # Parse fasttext labels (__label__en -> en)
            primary_lang = labels[0].replace('__label__', '')
            primary_conf = float(confidences[0])

            return {
                "lang": primary_lang,
                "confidence": primary_conf
            }
        except Exception as e:
            logger.error(f"fasttext detection error: {e}")
            return {"lang": "unknown", "confidence": 0.0}

    def _detect_with_sampling(self, text: str) -> Dict:
        """
        Sample multiple chunks and vote on language.
        Handles mixed-language documents (e.g., English terms in Chinese docs).

        Args:
            text: Full text to analyze

        Returns:
            Detection result with primary and secondary languages
        """
        # Sample 10 chunks evenly distributed throughout document
        chunk_size = len(text) // 10
        samples = []

        for i in range(10):
            start = i * chunk_size
            end = start + min(chunk_size, 500)  # Max 500 chars per sample
            if end <= len(text):
                samples.append(text[start:end])

        # Detect language for each sample
        votes = []
        for sample in samples:
            if self.fasttext_model:
                result = self._detect_fasttext(sample)
                if result['confidence'] > 0.5:  # Only count confident detections
                    votes.append((result['lang'], result['confidence']))

        # Vote with confidence weighting
        if not votes:
            if self.lingua_detector:
                return self._detect_with_lingua(text)
            return self._fallback_detection(text)

        lang_scores = Counter()
        for lang, conf in votes:
            lang_scores[lang] += conf

        # Primary language = most votes
        primary_lang, primary_score = lang_scores.most_common(1)[0]
        total_score = sum(lang_scores.values())
        primary_confidence = primary_score / total_score if total_score > 0 else 0

        # Secondary languages (above threshold)
        secondary = []
        for lang, score in lang_scores.most_common(5):
            if lang != primary_lang:
                conf = score / total_score
                if conf > self.SECONDARY_THRESHOLD:
                    secondary.append({"lang": lang, "confidence": round(conf, 3)})

        return {
            "primary": primary_lang,
            "confidence": round(primary_confidence, 3),
            "secondary": secondary,
            "script": self._detect_script(text[:500]),
            "method": "sampling-voted"
        }

    def _detect_with_lingua(self, text: str) -> Dict:
        """
        High-accuracy detection using lingua.
        Slower but more accurate for uncertain cases.

        Args:
            text: Text to detect (uses first 5000 chars)

        Returns:
            Detection result with primary and secondary languages
        """
        if not self.lingua_detector:
            return self._fallback_detection(text)

        try:
            # Get top language predictions with confidence values
            sample = text[:5000]  # Limit for performance
            confidences = self.lingua_detector.compute_language_confidence_values(sample)

            if not confidences:
                return self._fallback_detection(text)

            # Sort by confidence
            sorted_langs = sorted(confidences, key=lambda x: x.value, reverse=True)

            primary = sorted_langs[0]

            # Get ISO 639-1 code (2-letter code)
            primary_code = primary.language.iso_code_639_1.name.lower()

            # Secondary languages
            secondary = []
            for lang in sorted_langs[1:4]:
                if lang.value > 0.05:  # At least 5% confidence
                    lang_code = lang.language.iso_code_639_1.name.lower()
                    secondary.append({
                        "lang": lang_code,
                        "confidence": round(lang.value, 3)
                    })

            return {
                "primary": primary_code,
                "confidence": round(primary.value, 3),
                "secondary": secondary,
                "script": self._detect_script(text[:500]),
                "method": "lingua-definitive"
            }
        except Exception as e:
            logger.error(f"lingua detection error: {e}")
            return self._fallback_detection(text)

    def _detect_script(self, text: str) -> str:
        """
        Detect Unicode script (Latin, CJK, Arabic, Cyrillic, etc.).
        Very fast and reliable for script-specific languages.

        Args:
            text: Text sample

        Returns:
            Script name (e.g., "Latin", "CJK", "Arabic")
        """
        script_counts = Counter()

        for char in text:
            if char.isspace() or not char.isalpha():
                continue
            try:
                script = unicodedata.name(char, '').split()[0]
                script_counts[script] += 1
            except (ValueError, IndexError):
                continue

        if not script_counts:
            return "Unknown"

        dominant_script = script_counts.most_common(1)[0][0]

        # Map Unicode script names to readable names
        script_map = {
            "CJK": "CJK",
            "ARABIC": "Arabic",
            "CYRILLIC": "Cyrillic",
            "LATIN": "Latin",
            "DEVANAGARI": "Devanagari",
            "HANGUL": "Hangul",
            "HIRAGANA": "Japanese",
            "KATAKANA": "Japanese",
            "THAI": "Thai",
            "HEBREW": "Hebrew",
            "BENGALI": "Bengali",
        }

        for key, value in script_map.items():
            if key in dominant_script:
                return value

        return "Latin"  # Default

    def _fallback_detection(self, text: str) -> Dict:
        """
        Fallback detection for very short text or when all models fail.
        Uses script analysis to guess language.

        Args:
            text: Text sample

        Returns:
            Detection result with low confidence
        """
        script = self._detect_script(text)

        # Use script to guess language
        script_to_lang = {
            "Arabic": "ar",
            "Hebrew": "he",
            "Cyrillic": "ru",
            "CJK": "zh",  # Default to Chinese
            "Hangul": "ko",
            "Japanese": "ja",
            "Devanagari": "hi",
            "Thai": "th",
            "Bengali": "bn",
        }

        primary = script_to_lang.get(script, "en")  # Default to English

        return {
            "primary": primary,
            "confidence": 0.6,  # Low confidence
            "secondary": [],
            "script": script,
            "method": "script-fallback"
        }


# Global singleton instance
_detector_instance: Optional[LanguageDetector] = None


def get_language_detector() -> LanguageDetector:
    """
    Get or create the global LanguageDetector singleton.

    Returns:
        LanguageDetector instance
    """
    global _detector_instance
    if _detector_instance is None:
        _detector_instance = LanguageDetector()
    return _detector_instance

"""
Spell Correction

Uses pyspellchecker for multilingual spell correction (20+ languages).
Falls back to tenant-specific corrections before using spellchecker.
"""

import logging
import re
from typing import List, Dict, Optional
from spellchecker import SpellChecker

from .models import SpellCorrection

logger = logging.getLogger(__name__)


class SpellCorrector:
    """
    Multilingual spell correction using pyspellchecker

    Supports: en, es, de, fr, pt, ru, ar, lv, eu, nl, it, tr
    Latency: 1-3ms per query
    """

    # Supported languages mapping (pyspellchecker language codes)
    SUPPORTED_LANGUAGES = {
        'en': 'en',
        'es': 'es',
        'de': 'de',
        'fr': 'fr',
        'pt': 'pt',
        'ru': 'ru',
        'ar': 'ar',
        'lv': 'lv',
        'eu': 'eu',
        'nl': 'nl',
        'it': 'it',
        'tr': 'tr'
    }

    def __init__(self):
        """Initialize spell corrector with language-specific checkers"""
        self._checkers: Dict[str, SpellChecker] = {}

        # Pre-load English checker (most common)
        self._checkers['en'] = SpellChecker(language='en')

        logger.info("Spell corrector initialized (English pre-loaded)")

    def correct(
        self,
        text: str,
        language: str,
        tenant_corrections: Optional[Dict[str, str]] = None
    ) -> List[SpellCorrection]:
        """
        Correct spelling errors in text

        Args:
            text: Input text
            language: Language code (e.g., 'en', 'es')
            tenant_corrections: Optional tenant-specific corrections

        Returns:
            List of SpellCorrection objects

        Priority:
        1. Tenant corrections (highest)
        2. Spellchecker corrections
        """
        corrections = []

        # Check if language is supported
        if language not in self.SUPPORTED_LANGUAGES:
            logger.debug(f"Language {language} not supported for spell correction")
            return corrections

        # Get or create spell checker for language
        checker = self._get_checker(language)

        # Tokenize text (preserve original positions)
        tokens = self._tokenize(text)

        # Minimum confidence to apply a correction (prevents bad corrections).
        # Higher threshold = fewer false positives but misses some real typos.
        # 0.85 means only corrections with ≤15% character change are applied.
        MIN_CONFIDENCE = 0.85

        for token in tokens:
            word = token['word']
            word_lower = word.lower()

            # Skip short words (< 3 chars) and numbers
            if len(word) < 3 or word.isdigit():
                continue

            # Skip capitalized words (likely proper nouns: Mehta, OpenSearch, etc.)
            if word[0].isupper() and len(word) > 1:
                continue

            # Skip words with mixed case (CamelCase: RamGopal, JavaScript, etc.)
            if any(c.isupper() for c in word[1:]):
                continue

            # Priority 1: Check tenant corrections
            if tenant_corrections and word_lower in tenant_corrections:
                corrected = tenant_corrections[word_lower]
                if corrected != word_lower:
                    corrections.append(SpellCorrection(
                        original=word,
                        corrected=corrected,
                        confidence=1.0,
                        source='tenant_dict'
                    ))
                    logger.debug(f"Tenant correction: {word} -> {corrected}")
                continue

            # Priority 2: Check spellchecker
            if word_lower in checker:
                # Word is correct
                continue

            # Get correction candidate (closest by edit distance)
            corrected = checker.correction(word_lower)
            if corrected and corrected != word_lower:
                confidence = self._calculate_confidence(word_lower, corrected)
                # Only apply high-confidence corrections
                if confidence >= MIN_CONFIDENCE:
                    corrections.append(SpellCorrection(
                        original=word,
                        corrected=corrected,
                        confidence=confidence,
                        source='spellchecker'
                    ))
                    logger.debug(f"Spell correction: {word} -> {corrected} ({confidence})")

        return corrections

    def _get_checker(self, language: str) -> SpellChecker:
        """
        Get or create spell checker for language

        Args:
            language: Language code

        Returns:
            SpellChecker instance for the language
        """
        if language not in self._checkers:
            spell_lang = self.SUPPORTED_LANGUAGES.get(language, 'en')
            self._checkers[language] = SpellChecker(language=spell_lang)
            logger.info(f"Loaded spell checker for language: {language}")

        return self._checkers[language]

    def _tokenize(self, text: str) -> List[Dict[str, any]]:
        """
        Tokenize text into words with positions

        Args:
            text: Input text

        Returns:
            List of token dictionaries with 'word', 'start', 'end'
        """
        tokens = []
        # Match words (alphanumeric + hyphens)
        for match in re.finditer(r'\b[\w-]+\b', text):
            tokens.append({
                'word': match.group(),
                'start': match.start(),
                'end': match.end()
            })
        return tokens

    def _calculate_confidence(self, original: str, corrected: str) -> float:
        """
        Calculate confidence score based on edit distance

        Args:
            original: Original word
            corrected: Corrected word

        Returns:
            Confidence score (0.0-1.0)
        """
        # Simple Levenshtein distance approximation
        distance = self._levenshtein_distance(original, corrected)
        max_len = max(len(original), len(corrected))

        if max_len == 0:
            return 1.0

        # Confidence decreases with edit distance
        confidence = 1.0 - (distance / max_len)
        return round(max(confidence, 0.5), 2)  # Minimum 0.5 confidence

    @staticmethod
    def _levenshtein_distance(s1: str, s2: str) -> int:
        """
        Calculate Levenshtein distance between two strings

        Args:
            s1: First string
            s2: Second string

        Returns:
            Edit distance
        """
        if len(s1) < len(s2):
            return SpellCorrector._levenshtein_distance(s2, s1)

        if len(s2) == 0:
            return len(s1)

        previous_row = range(len(s2) + 1)
        for i, c1 in enumerate(s1):
            current_row = [i + 1]
            for j, c2 in enumerate(s2):
                # Cost of insertions, deletions, or substitutions
                insertions = previous_row[j + 1] + 1
                deletions = current_row[j] + 1
                substitutions = previous_row[j] + (c1 != c2)
                current_row.append(min(insertions, deletions, substitutions))
            previous_row = current_row

        return previous_row[-1]

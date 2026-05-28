"""
Synonym Expansion

Uses NLTK WordNet and Open Multilingual WordNet (OMW) for synonym expansion.
Supports 30+ languages.
"""

import logging
import re
from typing import List, Dict, Optional, Set
import nltk
from nltk.corpus import wordnet as wn

from .models import SynonymExpansion

logger = logging.getLogger(__name__)

# Download required NLTK data on first import
try:
    wn.synsets('test')  # Test if WordNet is available
except LookupError:
    logger.info("Downloading NLTK WordNet data...")
    nltk.download('wordnet', quiet=True)
    nltk.download('omw-1.4', quiet=True)  # Open Multilingual WordNet
    logger.info("NLTK data downloaded")


class SynonymExpander:
    """
    Multilingual synonym expansion using NLTK WordNet + OMW

    Supports 30+ languages via Open Multilingual WordNet.
    Latency: 0.5-1ms per query
    """

    # Language code mapping (NLTK uses ISO 639-3 codes)
    LANG_MAP = {
        'en': 'eng',
        'es': 'spa',
        'fr': 'fra',
        'de': 'deu',
        'it': 'ita',
        'nl': 'nld',
        'pt': 'por',
        'ru': 'rus',
        'ja': 'jpn',
        'zh': 'cmn',  # Chinese Mandarin
        'ar': 'arb',  # Arabic
        'fa': 'fas',  # Farsi
        'pl': 'pol',
        'no': 'nob',  # Norwegian Bokmål
        'fi': 'fin',
        'da': 'dan',
        'sv': 'swe',
        'el': 'ell',  # Greek
        'he': 'heb',
        'id': 'ind',
        'th': 'tha',
        'ro': 'ron',
        'bg': 'bul',
        'sk': 'slk',
        'sl': 'slv',
        'hr': 'hrv',
        'ca': 'cat',
        'eu': 'eus',
        'gl': 'glg',
        'lt': 'lit',
        'lv': 'lav',
        'et': 'est'
    }

    def __init__(self):
        """Initialize synonym expander"""
        logger.info("Synonym expander initialized with WordNet + OMW")

    def expand(
        self,
        text: str,
        language: str,
        max_synonyms: int = 3,
        tenant_synonyms: Optional[Dict[str, List[str]]] = None,
        tenant_abbreviations: Optional[Dict[str, str]] = None
    ) -> List[SynonymExpansion]:
        """
        Expand terms with synonyms

        Args:
            text: Input text
            language: Language code (e.g., 'en', 'es')
            max_synonyms: Maximum synonyms per term
            tenant_synonyms: Optional tenant-specific synonyms
            tenant_abbreviations: Optional tenant abbreviations

        Returns:
            List of SynonymExpansion objects

        Priority:
        1. Tenant abbreviations (highest - domain shortcuts)
        2. Tenant synonyms
        3. WordNet synonyms
        """
        expansions = []

        # Get WordNet language code
        wn_lang = self.LANG_MAP.get(language, 'eng')

        # Tokenize text
        tokens = self._tokenize(text)

        for token in tokens:
            word = token['word']
            word_lower = word.lower()

            # Skip short words (< 3 chars) and numbers
            if len(word) < 3 or word.isdigit():
                continue

            synonyms_found: Set[str] = set()
            source = 'none'

            # Priority 1: Check tenant abbreviations (k8s -> kubernetes)
            if tenant_abbreviations and word_lower in tenant_abbreviations:
                expansion = tenant_abbreviations[word_lower]
                synonyms_found.add(expansion)
                source = 'abbreviation'
                logger.debug(f"Abbreviation expansion: {word} -> {expansion}")

            # Priority 2: Check tenant synonyms
            elif tenant_synonyms and word_lower in tenant_synonyms:
                synonyms_found.update(tenant_synonyms[word_lower][:max_synonyms])
                source = 'tenant_dict'
                logger.debug(f"Tenant synonyms: {word} -> {synonyms_found}")

            # Priority 3: Check WordNet
            else:
                wn_synonyms = self._get_wordnet_synonyms(word_lower, wn_lang, max_synonyms)
                if wn_synonyms:
                    synonyms_found.update(wn_synonyms)
                    source = 'wordnet'
                    logger.debug(f"WordNet synonyms: {word} -> {wn_synonyms}")

            # Add expansion if synonyms found
            if synonyms_found:
                # Remove the original word from synonyms
                synonyms_found.discard(word_lower)

                if synonyms_found:
                    expansions.append(SynonymExpansion(
                        term=word,
                        synonyms=list(synonyms_found)[:max_synonyms],
                        source=source
                    ))

        return expansions

    def _get_wordnet_synonyms(
        self,
        word: str,
        language: str,
        max_synonyms: int
    ) -> List[str]:
        """
        Get synonyms from WordNet for a word

        Args:
            word: Word to find synonyms for
            language: WordNet language code (e.g., 'eng', 'spa')
            max_synonyms: Maximum synonyms to return

        Returns:
            List of synonyms
        """
        synonyms = set()

        try:
            # Get synsets for the word in the specified language
            synsets = wn.synsets(word, lang=language)

            # Extract lemmas (synonyms) from synsets
            for synset in synsets[:2]:  # Limit to first 2 synsets (most common meanings)
                for lemma in synset.lemmas(lang=language):
                    synonym = lemma.name()

                    # Clean up synonym (replace underscores)
                    synonym = synonym.replace('_', ' ')

                    # Skip multi-word synonyms if original is single word
                    if ' ' not in word and ' ' in synonym:
                        continue

                    synonyms.add(synonym)

                    if len(synonyms) >= max_synonyms:
                        break

                if len(synonyms) >= max_synonyms:
                    break

        except Exception as e:
            logger.debug(f"WordNet lookup failed for '{word}': {e}")

        return list(synonyms)

    def _tokenize(self, text: str) -> List[Dict[str, any]]:
        """
        Tokenize text into words

        Args:
            text: Input text

        Returns:
            List of token dictionaries with 'word', 'start', 'end'
        """
        tokens = []
        # Match words (alphanumeric + hyphens, allows abbreviations like k8s)
        for match in re.finditer(r'\b[\w-]+\b', text):
            tokens.append({
                'word': match.group(),
                'start': match.start(),
                'end': match.end()
            })
        return tokens

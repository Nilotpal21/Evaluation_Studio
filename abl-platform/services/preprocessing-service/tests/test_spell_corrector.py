"""
Tests for spell correction
"""

import pytest
from src.preprocessing.spell_corrector import SpellCorrector
from src.preprocessing.models import SpellCorrection


class TestSpellCorrector:
    """Test spell correction functionality"""

    @pytest.fixture
    def corrector(self):
        """Create spell corrector instance"""
        return SpellCorrector()

    def test_correct_english_misspelling(self, corrector):
        """Test English spell correction"""
        # Use common misspellings that are definitely in the dictionary
        text = "recieve the mesage from the server"
        corrections = corrector.correct(text, 'en')

        # Should find corrections for "recieve" and "mesage"
        assert len(corrections) >= 2
        corrected_words = [c.original for c in corrections]
        assert 'recieve' in corrected_words
        assert 'mesage' in corrected_words

    def test_correct_spanish_misspelling(self, corrector):
        """Test Spanish spell correction"""
        text = "despliegue de aplicacin en el servidor"
        corrections = corrector.correct(text, 'es')

        assert len(corrections) >= 1
        assert any(c.original == 'aplicacin' for c in corrections)
        assert all(c.source == 'spellchecker' for c in corrections)

    def test_no_corrections_for_correct_text(self, corrector):
        """Test that correct text returns no corrections"""
        text = "the quick brown fox jumps over the lazy dog"
        corrections = corrector.correct(text, 'en')

        assert len(corrections) == 0

    def test_tenant_corrections_priority(self, corrector):
        """Test tenant corrections take priority over spellchecker"""
        text = "kubes deployment"
        tenant_corrections = {
            'kubes': 'kubernetes'
        }
        corrections = corrector.correct(text, 'en', tenant_corrections)

        assert len(corrections) == 1
        assert corrections[0].original == 'kubes'
        assert corrections[0].corrected == 'kubernetes'
        assert corrections[0].source == 'tenant_dict'
        assert corrections[0].confidence == 1.0

    def test_skip_short_words(self, corrector):
        """Test that short words are skipped"""
        text = "a b cd efg hijk"
        corrections = corrector.correct(text, 'en')

        # Should skip 'a', 'b', 'cd' (< 3 chars)
        assert all(len(c.original) >= 3 for c in corrections)

    def test_skip_numbers(self, corrector):
        """Test that numbers are skipped"""
        text = "deploy 123 containers"
        corrections = corrector.correct(text, 'en')

        # Should not try to correct numbers
        assert not any('123' in c.original for c in corrections)

    def test_confidence_score(self, corrector):
        """Test confidence scores are calculated"""
        # Use a common misspelling
        text = "recieve the mesage"
        corrections = corrector.correct(text, 'en')

        assert len(corrections) >= 1
        for correction in corrections:
            assert 0.5 <= correction.confidence <= 1.0

    def test_unsupported_language_returns_empty(self, corrector):
        """Test unsupported language returns no corrections"""
        text = "some text with typos"
        corrections = corrector.correct(text, 'xx')  # Invalid language

        assert len(corrections) == 0

    def test_tech_terms_with_tenant_dict(self, corrector):
        """Test that tech terms work with tenant dictionaries"""
        text = "kuberntes and docekr deployment"
        tenant_corrections = {
            'kuberntes': 'kubernetes',
            'docekr': 'docker'
        }
        corrections = corrector.correct(text, 'en', tenant_corrections)

        assert len(corrections) == 2
        assert any(c.original == 'kuberntes' and c.corrected == 'kubernetes' for c in corrections)
        assert any(c.original == 'docekr' and c.corrected == 'docker' for c in corrections)
        assert all(c.source == 'tenant_dict' for c in corrections)

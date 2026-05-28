"""
Tests for language detection
"""

import pytest
from src.preprocessing.language_detector import LanguageDetector


class TestLanguageDetector:
    """Test language detection functionality"""

    @pytest.fixture
    def detector(self):
        """Create language detector instance"""
        return LanguageDetector()

    def test_detect_english(self, detector):
        """Test English language detection"""
        text = "This is an English text about kubernetes deployment"
        language, confidence = detector.detect(text)

        assert language == 'en'
        assert confidence > 0.9

    def test_detect_spanish(self, detector):
        """Test Spanish language detection"""
        text = "Este es un texto en español sobre despliegue de kubernetes"
        language, confidence = detector.detect(text)

        assert language == 'es'
        assert confidence > 0.9

    def test_detect_german(self, detector):
        """Test German language detection"""
        text = "Dies ist ein deutscher Text über Kubernetes-Bereitstellung"
        language, confidence = detector.detect(text)

        assert language == 'de'
        assert confidence > 0.9

    def test_detect_french(self, detector):
        """Test French language detection"""
        text = "Ceci est un texte français sur le déploiement de kubernetes"
        language, confidence = detector.detect(text)

        assert language == 'fr'
        assert confidence > 0.9

    def test_detect_short_text(self, detector):
        """Test detection on short text"""
        text = "Hello world"
        language, confidence = detector.detect(text)

        # Short text may be detected as various related languages (en, nl, etc.)
        # Just verify it's a supported language with reasonable confidence
        assert language in detector.SUPPORTED_LANGUAGES
        assert confidence >= 0.5

    def test_detect_mixed_language_defaults_to_dominant(self, detector):
        """Test detection on mixed language text"""
        text = "This is mostly English with some español words"
        language, confidence = detector.detect(text)

        assert language == 'en'

    def test_detect_unsupported_language_defaults_to_english(self, detector):
        """Test unsupported language defaults to English"""
        # Use a clearly non-supported language pattern
        # Using Welsh (not in supported list) with more text for reliable detection
        text = "Mae hwn yn destun Cymraeg nad yw yn cael ei gefnogi gennym ni"
        language, confidence = detector.detect(text)

        # Should default to English for unsupported languages
        assert language == 'en'

    def test_is_supported(self, detector):
        """Test language support checking"""
        assert detector.is_supported('en')
        assert detector.is_supported('es')
        assert detector.is_supported('de')
        assert not detector.is_supported('xx')  # Invalid code

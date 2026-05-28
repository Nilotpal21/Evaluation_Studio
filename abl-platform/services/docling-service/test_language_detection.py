"""
Test suite for language detection in document extraction

Tests the integrated language detection system with:
- Automatic detection from document content
- Mixed-language content handling
- Explicit language overrides
- Detection enable/disable flag
- API parameter integration

Validates:
- Language detection accuracy
- Confidence thresholds
- Secondary language detection
- Script detection
- Method reporting
"""

import io
import json
import pytest
from fastapi.testclient import TestClient
from app import app

client = TestClient(app)


# =============================================================================
# TEST DATA
# =============================================================================

ENGLISH_TEXT = """This is a comprehensive English document about machine learning and artificial intelligence.
The field has grown rapidly in recent years with advances in deep learning and neural networks.
Modern AI systems can now perform tasks that were once thought to require human intelligence.
Natural language processing enables machines to understand and generate human language.
Computer vision allows systems to analyze and interpret visual information from the world."""

CHINESE_WITH_ENGLISH = """这是一个关于人工智能和机器学习的技术文档。

## Machine Learning 基础

我们使用 Python 和 TensorFlow 来构建深度学习模型。API endpoint 提供 RESTful 接口访问。
训练数据存储在 MongoDB 数据库中，使用 Redis 进行缓存。

## Deep Learning 架构

神经网络包含多个层，每层进行特征提取和转换。Transformer 模型在自然语言处理领域表现优异。
我们的系统支持 GPU 加速训练，显著提升训练速度。"""

SPANISH_TEXT = """Este es un documento completo en español sobre inteligencia artificial.
La tecnología ha avanzado significativamente en los últimos años.
Los sistemas de aprendizaje automático ahora pueden realizar tareas complejas.
El procesamiento del lenguaje natural permite a las máquinas comprender el texto humano."""

FRENCH_TEXT = """Ceci est un document complet en français sur l'intelligence artificielle.
La technologie a considérablement progressé ces dernières années.
Les systèmes d'apprentissage automatique peuvent maintenant effectuer des tâches complexes.
Le traitement du langage naturel permet aux machines de comprendre le texte humain."""

SHORT_TEXT = "Too short."  # Below minimum threshold


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def create_file_upload(content: str, filename: str, content_type: str):
    """Create a file upload for testing"""
    return {
        'file': (filename, io.BytesIO(content.encode('utf-8')), content_type)
    }


def extract_with_language_detection(
    content: str,
    filename: str = 'test.txt',
    content_type: str = 'text/plain',
    language: str = None,
    detect_language: bool = True
):
    """Helper to call extraction with language detection parameters"""
    files = create_file_upload(content, filename, content_type)

    data = {
        'options': json.dumps({
            'extractImages': False,
            'extractTables': False,
            'preserveLayout': True,
            'renderScreenshots': False,
            'ocrEnabled': False
        })
    }

    # Add optional parameters
    if language is not None:
        data['language'] = language
    if not detect_language:
        data['detectLanguage'] = 'false'  # Form data as string

    response = client.post('/extract', files=files, data=data)
    return response


# =============================================================================
# HEALTH CHECK
# =============================================================================

def test_health_check_shows_language_detection():
    """Health check should report language detection availability"""
    response = client.get('/health')
    assert response.status_code == 200

    data = response.json()
    assert 'features' in data
    assert 'language_detection' in data['features']
    # Should be True if lingua and fasttext are installed
    assert isinstance(data['features']['language_detection'], bool)


# =============================================================================
# AUTOMATIC DETECTION TESTS
# =============================================================================

def test_english_detection():
    """Test automatic English detection"""
    response = extract_with_language_detection(ENGLISH_TEXT)

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert 'language' in metadata

    if metadata['language']:  # Only if detection available
        assert metadata['language'] == 'en'
        assert metadata['languageConfidence'] > 0.8
        assert metadata['languageDetectionMethod'] in [
            'fasttext-confident', 'sampling-voted', 'lingua-definitive', 'script-fallback'
        ]


def test_chinese_with_english_mixed_content():
    """Test detection of Chinese document with English technical terms"""
    response = extract_with_language_detection(CHINESE_WITH_ENGLISH)

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']

    if metadata.get('language'):  # Only if detection available
        # Primary language should be Chinese
        assert metadata['language'] == 'zh'
        assert metadata['languageConfidence'] > 0.6

        # Should detect CJK script
        assert metadata.get('languageScript') == 'CJK'

        # May have English as secondary language
        secondary = metadata.get('secondaryLanguages', [])
        if secondary:
            assert any(lang['lang'] == 'en' for lang in secondary)


def test_spanish_detection():
    """Test Spanish language detection"""
    response = extract_with_language_detection(SPANISH_TEXT)

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']

    if metadata.get('language'):
        assert metadata['language'] == 'es'
        assert metadata['languageConfidence'] > 0.8
        assert metadata.get('languageScript') == 'Latin'


def test_french_detection():
    """Test French language detection"""
    response = extract_with_language_detection(FRENCH_TEXT)

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']

    if metadata.get('language'):
        assert metadata['language'] == 'fr'
        assert metadata['languageConfidence'] > 0.8
        assert metadata.get('languageScript') == 'Latin'


def test_short_text_handling():
    """Test handling of text below minimum threshold"""
    response = extract_with_language_detection(SHORT_TEXT)

    assert response.status_code == 200
    data = response.json()

    # Should still succeed, but may not detect language
    metadata = data['metadata']
    # Language may be None or fallback (en) depending on implementation
    assert metadata.get('language') is None or metadata.get('languageConfidence', 0) < 0.9


# =============================================================================
# EXPLICIT LANGUAGE OVERRIDE TESTS
# =============================================================================

def test_explicit_language_override():
    """Test explicit language parameter overrides auto-detection"""
    response = extract_with_language_detection(
        ENGLISH_TEXT,
        language='fr'  # Override to French
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['language'] == 'fr'  # Should use override
    assert metadata['languageConfidence'] == 1.0  # Perfect confidence
    assert metadata['languageDetectionMethod'] == 'explicit'


def test_explicit_language_chinese():
    """Test explicit Chinese language override"""
    response = extract_with_language_detection(
        ENGLISH_TEXT,
        language='zh'
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['language'] == 'zh'
    assert metadata['languageConfidence'] == 1.0
    assert metadata['languageDetectionMethod'] == 'explicit'


# =============================================================================
# DETECTION ENABLE/DISABLE TESTS
# =============================================================================

def test_detection_disabled():
    """Test detectLanguage=false disables automatic detection"""
    response = extract_with_language_detection(
        ENGLISH_TEXT,
        detect_language=False
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    # Should not detect language
    assert metadata.get('language') is None
    assert metadata.get('languageConfidence') is None
    assert metadata.get('languageDetectionMethod') is None


def test_explicit_language_with_detection_disabled():
    """Test explicit language works even when detection is disabled"""
    response = extract_with_language_detection(
        ENGLISH_TEXT,
        language='es',
        detect_language=False
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    # Explicit override should still work
    assert metadata['language'] == 'es'
    assert metadata['languageConfidence'] == 1.0
    assert metadata['languageDetectionMethod'] == 'explicit'


# =============================================================================
# METADATA STRUCTURE TESTS
# =============================================================================

def test_language_metadata_structure():
    """Test language metadata has correct structure"""
    response = extract_with_language_detection(ENGLISH_TEXT)

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']

    # Check field types
    if metadata.get('language'):
        assert isinstance(metadata['language'], str)
        assert len(metadata['language']) == 2  # ISO 639-1 code

    if metadata.get('languageConfidence'):
        assert isinstance(metadata['languageConfidence'], float)
        assert 0.0 <= metadata['languageConfidence'] <= 1.0

    if metadata.get('languageScript'):
        assert isinstance(metadata['languageScript'], str)

    if metadata.get('languageDetectionMethod'):
        assert isinstance(metadata['languageDetectionMethod'], str)

    if metadata.get('secondaryLanguages'):
        assert isinstance(metadata['secondaryLanguages'], list)
        for lang in metadata['secondaryLanguages']:
            assert 'lang' in lang
            assert 'confidence' in lang
            assert isinstance(lang['lang'], str)
            assert isinstance(lang['confidence'], float)


# =============================================================================
# MULTI-PAGE DETECTION TESTS
# =============================================================================

def test_detection_from_multiple_pages():
    """Test language detection uses sample from multiple pages"""
    # Create longer text that might span multiple chunks
    long_text = '\n\n'.join([ENGLISH_TEXT] * 10)

    response = extract_with_language_detection(long_text)

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']

    if metadata.get('language'):
        assert metadata['language'] == 'en'
        # Should have high confidence even with long text
        assert metadata['languageConfidence'] > 0.8


# =============================================================================
# PERFORMANCE TESTS
# =============================================================================

def test_detection_performance():
    """Test language detection doesn't significantly impact performance"""
    import time

    # Test with detection
    start = time.time()
    response_with = extract_with_language_detection(ENGLISH_TEXT, detect_language=True)
    time_with = time.time() - start

    # Test without detection
    start = time.time()
    response_without = extract_with_language_detection(ENGLISH_TEXT, detect_language=False)
    time_without = time.time() - start

    assert response_with.status_code == 200
    assert response_without.status_code == 200

    # Language detection should add less than 500ms
    time_overhead = time_with - time_without
    assert time_overhead < 0.5, f"Detection overhead too high: {time_overhead:.3f}s"


if __name__ == '__main__':
    pytest.main([__file__, '-v'])

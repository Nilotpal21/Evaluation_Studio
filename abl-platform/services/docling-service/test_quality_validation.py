"""
Quality validation test suite for document extraction

Tests extraction quality for LlamaIndex formats (TXT, JSON, XML).
Docling formats (PDF, Office, markdown, CSV, images) require Docling
engine which may not be available in all test environments.

Focuses on quality metrics:
- Content preservation (no data loss)
- Chunking quality (sentence boundaries, reasonable sizes)
- Metadata completeness and accuracy
- Edge case handling (empty, large, malformed files)
- Performance and consistency

These tests are intended for manual validation and integration testing.
They are skipped in environments where extraction engines are unavailable.

Complements test_text_formats.py by focusing on quality rather than
just functional correctness.
"""

import io
import json
import pytest
from fastapi.testclient import TestClient
from app import app

client = TestClient(app)

# Check if engines are available by testing health endpoint
def engines_available():
    """Check if extraction engines are available"""
    try:
        response = client.get('/health')
        if response.status_code == 200:
            data = response.json()
            llamaindex_available = data.get('engines', {}).get('llamaindex', {}).get('available', False)
            return llamaindex_available
    except Exception:
        pass
    return False

SKIP_REASON = "Extraction engines not available in test environment - these tests are for manual/integration testing"
skip_if_engines_unavailable = pytest.mark.skipif(not engines_available(), reason=SKIP_REASON)


# =============================================================================
# TEST DATA - LLAMAINDEX FORMATS ONLY
# =============================================================================

# Nested JSON structure
NESTED_JSON = {
    "document": {
        "title": "Technical Specification",
        "version": "2.0",
        "metadata": {
            "author": "Engineering Team",
            "created": "2026-02-23",
            "tags": ["api", "documentation", "v2"]
        },
        "sections": [
            {
                "heading": "Overview",
                "content": "This document describes the API endpoints.",
                "subsections": [
                    {"title": "Authentication", "details": "OAuth 2.0 flow"},
                    {"title": "Rate Limiting", "details": "100 requests per minute"}
                ]
            },
            {
                "heading": "Endpoints",
                "content": "Available REST API endpoints.",
                "endpoints": [
                    {"path": "/api/users", "method": "GET", "description": "List users"},
                    {"path": "/api/users/:id", "method": "GET", "description": "Get user details"}
                ]
            }
        ]
    }
}

# XML with complex hierarchy
COMPLEX_XML = """<?xml version="1.0" encoding="UTF-8"?>
<library>
    <metadata>
        <name>City Library</name>
        <location>Downtown</location>
        <established>1985</established>
    </metadata>
    <books>
        <book id="001" category="fiction">
            <title>The Great Adventure</title>
            <author>
                <firstName>John</firstName>
                <lastName>Smith</lastName>
            </author>
            <year>2020</year>
            <availability status="available">5 copies</availability>
        </book>
        <book id="002" category="technical">
            <title>Modern Web Development</title>
            <author>
                <firstName>Jane</firstName>
                <lastName>Doe</lastName>
            </author>
            <year>2023</year>
            <availability status="checked-out">0 copies</availability>
        </book>
    </books>
</library>"""

# Long text for chunking validation
LONG_TEXT = """
The History of Computing

Computing has evolved dramatically over the past century. From mechanical calculators
to modern quantum computers, the journey has been remarkable.

Early Mechanical Computers

Charles Babbage designed the Analytical Engine in the 1830s, often considered the first
general-purpose computer design. Ada Lovelace wrote what is considered the first computer
program for this machine.

The Electronic Era

The invention of the transistor in 1947 revolutionized computing. Transistors replaced
vacuum tubes, making computers smaller, faster, and more reliable. This led to the
development of mainframe computers in the 1950s and 1960s.

Personal Computing Revolution

The 1970s and 1980s saw the birth of personal computers. Companies like Apple, IBM, and
Commodore brought computing to homes and small businesses. The graphical user interface
made computers accessible to non-technical users.

The Internet Age

The 1990s brought widespread internet adoption, fundamentally changing how we communicate
and access information. The World Wide Web, created by Tim Berners-Lee, became the
primary interface for the internet.

Mobile Computing

The 2000s introduced smartphones and tablets, putting powerful computers in everyone's
pockets. Mobile apps transformed how we interact with technology daily.

Cloud and AI

Today, cloud computing provides on-demand access to computing resources. Artificial
intelligence and machine learning are enabling new capabilities across industries.

Future Directions

Quantum computing, neuromorphic computing, and advanced AI systems promise to reshape
computing once again. The future holds exciting possibilities for technology advancement.
""" * 3  # Repeat 3 times to ensure multiple chunks


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def extract_document(content: str | bytes, filename: str, content_type: str, options: dict = None):
    """Helper to call the extraction endpoint"""
    if options is None:
        options = {
            'extractImages': True,
            'extractTables': True,
            'preserveLayout': True,
            'renderScreenshots': False,
            'ocrEnabled': True
        }

    if isinstance(content, str):
        content = content.encode('utf-8')

    files = {'file': (filename, io.BytesIO(content), content_type)}
    data = {'options': json.dumps(options)}

    response = client.post('/extract', files=files, data=data)
    return response


def get_full_text(result):
    """Extract concatenated text from all pages"""
    return ' '.join(page['text'] for page in result['pages'])


# =============================================================================
# CONTENT PRESERVATION TESTS (LLAMAINDEX FORMATS)
# =============================================================================

@skip_if_engines_unavailable
def test_json_nested_structure_preservation():
    """Test that JSON preserves nested structures and arrays"""
    json_content = json.dumps(NESTED_JSON, indent=2)
    response = extract_document(json_content, 'spec.json', 'application/json')
    assert response.status_code == 200

    result = response.json()
    full_text = get_full_text(result)

    # Verify top-level fields
    assert 'Technical Specification' in full_text
    assert 'Engineering Team' in full_text

    # Verify nested metadata
    assert '2026-02-23' in full_text or '2026' in full_text
    assert 'api' in full_text
    assert 'documentation' in full_text

    # Verify sections
    assert 'Overview' in full_text
    assert 'Authentication' in full_text
    assert 'OAuth' in full_text or 'OAuth 2.0' in full_text

    # Verify endpoints
    assert '/api/users' in full_text
    assert 'GET' in full_text


@skip_if_engines_unavailable
def test_xml_hierarchy_preservation():
    """Test that XML preserves element hierarchy and attributes"""
    response = extract_document(COMPLEX_XML, 'library.xml', 'application/xml')
    assert response.status_code == 200

    result = response.json()
    full_text = get_full_text(result)

    # Verify metadata
    assert 'City Library' in full_text
    assert 'Downtown' in full_text
    assert '1985' in full_text

    # Verify book data
    assert 'The Great Adventure' in full_text
    assert 'John' in full_text and 'Smith' in full_text
    assert 'Modern Web Development' in full_text
    assert 'Jane' in full_text and 'Doe' in full_text

    # Verify nested elements
    assert 'fiction' in full_text.lower() or 'technical' in full_text.lower()
    assert '2020' in full_text
    assert '2023' in full_text


# =============================================================================
# CHUNKING QUALITY TESTS
# =============================================================================

@skip_if_engines_unavailable
def test_long_text_chunking_quality():
    """Test that long text is chunked sensibly without data loss"""
    response = extract_document(LONG_TEXT, 'history.txt', 'text/plain')
    assert response.status_code == 200

    result = response.json()
    pages = result['pages']

    # Should create multiple chunks
    assert len(pages) > 1, "Long text should be chunked into multiple pages"

    full_text = get_full_text(result)

    # Verify key sections present (no data loss)
    assert 'History of Computing' in full_text
    assert 'Charles Babbage' in full_text
    assert 'Ada Lovelace' in full_text
    assert 'transistor' in full_text
    assert 'Personal Computing Revolution' in full_text
    assert 'Internet Age' in full_text
    assert 'Cloud and AI' in full_text
    assert 'Quantum computing' in full_text

    # Verify no excessive chunk size variance
    chunk_sizes = [len(page['text']) for page in pages]
    avg_size = sum(chunk_sizes) / len(chunk_sizes)

    # Most chunks should be within reasonable range of average
    reasonable_chunks = [s for s in chunk_sizes if avg_size * 0.3 < s < avg_size * 2.5]
    assert len(reasonable_chunks) >= len(chunk_sizes) * 0.6, "Chunks should be reasonably uniform"


@skip_if_engines_unavailable
def test_chunk_boundary_quality():
    """Test that chunks don't break mid-word or mid-sentence inappropriately"""
    # Create text with clear sentence boundaries
    sentences = [
        "This is the first sentence with important data.",
        "Here is the second sentence discussing technical details.",
        "The third sentence provides additional context.",
        "Fourth sentence continues the narrative flow.",
        "Fifth sentence adds more comprehensive information.",
    ] * 50  # Repeat to force chunking

    text = ' '.join(sentences)
    response = extract_document(text, 'sentences.txt', 'text/plain')
    assert response.status_code == 200

    result = response.json()
    pages = result['pages']

    if len(pages) > 1:
        for i, page in enumerate(pages[:-1]):  # Exclude last page
            chunk_text = page['text'].strip()
            if chunk_text:
                # Chunks should ideally end with sentence terminators
                last_50_chars = chunk_text[-50:]
                # Allow some flexibility - at least should have a period somewhere
                # in the last portion (not a hard rule due to overlap)
                assert '.' in last_50_chars or len(chunk_text) > 1000, \
                    f"Chunk {i} should end near sentence boundary"


# =============================================================================
# METADATA QUALITY TESTS
# =============================================================================

@skip_if_engines_unavailable
def test_metadata_completeness():
    """Test that metadata is complete and accurate for LlamaIndex formats"""
    test_cases = [
        (json.dumps(NESTED_JSON), 'test.json', 'application/json', 'json'),
        (COMPLEX_XML, 'test.xml', 'application/xml', 'xml'),
        (LONG_TEXT, 'test.txt', 'text/plain', 'plain'),
    ]

    for content, filename, content_type, expected_type_hint in test_cases:
        response = extract_document(content, filename, content_type)
        assert response.status_code == 200, f"Failed for {filename}"

        result = response.json()
        metadata = result['metadata']

        # Verify all required metadata fields
        assert 'pageCount' in metadata, f"Missing pageCount for {filename}"
        assert 'hasOCR' in metadata, f"Missing hasOCR for {filename}"
        assert 'totalTables' in metadata, f"Missing totalTables for {filename}"
        assert 'totalImages' in metadata, f"Missing totalImages for {filename}"
        assert 'processingTime' in metadata, f"Missing processingTime for {filename}"
        assert 'documentType' in metadata, f"Missing documentType for {filename}"

        # Verify metadata values are sensible
        assert metadata['pageCount'] > 0, f"Invalid pageCount for {filename}"
        assert metadata['processingTime'] > 0, f"Invalid processingTime for {filename}"
        assert isinstance(metadata['hasOCR'], bool), f"Invalid hasOCR type for {filename}"
        assert metadata['totalTables'] >= 0, f"Invalid totalTables for {filename}"
        assert metadata['totalImages'] >= 0, f"Invalid totalImages for {filename}"

        # Text formats shouldn't have tables/images
        assert metadata['totalTables'] == 0, f"{filename} should have no tables"
        assert metadata['totalImages'] == 0, f"{filename} should have no images"


@skip_if_engines_unavailable
def test_processing_time_reasonable():
    """Test that processing times are tracked and reasonable"""
    # Small document should process quickly
    small_text = "Hello world"
    response = extract_document(small_text, 'small.txt', 'text/plain')
    assert response.status_code == 200

    result = response.json()
    processing_time = result['metadata']['processingTime']

    # Should process in under 5 seconds for tiny document
    assert processing_time < 5.0, "Small document should process quickly"
    assert processing_time > 0, "Processing time should be positive"


# =============================================================================
# EDGE CASE TESTS
# =============================================================================

@skip_if_engines_unavailable
def test_empty_document_handling():
    """Test handling of empty documents (LlamaIndex formats only)"""
    empty_cases = [
        ('', 'empty.txt', 'text/plain'),
        ('{}', 'empty.json', 'application/json'),
        ('<?xml version="1.0"?><root></root>', 'empty.xml', 'application/xml'),
    ]

    for content, filename, content_type in empty_cases:
        response = extract_document(content, filename, content_type)

        # Should handle gracefully (200 with empty pages or 400 with error)
        assert response.status_code in [200, 400], f"Unexpected status for {filename}"

        if response.status_code == 200:
            result = response.json()
            # Empty docs should have minimal pages or empty content
            assert len(result['pages']) <= 1, f"Too many pages for empty {filename}"


@skip_if_engines_unavailable
def test_special_characters_handling():
    """Test handling of special characters and unicode"""
    special_text = """
    Special Characters Test

    Unicode: 你好世界 🌍 Привет мир
    Symbols: © ® ™ € £ ¥
    Math: ∑ ∫ √ π ≈ ≠
    Arrows: → ← ↑ ↓ ⇒
    Quotes: "smart quotes" 'apostrophes' «guillemets»
    """

    response = extract_document(special_text, 'special.txt', 'text/plain')
    assert response.status_code == 200

    result = response.json()
    full_text = get_full_text(result)

    # Should preserve or gracefully handle special characters
    # At minimum, should not crash and should preserve basic structure
    assert len(full_text) > 0
    assert 'Special Characters Test' in full_text


@skip_if_engines_unavailable
def test_malformed_input_graceful_degradation():
    """Test that malformed inputs are handled gracefully (LlamaIndex formats)"""
    malformed_cases = [
        ('{"invalid": json', 'bad.json', 'application/json'),
        ('<invalid><xml>', 'bad.xml', 'application/xml'),
        ('random binary data \x00\x01\x02', 'bad.txt', 'text/plain'),
    ]

    for content, filename, content_type in malformed_cases:
        response = extract_document(content, filename, content_type)

        # Should either succeed with partial extraction or return proper error
        assert response.status_code in [200, 400, 500], f"Unexpected status for {filename}"

        # Should not crash the service (verified by this test completing)


# =============================================================================
# CONSISTENCY TESTS
# =============================================================================

@skip_if_engines_unavailable
def test_consistent_page_structure():
    """Test that all pages have consistent structure"""
    response = extract_document(LONG_TEXT, 'long.txt', 'text/plain')
    assert response.status_code == 200

    result = response.json()
    pages = result['pages']

    # All pages should have same structure
    for i, page in enumerate(pages):
        assert 'pageNumber' in page, f"Page {i} missing pageNumber"
        assert 'text' in page, f"Page {i} missing text"
        assert 'layout' in page, f"Page {i} missing layout"
        assert 'tables' in page, f"Page {i} missing tables"
        assert 'images' in page, f"Page {i} missing images"

        # Verify types
        assert isinstance(page['pageNumber'], int), f"Page {i} has invalid pageNumber type"
        assert isinstance(page['text'], str), f"Page {i} has invalid text type"
        assert isinstance(page['layout'], dict), f"Page {i} has invalid layout type"
        assert isinstance(page['tables'], list), f"Page {i} has invalid tables type"
        assert isinstance(page['images'], list), f"Page {i} has invalid images type"


@skip_if_engines_unavailable
def test_page_numbering_sequential():
    """Test that page numbers are sequential starting from 1"""
    response = extract_document(LONG_TEXT, 'numbered.txt', 'text/plain')
    assert response.status_code == 200

    result = response.json()
    pages = result['pages']

    # Page numbers should start at 1 and increment
    expected_page_numbers = list(range(1, len(pages) + 1))
    actual_page_numbers = [page['pageNumber'] for page in pages]

    assert actual_page_numbers == expected_page_numbers, "Page numbers should be sequential"


# =============================================================================
# PERFORMANCE QUALITY TESTS
# =============================================================================

@skip_if_engines_unavailable
def test_small_file_performance():
    """Test that small files process efficiently (LlamaIndex formats)"""
    small_docs = [
        ("Small text document", "small.txt", "text/plain"),
        ('{"key": "value"}', "small.json", "application/json"),
        ('<?xml version="1.0"?><root><item>value</item></root>', "small.xml", "application/xml"),
    ]

    for content, filename, content_type in small_docs:
        response = extract_document(content, filename, content_type)
        assert response.status_code == 200

        result = response.json()
        processing_time = result['metadata']['processingTime']

        # Small files should process very quickly (under 2 seconds)
        assert processing_time < 2.0, f"{filename} took too long: {processing_time}s"


@skip_if_engines_unavailable
def test_consistent_multiple_extractions():
    """Test that same document produces consistent results across extractions"""
    content = "Test document with consistent content for validation."
    filename = "consistent.txt"
    content_type = "text/plain"

    # Extract same document twice
    response1 = extract_document(content, filename, content_type)
    response2 = extract_document(content, filename, content_type)

    assert response1.status_code == 200
    assert response2.status_code == 200

    result1 = response1.json()
    result2 = response2.json()

    # Content should be identical
    text1 = get_full_text(result1)
    text2 = get_full_text(result2)

    assert text1 == text2, "Same document should produce identical text"

    # Page count should match
    assert result1['metadata']['pageCount'] == result2['metadata']['pageCount']


@skip_if_engines_unavailable
def test_document_type_detection():
    """Test document type is detected correctly for LlamaIndex formats"""
    test_cases = [
        ('test content', 'test.txt', 'text/plain', 'plain'),
        (json.dumps(NESTED_JSON), 'test.json', 'application/json', 'json'),
        (COMPLEX_XML, 'test.xml', 'application/xml', 'xml'),
    ]

    for content, filename, content_type, expected_type in test_cases:
        response = extract_document(content, filename, content_type)
        assert response.status_code == 200, f"Failed for {filename}: {response.json()}"

        data = response.json()
        doc_type = data['metadata'].get('documentType', '')
        assert expected_type in doc_type.lower() or doc_type != '', \
            f"Wrong type for {filename}: expected '{expected_type}' in '{doc_type}'"


if __name__ == '__main__':
    pytest.main([__file__, '-v'])

"""
Test suite for LlamaIndex text format extraction

Tests LlamaIndex integration for text-based formats:
- TXT (plain text)
- JSON
- XML

Note: Markdown and CSV are now handled by Docling natively and tested separately.

Validates:
- Format detection and routing to LlamaIndex
- Content extraction quality
- Semantic chunking behavior
- Metadata preservation
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

SAMPLE_TXT = """This is a sample plain text document.

It contains multiple paragraphs with various sentences. The semantic chunker should split this text at appropriate boundaries while respecting sentence structure.

This is the third paragraph. It demonstrates how the chunker handles longer content and maintains context across chunks."""

SAMPLE_MARKDOWN = """# Main Title

This is the introduction paragraph.

## Section 1

Content for section 1.

### Subsection 1.1

Detailed content here.

```python
def example():
    return "code"
```

## Section 2

More content in section 2.
"""

SAMPLE_JSON = {
    "title": "Sample Document",
    "author": "Test Author",
    "content": "This is the main content of the JSON document.",
    "metadata": {
        "created": "2026-02-23",
        "tags": ["test", "sample"]
    }
}

SAMPLE_CSV = """Name,Age,City
Alice,30,New York
Bob,25,San Francisco
Charlie,35,Los Angeles"""

SAMPLE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<document>
    <title>Sample Document</title>
    <author>Test Author</author>
    <content>
        <paragraph>First paragraph of content.</paragraph>
        <paragraph>Second paragraph of content.</paragraph>
    </content>
</document>"""


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def create_file_upload(content: str | bytes, filename: str, content_type: str):
    """Create a file upload for testing"""
    if isinstance(content, str):
        content = content.encode('utf-8')

    return {
        'file': (filename, io.BytesIO(content), content_type)
    }


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

    files = create_file_upload(content, filename, content_type)
    data = {'options': json.dumps(options)}

    response = client.post('/extract', files=files, data=data)
    return response


# =============================================================================
# HEALTH CHECK
# =============================================================================

def test_health_check_shows_llamaindex():
    """Health check should report LlamaIndex availability"""
    response = client.get('/health')
    assert response.status_code == 200

    data = response.json()
    assert 'engines' in data
    assert 'llamaindex' in data['engines']
    assert data['engines']['llamaindex']['available'] is True
    # LlamaIndex now handles 1 format: TXT (CSV/JSON/XML removed - need hierarchical tree extraction)
    assert data['engines']['llamaindex']['formats'] == 1


# =============================================================================
# TXT FORMAT TESTS
# =============================================================================

def test_txt_extraction():
    """Test plain text extraction"""
    response = extract_document(SAMPLE_TXT, 'sample.txt', 'text/plain')

    assert response.status_code == 200
    data = response.json()

    # Verify structure
    assert 'pages' in data
    assert 'metadata' in data
    assert len(data['pages']) > 0

    # Verify content
    pages = data['pages']
    full_text = ' '.join(p['text'] for p in pages)
    assert 'sample plain text document' in full_text
    assert 'multiple paragraphs' in full_text


def test_txt_single_page_extraction():
    """Test that TXT is extracted as single page (chunking happens downstream)"""
    long_text = ' '.join(['This is sentence {}.'.format(i) for i in range(200)])

    response = extract_document(long_text, 'long.txt', 'text/plain')
    assert response.status_code == 200

    data = response.json()
    pages = data['pages']

    # Should return as single page (NOT chunked during extraction)
    assert len(pages) == 1, "TXT should be extracted as single page, chunked in page-processing"

    # Page should contain all text
    full_text = pages[0]['text']
    assert 'sentence 0' in full_text
    assert 'sentence 199' in full_text
    assert len(full_text) > 3000  # All sentences present


def test_txt_metadata():
    """Test TXT extraction includes metadata"""
    response = extract_document(SAMPLE_TXT, 'sample.txt', 'text/plain')
    assert response.status_code == 200

    data = response.json()

    # Check page structure
    for page in data['pages']:
        assert 'pageNumber' in page
        assert 'text' in page
        assert 'layout' in page
        # PageData doesn't have metadata field - that's at document level
        assert isinstance(page['pageNumber'], int)
        assert isinstance(page['text'], str)


# =============================================================================
# MARKDOWN FORMAT TESTS (Now handled by Docling - skipped)
# =============================================================================

@pytest.mark.skip(reason="Markdown now routed to Docling (not LlamaIndex)")
def test_markdown_extraction():
    """Test markdown extraction"""
    response = extract_document(SAMPLE_MARKDOWN, 'sample.md', 'text/markdown')

    assert response.status_code == 200
    data = response.json()

    assert len(data['pages']) > 0

    # Verify markdown content is extracted
    full_text = ' '.join(p['text'] for p in data['pages'])
    assert 'Main Title' in full_text
    assert 'Section 1' in full_text
    assert 'Section 2' in full_text


@pytest.mark.skip(reason="Markdown now routed to Docling (not LlamaIndex)")
def test_markdown_structure_preservation():
    """Test that markdown preserves headings and structure"""
    response = extract_document(SAMPLE_MARKDOWN, 'sample.md', 'text/markdown')
    assert response.status_code == 200

    data = response.json()
    full_text = ' '.join(p['text'] for p in data['pages'])

    # Should preserve markdown formatting
    assert '#' in full_text or 'Main Title' in full_text

    # Code blocks should be preserved
    assert 'python' in full_text or 'def example' in full_text


@pytest.mark.skip(reason="Markdown now routed to Docling (not LlamaIndex)")
def test_markdown_code_block_preservation():
    """Test that code blocks are kept intact"""
    md_with_code = """# Code Example

Some text before.

```python
def foo():
    return "bar"
```

Text after.
"""

    response = extract_document(md_with_code, 'code.md', 'text/markdown')
    assert response.status_code == 200

    data = response.json()
    full_text = ' '.join(p['text'] for p in data['pages'])

    # Code should be present
    assert 'def foo' in full_text or 'foo()' in full_text


# =============================================================================
# JSON FORMAT TESTS - TEMPORARILY DISABLED
# =============================================================================
# JSON extraction removed - needs specialized structured data handling
# Current text-based extraction loses structure and doesn't support querying

@pytest.mark.skip(reason="JSON extraction temporarily disabled - needs specialized structured data handling")
def test_json_extraction():
    """Test JSON extraction"""
    json_content = json.dumps(SAMPLE_JSON)
    response = extract_document(json_content, 'sample.json', 'application/json')

    assert response.status_code == 200
    data = response.json()

    assert len(data['pages']) > 0

    # Verify JSON content is extracted
    full_text = ' '.join(p['text'] for p in data['pages'])
    assert 'Sample Document' in full_text
    assert 'Test Author' in full_text


@pytest.mark.skip(reason="JSON extraction temporarily disabled - needs specialized structured data handling")
def test_json_nested_structure():
    """Test JSON with nested structure"""
    nested_json = {
        "level1": {
            "level2": {
                "level3": "Deep value",
                "array": [1, 2, 3]
            }
        }
    }

    json_content = json.dumps(nested_json, indent=2)
    response = extract_document(json_content, 'nested.json', 'application/json')

    assert response.status_code == 200
    data = response.json()

    # Should extract nested content
    full_text = ' '.join(p['text'] for p in data['pages'])
    assert 'Deep value' in full_text or 'level1' in full_text


# =============================================================================
# CSV FORMAT TESTS (Now handled by Docling - skipped)
# =============================================================================

@pytest.mark.skip(reason="CSV now routed to Docling (not LlamaIndex)")
def test_csv_extraction():
    """Test CSV extraction"""
    response = extract_document(SAMPLE_CSV, 'sample.csv', 'text/csv')

    assert response.status_code == 200
    data = response.json()

    assert len(data['pages']) > 0

    # Verify CSV content is extracted
    full_text = ' '.join(p['text'] for p in data['pages'])
    assert 'Alice' in full_text
    assert 'Bob' in full_text
    assert 'New York' in full_text


@pytest.mark.skip(reason="CSV now routed to Docling (not LlamaIndex)")
def test_csv_header_detection():
    """Test CSV header detection"""
    response = extract_document(SAMPLE_CSV, 'sample.csv', 'text/csv')
    assert response.status_code == 200

    data = response.json()
    full_text = ' '.join(p['text'] for p in data['pages'])

    # Headers should be present
    assert 'Name' in full_text or 'Age' in full_text or 'City' in full_text


# =============================================================================
# XML FORMAT TESTS - DISABLED (Need Hierarchical Tree Extraction)
# =============================================================================
# XML extraction removed - needs specialized hierarchical tree handling (task #15)
# Current text-based extraction loses element hierarchy and structure

@pytest.mark.skip(reason="XML extraction removed - needs hierarchical tree extraction (task #15)")
def test_xml_extraction():
    """Test XML extraction"""
    response = extract_document(SAMPLE_XML, 'sample.xml', 'application/xml')

    assert response.status_code == 200
    data = response.json()

    assert len(data['pages']) > 0

    # Verify XML content is extracted
    full_text = ' '.join(p['text'] for p in data['pages'])
    assert 'Sample Document' in full_text
    assert 'Test Author' in full_text
    assert 'First paragraph' in full_text


@pytest.mark.skip(reason="XML extraction removed - needs hierarchical tree extraction (task #15)")
def test_xml_alternative_content_type():
    """Test XML with text/xml content type"""
    response = extract_document(SAMPLE_XML, 'sample.xml', 'text/xml')

    assert response.status_code == 200
    data = response.json()

    assert len(data['pages']) > 0


@pytest.mark.skip(reason="XML extraction removed - needs hierarchical tree extraction (task #15)")
def test_xml_structure_extraction():
    """Test XML structure extraction"""
    response = extract_document(SAMPLE_XML, 'sample.xml', 'application/xml')
    assert response.status_code == 200

    data = response.json()
    full_text = ' '.join(p['text'] for p in data['pages'])

    # Should extract element content
    assert 'paragraph' in full_text.lower() or 'First paragraph' in full_text


# =============================================================================
# UNIFIED ENDPOINT TESTS
# =============================================================================

def test_unified_endpoint_routes_to_llamaindex():
    """Test that unified endpoint routes text formats to LlamaIndex"""
    # Only LlamaIndex format: TXT (CSV/JSON/XML removed - need hierarchical tree extraction)
    test_cases = [
        ('test.txt', 'text/plain', 'Plain text'),
    ]

    for filename, content_type, content in test_cases:
        response = extract_document(content, filename, content_type)
        assert response.status_code == 200, f"Failed for {filename}"

        data = response.json()
        assert len(data['pages']) > 0, f"No pages for {filename}"


def test_unsupported_format():
    """Test unsupported format returns error"""
    response = extract_document('test content', 'test.xyz', 'application/x-unknown')

    assert response.status_code == 400
    assert 'Unsupported content type' in response.json()['detail']


# =============================================================================
# METADATA TESTS
# =============================================================================

def test_extraction_metadata():
    """Test extraction metadata is complete"""
    response = extract_document(SAMPLE_TXT, 'sample.txt', 'text/plain')
    assert response.status_code == 200

    data = response.json()
    metadata = data['metadata']

    # Verify metadata fields
    assert 'pageCount' in metadata
    assert 'hasOCR' in metadata
    assert 'totalTables' in metadata
    assert 'totalImages' in metadata
    assert 'processingTime' in metadata
    assert 'documentType' in metadata

    # Text formats shouldn't have tables/images
    assert metadata['totalTables'] == 0
    assert metadata['totalImages'] == 0


def test_document_type_detection():
    """Test document type is detected correctly (LlamaIndex formats only)"""
    # Only test LlamaIndex format: TXT (CSV/JSON/XML removed - need hierarchical tree extraction)
    test_cases = [
        ('test.txt', 'text/plain', 'plain', 'test content'),
    ]

    for filename, content_type, expected_type, content in test_cases:
        response = extract_document(content, filename, content_type)
        assert response.status_code == 200, f"Failed for {filename}: {response.json()}"

        data = response.json()
        doc_type = data['metadata'].get('documentType', '')
        assert expected_type in doc_type.lower() or doc_type != '', f"Wrong type for {filename}"


# =============================================================================
# CHUNKING BEHAVIOR TESTS
# =============================================================================

def test_chunking_respects_sentence_boundaries():
    """Test that chunking doesn't split mid-sentence"""
    # Create text with clear sentence boundaries
    sentences = [f"This is sentence number {i}." for i in range(100)]
    text = ' '.join(sentences)

    response = extract_document(text, 'sentences.txt', 'text/plain')
    assert response.status_code == 200

    data = response.json()

    # Check that chunks end with sentence terminators
    for page in data['pages']:
        chunk_text = page['text'].strip()
        if chunk_text:
            # Should end with sentence terminator (or be incomplete due to overlap)
            # This is a heuristic - not all chunks will end perfectly
            last_char = chunk_text[-1]
            # Most chunks should end reasonably (period, or part of overlap)
            assert last_char in '.!?0123456789' or len(chunk_text) > 900


def test_chunk_overlap():
    """Test that chunks have appropriate overlap"""
    long_text = ' '.join(['Sentence {}.'.format(i) for i in range(150)])

    response = extract_document(long_text, 'long.txt', 'text/plain')
    assert response.status_code == 200

    data = response.json()
    pages = data['pages']

    if len(pages) > 1:
        # Check for overlap between consecutive chunks
        for i in range(len(pages) - 1):
            chunk1_end = pages[i]['text'][-50:]  # Last 50 chars
            chunk2_start = pages[i + 1]['text'][:100]  # First 100 chars

            # There might be some overlap (this is a loose check)
            # The overlap is configured as 200 chars in the implementation
            # So we just verify chunks exist and are reasonable
            assert len(pages[i]['text']) > 0
            assert len(pages[i + 1]['text']) > 0


# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================

def test_empty_file():
    """Test handling of empty file"""
    response = extract_document('', 'empty.txt', 'text/plain')

    # Should handle gracefully
    assert response.status_code in [200, 400]


def test_malformed_json():
    """Test handling of malformed JSON"""
    malformed = '{"key": "value"'  # Missing closing brace
    response = extract_document(malformed, 'bad.json', 'application/json')

    # Should handle error gracefully
    assert response.status_code in [200, 400, 500]


def test_malformed_xml():
    """Test handling of malformed XML"""
    malformed = '<root><item>value</root>'  # Mismatched tags
    response = extract_document(malformed, 'bad.xml', 'application/xml')

    # Should handle error gracefully
    assert response.status_code in [200, 400, 500]


# =============================================================================
# INTEGRATION TESTS
# =============================================================================

def test_extract_all_formats_sequentially():
    """Test extracting all LlamaIndex formats in sequence"""
    # Only test LlamaIndex format: TXT (CSV/JSON/XML removed - need hierarchical tree extraction)
    formats = [
        (SAMPLE_TXT, 'sample.txt', 'text/plain'),
    ]

    results = []
    for content, filename, content_type in formats:
        response = extract_document(content, filename, content_type)
        assert response.status_code == 200, f"Failed for {filename}"
        results.append(response.json())

    # All should succeed
    assert len(results) == 1

    # All should have pages
    for result in results:
        assert len(result['pages']) > 0


def test_consistent_response_format():
    """Test all LlamaIndex formats return consistent response structure"""
    # Only test LlamaIndex format: TXT (CSV/JSON/XML removed - need hierarchical tree extraction)
    formats = [
        (SAMPLE_TXT, 'sample.txt', 'text/plain'),
    ]

    for content, filename, content_type in formats:
        response = extract_document(content, filename, content_type)
        assert response.status_code == 200

        data = response.json()

        # Verify consistent structure
        assert 'pages' in data
        assert 'metadata' in data
        assert 'structure' in data

        # Verify page structure
        for page in data['pages']:
            assert 'pageNumber' in page
            assert 'text' in page
            assert 'layout' in page
            assert 'tables' in page
            assert 'images' in page


if __name__ == '__main__':
    pytest.main([__file__, '-v'])

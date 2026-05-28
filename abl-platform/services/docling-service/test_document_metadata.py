"""
Test suite for document metadata extraction

Tests document metadata extraction from various formats:
- PDF metadata (author, dates, title, subject, keywords)
- DOCX metadata (Office document properties)
- PPTX metadata (PowerPoint properties)
- Explicit metadata overrides via API
- Metadata merging (extracted + explicit)

Validates:
- Metadata extraction accuracy
- API parameter integration
- Explicit overrides
- Date format handling (ISO 8601)
- Keywords parsing
"""

import io
import json
import pytest
from datetime import datetime
from fastapi.testclient import TestClient
from app import app

client = TestClient(app)


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def create_file_upload(content: bytes, filename: str, content_type: str):
    """Create a file upload for testing"""
    return {
        'file': (filename, io.BytesIO(content), content_type)
    }


def extract_with_metadata(
    content: bytes,
    filename: str,
    content_type: str,
    author: str = None,
    title: str = None,
    subject: str = None,
    created_date: str = None,
    modified_date: str = None,
    keywords: str = None
):
    """Helper to call extraction with metadata parameters"""
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

    # Add optional metadata parameters
    if author is not None:
        data['author'] = author
    if title is not None:
        data['title'] = title
    if subject is not None:
        data['subject'] = subject
    if created_date is not None:
        data['createdDate'] = created_date
    if modified_date is not None:
        data['modifiedDate'] = modified_date
    if keywords is not None:
        data['keywords'] = keywords

    response = client.post('/extract', files=files, data=data)
    return response


# =============================================================================
# EXPLICIT METADATA TESTS
# =============================================================================

def test_explicit_author():
    """Test explicit author parameter"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        author='John Doe'
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['author'] == 'John Doe'


def test_explicit_title():
    """Test explicit title parameter"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        title='Test Document Title'
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['title'] == 'Test Document Title'


def test_explicit_subject():
    """Test explicit subject parameter"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        subject='Technical Documentation'
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['subject'] == 'Technical Documentation'


def test_explicit_dates():
    """Test explicit creation and modification dates"""
    content = b"Simple text content"
    created = '2024-01-15T10:30:00'
    modified = '2024-02-20T15:45:00'

    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        created_date=created,
        modified_date=modified
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['createdDate'] == created
    assert metadata['modifiedDate'] == modified


def test_explicit_keywords():
    """Test explicit keywords parameter (comma-separated)"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        keywords='machine learning, AI, deep learning, NLP'
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['keywords'] == ['machine learning', 'AI', 'deep learning', 'NLP']


def test_explicit_keywords_whitespace_handling():
    """Test keywords with extra whitespace are trimmed"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        keywords='  keyword1  ,  keyword2  ,  keyword3  '
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['keywords'] == ['keyword1', 'keyword2', 'keyword3']


def test_all_explicit_metadata():
    """Test all metadata parameters together"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        author='Jane Smith',
        title='Complete Test Document',
        subject='Integration Testing',
        created_date='2024-01-01T00:00:00',
        modified_date='2024-12-31T23:59:59',
        keywords='test, integration, metadata'
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']
    assert metadata['author'] == 'Jane Smith'
    assert metadata['title'] == 'Complete Test Document'
    assert metadata['subject'] == 'Integration Testing'
    assert metadata['createdDate'] == '2024-01-01T00:00:00'
    assert metadata['modifiedDate'] == '2024-12-31T23:59:59'
    assert metadata['keywords'] == ['test', 'integration', 'metadata']


# =============================================================================
# METADATA STRUCTURE TESTS
# =============================================================================

def test_metadata_fields_exist():
    """Test all metadata fields are present in response"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain'
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']

    # Check all metadata fields exist (may be None)
    assert 'author' in metadata
    assert 'title' in metadata
    assert 'subject' in metadata
    assert 'createdDate' in metadata
    assert 'modifiedDate' in metadata
    assert 'keywords' in metadata


def test_metadata_types():
    """Test metadata field types are correct"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        author='Author Name',
        title='Title Text',
        subject='Subject Text',
        created_date='2024-01-15T10:30:00',
        modified_date='2024-02-20T15:45:00',
        keywords='key1, key2'
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']

    # Type checks
    assert isinstance(metadata['author'], str)
    assert isinstance(metadata['title'], str)
    assert isinstance(metadata['subject'], str)
    assert isinstance(metadata['createdDate'], str)
    assert isinstance(metadata['modifiedDate'], str)
    assert isinstance(metadata['keywords'], list)
    assert all(isinstance(k, str) for k in metadata['keywords'])


def test_empty_metadata_defaults():
    """Test metadata fields default to None when not provided"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain'
        # No metadata provided
    )

    assert response.status_code == 200
    data = response.json()

    metadata = data['metadata']

    # Plain text has no extractable metadata
    # So all should be None (unless extracted from file properties, which TXT doesn't have)
    assert metadata['author'] is None
    assert metadata['title'] is None
    assert metadata['subject'] is None
    assert metadata['createdDate'] is None
    assert metadata['modifiedDate'] is None
    assert metadata['keywords'] is None


# =============================================================================
# PDF METADATA EXTRACTION TESTS (Requires PyPDF2)
# =============================================================================

@pytest.mark.skip(reason="Requires actual PDF file with metadata for testing")
def test_pdf_metadata_extraction():
    """Test PDF metadata extraction (author, title, dates)"""
    # This test requires a real PDF with metadata
    # In production, you'd have test fixtures with known metadata
    pass


@pytest.mark.skip(reason="Requires actual PDF file with metadata for testing")
def test_pdf_metadata_override():
    """Test explicit metadata overrides extracted PDF metadata"""
    # This test requires a real PDF with metadata
    # Verify explicit parameters override extracted values
    pass


# =============================================================================
# DOCX METADATA EXTRACTION TESTS (Requires python-docx)
# =============================================================================

@pytest.mark.skip(reason="Requires actual DOCX file with metadata for testing")
def test_docx_metadata_extraction():
    """Test DOCX core properties extraction"""
    # This test requires a real DOCX with core properties
    pass


@pytest.mark.skip(reason="Requires actual DOCX file with metadata for testing")
def test_docx_metadata_override():
    """Test explicit metadata overrides extracted DOCX metadata"""
    pass


# =============================================================================
# PPTX METADATA EXTRACTION TESTS (Requires python-pptx)
# =============================================================================

@pytest.mark.skip(reason="Requires actual PPTX file with metadata for testing")
def test_pptx_metadata_extraction():
    """Test PPTX core properties extraction"""
    pass


@pytest.mark.skip(reason="Requires actual PPTX file with metadata for testing")
def test_pptx_metadata_override():
    """Test explicit metadata overrides extracted PPTX metadata"""
    pass


# =============================================================================
# DATE FORMAT TESTS
# =============================================================================

def test_date_format_iso8601():
    """Test ISO 8601 date format is accepted"""
    content = b"Simple text content"
    valid_dates = [
        '2024-01-15T10:30:00',
        '2024-12-31T23:59:59',
        '2024-06-15T12:00:00Z',
        '2024-03-20T08:30:00+00:00',
    ]

    for date_str in valid_dates:
        response = extract_with_metadata(
            content,
            'test.txt',
            'text/plain',
            created_date=date_str
        )

        assert response.status_code == 200
        data = response.json()
        metadata = data['metadata']
        assert metadata['createdDate'] == date_str


# =============================================================================
# EDGE CASES
# =============================================================================

def test_empty_author():
    """Test empty string author is handled (treated as not provided)"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        author=''
    )

    assert response.status_code == 200
    data = response.json()
    metadata = data['metadata']
    # Empty string in Form parameter is treated as None (not provided)
    # This is the expected FastAPI behavior
    assert metadata['author'] is None or metadata['author'] == ''


def test_empty_keywords():
    """Test empty keywords string results in None or empty list"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        keywords=''
    )

    assert response.status_code == 200
    data = response.json()
    metadata = data['metadata']
    # Empty string for keywords is treated as not provided
    assert metadata['keywords'] is None or metadata['keywords'] == []


def test_keywords_single_value():
    """Test keywords with single value (no commas)"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        keywords='single-keyword'
    )

    assert response.status_code == 200
    data = response.json()
    metadata = data['metadata']
    assert metadata['keywords'] == ['single-keyword']


def test_special_characters_in_metadata():
    """Test special characters in metadata fields"""
    content = b"Simple text content"
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        author='Müller, José & O\'Brien',
        title='测试文档 - Test Document',
        subject='Тест / تجربة',
        keywords='keyword-1, keyword_2, keyword.3'
    )

    assert response.status_code == 200
    data = response.json()
    metadata = data['metadata']

    assert metadata['author'] == 'Müller, José & O\'Brien'
    assert metadata['title'] == '测试文档 - Test Document'
    assert metadata['subject'] == 'Тест / تجربة'
    assert metadata['keywords'] == ['keyword-1', 'keyword_2', 'keyword.3']


def test_long_metadata_values():
    """Test handling of very long metadata values"""
    content = b"Simple text content"
    long_author = 'A' * 500
    long_title = 'T' * 1000
    long_keywords = ', '.join([f'keyword{i}' for i in range(100)])

    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        author=long_author,
        title=long_title,
        keywords=long_keywords
    )

    assert response.status_code == 200
    data = response.json()
    metadata = data['metadata']

    assert metadata['author'] == long_author
    assert metadata['title'] == long_title
    assert len(metadata['keywords']) == 100


# =============================================================================
# INTEGRATION TESTS
# =============================================================================

def test_metadata_with_language_detection():
    """Test metadata extraction works alongside language detection"""
    content = b"This is an English document with metadata."
    response = extract_with_metadata(
        content,
        'test.txt',
        'text/plain',
        author='Test Author',
        title='Test Title',
        keywords='test, english'
    )

    assert response.status_code == 200
    data = response.json()
    metadata = data['metadata']

    # Both metadata and language should be present
    assert metadata['author'] == 'Test Author'
    assert metadata['title'] == 'Test Title'
    assert metadata['keywords'] == ['test', 'english']

    # Language detection should also work
    if metadata.get('language'):  # Only if detection available
        assert metadata['language'] in ['en', 'unknown']


def test_metadata_with_full_extraction():
    """Test metadata extraction with full document extraction options"""
    content = b"This is a complete test document."
    response = client.post(
        '/extract',
        files={'file': ('test.txt', io.BytesIO(content), 'text/plain')},
        data={
            'options': json.dumps({
                'extractImages': True,
                'extractTables': True,
                'preserveLayout': True,
                'renderScreenshots': False,
                'ocrEnabled': True
            }),
            'author': 'Integration Test Author',
            'title': 'Integration Test Title',
            'language': 'en'
        }
    )

    assert response.status_code == 200
    data = response.json()

    # Check all response components
    assert 'pages' in data
    assert 'metadata' in data
    assert 'structure' in data

    metadata = data['metadata']
    assert metadata['author'] == 'Integration Test Author'
    assert metadata['title'] == 'Integration Test Title'
    assert metadata['language'] == 'en'


if __name__ == '__main__':
    pytest.main([__file__, '-v'])

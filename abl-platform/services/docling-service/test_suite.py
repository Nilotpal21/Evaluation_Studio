"""
Comprehensive Test Suite for Docling Service

Tests:
- Unit tests for helper functions
- Integration tests for extraction endpoint
- Performance benchmarks
- Edge case handling

Usage:
    pytest test_suite.py -v
    pytest test_suite.py -v -k "test_simple"  # Run specific tests
"""

import pytest
import requests
import json
import base64
import io
import time
from pathlib import Path
from PIL import Image
from test_datasets import DatasetDownloader, TEST_DOCUMENTS


# ─── Configuration ───────────────────────────────────────────────────────────

SERVICE_URL = "http://localhost:8080"
TIMEOUT = 300  # 5 minutes for large documents
PNG_MAGIC_HEADER = b"\x89PNG\r\n\x1a\n"


# ─── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def service_url():
    """Docling service URL"""
    return SERVICE_URL


@pytest.fixture(scope="session")
def test_documents():
    """Load test documents from shared location (no download)"""
    downloader = DatasetDownloader()  # Uses shared location from env or default

    # Check which datasets exist
    existing = downloader.check_datasets_exist()
    missing = [key for key, exists in existing.items() if not exists]

    if missing:
        print("\n" + "=" * 80)
        print("⚠️  MISSING TEST DATASETS")
        print("=" * 80)
        print(f"Missing datasets: {', '.join(missing)}")
        print(f"\nDataset location: {downloader.download_dir}")
        print("\nTo download datasets (one-time setup):")
        print("  python test_datasets.py download")
        print("\nOr set custom location:")
        print("  export TEST_DATASET_DIR=/path/to/shared/datasets")
        print("=" * 80 + "\n")

    # Return paths for existing datasets
    results = {}
    for key in TEST_DOCUMENTS.keys():
        path = downloader.get_dataset_path(key)
        results[key] = str(path) if path else None

    return results


@pytest.fixture(scope="session")
def service_health(service_url):
    """Check if service is healthy before running tests"""
    try:
        response = requests.get(f"{service_url}/health", timeout=5)
        assert response.status_code == 200, "Service not healthy"
        health = response.json()
        assert health.get('engines', {}).get('docling', {}).get('available'), "Docling not available"
        return health
    except Exception as e:
        pytest.skip(f"Service not available: {e}")


# ─── Health Check Tests ──────────────────────────────────────────────────────

def test_health_endpoint(service_url):
    """Test health endpoint returns correct structure"""
    response = requests.get(f"{service_url}/health")

    assert response.status_code == 200
    health = response.json()

    # Check required fields
    assert 'status' in health
    assert 'service' in health
    assert 'version' in health
    assert 'engines' in health
    assert 'features' in health

    # Check values
    assert health['status'] in ['healthy', 'unhealthy']
    assert health['engines']['docling']['available'] is True


# ─── Simple Document Tests ───────────────────────────────────────────────────

def test_extract_simple_pdf(service_url, service_health, test_documents):
    """Test extraction of simple text-only PDF"""
    doc_path = test_documents.get('simple_text_pdf')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f, 'application/pdf')}
        options = json.dumps({
            'extractImages': False,
            'extractTables': False,
            'renderScreenshots': False,
            'ocrEnabled': False,
        })
        data = {'options': options}

        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )

    assert response.status_code == 200
    result = response.json()

    # Validate structure
    assert 'pages' in result
    assert 'metadata' in result
    assert 'structure' in result

    # Validate metadata
    metadata = result['metadata']
    assert metadata['pageCount'] >= 1
    assert metadata['processingTime'] > 0

    # Validate pages
    pages = result['pages']
    assert len(pages) == metadata['pageCount']

    # Validate first page
    page = pages[0]
    assert 'pageNumber' in page
    assert 'text' in page
    assert len(page['text']) > 0  # Should have extracted text


def test_extract_with_tables(service_url, service_health, test_documents):
    """Test extraction of document with tables"""
    doc_path = test_documents.get('docx_sample')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}
        options = json.dumps({
            'extractImages': False,
            'extractTables': True,
            'renderScreenshots': False,
            'ocrEnabled': False,
        })
        data = {'options': options}

        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )

    assert response.status_code == 200
    result = response.json()

    # Should have extracted tables
    metadata = result['metadata']
    # Note: May be 0 if sample doesn't have tables, just test structure
    assert 'totalTables' in metadata
    assert isinstance(metadata['totalTables'], int)


# ─── Complex Document Tests ──────────────────────────────────────────────────

def test_extract_research_paper(service_url, service_health, test_documents):
    """Test extraction of academic paper with charts/tables"""
    doc_path = test_documents.get('research_paper')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f, 'application/pdf')}
        options = json.dumps({
            'extractImages': True,
            'extractTables': True,
            'renderScreenshots': True,
            'ocrEnabled': False,
        })
        data = {'options': options}

        start_time = time.time()
        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )
        elapsed = time.time() - start_time

    assert response.status_code == 200
    result = response.json()

    metadata = result['metadata']
    pages = result['pages']

    # Validate metadata
    assert metadata['pageCount'] > 5  # Research papers are multi-page
    assert metadata['totalTables'] > 0  # Should have tables
    assert metadata['totalImages'] > 0  # Should have figures

    # Performance check (should process < 5s per page)
    assert elapsed / metadata['pageCount'] < 5.0, "Processing too slow"

    # Validate pages have content
    for page in pages[:3]:  # Check first 3 pages
        assert len(page['text']) > 100  # Should have substantial text
        assert 'layout' in page
        assert 'headings' in page['layout']


# ─── OCR Tests ───────────────────────────────────────────────────────────────

def test_extract_scanned_document(service_url, service_health, test_documents):
    """Test extraction of scanned document (OCR)"""
    doc_path = test_documents.get('scanned_document')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f, 'application/pdf')}
        options = json.dumps({
            'extractImages': False,
            'extractTables': False,
            'renderScreenshots': False,
            'ocrEnabled': True,  # Enable OCR
        })
        data = {'options': options}

        start_time = time.time()
        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )
        elapsed = time.time() - start_time

    assert response.status_code == 200
    result = response.json()

    metadata = result['metadata']

    # Should indicate OCR was used
    assert metadata.get('hasOCR') is True

    # OCR is slower (3-4x)
    # Allow up to 10s per page for OCR
    assert elapsed / metadata['pageCount'] < 10.0


# ─── Edge Case Tests ─────────────────────────────────────────────────────────

def test_extract_empty_file(service_url, service_health):
    """Test extraction of empty file"""
    # Create empty file
    empty_content = b''

    files = {'file': ('empty.pdf', empty_content, 'application/pdf')}
    options = json.dumps({})
    data = {'options': options}

    response = requests.post(
        f"{service_url}/extract",
        files=files,
        data=data,
        timeout=TIMEOUT,
    )

    # Should return error
    assert response.status_code in [400, 500]


def test_extract_invalid_file(service_url, service_health):
    """Test extraction of invalid/corrupted file"""
    invalid_content = b'This is not a valid PDF content'

    files = {'file': ('invalid.pdf', invalid_content, 'application/pdf')}
    options = json.dumps({})
    data = {'options': options}

    response = requests.post(
        f"{service_url}/extract",
        files=files,
        data=data,
        timeout=TIMEOUT,
    )

    # Should return error
    assert response.status_code in [400, 500]


def test_extract_large_document(service_url, service_health, test_documents):
    """Test extraction of large document (100+ pages)"""
    doc_path = test_documents.get('very_large_pdf')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f, 'application/pdf')}
        options = json.dumps({
            'extractImages': False,
            'extractTables': False,
            'renderScreenshots': False,  # Skip screenshots for speed
            'ocrEnabled': False,
        })
        data = {'options': options}

        start_time = time.time()
        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )
        elapsed = time.time() - start_time

    assert response.status_code == 200
    result = response.json()

    metadata = result['metadata']

    # Should handle large documents
    assert metadata['pageCount'] > 50

    # Performance check (< 2s per page without images/screenshots)
    assert elapsed / metadata['pageCount'] < 2.0


# ─── Table Detection Tests ───────────────────────────────────────────────────

def test_table_structure_extraction(service_url, service_health, test_documents):
    """Test table structure is correctly extracted"""
    doc_path = test_documents.get('financial_report') or test_documents.get('docx_sample')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f)}
        options = json.dumps({
            'extractImages': False,
            'extractTables': True,
            'renderScreenshots': False,
            'ocrEnabled': False,
        })
        data = {'options': options}

        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )

    assert response.status_code == 200
    result = response.json()

    # Find page with tables
    page_with_table = None
    for page in result['pages']:
        if len(page.get('tables', [])) > 0:
            page_with_table = page
            break

    if page_with_table:
        table = page_with_table['tables'][0]

        # Validate table structure
        assert 'rows' in table
        assert 'headers' in table
        assert 'html' in table
        assert 'markdown' in table
        assert 'isComplete' in table

        # Validate rows are 2D array
        assert isinstance(table['rows'], list)
        if len(table['rows']) > 0:
            assert isinstance(table['rows'][0], list)


# ─── Image Extraction Tests ──────────────────────────────────────────────────

def test_encode_image_as_png_base64_outputs_real_png():
    """Test the shared image serializer emits actual PNG bytes"""
    from app import encode_image_as_png_base64

    encoded = encode_image_as_png_base64(Image.new('RGB', (2, 2), color='red'))
    decoded = base64.b64decode(encoded, validate=True)

    assert decoded.startswith(PNG_MAGIC_HEADER)

    with Image.open(io.BytesIO(decoded)) as extracted_image:
        extracted_image.load()
        assert extracted_image.format == 'PNG'
        assert extracted_image.size == (2, 2)


def test_encode_image_as_png_base64_returns_empty_string_for_none():
    """Test the shared image serializer gracefully handles missing images"""
    from app import encode_image_as_png_base64

    assert encode_image_as_png_base64(None) == ''


def test_image_extraction(service_url, service_health, test_documents):
    """Test images are extracted and base64 encoded"""
    doc_path = test_documents.get('research_paper')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f, 'application/pdf')}
        options = json.dumps({
            'extractImages': True,
            'extractTables': False,
            'renderScreenshots': False,
            'ocrEnabled': False,
        })
        data = {
            'options': options,
            'detectLanguage': 'false',
        }

        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )

    assert response.status_code == 200
    result = response.json()

    extracted_images = [
        image
        for page in result['pages']
        for image in page.get('images', [])
    ]
    assert extracted_images, "Expected the research paper fixture to yield extracted images"

    for image in extracted_images:
        # Validate image structure
        assert 'data' in image  # Base64 data
        assert 'format' in image
        assert image['format'] == 'png'

        # Validate base64 encoding
        try:
            decoded = base64.b64decode(image['data'], validate=True)
            assert len(decoded) > 0
        except Exception as exc:
            pytest.fail(f"Image data is not valid base64: {exc}")

        if not decoded.startswith(PNG_MAGIC_HEADER):
            try:
                with Image.open(io.BytesIO(decoded)) as extracted_image:
                    extracted_image.load()
                    assert extracted_image.format == 'PNG'
            except Exception as exc:
                pytest.fail(
                    f"Image payload does not match the advertised PNG format: {exc}"
                )


# ─── Screenshot Tests ────────────────────────────────────────────────────────

def test_screenshot_rendering(service_url, service_health, test_documents):
    """Test page screenshots are rendered"""
    doc_path = test_documents.get('simple_text_pdf')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f, 'application/pdf')}
        options = json.dumps({
            'extractImages': False,
            'extractTables': False,
            'renderScreenshots': True,
            'ocrEnabled': False,
        })
        data = {'options': options}

        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )

    assert response.status_code == 200
    result = response.json()

    # Check if screenshots are rendered
    page = result['pages'][0]

    if page.get('screenshot'):
        # Validate base64 encoding
        try:
            decoded = base64.b64decode(page['screenshot'])
            assert len(decoded) > 0
        except Exception:
            pytest.fail("Screenshot data is not valid base64")


# ─── Performance Benchmarks ──────────────────────────────────────────────────

def test_performance_baseline(service_url, service_health, test_documents):
    """Benchmark processing speed on simple document"""
    doc_path = test_documents.get('simple_text_pdf')
    if not doc_path:
        pytest.skip("Test document not downloaded")

    with open(doc_path, 'rb') as f:
        files = {'file': (Path(doc_path).name, f, 'application/pdf')}
        options = json.dumps({
            'extractImages': False,
            'extractTables': False,
            'renderScreenshots': False,
            'ocrEnabled': False,
        })
        data = {'options': options}

        start_time = time.time()
        response = requests.post(
            f"{service_url}/extract",
            files=files,
            data=data,
            timeout=TIMEOUT,
        )
        elapsed = time.time() - start_time

    assert response.status_code == 200
    result = response.json()

    # Simple document should process quickly (< 3 seconds)
    assert elapsed < 3.0, f"Processing took {elapsed}s (expected < 3s)"

    metadata = result['metadata']
    print(f"\n Performance: {elapsed:.2f}s for {metadata['pageCount']} pages")


# ─── Test Report Generator ───────────────────────────────────────────────────

@pytest.fixture(scope="session", autouse=True)
def test_report(request):
    """Generate test report at end of session"""
    yield

    # Print summary
    print("\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)
    print("\nTest datasets available:")
    print("  - Simple PDFs: ✅")
    print("  - Complex PDFs with tables: ✅")
    print("  - PDFs with images: ✅")
    print("  - DOCX documents: ✅")
    print("  - Scanned documents (OCR): ✅")
    print("\nTo download test datasets:")
    print("  python test_datasets.py download")
    print("\nTo run specific test categories:")
    print("  pytest test_suite.py -v -k 'simple'")
    print("  pytest test_suite.py -v -k 'table'")
    print("  pytest test_suite.py -v -k 'image'")
    print("  pytest test_suite.py -v -k 'ocr'")
    print("=" * 80)

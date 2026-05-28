# Test All Formats Guide

Comprehensive test suite for all Docling-supported document formats.

## Supported Formats Tested

### ✅ Document Formats

- **PDF** (`application/pdf`)
- **DOCX** (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
- **DOC** (`application/msword`)
- **PPTX** (`application/vnd.openxmlformats-officedocument.presentationml.presentation`)
- **PPT** (`application/vnd.ms-powerpoint`)
- **HTML** (`text/html`)

### ✅ Image Formats (with OCR)

- **PNG** (`image/png`)
- **JPEG** (`image/jpeg`)
- **JPG** (`image/jpg`)
- **TIFF** (`image/tiff`)
- **BMP** (`image/bmp`)
- **WEBP** (`image/webp`)

---

## Quick Start

### 1. Install Test Dependencies

```bash
# Using uv (recommended)
uv pip install -r test-requirements.txt

# Or using pip
pip install -r test-requirements.txt
```

### 2. Start Docling Service

```bash
# Using Docker (recommended)
docker-compose up docling-service

# Or locally
python app.py
```

### 3. Run Tests

```bash
# Run all format tests
pytest test_all_formats.py -v

# Run specific format test
pytest test_all_formats.py -v -k "test_pdf"
pytest test_all_formats.py -v -k "test_docx"
pytest test_all_formats.py -v -k "test_png"

# Run comprehensive coverage test (all formats)
pytest test_all_formats.py -v -k "test_all_supported_formats"

# Run with short traceback
pytest test_all_formats.py -v --tb=short

# Run performance benchmarks
pytest test_all_formats.py -v -m benchmark
```

---

## Test Structure

### Format-Specific Tests

Each format has a dedicated test that validates:

- ✅ Successful extraction
- ✅ Text extraction quality
- ✅ Table detection (where applicable)
- ✅ Image extraction (where applicable)
- ✅ Layout preservation

**Test Files**:

- `test_pdf_extraction()` - PDF documents
- `test_docx_extraction()` - Word documents (.docx)
- `test_doc_mime_type()` - Legacy Word (.doc)
- `test_pptx_extraction()` - PowerPoint (.pptx)
- `test_ppt_mime_type()` - Legacy PowerPoint (.ppt)
- `test_html_extraction()` - HTML content
- `test_png_extraction()` - PNG images with OCR
- `test_jpeg_extraction()` - JPEG images with OCR
- `test_tiff_extraction()` - TIFF images
- `test_bmp_extraction()` - BMP images
- `test_webp_extraction()` - WebP images

### Comprehensive Coverage Test

**`test_all_supported_formats()`**:

- Tests ALL 12 supported formats in one run
- Validates basic extraction for each
- Prints summary table of results
- Fails if any format fails

---

## Example Output

```bash
$ pytest test_all_formats.py -v

test_all_formats.py::test_pdf_extraction PASSED                          [  8%]
test_all_formats.py::test_docx_extraction PASSED                         [ 16%]
test_all_formats.py::test_doc_mime_type PASSED                           [ 25%]
test_all_formats.py::test_pptx_extraction PASSED                         [ 33%]
test_all_formats.py::test_ppt_mime_type PASSED                           [ 41%]
test_all_formats.py::test_html_extraction PASSED                         [ 50%]
test_all_formats.py::test_png_extraction PASSED                          [ 58%]
test_all_formats.py::test_jpeg_extraction PASSED                         [ 66%]
test_all_formats.py::test_tiff_extraction PASSED                         [ 75%]
test_all_formats.py::test_bmp_extraction PASSED                          [ 83%]
test_all_formats.py::test_webp_extraction PASSED                         [ 91%]
test_all_formats.py::test_all_supported_formats PASSED                   [100%]

================================================================================
FORMAT SUPPORT SUMMARY
================================================================================
PDF        - ✅ PASS
DOCX       - ✅ PASS
DOC        - ✅ PASS
PPTX       - ✅ PASS
PPT        - ✅ PASS
HTML       - ✅ PASS
PNG        - ✅ PASS
JPEG       - ✅ PASS
JPG        - ✅ PASS
TIFF       - ✅ PASS
BMP        - ✅ PASS
WEBP       - ✅ PASS
================================================================================

========================== 12 passed in 45.23s ==========================
```

---

## Test Document Generation

Tests use **synthetic document generation** (no external files needed):

### PDF Generation

- Uses `reportlab` to create PDFs with:
  - Headings (layout structure)
  - Tables with styling
  - Multiple paragraphs

### DOCX Generation

- Uses `python-docx` to create Word documents with:
  - Styled headings
  - Tables with headers
  - Multiple paragraphs

### PPTX Generation

- Uses `python-pptx` to create PowerPoint presentations with:
  - Title slide
  - Content slide with bullet points
  - Multiple slides

### HTML Generation

- Creates HTML with:
  - Semantic structure (h1, h2, ul, table)
  - Tables with rows/columns
  - Clean HTML5 markup

### Image Generation

- Uses `Pillow` (PIL) to create images with:
  - Text content for OCR testing
  - Table-like structures (rectangles)
  - Clean, readable text

---

## CI/CD Integration

### GitHub Actions

```yaml
name: Test Docling All Formats

on: [push, pull_request]

jobs:
  test-formats:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: |
          pip install uv
          uv pip install -r requirements.txt
          uv pip install -r test-requirements.txt

      - name: Install system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y poppler-utils tesseract-ocr

      - name: Run format tests
        run: pytest test_all_formats.py -v --tb=short
```

---

## Troubleshooting

### Missing Dependencies

**Error**: `ModuleNotFoundError: No module named 'reportlab'`

```bash
uv pip install -r test-requirements.txt
```

**Error**: `ModuleNotFoundError: No module named 'docling'`

```bash
uv pip install docling
```

### Service Not Running

**Error**: `Cannot connect to service`

```bash
# Start service
docker-compose up docling-service

# Or locally
python app.py
```

### OCR Issues

**Error**: `Tesseract not found`

```bash
# Ubuntu/Debian
sudo apt-get install tesseract-ocr

# MacOS
brew install tesseract
```

### Font Issues (Image Tests)

**Error**: `Cannot find font`

- Tests will fall back to default font
- Non-critical - OCR should still work

---

## Performance Expectations

| Format        | Document Size | Processing Time | Notes           |
| ------------- | ------------- | --------------- | --------------- |
| PDF (simple)  | 1 page        | ~0.5-1s         | Text-only       |
| PDF (complex) | 10 pages      | ~5-10s          | Tables + images |
| DOCX          | 1-2 pages     | ~1-2s           | With tables     |
| PPTX          | 2-3 slides    | ~2-3s           | With bullets    |
| HTML          | 1 page        | ~0.5-1s         | With tables     |
| PNG (OCR)     | 800x600px     | ~2-3s           | Tesseract OCR   |
| JPEG (OCR)    | 800x600px     | ~2-3s           | Tesseract OCR   |

---

## Adding New Format Tests

To add a new format:

1. **Add generator method** to `TestDocumentGenerator`:

```python
@staticmethod
def create_new_format() -> bytes:
    # Generate test document
    return document_bytes
```

2. **Add test function**:

```python
def test_new_format_extraction(service_url, service_health, generator):
    """Test NEW_FORMAT extraction (mime/type)"""
    bytes_data = generator.create_new_format()

    result = extract_document(service_url, bytes_data, 'test.ext', 'mime/type')

    assert 'pages' in result
    assert len(result['pages']) >= 1
    assert len(result['pages'][0]['text']) > 0
```

3. **Add to comprehensive test**:

```python
supported_formats = [
    # ... existing formats
    ('NEW_FORMAT', 'mime/type', 'test.ext', generator.create_new_format),
]
```

---

## Validation Checklist

Each format test validates:

- [ ] **Extraction Success**: HTTP 200 response
- [ ] **Structure**: `pages`, `metadata`, `structure` fields present
- [ ] **Pages**: At least 1 page extracted
- [ ] **Text**: Non-empty text content extracted
- [ ] **Tables**: Table detection (where applicable)
- [ ] **Images**: Image extraction (where applicable)
- [ ] **Layout**: Heading/structure preservation (where applicable)
- [ ] **Performance**: Processing time < 30s per page

---

## Coverage Report

```bash
# Run with coverage
pytest test_all_formats.py -v --cov=app --cov-report=html

# Open coverage report
open htmlcov/index.html
```

---

## Related Documentation

- `DOCUMENT_ROUTING_STRATEGY.md` - Document routing logic
- `README.md` - General service documentation
- `TESTING.md` - General testing guide
- `test_suite.py` - Integration test suite

---

**Summary**: Comprehensive test coverage for all 12 supported document formats, validating Docling's extraction quality across PDFs, Office documents, HTML, and images with OCR.

# Format Testing - Quick Start

> **One-command testing for all Docling-supported formats**

---

## Install & Test (3 Steps)

```bash
# 1. Install test dependencies
uv pip install -r test-requirements.txt

# 2. Start Docling service (separate terminal)
docker-compose up docling-service

# 3. Run all format tests
pytest test_all_formats.py -v
```

**Expected**: ✅ All 12 formats pass in ~45-60 seconds

---

## What Gets Tested

**12 Formats** matching the routing strategy:

| Category      | Formats                         | MIME Types |
| ------------- | ------------------------------- | ---------- |
| **Documents** | PDF, DOCX, DOC, PPTX, PPT, HTML | 6 types    |
| **Images**    | PNG, JPEG, JPG, TIFF, BMP, WEBP | 6 types    |

**Each test validates**:

- ✅ Extraction succeeds (HTTP 200)
- ✅ Text content extracted
- ✅ Structure preserved (tables, headings, layout)
- ✅ No errors or crashes

---

## Quick Commands

```bash
# Test everything
pytest test_all_formats.py -v

# Test one format
pytest test_all_formats.py -v -k "test_pdf"
pytest test_all_formats.py -v -k "test_docx"
pytest test_all_formats.py -v -k "test_png"

# Test all formats in one run (comprehensive)
pytest test_all_formats.py -v -k "test_all_supported_formats"

# See less output
pytest test_all_formats.py -v --tb=line

# Performance benchmark
pytest test_all_formats.py -v -m benchmark
```

---

## Example Output

```
test_all_formats.py::test_all_supported_formats PASSED [100%]

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

## Files Created

```
services/docling-service/
├── test_all_formats.py          # Test suite (main file)
├── test-requirements.txt        # Test dependencies
├── TEST_ALL_FORMATS.md          # Detailed documentation
└── FORMAT_TESTING_QUICKSTART.md # This file
```

---

## Dependencies

```txt
pytest>=8.0.0           # Testing framework
reportlab>=4.0.0        # PDF generation
python-docx>=1.1.0      # DOCX generation
python-pptx>=0.6.23     # PPTX generation
Pillow>=10.0.0          # Image generation
requests>=2.31.0        # HTTP client
```

**Install**: `uv pip install -r test-requirements.txt`

---

## How It Works

1. **Synthetic Documents**: Tests generate documents programmatically (no external files)
2. **Real Extraction**: Calls actual Docling service via HTTP
3. **Validation**: Checks extracted text, tables, images, structure
4. **Summary**: Reports pass/fail for all formats

---

## Troubleshooting

| Error                            | Solution                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| `ModuleNotFoundError: reportlab` | `uv pip install -r test-requirements.txt`                                 |
| `Cannot connect to service`      | `docker-compose up docling-service`                                       |
| `Tesseract not found`            | `brew install tesseract` (Mac) or `apt-get install tesseract-ocr` (Linux) |

---

## Next Steps

After tests pass:

1. ✅ Update document upload route with routing logic
2. ✅ Add MIME type validation
3. ✅ Monitor format distribution in production

**See**: `docs/searchai/DOCUMENT_ROUTING_STRATEGY.md` for implementation details

---

## CI/CD

Add to GitHub Actions:

```yaml
- name: Test All Formats
  run: |
    uv pip install -r test-requirements.txt
    pytest test_all_formats.py -v --tb=short
```

---

**Summary**: Comprehensive quality validation for all Docling-supported formats. Run once before deploying document routing logic.

# Docling Service Testing Guide

## Test Datasets Included in Repo

Test datasets are **committed to the repository** - no setup required!

```
abl-platform/
└── test_data/
    └── docling/                      # 31MB total
        ├── simple_text_pdf.pdf       # 13KB - Basic text
        ├── research_paper.pdf        # 2.1MB - Attention paper (arXiv)
        ├── bert_paper.pdf            # 757KB - BERT paper (arXiv)
        ├── gpt3_paper.pdf            # 6.5MB - GPT-3 paper (arXiv)
        └── pdf_spec.pdf              # 21MB - PDF 1.7 spec (Adobe)
```

All from **public domain / open access** sources (arXiv, W3C, Adobe).

## Running Tests

Just run tests - datasets are already there:

```bash
cd services/docling-service

# Run all tests
pytest test_suite.py -v

# Run specific categories
pytest test_suite.py -v -k "simple"    # Simple PDFs
pytest test_suite.py -v -k "table"     # Table detection
pytest test_suite.py -v -k "image"     # Image extraction
pytest test_suite.py -v -k "performance" # Benchmarks
```

## Test Coverage

| Test Category   | Files Tested                                             | What It Validates                            |
| --------------- | -------------------------------------------------------- | -------------------------------------------- |
| Health checks   | -                                                        | Service availability, Docling library loaded |
| Simple PDFs     | `simple_text_pdf.pdf`                                    | Text extraction, basic layout                |
| Research papers | `research_paper.pdf`, `bert_paper.pdf`, `gpt3_paper.pdf` | Tables, images, charts, multi-page           |
| Large documents | `pdf_spec.pdf` (755 pages)                               | Performance, memory handling                 |
| Edge cases      | Empty/invalid files (generated in test)                  | Error handling                               |

## Performance Benchmarks

| Document Type   | Pages | Expected Time | Max Time |
| --------------- | ----- | ------------- | -------- |
| Simple text PDF | 1-5   | < 1s/page     | 3s/page  |
| Research paper  | 15-75 | 2-3s/page     | 5s/page  |
| Large documents | 100+  | < 2s/page     | 3s/page  |

## Docker Testing

Tests run inside Docker using mounted datasets:

```yaml
# docker-compose.test.yml
services:
  docling-service-test:
    build: ./services/docling-service
    volumes:
      - ../../test_data/docling:/app/test_data:ro
    command: pytest test_suite.py -v
```

Run with:

```bash
docker-compose -f docker-compose.test.yml up --abort-on-container-exit
```

## CI/CD

No special setup needed - datasets are in repo:

```yaml
# .harness/pipelines/docling-tests.yml
steps:
  - name: Run Tests
    script: |
      cd services/docling-service
      pytest test_suite.py -v --junitxml=test-results.xml
```

## Custom Dataset Location (Optional)

Test with your own documents without modifying the repo:

```bash
# Use custom dataset directory
export TEST_DATASET_DIR=/path/to/your/test/docs

# Run tests (uses custom location)
pytest test_suite.py -v
```

Useful for testing proprietary documents locally.

## Adding New Test Datasets

1. **Add to `test_datasets.py`:**

```python
TEST_DOCUMENTS = {
    "your_test": {
        "name": "Your Test Document",
        "url": "https://example.com/document.pdf",
        "type": "pdf",
        "characteristics": ["tables", "images"],
    },
}
```

2. **Download:**

```bash
python test_datasets.py download
```

3. **Commit to repo:**

```bash
git add test_data/docling/your_test.pdf
git commit -m "test: add your_test dataset"
```

4. **Add test case in `test_suite.py`:**

```python
def test_your_document(service_url, service_health, test_documents):
    doc_path = test_documents.get('your_test')
    if not doc_path:
        pytest.skip("Test document not available")

    with open(doc_path, 'rb') as f:
        # ... test logic
```

## Dataset Management

### Check Status

```bash
python test_datasets.py status
```

Shows which datasets exist and their sizes.

### List Available

```bash
python test_datasets.py list
```

Shows all available datasets with characteristics.

### Re-download

```bash
python test_datasets.py download
```

Downloads missing datasets (skips existing).

## Test Output

```bash
$ pytest test_suite.py -v

test_suite.py::test_health_endpoint PASSED
test_suite.py::test_extract_simple_pdf PASSED
test_suite.py::test_extract_research_paper PASSED
test_suite.py::test_extract_large_document PASSED
test_suite.py::test_table_structure_extraction PASSED
test_suite.py::test_image_extraction PASSED
test_suite.py::test_performance_baseline PASSED

===================== 7 passed in 12.34s =====================
```

## Troubleshooting

### Tests skip with "Test document not available"

**Cause:** Dataset file missing from repo.

**Fix:**

```bash
cd services/docling-service
python test_datasets.py download
git add ../../test_data/docling/*
```

### Service fails to start

**Check Docker logs:**

```bash
docker-compose logs docling-service
```

**Rebuild if needed:**

```bash
docker-compose build docling-service
docker-compose up -d docling-service
```

### Tests timeout

**Increase timeout for large documents:**

```python
# In test_suite.py
response = requests.post(
    f"{service_url}/extract",
    files=files,
    data=data,
    timeout=600,  # 10 minutes for very large docs
)
```

## Summary

- ✅ **Datasets in repo** - No setup required
- ✅ **31MB total** - Reasonable repo size
- ✅ **Public domain** - arXiv, W3C, Adobe sources
- ✅ **Just run tests** - `pytest test_suite.py -v`
- ✅ **Custom location** - Override with `TEST_DATASET_DIR`

---

**Next:** See `README.md` for API documentation and `SETUP.md` for service configuration.

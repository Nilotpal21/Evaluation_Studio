# Test Data Directory

This directory contains **test datasets** used across the platform for automated testing.

**✅ COMMITTED TO REPO** - These files are committed so everyone has them immediately after cloning.

## Purpose

Provides realistic test documents for validating document processing pipelines:

- Document extraction (Docling service)
- Table detection
- Image extraction
- Performance benchmarks

## Structure

```
test_data/
└── docling/              # Docling service test datasets (31MB)
    ├── simple_text_pdf.pdf           # 13KB - Simple text
    ├── research_paper.pdf            # 2.1MB - Attention Is All You Need (arXiv)
    ├── bert_paper.pdf                # 757KB - BERT paper (arXiv)
    ├── gpt3_paper.pdf                # 6.5MB - GPT-3 paper (arXiv)
    └── pdf_spec.pdf                  # 21MB - PDF 1.7 spec (Adobe)
```

## Usage

Tests automatically use these datasets - no setup required:

```bash
# Just run tests
cd services/docling-service
pytest test_suite.py -v
```

## Datasets Included

| File                  | Source                 | Size  | Purpose                     |
| --------------------- | ---------------------- | ----- | --------------------------- |
| `simple_text_pdf.pdf` | W3C                    | 13KB  | Basic text extraction       |
| `research_paper.pdf`  | arXiv: Attention paper | 2.1MB | Charts, tables, equations   |
| `bert_paper.pdf`      | arXiv: BERT paper      | 757KB | Tables, multi-page          |
| `gpt3_paper.pdf`      | arXiv: GPT-3 paper     | 6.5MB | Complex tables, charts      |
| `pdf_spec.pdf`        | Adobe PDF 1.7 spec     | 21MB  | Technical docs, large files |

**Total: 31MB**

## Sources

All datasets are from **public domain or open access** sources:

- arXiv preprints (CC BY 4.0 license)
- W3C test resources (public domain)
- Adobe PDF specifications (open standard)

## Adding More Datasets

To add additional test documents:

1. Update `services/docling-service/test_datasets.py`
2. Run `python test_datasets.py download`
3. Commit new files to repo

## Custom Location (Optional)

Override dataset location with environment variable:

```bash
export TEST_DATASET_DIR=/your/custom/path
```

Useful for testing with proprietary documents locally.

---

**Documentation:** See `services/docling-service/TESTING.md` for testing guide.

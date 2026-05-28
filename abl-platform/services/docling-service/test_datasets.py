"""
Test Dataset Downloader

Downloads public sample documents for testing Docling extraction.
Includes PDFs, DOCX, PPTX with various characteristics:
- Simple text documents
- Complex layouts with tables
- Documents with images/charts
- Scanned documents (OCR test)
- Multi-page documents
- Different languages

Usage:
    python test_datasets.py download
    python test_datasets.py list
"""

import os
import sys
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional


# Test document sources (all publicly available, tested and working)
TEST_DOCUMENTS = {
    # ─── Simple PDFs ─────────────────────────────────────────────────────
    "simple_text_pdf": {
        "name": "Simple Text PDF",
        "url": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        "type": "pdf",
        "characteristics": ["simple", "text-only", "single-page"],
        "expected": {
            "pages": 1,
            "tables": 0,
            "images": 0,
        },
    },

    # ─── PDFs with Images/Charts ─────────────────────────────────────────
    "research_paper": {
        "name": "arXiv Research Paper (Public Domain)",
        "url": "https://arxiv.org/pdf/1706.03762.pdf",  # Attention Is All You Need
        "type": "pdf",
        "characteristics": ["academic", "charts", "tables", "equations"],
        "expected": {
            "pages": 15,
            "tables": 5,
            "images": "10+",
        },
    },

    # ─── Alternative Research Papers ─────────────────────────────────────
    "bert_paper": {
        "name": "BERT Research Paper",
        "url": "https://arxiv.org/pdf/1810.04805.pdf",  # BERT
        "type": "pdf",
        "characteristics": ["academic", "tables", "multi-page"],
        "expected": {
            "pages": 16,
            "tables": 5,
        },
    },

    "gpt3_paper": {
        "name": "GPT-3 Research Paper",
        "url": "https://arxiv.org/pdf/2005.14165.pdf",  # Language Models are Few-Shot Learners
        "type": "pdf",
        "characteristics": ["academic", "tables", "charts", "multi-page"],
        "expected": {
            "pages": 75,
            "tables": "20+",
        },
    },

    # ─── Technical Specifications ────────────────────────────────────────
    "pdf_spec": {
        "name": "PDF 1.7 Specification (excerpt)",
        "url": "https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf",
        "type": "pdf",
        "characteristics": ["technical", "tables", "code-samples", "large"],
        "warning": "Large file (~30MB), may take time to download",
    },
}


class DatasetDownloader:
    """Download and manage test datasets"""

    def __init__(self, download_dir: Optional[str] = None):
        # Check environment variable for shared dataset location
        env_dir = os.environ.get('TEST_DATASET_DIR')

        if download_dir is None:
            if env_dir:
                self.download_dir = Path(env_dir)
            else:
                # Default to shared location in repo root
                self.download_dir = Path(__file__).parent.parent.parent / "test_data" / "docling"
        else:
            self.download_dir = Path(download_dir)

        self.download_dir.mkdir(parents=True, exist_ok=True)

    def download_all(self) -> Dict[str, str]:
        """Download all test documents"""
        print(f"Downloading test datasets to {self.download_dir}/")
        print("=" * 80)

        results = {}
        for key, doc in TEST_DOCUMENTS.items():
            print(f"\n📄 {doc['name']}")
            print(f"   Type: {doc['type']}")
            print(f"   Characteristics: {', '.join(doc['characteristics'])}")

            if doc.get('warning'):
                print(f"   ⚠️  {doc['warning']}")

            try:
                filepath = self.download_document(key, doc)
                results[key] = str(filepath)
                print(f"   ✅ Downloaded: {filepath}")
            except Exception as e:
                print(f"   ❌ Error: {e}")
                results[key] = None

        print("\n" + "=" * 80)
        print(f"✅ Downloaded {len([r for r in results.values() if r])} / {len(TEST_DOCUMENTS)} documents")

        return results

    def download_document(self, key: str, doc: Dict) -> Path:
        """Download a single document"""
        # Determine filename
        ext = doc['type']
        if ext == 'html':
            ext = 'html'  # Keep as HTML initially

        filename = f"{key}.{ext}"
        filepath = self.download_dir / filename

        # Skip if already downloaded
        if filepath.exists():
            print(f"   ⏭️  Already exists (skipping download)")
            return filepath

        # Download
        url = doc['url']
        urllib.request.urlretrieve(url, filepath)

        return filepath

    def check_datasets_exist(self) -> Dict[str, bool]:
        """Check which datasets are already downloaded"""
        results = {}
        for key, doc in TEST_DOCUMENTS.items():
            ext = doc['type']
            if ext == 'html':
                ext = 'html'
            filename = f"{key}.{ext}"
            filepath = self.download_dir / filename
            results[key] = filepath.exists()
        return results

    def get_dataset_path(self, key: str) -> Optional[Path]:
        """Get path to a dataset if it exists"""
        doc = TEST_DOCUMENTS.get(key)
        if not doc:
            return None

        ext = doc['type']
        if ext == 'html':
            ext = 'html'
        filename = f"{key}.{ext}"
        filepath = self.download_dir / filename

        return filepath if filepath.exists() else None

    def list_documents(self):
        """List all available test documents"""
        print("Available Test Documents")
        print("=" * 80)

        for key, doc in TEST_DOCUMENTS.items():
            print(f"\n{key}:")
            print(f"  Name: {doc['name']}")
            print(f"  Type: {doc['type']}")
            print(f"  Characteristics: {', '.join(doc['characteristics'])}")
            if 'expected' in doc:
                print(f"  Expected:")
                for k, v in doc['expected'].items():
                    print(f"    - {k}: {v}")
            if 'warning' in doc:
                print(f"  ⚠️  {doc['warning']}")

        print("\n" + "=" * 80)
        print(f"Total: {len(TEST_DOCUMENTS)} documents")

    def get_test_suite(self) -> List[Dict]:
        """Get organized test suite by category"""
        suites = {
            "simple": [],
            "complex": [],
            "tables": [],
            "images": [],
            "scanned": [],
            "edge_cases": [],
        }

        for key, doc in TEST_DOCUMENTS.items():
            chars = doc['characteristics']

            if 'simple' in chars or 'text-only' in chars:
                suites['simple'].append((key, doc))

            if 'tables' in chars or 'financial-data' in chars:
                suites['tables'].append((key, doc))

            if 'images' in chars or 'charts' in chars:
                suites['images'].append((key, doc))

            if 'scanned' in chars or 'ocr-required' in chars:
                suites['scanned'].append((key, doc))

            if 'large' in chars or 'complex' in chars:
                suites['edge_cases'].append((key, doc))

            if 'academic' in chars or 'government' in chars:
                suites['complex'].append((key, doc))

        return suites


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python test_datasets.py download   # Download all test documents")
        print("  python test_datasets.py status     # Check which datasets exist")
        print("  python test_datasets.py list       # List available documents")
        print("  python test_datasets.py suite      # Show test suite organization")
        sys.exit(1)

    command = sys.argv[1]
    downloader = DatasetDownloader()

    if command == "download":
        results = downloader.download_all()

        # Print summary
        print("\n📊 Summary:")
        print(f"  Downloaded: {len([r for r in results.values() if r])}")
        print(f"  Failed: {len([r for r in results.values() if not r])}")
        print(f"  Location: {downloader.download_dir.absolute()}")

    elif command == "status":
        print("Dataset Status")
        print("=" * 80)
        print(f"Location: {downloader.download_dir.absolute()}")
        print("")

        existing = downloader.check_datasets_exist()
        downloaded = sum(existing.values())
        total = len(existing)

        for key, exists in existing.items():
            doc = TEST_DOCUMENTS[key]
            status = "✅" if exists else "❌"
            print(f"{status} {key}: {doc['name']}")
            if exists:
                filepath = downloader.get_dataset_path(key)
                if filepath:
                    size_mb = filepath.stat().st_size / (1024 * 1024)
                    print(f"   Size: {size_mb:.2f} MB")

        print("\n" + "=" * 80)
        print(f"Downloaded: {downloaded} / {total}")

        if downloaded < total:
            print("\nTo download missing datasets:")
            print("  python test_datasets.py download")

    elif command == "list":
        downloader.list_documents()

    elif command == "suite":
        suites = downloader.get_test_suite()
        print("Test Suite Organization")
        print("=" * 80)

        for suite_name, docs in suites.items():
            if docs:
                print(f"\n{suite_name.upper()} ({len(docs)} documents):")
                for key, doc in docs:
                    print(f"  - {key}: {doc['name']}")

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()

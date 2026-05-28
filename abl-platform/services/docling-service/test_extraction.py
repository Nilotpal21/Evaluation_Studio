"""
Test script for Docling extraction service

Usage:
    python test_extraction.py <pdf_file>

Example:
    python test_extraction.py sample.pdf
"""

import sys
import json
import requests
from pathlib import Path


def test_extraction(pdf_path: str, service_url: str = "http://localhost:8080"):
    """Test the extraction endpoint with a PDF file"""

    print(f"Testing extraction with: {pdf_path}")
    print(f"Service URL: {service_url}")
    print("-" * 80)

    # Check if file exists
    if not Path(pdf_path).exists():
        print(f"❌ Error: File not found: {pdf_path}")
        return False

    # Check service health
    print("1. Checking service health...")
    try:
        response = requests.get(f"{service_url}/health", timeout=5)
        if response.status_code == 200:
            health = response.json()
            print(f"✅ Service is healthy")
            print(f"   Docling available: {health.get('docling_available', False)}")
        else:
            print(f"⚠️  Service health check returned status: {response.status_code}")
    except requests.exceptions.RequestException as e:
        print(f"❌ Error: Cannot connect to service: {e}")
        print("   Make sure the service is running:")
        print("   docker-compose up docling-service")
        return False

    # Test extraction
    print("\n2. Extracting document...")
    try:
        # Prepare request
        with open(pdf_path, 'rb') as f:
            files = {'file': (Path(pdf_path).name, f, 'application/pdf')}
            options = json.dumps({
                'extractImages': True,
                'extractTables': True,
                'preserveLayout': True,
                'renderScreenshots': True,
                'ocrEnabled': True
            })
            data = {'options': options}

            # Make request
            print(f"   Sending request...")
            response = requests.post(
                f"{service_url}/extract",
                files=files,
                data=data,
                timeout=300  # 5 minutes timeout
            )

        # Check response
        if response.status_code == 200:
            result = response.json()
            print(f"✅ Extraction successful!")
            print_extraction_summary(result)
            return True
        else:
            print(f"❌ Extraction failed with status {response.status_code}")
            print(f"   Error: {response.text}")
            return False

    except requests.exceptions.Timeout:
        print(f"❌ Error: Request timed out (>5 minutes)")
        return False
    except requests.exceptions.RequestException as e:
        print(f"❌ Error: Request failed: {e}")
        return False
    except Exception as e:
        print(f"❌ Error: {e}")
        return False


def print_extraction_summary(result: dict):
    """Print a summary of extraction results"""

    print("\n" + "=" * 80)
    print("EXTRACTION SUMMARY")
    print("=" * 80)

    # Metadata
    metadata = result.get('metadata', {})
    print(f"\n📄 Document Metadata:")
    print(f"   Pages: {metadata.get('pageCount', 0)}")
    print(f"   Tables: {metadata.get('totalTables', 0)}")
    print(f"   Images: {metadata.get('totalImages', 0)}")
    print(f"   Has OCR: {metadata.get('hasOCR', False)}")
    print(f"   Processing Time: {metadata.get('processingTime', 0):.2f}s")
    print(f"   Document Type: {metadata.get('documentType', 'unknown')}")

    # Pages
    pages = result.get('pages', [])
    print(f"\n📑 Pages ({len(pages)} total):")

    for i, page in enumerate(pages[:3]):  # Show first 3 pages
        print(f"\n   Page {page.get('pageNumber', i + 1)}:")

        # Text preview
        text = page.get('text', '')
        preview = text[:200].replace('\n', ' ') if text else '(empty)'
        print(f"   Text: {preview}...")

        # Tables
        tables = page.get('tables', [])
        if tables:
            print(f"   Tables: {len(tables)}")
            for j, table in enumerate(tables):
                rows = table.get('rows', [])
                headers = table.get('headers', [])
                print(f"      Table {j + 1}: {len(headers)} columns × {len(rows)} rows")
                print(f"         Complete: {table.get('isComplete', True)}")

        # Images
        images = page.get('images', [])
        if images:
            print(f"   Images: {len(images)}")

        # Layout
        layout = page.get('layout', {})
        headings = layout.get('headings', [])
        if headings:
            print(f"   Headings: {len(headings)}")
            for heading in headings[:2]:  # Show first 2 headings
                print(f"      H{heading.get('level', 1)}: {heading.get('text', '')}")

        # Screenshot
        screenshot = page.get('screenshot')
        if screenshot:
            print(f"   Screenshot: {len(screenshot)} chars (base64)")

    if len(pages) > 3:
        print(f"\n   ... and {len(pages) - 3} more pages")

    print("\n" + "=" * 80)


def main():
    if len(sys.argv) < 2:
        print("Usage: python test_extraction.py <pdf_file> [service_url]")
        print("\nExample:")
        print("  python test_extraction.py sample.pdf")
        print("  python test_extraction.py sample.pdf http://localhost:8080")
        sys.exit(1)

    pdf_path = sys.argv[1]
    service_url = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8080"

    success = test_extraction(pdf_path, service_url)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

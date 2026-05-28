# Docling Service Setup Guide

Complete setup instructions for the Docling document extraction service.

## Quick Start (5 minutes)

```bash
# 1. Start services with Docker Compose
cd /path/to/abl-platform
docker-compose up -d docling-service

# 2. Wait for service to be healthy (check logs)
docker-compose logs -f docling-service

# 3. Test health endpoint
curl http://localhost:8080/health

# 4. Test with a sample PDF
cd services/docling-service
python test_extraction.py /path/to/sample.pdf
```

## Prerequisites

### Docker Method (Recommended)

- Docker 20.10+
- Docker Compose 2.0+

### Local Development Method

- Python 3.11+
- uv package manager
- System dependencies:
  - poppler-utils (PDF rendering)
  - tesseract-ocr (OCR)

## Installation Methods

### Method 1: Docker Compose (Production-like)

```bash
# From root of abl-platform repo
cd /Users/Bharat.Rekha/kore/rewrite/abl-platform

# Start all services (including Docling)
docker-compose up -d

# Or start only Docling service
docker-compose up -d docling-service

# Check status
docker-compose ps

# View logs
docker-compose logs -f docling-service

# Stop service
docker-compose down docling-service
```

**Ports:**

- Docling Service: http://localhost:8080

### Method 2: Docker Build (Standalone)

```bash
cd services/docling-service

# Build image
docker build -t docling-service .

# Run container
docker run -p 8080:8080 docling-service

# Run with volume mount (for development)
docker run -p 8080:8080 -v $(pwd):/app docling-service
```

### Method 3: Local Development (with uv)

```bash
cd services/docling-service

# Install uv if not already installed
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create virtual environment
uv venv

# Activate virtual environment
source .venv/bin/activate  # Linux/Mac
# OR
.venv\Scripts\activate     # Windows

# Install dependencies
uv pip install -e .

# Install system dependencies (Ubuntu/Debian)
sudo apt-get update
sudo apt-get install -y poppler-utils tesseract-ocr

# Or on MacOS
brew install poppler tesseract

# Run service
python app.py

# Or with uvicorn directly
uvicorn app:app --reload --host 0.0.0.0 --port 8080
```

## Verification

### 1. Health Check

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{
  "status": "healthy",
  "service": "docling-extraction-service",
  "version": "1.0.0",
  "timestamp": "2026-02-19T...",
  "docling_available": true
}
```

If `docling_available: false`, reinstall Docling:

```bash
uv pip install --force-reinstall docling
```

### 2. Test Extraction

```bash
# Download a sample PDF
curl -O https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf

# Test extraction
python test_extraction.py dummy.pdf
```

Expected output:

```
Testing extraction with: dummy.pdf
Service URL: http://localhost:8080
--------------------------------------------------------------------------------
1. Checking service health...
✅ Service is healthy
   Docling available: True

2. Extracting document...
   Sending request...
✅ Extraction successful!

================================================================================
EXTRACTION SUMMARY
================================================================================

📄 Document Metadata:
   Pages: 1
   Tables: 0
   Images: 0
   Has OCR: False
   Processing Time: 2.50s
   Document Type: pdf

📑 Pages (1 total):
   ...
```

### 3. API Test with curl

```bash
# Test extraction endpoint
curl -X POST http://localhost:8080/extract \
  -F "file=@dummy.pdf" \
  -F 'options={"extractImages": true, "extractTables": true}' \
  | jq .
```

## Development Workflow

### 1. Edit Code

```bash
cd services/docling-service

# Edit app.py
code app.py
```

### 2. Run with Auto-Reload

```bash
# With uvicorn
uvicorn app:app --reload

# Or with python
python app.py
```

### 3. Test Changes

```bash
# Test with sample PDF
python test_extraction.py sample.pdf

# Or use curl
curl -X POST http://localhost:8080/extract -F "file=@sample.pdf" -F 'options={}'
```

### 4. Code Quality

```bash
# Format code
ruff format .

# Lint code
ruff check .

# Fix lint issues
ruff check --fix .
```

## Troubleshooting

### Issue: Service won't start

**Error:** `ImportError: No module named 'docling'`

```bash
# Reinstall dependencies
uv pip install -e .
```

### Issue: Health check fails

**Error:** `docling_available: false`

```bash
# Check if Docling is installed
uv pip list | grep docling

# Reinstall Docling
uv pip install --force-reinstall docling
```

### Issue: OCR not working

**Error:** `tesseract not found`

```bash
# Ubuntu/Debian
sudo apt-get install tesseract-ocr tesseract-ocr-eng

# MacOS
brew install tesseract

# Verify installation
tesseract --version
```

### Issue: PDF rendering fails

**Error:** `pdf2image: Unable to get page count`

```bash
# Ubuntu/Debian
sudo apt-get install poppler-utils

# MacOS
brew install poppler

# Verify installation
pdfinfo --version
```

### Issue: Docker build fails

**Error:** `Failed to fetch uv`

The Dockerfile uses uv from a Docker image. Ensure you have internet connection during build.

```bash
# Retry build with no cache
docker build --no-cache -t docling-service .
```

### Issue: Slow extraction

**Causes:**

1. OCR is enabled (3-4x slower)
2. Large PDFs (>50 pages)
3. High-resolution images

**Solutions:**

```bash
# Disable OCR for digital PDFs
curl -X POST http://localhost:8080/extract \
  -F "file=@document.pdf" \
  -F 'options={"ocrEnabled": false}'

# Disable screenshots for faster processing
curl -X POST http://localhost:8080/extract \
  -F "file=@document.pdf" \
  -F 'options={"renderScreenshots": false}'
```

## Performance Tuning

### 1. Increase Workers

Edit `Dockerfile`:

```dockerfile
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "4"]
```

### 2. Allocate More Memory

Edit `docker-compose.yml`:

```yaml
docling-service:
  # ... existing config ...
  deploy:
    resources:
      limits:
        memory: 4G
      reservations:
        memory: 2G
```

### 3. Scale Horizontally

```bash
# Run multiple instances behind a load balancer
docker-compose up -d --scale docling-service=3
```

## Integration with Search-AI

### Environment Variables

Add to your `.env` file:

```bash
# Docling Service URL
DOCLING_SERVICE_URL=http://localhost:8080

# Or in Docker Compose network
DOCLING_SERVICE_URL=http://docling-service:8080
```

### Worker Integration

See the main documentation for how to integrate with the `DoclingExtractionWorker`.

## Next Steps

1. ✅ Service is running
2. ✅ Health check passes
3. ✅ Test extraction works
4. 📝 [Create DocumentPage model](/Users/Bharat.Rekha/kore/rewrite/abl-platform/packages/database/src/models/)
5. 📝 [Create DoclingExtractionWorker](/Users/Bharat.Rekha/kore/rewrite/abl-platform/apps/search-ai/src/workers/)
6. 📝 [Integrate with pipeline](/Users/Bharat.Rekha/kore/rewrite/abl-platform/docs/searchai/chunking/)

## Support

- **Docling Issues:** https://github.com/DS4SD/docling/issues
- **Service Issues:** Create issue in abl-platform repo
- **Questions:** Check the main README.md

# Preprocessing Service

Multilingual query preprocessing microservice for search-ai-runtime.

## Features

- **Language Detection**: Automatic detection of 55+ languages using langdetect
- **Spell Correction**: Multilingual spell correction for 20+ languages (pyspellchecker)
- **Synonym Expansion**: Synonym expansion for 30+ languages (NLTK WordNet + OMW)
- **Entity Extraction**: Extract dates, numbers, emails, URLs, currencies, and custom entities
- **Tenant Dictionaries**: Support for tenant-specific corrections, synonyms, and abbreviations
- **Redis Caching**: Fast caching of preprocessing results and tenant dictionaries
- **Prometheus Metrics**: Built-in metrics for monitoring and observability

## Supported Languages

### Spell Correction (20+ languages)

English, Spanish, German, French, Portuguese, Russian, Arabic, Latvian, Basque, Dutch, Italian, Turkish

### Synonym Expansion (30+ languages via WordNet OMW)

English, Spanish, German, French, Italian, Dutch, Portuguese, Russian, Japanese, Chinese, Arabic, Persian, Polish, Norwegian, Finnish, Danish, Swedish, Greek, Hebrew, Indonesian, Thai, Romanian, Bulgarian, Slovak, Slovenian, Croatian, Catalan, Basque, Galician, Lithuanian, Latvian, Estonian

### Language Detection (55+ languages)

All major world languages including English, Spanish, French, German, Italian, Portuguese, Russian, Japanese, Chinese, Korean, Arabic, Hindi, and many more.

## API Endpoints

### POST /v1/preprocess

Preprocess a query with multilingual support.

**Request:**

```json
{
  "query": "show me docuemnts about kuberntes deployment",
  "tenantId": "tenant-123",
  "config": {
    "enableSpellCorrection": true,
    "enableSynonymExpansion": true,
    "enableEntityExtraction": true,
    "maxSynonyms": 3
  }
}
```

**Response:**

```json
{
  "processedQuery": "show me documents about kubernetes deployment",
  "language": "en",
  "confidence": 0.99,
  "stages": {
    "spellCorrection": [
      {
        "original": "docuemnts",
        "corrected": "documents",
        "confidence": 0.95,
        "source": "spellchecker"
      },
      {
        "original": "kuberntes",
        "corrected": "kubernetes",
        "confidence": 0.93,
        "source": "spellchecker"
      }
    ],
    "synonymExpansion": [
      {
        "term": "kubernetes",
        "synonyms": ["k8s", "container orchestration"],
        "source": "wordnet"
      }
    ],
    "entities": []
  },
  "metadata": {
    "originalQuery": "show me docuemnts about kuberntes deployment",
    "processingTimeMs": 2.5,
    "stagesExecuted": [
      "language_detection",
      "spell_correction",
      "synonym_expansion",
      "entity_extraction"
    ]
  }
}
```

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "service": "preprocessing-service",
  "version": "1.0.0"
}
```

### GET /v1/languages

List all supported languages.

**Response:**

```json
{
  "languages": {
    "spellCorrection": ["en", "es", "de", "fr", ...],
    "synonymExpansion": ["en", "es", "de", "fr", ...],
    "detection": ["en", "es", "de", "fr", ...]
  },
  "total": {
    "spellCorrection": 12,
    "synonymExpansion": 32,
    "detection": 55
  }
}
```

### GET /metrics

Prometheus metrics endpoint.

## Setup

### Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) - Fast Python package installer
- Redis (for caching)
- Docker (for containerized deployment)

### Local Development

1. Clone the repository:

```bash
cd services/preprocessing-service
```

2. Install uv (if not already installed):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

3. Create virtual environment and install dependencies:

```bash
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv pip install -e .
```

4. Install dev dependencies:

```bash
uv pip install -e ".[dev]"
```

5. Set up environment variables:

```bash
cp .env.example .env
# Edit .env with your configuration
```

6. Run the service:

```bash
python app.py
```

The service will be available at `http://localhost:8003`.

### Docker Deployment

1. Build the Docker image:

```bash
docker build -t preprocessing-service:latest .
```

2. Run the container:

```bash
docker run -d \
  --name preprocessing-service \
  -p 8003:8003 \
  -e REDIS_HOST=redis \
  -e REDIS_PORT=6379 \
  preprocessing-service:latest
```

### Docker Compose

```bash
docker-compose up -d
```

## Testing

Run tests with pytest:

```bash
# Run all tests
uv run pytest

# Run with coverage
uv run pytest --cov=src --cov-report=html

# Run specific test file
uv run pytest tests/test_pipeline.py -v
```

## Code Quality

```bash
# Format code with black
uv run black src/ tests/

# Lint with ruff
uv run ruff check src/ tests/

# Type check with mypy
uv run mypy src/
```

## Performance

- **Language Detection**: < 1ms
- **Spell Correction**: 1-3ms
- **Synonym Expansion**: 0.5-1ms
- **Entity Extraction**: 0.5-1ms
- **Total Pipeline**: 2-6ms (average)

## Monitoring

The service exposes Prometheus metrics at `/metrics`:

- `preprocessing_requests_total`: Total preprocessing requests by language and tenant
- `preprocessing_duration_seconds`: Request duration by language and stage
- `preprocessing_errors_total`: Total errors by error type

## Architecture

```
preprocessing-service/
├── app.py                          # Flask application
├── pyproject.toml                  # Project configuration & dependencies
├── Dockerfile                      # Docker image definition
├── docker-compose.yml              # Local dev setup
├── .env.example                    # Environment template
├── .gitignore                      # Git ignore rules
├── README.md                       # User documentation
├── IMPLEMENTATION.md               # Implementation details
├── src/
│   ├── preprocessing/
│   │   ├── pipeline.py             # Main preprocessing pipeline
│   │   ├── language_detector.py   # Language detection (langdetect)
│   │   ├── spell_corrector.py     # Spell correction (pyspellchecker)
│   │   ├── synonym_expander.py    # Synonym expansion (NLTK OMW)
│   │   ├── entity_extractor.py    # Entity extraction (regex)
│   │   └── models.py               # Pydantic data models
│   └── cache/
│       └── redis_cache.py          # Redis caching layer
├── dictionaries/                   # Language-specific dictionaries
└── tests/                          # Unit tests
```

## Integration with search-ai-runtime

The TypeScript search-ai-runtime client calls this service via HTTP:

```typescript
const result = await fetch('http://preprocessing-service:8003/v1/preprocess', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: userQuery,
    tenantId: tenant.id,
    config: {
      enableSpellCorrection: true,
      enableSynonymExpansion: true,
      enableEntityExtraction: true,
      maxSynonyms: 3,
    },
  }),
  signal: AbortSignal.timeout(100), // 100ms timeout
});

const preprocessed = await result.json();
```

## Tenant Dictionaries

Tenants can define custom corrections, synonyms, and abbreviations:

```python
# Example tenant dictionary in Redis
{
  "tenant_id": "acme-corp",
  "corrections": {
    "kubes": "kubernetes",
    "docekr": "docker"
  },
  "abbreviations": {
    "k8s": "kubernetes",
    "ci/cd": "continuous integration continuous deployment"
  },
  "synonyms": {
    "deploy": ["release", "rollout", "publish"],
    "monitor": ["observe", "track", "watch"]
  },
  "entity_patterns": [
    {
      "name": "git_sha",
      "pattern": "[0-9a-f]{7,40}",
      "type": "commit_hash"
    }
  ]
}
```

## Development Workflow

```bash
# Set up development environment
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"

# Make changes to code
# ...

# Format and lint
uv run black src/ tests/
uv run ruff check src/ tests/ --fix

# Run tests
uv run pytest

# Build Docker image
docker build -t preprocessing-service:latest .

# Test locally with Docker Compose
docker-compose up -d
curl http://localhost:8003/health

# View logs
docker-compose logs -f preprocessing-service
```

## License

Proprietary - Kore.ai

# BGE-M3 Embedding Service

Flask microservice providing BGE-M3 embeddings with OpenAI-compatible API format.

## Features

- **OpenAI-compatible API** (`/v1/embeddings` endpoint)
- **BGE-M3 model** - SOTA multilingual embeddings (1024 dimensions)
- **Normalized embeddings** - Ready for cosine similarity
- **ARM64 compatible** - Runs on Apple Silicon and x86_64
- **Model caching** - First run downloads, then cached in volume

## Quick Start

### Prerequisites

- Python 3.11+ (or Docker)
- [uv](https://github.com/astral-sh/uv) - Fast Python package manager

### Option 1: Docker (Recommended)

```bash
# Build and run
docker build -t bge-m3-service .
docker run -p 8001:8001 bge-m3-service

# Or use docker-compose
docker-compose up bge-m3-service

# Test
curl http://localhost:8001/health
```

### Option 2: Local Development with uv

```bash
# Install uv if not already installed
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create virtual environment and install dependencies
uv venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
uv pip install -r requirements.lock

# Run service
python app.py
```

## Usage

### Health Check

```bash
curl http://localhost:8001/health
```

**Response:**

```json
{
  "status": "healthy",
  "model": "BAAI/bge-m3",
  "dimension": 1024
}
```

### Generate Embeddings (OpenAI-compatible)

```bash
curl -X POST http://localhost:8001/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "input": ["Hello world", "Machine learning is amazing"],
    "model": "bge-m3"
  }'
```

**Response:**

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.123, -0.456, ...]
    },
    {
      "object": "embedding",
      "index": 1,
      "embedding": [0.789, -0.012, ...]
    }
  ],
  "model": "BAAI/bge-m3",
  "usage": {
    "prompt_tokens": 6,
    "total_tokens": 6
  }
}
```

### Legacy Endpoint

```bash
curl -X POST http://localhost:8001/embed \
  -H "Content-Type: application/json" \
  -d '{
    "texts": ["Hello world", "Machine learning is amazing"]
  }'
```

## API Reference

### POST /v1/embeddings

OpenAI-compatible embeddings endpoint.

**Request:**

```json
{
  "input": ["text1", "text2", ...] | "single text",
  "model": "bge-m3"  // optional
}
```

**Response:**

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [float, ...]
    }
  ],
  "model": "BAAI/bge-m3",
  "usage": {
    "prompt_tokens": int,
    "total_tokens": int
  }
}
```

### POST /embed (Legacy)

**Request:**

```json
{
  "texts": ["text1", "text2", ...]
}
```

**Response:**

```json
{
  "embeddings": [[float, ...], ...],
  "dimension": 1024,
  "model": "BAAI/bge-m3"
}
```

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "model": "BAAI/bge-m3",
  "dimension": 1024
}
```

## Environment Variables

| Variable     | Default       | Description            |
| ------------ | ------------- | ---------------------- |
| `PORT`       | `8001`        | Server port            |
| `MODEL_NAME` | `BAAI/bge-m3` | HuggingFace model name |

## Development

### Setup with uv

```bash
# Create venv and install deps
uv venv
source .venv/bin/activate
uv pip install -r requirements.lock

# Install dev dependencies
uv pip install --group dev

# Run with auto-reload (requires additional setup)
flask --app app run --reload

# Format code
ruff format .

# Lint code
ruff check .
```

### Lockfile Management

```bash
# Regenerate lockfile after updating pyproject.toml
uv pip compile pyproject.toml -o requirements.lock

# Upgrade all dependencies to latest compatible versions
uv pip compile --upgrade pyproject.toml -o requirements.lock

# Upgrade a specific package
# Edit pyproject.toml, then regenerate lockfile
uv pip compile pyproject.toml -o requirements.lock
```

### Run Tests

```bash
# Install dev dependencies
uv pip install -e ".[dev]"

# Run tests
pytest

# Test manually
python -c "
import requests
response = requests.post('http://localhost:8001/v1/embeddings', json={'input': ['test']})
print(response.json())
"
```

## Integration with Search-AI

```typescript
// Example: Using as OpenAI embeddings replacement

import { OpenAI } from 'openai';

const client = new OpenAI({
  baseURL: 'http://bge-m3-service:8001/v1',
  apiKey: 'not-needed', // Service doesn't require auth
});

const response = await client.embeddings.create({
  model: 'bge-m3',
  input: 'Your text here',
});

const embedding = response.data[0].embedding;
```

## Performance

| Batch Size | Processing Time | Memory Usage |
| ---------- | --------------- | ------------ |
| 1 text     | ~50ms           | 1.5 GB       |
| 10 texts   | ~150ms          | 1.6 GB       |
| 100 texts  | ~800ms          | 2.0 GB       |

**Note:** First request triggers model download (~2GB). Subsequent requests use cached model.

## Model Details

- **Model**: [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)
- **Dimensions**: 1024
- **Languages**: 100+ (multilingual)
- **Max sequence length**: 8192 tokens
- **Normalization**: L2 normalized (ready for cosine similarity)

## Why uv?

We use [uv](https://github.com/astral-sh/uv) as the Python package manager because:

- ⚡ **10-100x faster** than pip
- 🔒 **Reliable lockfiles** for reproducible builds
- 🎯 **Modern** dependency resolution
- 🐳 **Docker-friendly** (single binary, fast installs)
- 📦 **Compatible** with pip and pyproject.toml

## Troubleshooting

### uv not found

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Model download fails

```bash
# Pre-download model manually
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3')"
```

### Out of memory

Reduce batch size or increase container memory limit:

```bash
docker run -p 8001:8001 --memory="4g" bge-m3-service
```

## License

MIT

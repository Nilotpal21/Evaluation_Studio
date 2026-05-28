# Building & Running the Go Crawler Worker

## Quick Start

### Option 1: Using Scripts (Recommended)

```bash
# Build the binary
./build.sh

# Run the worker
./run.sh
```

### Option 2: Using Makefile

```bash
# Install dependencies
make install

# Build
make build-local

# Run
make run
```

### Option 3: Manual

```bash
# Install dependencies
go mod download
go mod tidy

# Build
go build -o bin/crawler-worker ./cmd/worker

# Run
./bin/crawler-worker
```

---

## Build Targets

### Local Development (macOS/Linux)

```bash
# Build for your current OS
go build -o bin/crawler-worker ./cmd/worker

# Or use script
./scripts/build.sh
```

**Output**: `bin/crawler-worker` (for your OS)

---

### Production (Linux)

```bash
# Build for Linux/amd64 (most common)
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/crawler-worker-linux-amd64 ./cmd/worker

# Or use Makefile
make build
```

**Output**: `bin/crawler-worker-linux-amd64`

---

### Docker

```bash
# Build Docker image
docker build -t crawler-go-worker:latest .

# Or use script
./scripts/docker-build.sh

# Or use Makefile
make docker-build
```

**Output**: Docker image `crawler-go-worker:latest`

---

## Running

### Local

```bash
# Run with defaults
./run.sh

# Or run binary directly
./bin/crawler-worker

# With custom environment
REDIS_URL=redis://localhost:6379 \
QUEUE_NAME=static-crawl \
PARALLELISM=200 \
./bin/crawler-worker
```

---

### Docker

```bash
# Run Docker container
docker run --rm -it \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e QUEUE_NAME=static-crawl \
  crawler-go-worker:latest

# Or use script
./scripts/docker-run.sh

# Or use Makefile
make docker-run
```

---

### Kubernetes

```bash
# Apply deployment
kubectl apply -f k8s/deployment.yaml

# Scale workers
kubectl scale deployment crawler-go-worker --replicas=100

# View logs
kubectl logs -f deployment/crawler-go-worker
```

---

## Testing

```bash
# Run tests
./scripts/test.sh

# Or use Makefile
make test

# Or manually
go test -v ./...

# With coverage
go test -v -coverprofile=coverage.out ./...
go tool cover -html=coverage.out -o coverage.html
```

---

## Configuration

### Environment Variables

Create `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit values:

```bash
# Redis
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=
REDIS_DB=0

# Queue
QUEUE_NAME=static-crawl
PARALLELISM=100

# Crawler
USER_AGENT=SearchAI-Bot/1.0
MAX_DEPTH=5
REQUEST_TIMEOUT=30s
```

Scripts will automatically load `.env` if it exists.

---

## Directory Structure

```
apps/crawler-go-worker/
├── bin/                        # Build output (gitignored)
│   ├── crawler-worker          # Local OS binary
│   ├── crawler-worker-linux-amd64
│   └── crawler-worker-darwin-arm64
├── scripts/                    # Build & run scripts
│   ├── build.sh               # Build all targets
│   ├── run.sh                 # Run locally
│   ├── test.sh                # Run tests
│   ├── docker-build.sh        # Build Docker image
│   └── docker-run.sh          # Run Docker container
├── build.sh                   # Convenience wrapper
└── run.sh                     # Convenience wrapper
```

---

## Troubleshooting

### Go not installed

```bash
# macOS
brew install go

# Linux (Ubuntu)
sudo apt install golang-1.22

# Verify
go version
```

### Dependencies not downloading

```bash
# Clear module cache
go clean -modcache

# Re-download
go mod download
go mod tidy
```

### Binary won't run

```bash
# Check if executable
ls -la bin/crawler-worker

# Make executable
chmod +x bin/crawler-worker

# Check architecture
file bin/crawler-worker
```

### Redis connection failed

```bash
# Check Redis is running
redis-cli ping

# Check Redis URL
echo $REDIS_URL

# Test connection
redis-cli -u redis://localhost:6379 ping
```

---

## CI/CD Pipeline

### GitHub Actions Example

```yaml
name: Build Go Worker

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up Go
        uses: actions/setup-go@v4
        with:
          go-version: '1.22'

      - name: Install dependencies
        working-directory: apps/crawler-go-worker
        run: go mod download

      - name: Build
        working-directory: apps/crawler-go-worker
        run: make build

      - name: Test
        working-directory: apps/crawler-go-worker
        run: make test

      - name: Build Docker image
        working-directory: apps/crawler-go-worker
        run: docker build -t crawler-go-worker:${{ github.sha }} .
```

---

## Production Deployment

### Build Production Binary

```bash
# Clean build for production
make clean
make build

# Verify binary
./bin/crawler-worker-linux-amd64 --help
```

### Build Docker Image

```bash
# Build with version tag
VERSION=1.0.0 ./scripts/docker-build.sh

# Push to registry
docker tag crawler-go-worker:latest ghcr.io/org/crawler-go-worker:1.0.0
docker push ghcr.io/org/crawler-go-worker:1.0.0
```

### Deploy to Kubernetes

```bash
# Update image in deployment
kubectl set image deployment/crawler-go-worker \
  worker=ghcr.io/org/crawler-go-worker:1.0.0

# Or apply new manifest
kubectl apply -f k8s/deployment.yaml

# Verify rollout
kubectl rollout status deployment/crawler-go-worker
```

---

## Performance Tuning

### Build Flags

```bash
# Optimize for size
go build -ldflags="-s -w" -o bin/crawler-worker ./cmd/worker

# Enable all optimizations
go build -ldflags="-s -w" -gcflags="all=-trimpath" -o bin/crawler-worker ./cmd/worker
```

### Runtime Tuning

```bash
# Adjust parallelism based on CPU
export PARALLELISM=$(nproc)  # Use all CPU cores

# Adjust memory limits
export GOGC=100  # Default garbage collection
export GOMEMLIMIT=512MiB  # Soft memory limit (Go 1.19+)
```

---

## Next Steps

1. Build: `./build.sh`
2. Test: `./scripts/test.sh`
3. Run: `./run.sh`
4. Deploy: See production deployment section

For more details, see [README.md](./README.md)

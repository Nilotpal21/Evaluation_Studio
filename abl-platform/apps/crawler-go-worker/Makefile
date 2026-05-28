.PHONY: build run test clean docker-build docker-run install

# Binary name
BINARY_NAME=crawler-worker
DOCKER_IMAGE=crawler-go-worker

# Go parameters
GOCMD=go
GOBUILD=$(GOCMD) build
GOTEST=$(GOCMD) test
GOMOD=$(GOCMD) mod
GOGET=$(GOCMD) get

# Build the binary
build:
	@echo "Building $(BINARY_NAME)..."
	@CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GOBUILD) -o bin/$(BINARY_NAME) ./cmd/worker
	@echo "Build complete: bin/$(BINARY_NAME)"

# Build for local OS
build-local:
	@echo "Building $(BINARY_NAME) for local OS..."
	@$(GOBUILD) -o bin/$(BINARY_NAME) ./cmd/worker
	@echo "Build complete: bin/$(BINARY_NAME)"

# Install dependencies
install:
	@echo "Installing dependencies..."
	@$(GOMOD) download
	@$(GOMOD) tidy
	@echo "Dependencies installed"

# Run the worker
run: build-local
	@echo "Running $(BINARY_NAME)..."
	@./bin/$(BINARY_NAME)

# Run tests
test:
	@echo "Running tests..."
	@$(GOTEST) -v ./...

# Run tests with coverage
test-coverage:
	@echo "Running tests with coverage..."
	@$(GOTEST) -v -coverprofile=coverage.out ./...
	@$(GOCMD) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Clean build artifacts
clean:
	@echo "Cleaning..."
	@rm -rf bin/
	@rm -f coverage.out coverage.html
	@echo "Clean complete"

# Build Docker image
docker-build:
	@echo "Building Docker image..."
	@docker build -t $(DOCKER_IMAGE):latest .
	@echo "Docker image built: $(DOCKER_IMAGE):latest"

# Run Docker container
docker-run:
	@echo "Running Docker container..."
	@docker run --rm -it \
		-e REDIS_URL=${REDIS_URL} \
		-e QUEUE_NAME=${QUEUE_NAME} \
		$(DOCKER_IMAGE):latest

# Run with Docker Compose
docker-compose-up:
	@echo "Starting with Docker Compose..."
	@docker-compose up -d

docker-compose-down:
	@echo "Stopping Docker Compose..."
	@docker-compose down

# Development mode (watch for changes)
dev:
	@echo "Running in development mode..."
	@which air > /dev/null || $(GOGET) -u github.com/cosmtrek/air
	@air

# Format code
fmt:
	@echo "Formatting code..."
	@$(GOCMD) fmt ./...

# Run linter
lint:
	@echo "Running linter..."
	@which golangci-lint > /dev/null || curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b $(GOPATH)/bin
	@golangci-lint run

# Show help
help:
	@echo "Available targets:"
	@echo "  make build          - Build the binary for Linux"
	@echo "  make build-local    - Build the binary for local OS"
	@echo "  make install        - Install dependencies"
	@echo "  make run            - Build and run the worker"
	@echo "  make test           - Run tests"
	@echo "  make test-coverage  - Run tests with coverage report"
	@echo "  make clean          - Clean build artifacts"
	@echo "  make docker-build   - Build Docker image"
	@echo "  make docker-run     - Run Docker container"
	@echo "  make fmt            - Format code"
	@echo "  make lint           - Run linter"
	@echo "  make help           - Show this help message"

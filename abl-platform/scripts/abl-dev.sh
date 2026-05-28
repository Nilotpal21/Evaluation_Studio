#!/usr/bin/env bash
# =============================================================================
# ABL Platform Development Orchestrator
#
# CRITICAL: When Claude Code is asked "bring up services" or "start services",
# this script should ALWAYS be used. Read the sections below to understand
# what services exist and which profile to use.
#
# =============================================================================
# COMPLETE SERVICE INVENTORY (17 services total)
# =============================================================================
#
# Node.js Applications (7 services):
#   1. Studio (5173)           - THE ONLY UI for everything (agents, search, files)
#   2. Runtime (3112)          - Execution engine (critical hub)
#   3. Search AI (3005)        - Document ingestion (called by Studio)
#   4. Search AI Runtime (3004)- Query execution (called by Runtime)
#   5. Multimodal (3006)       - File processing (called by Runtime)
#   6. Admin Dashboard (3003)  - Platform admin (SEPARATE UI)
#   7. Telco NOC (4100)        - Demo app
#
# Go Services (1 service, Docker container):
#   1. Crawler Go Worker       - Web crawl execution (consumes BullMQ jobs from Search AI)
#
# Python Services (3 services):
#   1. Docling (8080)          - Document extraction
#   2. BGE-M3 (8001)           - Multilingual embeddings
#   3. Preprocessing (8003)    - Query preprocessing
#
# Infrastructure (6 services in docker-compose.yml):
#   1. MongoDB (27018)         - Primary data store
#   2. ClickHouse (8124)       - Analytics/traces
#   3. Redis (6380)            - Cache/queues
#   4. Neo4j (7474)            - Knowledge graph
#   5. OpenSearch (9200)       - Search engine
#   6. Qdrant (6333)           - Vector store (optional)
#
# =============================================================================
# SERVICE DEPENDENCIES (How they work together)
# =============================================================================
#
# Studio (THE UI) → Calls Runtime, Search AI, shows everything in one place
# Runtime (Hub) → Calls Search AI Runtime, Multimodal, LLM providers
# Search AI → Called BY Studio for KB management
# Search AI Runtime → Called BY Runtime when agents use search tools
# Multimodal → Called BY Runtime for file processing
# Admin → Separate UI, calls Runtime admin APIs
#
# CRITICAL: You CANNOT test search features without Studio + Runtime + Search services
# CRITICAL: You CANNOT test file features without Studio + Runtime + Multimodal
#
# =============================================================================
# PROFILE SELECTION GUIDE (When Claude is asked to bring up services)
# =============================================================================
#
# USER SAYS: "bring up services", "start agent platform", "test agents"
#   → USE: ./scripts/abl-dev.sh up core
#   → INCLUDES: Studio + Runtime + MongoDB + ClickHouse + Redis
#   → USE CASE: 90% of daily development (building/testing agents)
#
# USER SAYS: "bring up search", "work on search", "test knowledge base"
#   → USE: ./scripts/abl-dev.sh up core+search
#   → INCLUDES: Everything from 'core' + Search services + Neo4j + OpenSearch
#   → USE CASE: Adding search tools to agents, indexing documents
#
# USER SAYS: "bring up files", "work on file upload", "test attachments"
#   → USE: ./scripts/abl-dev.sh up core+files
#   → INCLUDES: Everything from 'core' + Multimodal + Docling
#   → USE CASE: Testing file attachments in agents
#
# USER SAYS: "bring up everything", "start all services", "full platform"
#   → USE: ./scripts/abl-dev.sh up full
#   → INCLUDES: All 17 services
#   → USE CASE: Integration testing, QA, demos
#
# USER SAYS: "bring up admin", "platform configuration"
#   → USE: ./scripts/abl-dev.sh up admin
#   → INCLUDES: Admin Dashboard + Runtime + databases
#   → USE CASE: Managing secrets, configuration
#
# DEFAULT: When unclear, use 'core' (covers 90% of work)
#
# =============================================================================
# QUICK COMMANDS (Most common operations)
# =============================================================================
#
# Start agent development:     ./scripts/abl-dev.sh up core
# Add search features:          ./scripts/abl-dev.sh up core+search
# Check what's running:         ./scripts/abl-dev.sh status
# View logs:                    ./scripts/abl-dev.sh logs runtime
# Stop everything:              ./scripts/abl-dev.sh down
# See all profiles:             ./scripts/abl-dev.sh profiles
#
# =============================================================================
# HEALTH CHECK VERIFICATION (After starting services)
# =============================================================================
#
# Studio:         http://localhost:5173 (should show login page)
# Runtime:        http://localhost:3112/health (should return {"status":"ok"})
# Search AI:      http://localhost:3005/health
# Neo4j Browser:  http://localhost:7474 (username: neo4j, password: abl_dev_password)
# OpenSearch:     http://localhost:9200
# MongoDB:        mongosh "mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin"
# Redis:          redis-cli -h localhost -p 6380 PING
#
# =============================================================================
# TROUBLESHOOTING (Common issues)
# =============================================================================
#
# Port already in use:
#   lsof -i :3112
#   kill -9 <PID>
#
# Service not healthy:
#   ./scripts/abl-dev.sh logs <service-name>
#   docker compose restart <service-name>
#
# Clean reset:
#   ./scripts/abl-dev.sh down
#   docker compose down -v  # WARNING: Deletes all data
#
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Project root (parent of scripts/)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# PID file to track running services
PIDFILE="$PROJECT_ROOT/.abl-dev-pids"

# =============================================================================
# Service Profile Definitions
# =============================================================================

# Define what each profile needs
declare -A PROFILES

# Minimal: Core infrastructure only (databases, cache)
# Use when: Running pre-built services, external testing
PROFILES[minimal]="mongo redis clickhouse"
PROFILES[minimal_apps]=""

# Core: Agent development (DEFAULT - 90% of daily work)
# Use when: Building agents, testing chat, debugging
# Includes: Studio (THE UI) + Runtime (execution engine) + core databases
PROFILES[core]="mongo redis clickhouse"
PROFILES[core_apps]="runtime studio"

# Core + Search: Agent development WITH search features
# Use when: Adding search tools to agents, indexing documents, KB management
# Includes: Everything from 'core' PLUS search services (called by Studio/Runtime)
# Note: crawler-go-worker is started as a Docker container alongside search-ai
PROFILES[core+search]="mongo redis clickhouse neo4j opensearch docling-service bge-m3-embeddings"
PROFILES[core+search_apps]="runtime studio search-ai crawler-go-worker search-ai-runtime preprocessing-service"

# Core + Files: Agent development WITH file upload features
# Use when: Testing file attachments, document parsing in agents
# Includes: Everything from 'core' PLUS file processing services
PROFILES[core+files]="mongo redis clickhouse docling-service"
PROFILES[core+files_apps]="runtime studio multimodal-service"

# Admin: Platform administration (SEPARATE from Studio)
# Use when: Managing secrets, configuration, audit logs
# Includes: Admin Dashboard (separate UI) + Runtime admin APIs
PROFILES[admin]="mongo redis clickhouse"
PROFILES[admin_apps]="admin runtime"

# Full: Everything (for comprehensive testing)
# Use when: Integration testing, QA, demos
PROFILES[full]="mongo redis clickhouse neo4j opensearch qdrant docling-service bge-m3-embeddings"
PROFILES[full_apps]="runtime studio search-ai crawler-go-worker search-ai-runtime multimodal-service admin preprocessing-service"

# Legacy aliases (for backwards compatibility)
PROFILES[agent-platform]="${PROFILES[core]}"
PROFILES[agent-platform_apps]="${PROFILES[core_apps]}"
PROFILES[search]="${PROFILES[core+search]}"
PROFILES[search_apps]="${PROFILES[core+search_apps]}"
PROFILES[multimodal]="${PROFILES[core+files]}"
PROFILES[multimodal_apps]="${PROFILES[core+files_apps]}"

# =============================================================================
# Helper Functions
# =============================================================================

print_header() {
    echo -e "\n${CYAN}${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}  $1${NC}"
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════════════${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        print_error "Docker is not running. Please start Docker and try again."
        exit 1
    fi
    print_success "Docker is running"
}

# Check if pnpm is installed
check_pnpm() {
    if ! command -v pnpm &> /dev/null; then
        print_error "pnpm is not installed. Install with: npm install -g pnpm@8.15.0"
        exit 1
    fi
    print_success "pnpm is installed ($(pnpm --version))"
}

# Check if dependencies are installed
check_dependencies() {
    if [ ! -d "node_modules" ]; then
        print_warning "Dependencies not installed. Running pnpm install..."
        pnpm install
    fi
    print_success "Dependencies are installed"
}

# Check if a port is available
check_port_available() {
    local port=$1
    local service=$2
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1 ; then
        print_warning "Port $port required by $service is already in use:"
        lsof -Pi :$port -sTCP:LISTEN | tail -n +2
        return 1
    fi
    return 0
}

# Check for duplicate running processes
check_duplicate_processes() {
    local has_duplicates=0

    # Check if PID file exists with stale entries
    if [ -f "$PIDFILE" ]; then
        print_info "Checking for existing processes..."
        local has_running=0
        while IFS=: read -r name pid; do
            if ps -p "$pid" > /dev/null 2>&1; then
                print_warning "Service $name (PID $pid) is already running"
                has_running=1
                has_duplicates=1
            fi
        done < "$PIDFILE"

        if [ $has_running -eq 1 ]; then
            print_error "Services are already running. Run './scripts/abl-dev.sh down' first to clean up"
            return 1
        else
            # Remove stale PID file
            rm -f "$PIDFILE"
        fi
    fi

    # Check critical ports directly
    declare -A critical_ports=(
        [3112]="Runtime"
        [5173]="Studio"
        [3005]="Search AI"
        [3004]="Search AI Runtime"
        [3006]="Multimodal"
        [3003]="Admin"
        [4100]="Telco NOC"
    )

    for port in "${!critical_ports[@]}"; do
        if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1 ; then
            local pid=$(lsof -Pi :$port -sTCP:LISTEN -t | head -1)
            print_warning "Port $port (${critical_ports[$port]}) is already in use by PID $pid"
            has_duplicates=1
        fi
    done

    if [ $has_duplicates -eq 1 ]; then
        print_error "Ports are already in use. Run './scripts/abl-dev.sh down' or kill processes manually"
        return 1
    fi

    return 0
}

# Validate environment files exist
validate_env_files() {
    print_info "Validating environment files..."

    declare -A env_files=(
        ["apps/runtime/.env"]="apps/runtime/.env.example"
        ["apps/studio/.env.local"]="apps/studio/.env.example"
        ["apps/search-ai/.env"]="apps/search-ai/.env.example"
        ["apps/search-ai-runtime/.env"]="apps/search-ai-runtime/.env.example"
        ["apps/multimodal-service/.env"]="apps/multimodal-service/.env.example"
    )

    local missing_count=0
    for file in "${!env_files[@]}"; do
        if [ ! -f "$file" ]; then
            local example="${env_files[$file]}"
            if [ -f "$example" ]; then
                print_warning "$file not found, copying from $(basename $example)"
                cp "$example" "$file"
            else
                print_warning "$file and $example both missing"
                missing_count=$((missing_count + 1))
            fi
        fi
    done

    if [ $missing_count -gt 0 ]; then
        print_warning "$missing_count environment files are missing (services may fail to start)"
    else
        print_success "Environment files validated"
    fi
}

# Pre-flight checks before starting services
pre_flight_checks() {
    local profile=$1
    print_header "Pre-Flight Checks"

    # Check for duplicate processes
    check_duplicate_processes || exit 1

    # Validate environment files
    validate_env_files

    # Check required ports for the profile
    if [[ "$profile" == "core+search" ]] || [[ "$profile" == "full" ]] || [[ "$profile" == "search" ]]; then
        print_info "Checking ports for search services..."
        check_port_available 8001 "BGE-M3 Embeddings" || exit 1
        check_port_available 8080 "Docling Service" || print_warning "Port 8080 in use, Docling may fail to start"
        check_port_available 3004 "Search AI Runtime" || exit 1
        check_port_available 8003 "Preprocessing Service" || exit 1
    fi

    if [[ "$profile" == "core+files" ]] || [[ "$profile" == "full" ]] || [[ "$profile" == "multimodal" ]]; then
        print_info "Checking ports for file services..."
        check_port_available 3006 "Multimodal Service" || exit 1
        check_port_available 8080 "Docling Service" || print_warning "Port 8080 in use, Docling may fail to start"
    fi

    print_success "Pre-flight checks passed"
}

# Health check for MongoDB
health_check_mongo() {
    local max_attempts=${1:-30}
    local attempt=0

    echo -n "Waiting for MongoDB to be healthy..."
    while [ $attempt -lt $max_attempts ]; do
        if mongosh mongodb://localhost:27018 --quiet --eval "db.runCommand({ ping: 1 })" > /dev/null 2>&1; then
            echo -e " ${GREEN}✓${NC}"
            return 0
        fi
        # Fallback to TCP check if mongosh not available
        if ! command -v mongosh &> /dev/null && nc -z localhost 27018 > /dev/null 2>&1; then
            echo -e " ${GREEN}✓${NC} ${YELLOW}(TCP check only)${NC}"
            return 0
        fi
        echo -n "."
        sleep 2
        attempt=$((attempt + 1))
    done
    echo -e " ${RED}✗${NC}"
    print_warning "MongoDB did not become healthy (check: docker compose logs mongo)"
    return 1
}

# Health check for Redis
health_check_redis() {
    local max_attempts=${1:-10}
    local attempt=0

    echo -n "Waiting for Redis to be healthy..."
    while [ $attempt -lt $max_attempts ]; do
        if redis-cli -p 6380 PING > /dev/null 2>&1; then
            echo -e " ${GREEN}✓${NC}"
            return 0
        fi
        # Fallback to TCP check if redis-cli not available
        if ! command -v redis-cli &> /dev/null && nc -z localhost 6380 > /dev/null 2>&1; then
            echo -e " ${GREEN}✓${NC} ${YELLOW}(TCP check only)${NC}"
            return 0
        fi
        echo -n "."
        sleep 2
        attempt=$((attempt + 1))
    done
    echo -e " ${RED}✗${NC}"
    print_warning "Redis did not become healthy (check: docker compose logs redis)"
    return 1
}

# Health check for a service (HTTP)
health_check() {
    local service=$1
    local url=$2
    local max_attempts=${3:-30}
    local attempt=0

    echo -n "Waiting for $service to be healthy..."
    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            echo -e " ${GREEN}✓${NC}"
            return 0
        fi
        echo -n "."
        sleep 2
        attempt=$((attempt + 1))
    done
    echo -e " ${RED}✗${NC}"
    print_error "$service failed to start within timeout"
    print_info "Troubleshooting steps:"
    print_info "  1. Check logs: tail -100 .abl-dev-$(echo $service | tr '[:upper:]' '[:lower:]' | tr ' ' '-').log"
    print_info "  2. Check Docker: docker compose logs $(echo $service | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
    print_info "  3. Manual test: curl -v $url"
    return 1
}

# Start Docker services
start_docker_services() {
    local services=$1

    if [ -z "$services" ]; then
        print_info "No Docker services to start for this profile"
        return 0
    fi

    print_header "Starting Docker Services"
    echo -e "${BOLD}Services:${NC} $services\n"

    # Start with docker compose
    docker compose up -d $services

    # Wait for health checks
    echo ""
    for service in $services; do
        case $service in
            mongo)
                health_check_mongo 30 || true
                ;;
            redis)
                health_check_redis 10 || true
                ;;
            clickhouse)
                health_check "ClickHouse" "http://localhost:8124" 20 || true
                ;;
            neo4j)
                health_check "Neo4j" "http://localhost:7474" 30 || true
                ;;
            opensearch)
                health_check "OpenSearch" "http://localhost:9200" 30 || true
                ;;
            qdrant)
                health_check "Qdrant" "http://localhost:6333" 15 || true
                ;;
            docling-service)
                health_check "Docling" "http://localhost:8080/health" 40 || true
                ;;
            bge-m3-embeddings)
                health_check "BGE-M3" "http://localhost:8001/health" 60 || true
                ;;
        esac
    done

    print_success "Docker services started"
}

# Start application services (pnpm dev)
start_app_services() {
    local apps=$1

    if [ -z "$apps" ]; then
        print_info "No application services to start for this profile"
        return 0
    fi

    print_header "Starting Application Services"
    echo -e "${BOLD}Applications:${NC} $apps\n"

    # Create PID file
    rm -f "$PIDFILE"
    touch "$PIDFILE"

    for app in $apps; do
        case $app in
            runtime)
                print_info "Starting Runtime (port 3112)..."
                cd "$PROJECT_ROOT/apps/runtime"
                pnpm dev > "$PROJECT_ROOT/.abl-dev-runtime.log" 2>&1 &
                echo "runtime:$!" >> "$PIDFILE"
                cd "$PROJECT_ROOT"
                sleep 3
                health_check "Runtime" "http://localhost:3112/health" 20 || print_warning "Runtime may still be starting"
                ;;
            studio)
                print_info "Starting Studio (port 5173)..."
                cd "$PROJECT_ROOT/apps/studio"
                # Clear Next.js cache to prevent stale build issues
                rm -rf .next
                pnpm dev > "$PROJECT_ROOT/.abl-dev-studio.log" 2>&1 &
                echo "studio:$!" >> "$PIDFILE"
                cd "$PROJECT_ROOT"
                sleep 5
                health_check "Studio" "http://localhost:5173" 30 || print_warning "Studio may still be starting"
                ;;
            search-ai)
                print_info "Starting Search AI Ingestion (port 3005)..."
                cd "$PROJECT_ROOT/apps/search-ai"
                pnpm dev > "$PROJECT_ROOT/.abl-dev-search-ai.log" 2>&1 &
                echo "search-ai:$!" >> "$PIDFILE"
                cd "$PROJECT_ROOT"
                sleep 3
                health_check "Search AI" "http://localhost:3005/health" 20 || print_warning "Search AI may still be starting"
                ;;
            crawler-go-worker)
                print_info "Starting Crawler Go Worker (Docker container)..."
                # Build and run the Go crawler worker as a Docker container
                # It connects to Redis on the Docker network to consume crawl jobs
                local crawler_dir="$PROJECT_ROOT/apps/crawler-go-worker"
                if [ -f "$crawler_dir/Dockerfile" ]; then
                    # Build image if source changed (Docker layer caching makes this fast)
                    docker build -t crawler-go-worker:latest "$crawler_dir" > /dev/null 2>&1
                    # Stop existing container if running
                    docker rm -f crawler-worker > /dev/null 2>&1 || true
                    # Start new container on the platform network
                    docker run -d \
                        --name crawler-worker \
                        --network abl-platform_architect_default \
                        --restart unless-stopped \
                        -e REDIS_URL=redis://abl-redis:6379 \
                        -e QUEUE_NAME=static-crawl \
                        -e MAX_CONCURRENCY=10 \
                        -e PARALLELISM=100 \
                        -e LOG_LEVEL=info \
                        crawler-go-worker:latest > /dev/null 2>&1
                    if docker ps | grep -q crawler-worker; then
                        print_success "Crawler Go Worker started"
                    else
                        print_warning "Crawler Go Worker failed to start (check: docker logs crawler-worker)"
                    fi
                else
                    print_warning "Crawler Go Worker Dockerfile not found at $crawler_dir, skipping"
                fi
                ;;
            search-ai-runtime)
                print_info "Starting Search AI Runtime (port 3004)..."
                cd "$PROJECT_ROOT/apps/search-ai-runtime"
                pnpm dev > "$PROJECT_ROOT/.abl-dev-search-ai-runtime.log" 2>&1 &
                echo "search-ai-runtime:$!" >> "$PIDFILE"
                cd "$PROJECT_ROOT"
                sleep 3
                health_check "Search AI Runtime" "http://localhost:3004/health" 20 || print_warning "Search AI Runtime may still be starting"
                ;;
            multimodal-service)
                print_info "Starting Multimodal Service (port 3006)..."
                cd "$PROJECT_ROOT/apps/multimodal-service"
                pnpm dev > "$PROJECT_ROOT/.abl-dev-multimodal.log" 2>&1 &
                echo "multimodal-service:$!" >> "$PIDFILE"
                cd "$PROJECT_ROOT"
                sleep 3
                health_check "Multimodal" "http://localhost:3006/health" 20 || print_warning "Multimodal may still be starting"
                ;;
            admin)
                print_info "Starting Admin Dashboard (port 3003)..."
                cd "$PROJECT_ROOT/apps/admin"
                # Clear Next.js cache to prevent stale build issues
                rm -rf .next
                pnpm dev > "$PROJECT_ROOT/.abl-dev-admin.log" 2>&1 &
                echo "admin:$!" >> "$PIDFILE"
                cd "$PROJECT_ROOT"
                sleep 5
                health_check "Admin" "http://localhost:3003" 30 || print_warning "Admin may still be starting"
                ;;
            preprocessing-service)
                print_info "Starting Preprocessing Service (port 8003)..."
                cd "$PROJECT_ROOT/services/preprocessing-service"
                # Check if Docker Compose exists for this service
                if [ -f "docker-compose.yml" ]; then
                    docker compose up -d
                    health_check "Preprocessing" "http://localhost:8003/health" 20 || print_warning "Preprocessing may still be starting"
                else
                    print_warning "Preprocessing service docker-compose.yml not found, skipping"
                fi
                cd "$PROJECT_ROOT"
                ;;
        esac
    done

    print_success "Application services started"
}

# Stop all services
stop_services() {
    print_header "Stopping Services"

    # Stop application services
    if [ -f "$PIDFILE" ]; then
        print_info "Stopping application services..."
        while IFS=: read -r name pid; do
            if ps -p "$pid" > /dev/null 2>&1; then
                print_info "Stopping $name (PID: $pid)..."
                kill "$pid" 2>/dev/null || true
            fi
        done < "$PIDFILE"
        rm -f "$PIDFILE"
        print_success "Application services stopped"
    fi

    # Stop crawler-go-worker container (runs outside docker compose)
    if docker ps -q --filter "name=crawler-worker" | grep -q .; then
        print_info "Stopping Crawler Go Worker..."
        docker rm -f crawler-worker > /dev/null 2>&1 || true
    fi

    # Stop Docker services
    print_info "Stopping Docker services..."
    docker compose down

    # Stop preprocessing service separately if running
    if [ -f "$PROJECT_ROOT/services/preprocessing-service/docker-compose.yml" ]; then
        cd "$PROJECT_ROOT/services/preprocessing-service"
        docker compose down 2>/dev/null || true
        cd "$PROJECT_ROOT"
    fi

    print_success "All services stopped"

    # Archive logs instead of deleting
    if ls .abl-dev-*.log 1> /dev/null 2>&1; then
        timestamp=$(date +%Y%m%d-%H%M%S)
        archive_dir=".abl-dev-logs-archive"
        mkdir -p "$archive_dir"
        tar czf "$archive_dir/logs-$timestamp.tar.gz" .abl-dev-*.log 2>/dev/null
        if [ $? -eq 0 ]; then
            print_info "Logs archived to $archive_dir/logs-$timestamp.tar.gz"
            rm -f .abl-dev-*.log
        else
            print_warning "Failed to archive logs, keeping them"
        fi
    fi
}

# Show status of all services
show_status() {
    print_header "Service Status"

    echo -e "${BOLD}Docker Services:${NC}"
    docker compose ps

    echo -e "\n${BOLD}Docker Application Services:${NC}"
    if docker ps --filter "name=crawler-worker" --format "{{.Names}}" | grep -q crawler-worker; then
        echo -e "  ${GREEN}●${NC} crawler-go-worker (Docker) - Running"
    fi

    echo -e "\n${BOLD}Application Services:${NC}"
    if [ -f "$PIDFILE" ]; then
        while IFS=: read -r name pid; do
            if ps -p "$pid" > /dev/null 2>&1; then
                echo -e "  ${GREEN}●${NC} $name (PID: $pid) - Running"
            else
                echo -e "  ${RED}●${NC} $name (PID: $pid) - Stopped"
            fi
        done < "$PIDFILE"
    else
        echo "  No application services tracked"
    fi

    echo -e "\n${BOLD}Health Checks:${NC}"
    check_health_all
}

# Check health of all known services
check_health_all() {
    # Special handling for MongoDB and Redis
    if mongosh mongodb://localhost:27018 --quiet --eval "db.runCommand({ ping: 1 })" > /dev/null 2>&1 || \
       nc -z localhost 27018 > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} MongoDB"
    else
        echo -e "  ${RED}✗${NC} MongoDB"
    fi

    if redis-cli -p 6380 PING > /dev/null 2>&1 || \
       nc -z localhost 6380 > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} Redis"
    else
        echo -e "  ${RED}✗${NC} Redis"
    fi

    # HTTP-based health checks for other services
    declare -A HEALTH_URLS=(
        ["ClickHouse"]="http://localhost:8124"
        ["Neo4j"]="http://localhost:7474"
        ["OpenSearch"]="http://localhost:9200"
        ["Qdrant"]="http://localhost:6333"
        ["Docling"]="http://localhost:8080/health"
        ["BGE-M3"]="http://localhost:8001/health"
        ["Preprocessing"]="http://localhost:8003/health"
        ["Runtime"]="http://localhost:3112/health"
        ["Studio"]="http://localhost:5173"
        ["Search AI"]="http://localhost:3005/health"
        ["Search AI Runtime"]="http://localhost:3004/health"
        ["Multimodal"]="http://localhost:3006/health"
        ["Admin"]="http://localhost:3003"
        ["Telco NOC"]="http://localhost:4100"
    )

    for service in "${!HEALTH_URLS[@]}"; do
        url="${HEALTH_URLS[$service]}"
        if curl -sf "$url" > /dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} $service"
        else
            echo -e "  ${RED}✗${NC} $service"
        fi
    done
}

# Show logs
show_logs() {
    local service=$1

    if [ -z "$service" ]; then
        print_error "Please specify a service to view logs"
        echo "Usage: $0 logs <service-name>"
        echo "Example: $0 logs runtime"
        exit 1
    fi

    # Check if it's a Docker service
    if docker compose ps | grep -q "$service"; then
        docker compose logs -f "$service"
    # Check if it's an app service with a log file
    elif [ -f ".abl-dev-${service}.log" ]; then
        tail -f ".abl-dev-${service}.log"
    else
        print_error "Service '$service' not found or no logs available"
        exit 1
    fi
}

# Show available profiles
show_profiles() {
    print_header "Available Service Profiles"

    cat << EOF
${BOLD}RECOMMENDED PROFILES (based on actual workflows):${NC}

${BOLD}core${NC} ${GREEN}← DEFAULT (90% of daily work)${NC}
  Agent development: Studio (THE UI) + Runtime (execution) + databases
  Docker: mongo, redis, clickhouse
  Apps: runtime, studio
  ${CYAN}Use when:${NC} Building agents, testing chat, debugging
  ${CYAN}What you get:${NC} Studio at http://localhost:5173

${BOLD}core+search${NC}
  Everything from 'core' PLUS search/knowledge base features
  Docker: (core infra) + neo4j, opensearch, docling, bge-m3
  Apps: (core apps) + search-ai, search-ai-runtime, preprocessing
  ${CYAN}Use when:${NC} Adding search tools to agents, indexing documents
  ${CYAN}Why together:${NC} Search AI called by Studio UI, Search AI Runtime called by Runtime

${BOLD}core+files${NC}
  Everything from 'core' PLUS file upload/processing features
  Docker: (core infra) + docling
  Apps: (core apps) + multimodal-service
  ${CYAN}Use when:${NC} Testing file attachments, document parsing in agents
  ${CYAN}Why together:${NC} Multimodal called by Runtime, UI in Studio

${BOLD}admin${NC}
  Platform administration (SEPARATE UI from Studio)
  Docker: mongo, redis, clickhouse
  Apps: admin, runtime
  ${CYAN}Use when:${NC} Managing secrets, configuration, audit logs
  ${CYAN}Admin UI:${NC} http://localhost:3003 (separate from Studio)

${BOLD}full${NC}
  Everything for integration testing
  Docker: all infrastructure services
  Apps: all application services
  ${CYAN}Use when:${NC} QA, integration testing, demos

${BOLD}UTILITY PROFILES:${NC}

${BOLD}minimal${NC}
  Infrastructure only (no apps)
  Docker: mongo, redis, clickhouse
  ${CYAN}Use when:${NC} Running pre-built services, external testing

${BOLD}LEGACY ALIASES (for backwards compatibility):${NC}
  agent-platform → core
  search → core+search
  multimodal → core+files

${BOLD}Examples:${NC}
  ./scripts/abl-dev.sh up core             # Start agent development (DEFAULT)
  ./scripts/abl-dev.sh up core+search      # Add search features
  ./scripts/abl-dev.sh up core+files       # Add file upload features
  ./scripts/abl-dev.sh up full             # Start everything
  ./scripts/abl-dev.sh status              # Check what's running

EOF
}

# =============================================================================
# Main Command Handler
# =============================================================================

main() {
    local command=${1:-help}
    local profile=${2:-}

    case $command in
        up)
            if [ -z "$profile" ]; then
                print_error "Please specify a profile"
                show_profiles
                exit 1
            fi

            if [ -z "${PROFILES[$profile]}" ]; then
                print_error "Unknown profile: $profile"
                show_profiles
                exit 1
            fi

            print_header "ABL Platform - Starting Profile: $profile"

            # Pre-flight checks
            check_docker
            check_pnpm
            check_dependencies
            pre_flight_checks "$profile"

            # Get services for this profile
            local docker_services="${PROFILES[$profile]}"
            local app_services="${PROFILES[${profile}_apps]}"

            # Start services
            start_docker_services "$docker_services"
            start_app_services "$app_services"

            # Summary
            print_header "Startup Complete!"
            echo -e "${GREEN}${BOLD}Profile '$profile' is ready!${NC}\n"

            if [[ "$app_services" == *"studio"* ]]; then
                echo -e "  ${CYAN}Studio:${NC}      http://localhost:5173"
            fi
            if [[ "$app_services" == *"runtime"* ]]; then
                echo -e "  ${CYAN}Runtime:${NC}     http://localhost:3112"
            fi
            if [[ "$app_services" == *"admin"* ]]; then
                echo -e "  ${CYAN}Admin:${NC}       http://localhost:3003"
            fi
            if [[ "$app_services" == *"search-ai"* ]]; then
                echo -e "  ${CYAN}Search AI:${NC}   http://localhost:3005"
            fi
            echo -e "\n${BOLD}Logs:${NC}     ./scripts/abl-dev.sh logs <service>"
            echo -e "${BOLD}Status:${NC}   ./scripts/abl-dev.sh status"
            echo -e "${BOLD}Stop:${NC}     ./scripts/abl-dev.sh down\n"
            ;;

        down)
            stop_services
            ;;

        status)
            show_status
            ;;

        logs)
            show_logs "$2"
            ;;

        profiles)
            show_profiles
            ;;

        help|--help|-h)
            cat << EOF
${CYAN}${BOLD}ABL Platform Development Orchestrator${NC}

${BOLD}USAGE:${NC}
  $0 <command> [options]

${BOLD}COMMANDS:${NC}
  up <profile>     Start services for a specific profile
  down             Stop all running services
  status           Show status of all services
  logs <service>   Follow logs for a specific service
  profiles         List all available profiles
  help             Show this help message

${BOLD}PROFILES:${NC}
  minimal          Core infrastructure only
  agent-platform   Agent development environment
  search           Search/knowledge services
  multimodal       File processing services
  admin            Admin dashboard
  full             Everything

${BOLD}EXAMPLES:${NC}
  $0 up agent-platform      # Start agent development
  $0 up search              # Start search services
  $0 status                 # Check what's running
  $0 logs runtime           # View runtime logs
  $0 down                   # Stop everything

${BOLD}MORE INFO:${NC}
  Run '$0 profiles' to see detailed profile descriptions

EOF
            ;;

        *)
            print_error "Unknown command: $command"
            echo "Run '$0 help' for usage information"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"

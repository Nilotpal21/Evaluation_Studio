# Crawler Implementation - Quick Start Guide

> **Purpose**: Step-by-step guide to set up crawler infrastructure
> **Time**: 30 minutes
> **Prerequisites**: Docker, Node 20+, Go 1.24+, pnpm

---

## 1. Project Structure Setup

### Create New Packages

```bash
# Navigate to project root
cd /Users/Bharat.Rekha/kore/rewrite/clone/abl-platform

# Create MCP Crawler Server (TypeScript)
mkdir -p apps/crawler-mcp-server/src/{tools,browser}
cd apps/crawler-mcp-server

# Initialize package.json
cat > package.json <<EOF
{
  "name": "@agent-platform/crawler-mcp-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "MCP Crawler Server - Browser automation primitives for ABL agents",
  "main": "dist/index.js",
  "scripts": {
    "dev": "NODE_ENV=development tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "playwright": "^1.40.0",
    "zod": "^3.25.76",
    "dotenv": "^17.2.3"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@vitest/coverage-v8": "^4.0.18",
    "tsx": "^4.7.0",
    "typescript": "^5.3.0",
    "vitest": "^4.0.18"
  }
}
EOF

# Create tsconfig.json
cat > tsconfig.json <<EOF
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

# Create vitest.config.ts
cat > vitest.config.ts <<EOF
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['dist', 'node_modules']
    }
  }
});
EOF

cd ../..
```

---

### Create Go Worker Package

```bash
# Create Go worker directory
mkdir -p apps/crawler-go-worker/{cmd/worker,internal/{crawler,queue,processor,storage},pkg/types}
cd apps/crawler-go-worker

# Initialize Go module
go mod init github.com/kore/abl-platform/crawler-go-worker

# Create main.go
cat > cmd/worker/main.go <<EOF
package main

import (
    "log"
    "os"
)

func main() {
    log.Println("Crawler Go Worker starting...")

    // TODO: Initialize worker
    // TODO: Connect to Redis/BullMQ
    // TODO: Start consuming jobs

    log.Println("Worker ready")
    select {} // Keep running
}
EOF

# Add dependencies
go get github.com/gocolly/colly/v2
go get github.com/PuerkitoBio/goquery
go get github.com/go-redis/redis/v9

# Create Makefile
cat > Makefile <<EOF
.PHONY: build run test clean

build:
	go build -o bin/worker ./cmd/worker

run: build
	./bin/worker

test:
	go test ./...

clean:
	rm -rf bin/
EOF

cd ../..
```

---

### Create Shared Types Package

```bash
# Create shared package
mkdir -p packages/crawler-shared/src/{types,schemas}
cd packages/crawler-shared

# Initialize package.json
cat > package.json <<EOF
{
  "name": "@agent-platform/crawler-shared",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Shared types and schemas for crawler services",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  }
}
EOF

# Create tsconfig.json
cat > tsconfig.json <<EOF
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

cd ../..
```

---

## 2. Install Dependencies

```bash
# Install all workspace dependencies
pnpm install

# Install Playwright browsers (for MCP server)
cd apps/crawler-mcp-server
pnpm exec playwright install chromium
cd ../..

# Install Go dependencies
cd apps/crawler-go-worker
go mod download
cd ../..
```

---

## 3. Create ABL Agent Definition

```bash
# Create agent file
mkdir -p examples/agents
cat > examples/agents/web_crawler_agent.abl <<EOF
AGENT web_crawler_agent {
  MODE: reasoning

  DESCRIPTION: """
  Web crawler agent that navigates websites intelligently.
  Uses MCP crawler tools to interact with pages like a human.
  """

  TOOL navigate {
    DESCRIPTION: "Navigate to a URL and wait for page load"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "navigate"
    }
    PARAMS: {
      url: string
      waitFor?: string = "load"
      timeout?: number = 30000
    }
  }

  TOOL get_page_content {
    DESCRIPTION: "Get current page HTML, text, and optional screenshot"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "get_page_content"
    }
    PARAMS: {
      includeHtml?: boolean = true
      includeText?: boolean = true
      includeScreenshot?: boolean = false
    }
  }

  TOOL click_element {
    DESCRIPTION: "Click an element on the page"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "click_element"
    }
    PARAMS: {
      selector: string
      waitAfterClick?: number = 1000
    }
  }

  TOOL extract_links {
    DESCRIPTION: "Extract all links from current page"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "extract_links"
    }
    PARAMS: {
      filter?: string
      includeExternal?: boolean = false
    }
  }

  GOAL: """
  Navigate websites and extract all relevant content.
  Adapt strategy based on site structure.
  """

  INSTRUCTIONS: """
  You are a web crawler that navigates websites like a human.

  Your approach:
  1. Navigate to the target URL
  2. Analyze the page structure
  3. Make intelligent decisions about interactions
  4. Extract relevant content
  5. Follow links systematically
  6. Report progress

  Be adaptive - every site is different!
  """
}
EOF
```

---

## 4. Update Docker Compose

```bash
# Add crawler services to docker-compose
cat > docker-compose.crawler.yml <<EOF
version: '3.9'

services:
  # Existing services (mongo, clickhouse, redis) are in docker-compose.yml

  crawler-mcp-server:
    build:
      context: ./apps/crawler-mcp-server
      dockerfile: Dockerfile
    container_name: crawler-mcp-server
    restart: unless-stopped
    ports:
      - "3100:3100"
    environment:
      - NODE_ENV=development
      - MCP_PORT=3100
      - REDIS_URL=redis://abl-redis:6379
    depends_on:
      - redis
    networks:
      - abl-network

  crawler-go-worker:
    build:
      context: ./apps/crawler-go-worker
      dockerfile: Dockerfile
    container_name: crawler-go-worker
    restart: unless-stopped
    environment:
      - REDIS_URL=redis://abl-redis:6379
      - WORKER_CONCURRENCY=100
    depends_on:
      - redis
    networks:
      - abl-network

networks:
  abl-network:
    external: true
EOF
```

---

## 5. Create Minimal Implementation

### MCP Server Index

```bash
cat > apps/crawler-mcp-server/src/index.ts <<EOF
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

class CrawlerMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server({
      name: 'crawler',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {}
      }
    });

    this.setupTools();
  }

  private setupTools() {
    // Register tools list
    this.server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'navigate',
          description: 'Navigate to a URL',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' }
            },
            required: ['url']
          }
        }
      ]
    }));

    // Handle tool calls
    this.server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'navigate') {
        console.log(\`Navigating to: \${args.url}\`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                url: args.url,
                title: 'Example Page'
              })
            }
          ]
        };
      }

      throw new Error(\`Unknown tool: \${name}\`);
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('Crawler MCP Server running on stdio');
  }
}

// Start server
const server = new CrawlerMCPServer();
server.start().catch(console.error);
EOF
```

---

## 6. Test the Setup

```bash
# Build all packages
pnpm build

# Test MCP server
cd apps/crawler-mcp-server
pnpm dev &
# Send test message (in another terminal)
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js

# Test Go worker
cd apps/crawler-go-worker
make build
./bin/worker &

# Stop test processes
pkill -f "crawler"
```

---

## 7. Development Workflow

### Start All Services

```bash
# Terminal 1: Start infrastructure
docker compose up -d

# Terminal 2: Start MCP server
cd apps/crawler-mcp-server
pnpm dev

# Terminal 3: Start Go workers
cd apps/crawler-go-worker
make run

# Terminal 4: Start search-ai API
cd apps/search-ai
pnpm dev
```

---

### Update Turbo Config

```bash
# Add crawler packages to turbo.json
# Edit turbo.json to include new packages in the build pipeline
```

---

## 8. Next Steps

1. **Implement MCP Tools** (Week 1)
   - `navigate()` - Full Playwright integration
   - `get_page_content()` - HTML + screenshot
   - `click_element()` - Element interaction
   - `extract_links()` - Link extraction

2. **Implement Go Worker** (Week 2)
   - BullMQ consumer
   - Colly crawler setup
   - Content extraction
   - Result publishing

3. **Agent Integration** (Week 3)
   - Connect agent to MCP server
   - Test with sample sites
   - Add progress tracking
   - WebSocket streaming

4. **Production Ready** (Week 4)
   - Docker images
   - Kubernetes manifests
   - Monitoring setup
   - Documentation

---

## 9. Useful Commands

```bash
# Build everything
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint

# Clean build artifacts
pnpm clean

# Start dev servers
pnpm dev

# Docker commands
docker compose up -d                    # Start all services
docker compose logs -f crawler-mcp-server  # View logs
docker compose down                     # Stop all services
docker compose down -v                  # Stop and remove volumes
```

---

## 10. Troubleshooting

### Playwright Installation Issues

```bash
# Install system dependencies (Ubuntu/Debian)
sudo apt-get install -y \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2

# Reinstall browsers
pnpm exec playwright install chromium --with-deps
```

### Go Module Issues

```bash
# Clear Go module cache
go clean -modcache

# Re-download dependencies
go mod download

# Verify dependencies
go mod verify
```

### Redis Connection Issues

```bash
# Check Redis is running
docker compose ps redis

# Test Redis connection
redis-cli -h localhost -p 6380 ping

# View Redis logs
docker compose logs -f redis
```

---

## Resources

- [Implementation Plan](./SEARCHAI_CRAWLER_IMPLEMENTATION_PLAN.md) - Full architecture details
- [Problem Taxonomy](./SEARCHAI_CRAWLER_PROBLEMS.md) - 130+ crawling challenges
- [Agent-Driven Architecture](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md) - Design philosophy
- [MCP SDK Docs](https://github.com/modelcontextprotocol/typescript-sdk)
- [Colly Docs](http://go-colly.org/)
- [Playwright Docs](https://playwright.dev/)

---

**Status**: ✅ Ready to implement
**Estimated Time**: 30 minutes for initial setup
**Next**: Start with MCP server implementation (Phase 1)

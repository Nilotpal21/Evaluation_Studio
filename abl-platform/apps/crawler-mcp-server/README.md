# Crawler MCP Server

Browser automation primitives exposed as MCP tools for ABL agents.

## Overview

The Crawler MCP Server provides a set of **browser automation tools** that allow ABL agents to navigate and interact with web pages like a human would. It uses Playwright under the hood for reliable, production-grade browser automation.

## Architecture

```
┌─────────────────────────────────────┐
│  ABL Agent                          │
│  - Reasons about site structure     │
│  - Decides what to do next          │
└────────────┬────────────────────────┘
             │ uses MCP tools
             ▼
┌─────────────────────────────────────┐
│  MCP Crawler Server                 │
│  - Exposes browser automation tools │
│  - Manages Playwright browser pool  │
│  - Handles session management       │
└────────────┬────────────────────────┘
             │ controls
             ▼
┌─────────────────────────────────────┐
│  Playwright Browser (Chromium)      │
│  - Renders JavaScript               │
│  - Executes user-like actions       │
└─────────────────────────────────────┘
```

## Available Tools

### Navigation

- **`navigate`** - Navigate to a URL and wait for page load
- **`go_back`** - Navigate back in browser history
- **`go_forward`** - Navigate forward in browser history

### Content Extraction

- **`get_page_content`** - Get HTML, text, and optional screenshot
- **`extract_links`** - Extract all links from the page
- **`extract_elements`** - Extract elements matching a selector
- **`get_page_state`** - Get page state (URL, title, scroll, cookies)

### Interaction

- **`click_element`** - Click an element
- **`type_text`** - Type text into an input field
- **`scroll`** - Scroll the page
- **`wait_for_element`** - Wait for element to appear

### Advanced

- **`take_screenshot`** - Capture screenshot of page or element
- **`execute_javascript`** - Execute custom JavaScript in page context

## Installation

```bash
# Install dependencies
pnpm install

# Install Playwright browsers
pnpm playwright:install

# Build
pnpm build
```

## Usage

### As MCP Server (with ABL Agent)

```bash
# Start the MCP server
pnpm dev

# The server runs on stdio and waits for MCP protocol messages
```

### As Standalone (for testing)

```typescript
import { CrawlerMCPServer } from './server.js';

const server = new CrawlerMCPServer();
await server.start();

// Server is now listening for MCP protocol messages on stdin/stdout
```

## Configuration

Environment variables (see `.env.example`):

```bash
HEADLESS=true                    # Run browser in headless mode
MAX_BROWSERS=1                   # Number of browser instances
MAX_PAGES_PER_BROWSER=50         # Max pages per browser
SESSION_TIMEOUT=1800000          # Session timeout (30 min)
```

## Development

```bash
# Start in watch mode
pnpm dev

# Run tests
pnpm test

# Type check
pnpm typecheck

# Build for production
pnpm build
```

## Docker

The Dockerfile uses a multi-stage build with isolated build context (`apps/crawler-mcp-server/` only — no monorepo root access). Key design decisions:

- **No lockfile**: Uses `pnpm install --no-frozen-lockfile` since `pnpm-lock.yaml` lives at the monorepo root
- **Standalone tsconfig**: `tsconfig.json` inlines all compiler options (no `extends` to monorepo root)
- **Production deps only**: A separate `prod-deps` stage installs only production dependencies for the runner image
- **No bundled npm**: The runner stage removes `/usr/local/lib/node_modules/npm` to eliminate base image CVEs
- **Playwright path**: `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` is set in the deps stage so browsers install to a known location for COPY

```bash
# Build image
docker build -t crawler-mcp-server .

# Run container
docker run -it --rm crawler-mcp-server
```

## Example: Agent Using MCP Tools

```abl
AGENT web_crawler_agent {
  MODE: reasoning

  TOOL navigate {
    DESCRIPTION: "Navigate to a URL"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "navigate"
    }
    PARAMS: { url: string }
  }

  TOOL extract_links {
    DESCRIPTION: "Extract links from page"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "extract_links"
    }
  }

  INSTRUCTIONS: """
  You navigate websites intelligently:
  1. Navigate to the URL
  2. Extract links
  3. Analyze the structure
  4. Decide what to do next
  """
}
```

## Architecture Details

### Browser Pool

The server maintains a pool of browser contexts to efficiently handle multiple agent sessions:

- Single browser instance (lightweight)
- Multiple contexts (isolated sessions)
- Automatic cleanup of stale sessions
- Configurable timeouts and limits

### Session Management

Each agent gets its own browser context:

- Isolated cookies and localStorage
- Independent navigation history
- Separate cache
- Concurrent execution supported

### Error Handling

All tools return structured results with success/error information:

```typescript
{
  success: boolean;
  // ... tool-specific data
  error?: string;
}
```

## Performance

- **Startup time**: ~2 seconds (browser launch)
- **Tool latency**: 50-500ms depending on operation
- **Memory**: ~200MB per browser, ~20MB per context
- **Concurrency**: Up to 50 pages per browser instance

## Troubleshooting

### Browser won't start

```bash
# Install system dependencies (Ubuntu/Debian)
sudo apt-get install -y libnss3 libatk1.0-0 libgbm1

# Reinstall Playwright browsers
pnpm playwright:install
```

### High memory usage

Reduce `MAX_PAGES_PER_BROWSER` in environment variables.

### Tools timing out

Increase timeout parameters in tool calls.

## Related

- [Implementation Plan](../../../docs/searchai/crawling/SEARCHAI_CRAWLER_IMPLEMENTATION_PLAN.md)
- [Quick Start Guide](../../../docs/searchai/crawling/QUICKSTART.md)
- [Agent-Driven Architecture](../../../docs/searchai/crawling/SEARCHAI_AGENT_DRIVEN_CRAWLER.md)

## License

Private - Part of ABL Platform

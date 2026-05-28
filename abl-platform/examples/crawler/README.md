# Web Crawler Agent Example

This example demonstrates how to use the Web Crawler agent to intelligently navigate and extract content from websites.

## Overview

The Web Crawler agent provides:

- **11 MCP Browser Tools** for interactive crawling (Playwright-based)
- **Bulk Crawl API** for efficient static HTML crawling (Go + Colly)
- **Intelligent Strategy Selection** between browser automation and bulk crawling
- **Structured Content Extraction** with configurable depth and breadth

## Architecture

```
┌─────────────┐
│   ABL Agent │ (web_crawler.agent.abl)
└──────┬──────┘
       │
       ├──────────► MCP Server (Playwright) ──► Browser Automation
       │            - navigate()
       │            - extract_links()
       │            - click_element()
       │            - get_page_content()
       │            - etc. (11 tools total)
       │
       └──────────► /api/crawl/batch ──► Go Workers (Colly) ──► Fast Static HTML
                    - Batch processing
                    - 10,000+ URLs/second
                    - Distributed workers
```

## Quick Start

### 1. Start MCP Server

```bash
cd apps/crawler-mcp-server
pnpm install
pnpm start
```

The MCP server will start and listen on stdio for tool calls from the ABL runtime.

### 2. Start Go Workers (Optional - for bulk crawling)

```bash
cd apps/crawler-go-worker
./build.sh
./run.sh
```

Workers will connect to Redis and wait for batch crawl jobs.

### 3. Use the Agent

```typescript
import { loadAgent } from '@agent-platform/runtime';

const crawler = await loadAgent('examples/crawler/agents/web_crawler.agent.abl');

// Start a crawl session
const session = await crawler.createSession({
  apiUrl: process.env.SEARCH_AI_API_URL,
  apiKey: process.env.API_KEY,
});

// Ask the agent to crawl
await session.send('Crawl https://example.com and extract all links');

// The agent will:
// 1. Navigate to the URL
// 2. Analyze the site structure
// 3. Choose between browser or bulk crawling
// 4. Extract content and links
// 5. Return structured results
```

## MCP Server Configuration

### Environment Variables

Create `.env` in `apps/crawler-mcp-server`:

```bash
# Browser Configuration
HEADLESS=true
MAX_PAGES_PER_BROWSER=50
SESSION_TIMEOUT=1800000

# MCP Configuration
MCP_TRANSPORT=stdio
LOG_LEVEL=info
```

### ABL Runtime Integration

The ABL runtime automatically discovers MCP servers defined in tools. The agent definition includes:

```abl
navigate(url: string) -> {success: boolean, ...}
  type: mcp
  server: "crawler"
  tool: "navigate"
  description: "Navigate to a URL"
```

This tells the runtime to:

1. Look for an MCP server named "crawler"
2. Call the "navigate" tool on that server
3. Pass parameters and return results

## Agent Capabilities

### MCP Browser Tools (Interactive)

| Tool                 | Purpose                  | Use Case                     |
| -------------------- | ------------------------ | ---------------------------- |
| `navigate`           | Go to URL                | Start crawling, change pages |
| `get_page_content`   | Get HTML/text/screenshot | Content extraction           |
| `click_element`      | Click buttons/links      | Navigate SPAs                |
| `type_text`          | Fill forms               | Search, filters              |
| `scroll`             | Scroll page              | Load lazy content            |
| `wait_for_element`   | Wait for elements        | Dynamic content              |
| `extract_links`      | Get all links            | Site structure               |
| `extract_elements`   | Get matching elements    | Structured data              |
| `take_screenshot`    | Capture visuals          | Visual verification          |
| `execute_javascript` | Run JS code              | Computed values              |
| `get_page_state`     | Get page state           | Debugging                    |

### Bulk Crawl API (High Performance)

| Tool               | Purpose         | Use Case                  |
| ------------------ | --------------- | ------------------------- |
| `crawl_batch`      | Submit bulk job | Large crawls (>20 pages)  |
| `get_crawl_status` | Check progress  | Monitor long-running jobs |

**Performance**: 10,000 URLs/second with 100 workers

## Example Use Cases

### Example 1: Explore a Documentation Site

```typescript
await session.send(`
  Crawl https://docs.example.com and:
  1. Extract all documentation page links
  2. Get the table of contents structure
  3. Identify which pages are tutorials vs API reference
`);
```

**Agent Strategy**: Uses browser tools to navigate and extract structure.

---

### Example 2: Scrape a Blog Archive

```typescript
await session.send(`
  Crawl https://blog.example.com and:
  1. Find all blog posts from 2024
  2. Extract titles, dates, and authors
  3. Get the first paragraph of each post
`);
```

**Agent Strategy**: Uses bulk crawl for efficiency (static HTML).

---

### Example 3: Monitor Product Listings

```typescript
await session.send(`
  Crawl https://shop.example.com/category/laptops and:
  1. Extract all product names and prices
  2. Identify products on sale
  3. Track availability status
`);
```

**Agent Strategy**: Checks if JavaScript-rendered, then chooses strategy.

---

### Example 4: Analyze Site Structure

```typescript
await session.send(`
  Analyze https://example.com:
  1. What's the main navigation structure?
  2. How many levels deep is the site?
  3. What are the main content categories?
`);
```

**Agent Strategy**: Explores with browser tools, builds sitemap.

## Configuration

### Crawl Depth and Breadth

The agent supports intelligent depth management:

```typescript
await session.send('Crawl example.com up to 50 pages, maximum depth 3');
```

The agent will:

- Start at the homepage
- Follow links up to 3 levels deep
- Stop at 50 pages or depth limit
- Prioritize important pages

### Content Extraction

Configure what data to extract:

```abl
GATHER:
  extraction_type:
    type: enum
    values:
      - "links_only"      # Just URLs
      - "metadata"        # Titles, descriptions, meta tags
      - "full_content"    # Complete HTML and text
      - "structured"      # Schema.org, OpenGraph
```

## Performance Tuning

### Browser Mode (MCP)

- **Throughput**: ~10-20 pages/second
- **Memory**: ~200 MB + 20 MB per session
- **Use When**: JavaScript required, <50 pages

### Bulk Mode (Go Workers)

- **Throughput**: 10,000 URLs/second (100 workers)
- **Memory**: ~50 MB per 1000 URLs
- **Use When**: Static HTML, >50 pages

### Hybrid Mode (Agent's Default)

- Agent analyzes site and chooses strategy
- Can switch mid-crawl if needed
- Best for unknown site types

## Troubleshooting

### MCP Server Not Found

**Error**: `MCP server "crawler" not found`

**Solution**: Ensure MCP server is running:

```bash
cd apps/crawler-mcp-server
pnpm start
```

---

### Crawl Times Out

**Error**: `Navigation timeout`

**Solution**: Increase timeout or use bulk crawl:

```typescript
await session.send('Use bulk crawl for example.com (site is slow)');
```

---

### JavaScript Required

**Error**: `Content not rendered`

**Solution**: Agent should auto-detect, but you can force browser mode:

```typescript
await session.send('Use browser mode to crawl example.com');
```

---

### Rate Limited

**Error**: `HTTP 429 Too Many Requests`

**Solution**: Agent will automatically slow down, or manually reduce parallelism:

```bash
# In .env for Go workers
PARALLELISM=10
DELAY_BETWEEN_REQUESTS=500ms
```

## API Reference

See [web_crawler.agent.abl](./agents/web_crawler.agent.abl) for complete tool signatures and documentation.

## Architecture Documents

- [Implementation Plan](../../docs/searchai/crawling/SEARCHAI_CRAWLER_IMPLEMENTATION_PLAN.md)
- [Framework Analysis](../../docs/searchai/crawling/GO_FRAMEWORK_ANALYSIS.md)
- [Pending Work](../../docs/searchai/crawling/PENDING_WORK.md)

## Testing

See test results:

- [MCP Server Tests](../../apps/crawler-mcp-server/TEST_RESULTS.md)
- [Go Worker Tests](../../apps/crawler-go-worker/TEST_RESULTS.md)
- [BullMQ Protocol](../../apps/crawler-go-worker/OPTION_A_COMPLETE.md)

## Contributing

When adding new crawler features:

1. Add MCP tool to `apps/crawler-mcp-server/src/tools/`
2. Update agent definition with new tool signature
3. Add example use case to this README
4. Test with real websites

## License

Same as ABL Platform

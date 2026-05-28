# SearchAI: Agent-Driven Crawler Architecture

> **Paradigm**: Crawler as "Mouse", Agent as "Human"
> **Date**: 2026-02-12
> **Status**: Current Direction ⭐
> **Vision**: ABL agent navigates web like a human, using crawler as low-level tool

**📖 Part of SearchAI Design**: See [SEARCHAI_DESIGN_INDEX.md](./SEARCHAI_DESIGN_INDEX.md) for complete design overview

**TL;DR**: Instead of pre-configuring autonomous crawler, use ABL agent to navigate web interactively. Agent observes page → reasons about what to do → uses crawler tools (click, scroll, extract) → adapts dynamically. Handles any page structure with zero configuration.

---

## Table of Contents

1. [Paradigm Shift: Autonomous vs Agent-Driven](#1-paradigm-shift-autonomous-vs-agent-driven)
2. [Crawler as MCP Tool](#2-crawler-as-mcp-tool)
3. [Agent as Web Navigator](#3-agent-as-web-navigator)
4. [Scenarios & Use Cases](#4-scenarios--use-cases)
5. [Architecture Design](#5-architecture-design)
6. [Implementation Details](#6-implementation-details)
7. [Comparison: Traditional vs Agent-Driven](#7-comparison-traditional-vs-agent-driven)

---

## 1. Paradigm Shift: Autonomous vs Agent-Driven

### 1.1 Traditional Approach (What We Designed Before)

```
┌─────────────────────────────────────────────┐
│  Autonomous Crawler                         │
│  - Pre-configured with all rules            │
│  - Executes deterministically               │
│  - Limited to predefined logic              │
│  - Can't adapt to unexpected situations     │
└─────────────────────────────────────────────┘

Example:
  crawler.configure({
    maxDepth: 5,
    followLinks: true,
    clickDropdowns: false  // ← Can't change mid-crawl
  });

  crawler.run(); // Executes autonomously
```

**Limitations:**

- ❌ Can't make decisions based on what it sees
- ❌ Can't handle unexpected page structures
- ❌ Can't adapt strategy mid-crawl
- ❌ Can't reason about content ("is this the right section?")

---

### 1.2 Agent-Driven Approach (Your Vision!)

```
┌─────────────────────────────────────────────┐
│  ABL Agent (Human-like Navigator)          │
│  - Observes page                            │
│  - Makes decisions in real-time             │
│  - Uses crawler as tool (like mouse)        │
│  - Adapts to any situation                  │
└───────────┬─────────────────────────────────┘
            │ uses tools
            ▼
┌─────────────────────────────────────────────┐
│  Crawler (Mouse/Browser Control)           │
│  - Primitive operations only                │
│  - click(), type(), scroll(), wait()        │
│  - extract(), navigate()                    │
│  - No decision-making logic                 │
└─────────────────────────────────────────────┘

Example:
  Agent observes: "I see a dropdown menu"
  Agent decides: "Let me click it to reveal content"
  Agent uses tool: crawler.click(dropdown)
  Agent observes result: "New content appeared"
  Agent decides: "Let me extract this content"
  Agent uses tool: crawler.extract(content)
```

**Benefits:**

- ✅ Makes decisions based on what it sees
- ✅ Handles any page structure dynamically
- ✅ Adapts strategy in real-time
- ✅ Reasons about content quality and relevance
- ✅ Can ask user for guidance when uncertain

---

## 2. Crawler as MCP Tool

### 2.1 MCP Tool Definition

**Concept**: Crawler exposes primitive operations as MCP tools that an agent can use

```typescript
// MCP Server: crawler-tools
{
  name: "crawler",
  version: "1.0",
  tools: [
    {
      name: "navigate",
      description: "Navigate to a URL",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          wait_for: { type: "string", enum: ["load", "networkidle", "domcontentloaded"] }
        }
      }
    },
    {
      name: "get_page_content",
      description: "Get current page HTML and text content",
      input_schema: { type: "object", properties: {} }
    },
    {
      name: "click_element",
      description: "Click an element on the page",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector or text content" }
        }
      }
    },
    {
      name: "type_text",
      description: "Type text into an input field",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" }
        }
      }
    },
    {
      name: "scroll",
      description: "Scroll the page",
      input_schema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["down", "up", "to_bottom"] },
          amount: { type: "number", description: "Pixels to scroll" }
        }
      }
    },
    {
      name: "wait",
      description: "Wait for element or time",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["time", "selector", "function"] },
          value: { type: "string" }
        }
      }
    },
    {
      name: "extract_links",
      description: "Extract all links from current page",
      input_schema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Optional filter pattern" }
        }
      }
    },
    {
      name: "extract_elements",
      description: "Extract elements matching a selector",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          attributes: { type: "array", items: { type: "string" } }
        }
      }
    },
    {
      name: "take_screenshot",
      description: "Take screenshot of current page or element",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Optional element selector" },
          full_page: { type: "boolean" }
        }
      }
    },
    {
      name: "get_page_state",
      description: "Get current page state (URL, title, loaded resources)",
      input_schema: { type: "object", properties: {} }
    },
    {
      name: "execute_javascript",
      description: "Execute JavaScript in page context",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code to execute" }
        }
      }
    },
    {
      name: "go_back",
      description: "Navigate back in browser history",
      input_schema: { type: "object", properties: {} }
    },
    {
      name: "go_forward",
      description: "Navigate forward in browser history",
      input_schema: { type: "object", properties: {} }
    }
  ]
}
```

---

### 2.2 Crawler Tool Implementation

```typescript
// MCP Server Implementation
class CrawlerMCPServer {
  private browser: Browser;
  private page: Page;

  async handleToolCall(tool: string, args: any): Promise<any> {
    switch (tool) {
      case 'navigate':
        await this.page.goto(args.url, {
          waitUntil: args.wait_for || 'load',
        });
        return {
          success: true,
          url: this.page.url(),
          title: await this.page.title(),
        };

      case 'get_page_content':
        return {
          url: this.page.url(),
          title: await this.page.title(),
          html: await this.page.content(),
          text: await this.page.evaluate(() => document.body.innerText),
          screenshot: await this.page.screenshot({ encoding: 'base64' }),
        };

      case 'click_element':
        const element = await this.page.locator(args.selector);
        await element.click();
        await this.page.waitForLoadState('networkidle');
        return {
          success: true,
          message: `Clicked element: ${args.selector}`,
        };

      case 'type_text':
        await this.page.fill(args.selector, args.text);
        return {
          success: true,
          message: `Typed text into: ${args.selector}`,
        };

      case 'scroll':
        if (args.direction === 'to_bottom') {
          await this.page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
        } else {
          const amount = args.direction === 'down' ? args.amount : -args.amount;
          await this.page.evaluate((pixels) => {
            window.scrollBy(0, pixels);
          }, amount);
        }
        return { success: true };

      case 'extract_links':
        const links = await this.page.$$eval(
          'a[href]',
          (anchors, filter) => {
            return anchors
              .map((a) => ({
                text: a.textContent?.trim(),
                href: a.href,
                title: a.title,
              }))
              .filter((link) => !filter || link.href.includes(filter));
          },
          args.filter,
        );
        return { links };

      case 'extract_elements':
        const elements = await this.page.$$eval(
          args.selector,
          (els, attrs) => {
            return els.map((el) => {
              const data: any = { text: el.textContent?.trim() };
              attrs.forEach((attr) => {
                data[attr] = el.getAttribute(attr);
              });
              return data;
            });
          },
          args.attributes || [],
        );
        return { elements };

      case 'take_screenshot':
        const screenshot = await this.page.screenshot({
          fullPage: args.full_page || false,
          clip: args.selector ? await this.getElementBounds(args.selector) : undefined,
        });
        return {
          screenshot: screenshot.toString('base64'),
          format: 'png',
        };

      case 'get_page_state':
        return {
          url: this.page.url(),
          title: await this.page.title(),
          scroll: await this.page.evaluate(() => ({
            x: window.scrollX,
            y: window.scrollY,
            maxY: document.body.scrollHeight,
          })),
          cookies: await this.page.context().cookies(),
          localStorage: await this.page.evaluate(() => JSON.stringify(localStorage)),
        };

      case 'execute_javascript':
        const result = await this.page.evaluate(args.code);
        return { result };

      case 'go_back':
        await this.page.goBack();
        return { success: true, url: this.page.url() };

      case 'go_forward':
        await this.page.goForward();
        return { success: true, url: this.page.url() };

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }
}
```

---

## 3. Agent as Web Navigator

### 3.1 ABL Agent Definition

```abl
AGENT web_crawler_agent {
  MODE: reasoning

  # Crawler tools available to agent
  TOOL navigate {
    DESCRIPTION: "Navigate to a URL and wait for page load"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "navigate"
    }
    PARAMS: {
      url: string
      wait_for?: string
    }
  }

  TOOL get_page_content {
    DESCRIPTION: "Get current page HTML, text, and screenshot"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "get_page_content"
    }
  }

  TOOL click {
    DESCRIPTION: "Click an element on the page"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "click_element"
    }
    PARAMS: {
      selector: string
    }
  }

  TOOL type_text {
    DESCRIPTION: "Type text into an input field"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "type_text"
    }
    PARAMS: {
      selector: string
      text: string
    }
  }

  TOOL scroll {
    DESCRIPTION: "Scroll the page"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "scroll"
    }
    PARAMS: {
      direction: string
      amount?: number
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
    }
  }

  TOOL extract_elements {
    DESCRIPTION: "Extract elements matching a selector"
    BINDING: {
      type: "mcp"
      server: "crawler"
      tool: "extract_elements"
    }
    PARAMS: {
      selector: string
      attributes?: array<string>
    }
  }

  GOAL: "Navigate websites like a human to extract content"

  INSTRUCTIONS: """
  You are a web crawler agent that navigates websites intelligently.

  Your approach:
  1. Navigate to the target URL
  2. Observe the page content and structure
  3. Make decisions based on what you see:
     - If you see a dropdown menu, click it to reveal content
     - If you see tabs, click each tab to see hidden content
     - If you see "Load More" button, click it to load more items
     - If you see pagination, navigate through pages
     - If you see forms, fill them if needed to access content
  4. Extract relevant content
  5. Follow links to discover more pages
  6. Adapt your strategy based on the site structure

  Be intelligent:
  - Don't click navigation links that go to external sites
  - Don't submit forms unless necessary for content access
  - Recognize when you've reached the end (no more content)
  - Extract only relevant content (ignore ads, menus, footers)
  """
}
```

---

### 3.2 Agent Reasoning Examples

#### Example 1: Discovering Content Behind Dropdown

```
Agent Session Log:
─────────────────────────────────────────────────────────

User: "Crawl https://example.com/products"

Agent: [Calling tool: navigate]
  → navigate({ url: "https://example.com/products" })

Tool Response:
  {
    success: true,
    url: "https://example.com/products",
    title: "Our Products"
  }

Agent: [Calling tool: get_page_content]
  → get_page_content()

Tool Response:
  {
    url: "https://example.com/products",
    title: "Our Products",
    text: "Select a category: [Dropdown]\n...",
    screenshot: "base64..."
  }

Agent Reasoning:
  "I see a page with a dropdown menu for categories.
   The page currently shows minimal content.
   I should click the dropdown to see available categories."

Agent: [Calling tool: click]
  → click({ selector: "select#category" })

Tool Response:
  { success: true, message: "Clicked element: select#category" }

Agent: [Calling tool: extract_elements]
  → extract_elements({
      selector: "select#category option",
      attributes: ["value"]
    })

Tool Response:
  {
    elements: [
      { text: "Electronics", value: "electronics" },
      { text: "Clothing", value: "clothing" },
      { text: "Books", value: "books" }
    ]
  }

Agent Reasoning:
  "I found 3 categories. I should explore each one to get all content.
   Let me select each category and extract the products."

Agent: [Loop for each category]
  For "Electronics":
    → click({ selector: "option[value='electronics']" })
    → wait({ type: "time", value: "1000" })
    → extract_elements({ selector: ".product-card" })
    → Store extracted products

  For "Clothing":
    → click({ selector: "option[value='clothing']" })
    → wait({ type: "time", value: "1000" })
    → extract_elements({ selector: ".product-card" })
    → Store extracted products

  [... and so on]

Agent: "Completed! Extracted products from all 3 categories."
```

---

#### Example 2: Infinite Scroll Detection

```
Agent Session Log:
─────────────────────────────────────────────────────────

User: "Crawl https://example.com/blog"

Agent: [Calling tool: navigate]
  → navigate({ url: "https://example.com/blog" })

Agent: [Calling tool: get_page_content]
  → get_page_content()

Agent Reasoning:
  "I see 10 blog posts on the page.
   I notice there's no 'Next Page' button.
   This might be an infinite scroll page.
   Let me scroll down and see if more content loads."

Agent: [Calling tool: scroll]
  → scroll({ direction: "to_bottom" })

Agent: [Calling tool: wait]
  → wait({ type: "time", value: "2000" })

Agent: [Calling tool: get_page_content]
  → get_page_content()

Agent Reasoning:
  "After scrolling, I now see 20 blog posts (10 more loaded).
   This confirms infinite scroll.
   I should continue scrolling until no new content appears."

Agent: [Loop]
  previousCount = 20

  scroll({ direction: "to_bottom" })
  wait({ type: "time", value: "2000" })
  currentContent = get_page_content()
  currentCount = count posts in currentContent

  if currentCount === previousCount:
    Agent: "No new content loaded. Reached the end."
    break

  previousCount = currentCount
  continue

Agent: "Completed! Extracted all 47 blog posts."
```

---

#### Example 3: Form-Based Search

```
Agent Session Log:
─────────────────────────────────────────────────────────

User: "Crawl https://library.com and search for books about 'AI'"

Agent: [Calling tool: navigate]
  → navigate({ url: "https://library.com" })

Agent: [Calling tool: get_page_content]
  → get_page_content()

Agent Reasoning:
  "I see a search form on the homepage.
   To find books about 'AI', I need to fill the search form."

Agent: [Calling tool: type_text]
  → type_text({ selector: "input#search", text: "AI" })

Agent: [Calling tool: click]
  → click({ selector: "button[type='submit']" })

Agent: [Calling tool: wait]
  → wait({ type: "networkidle" })

Agent: [Calling tool: get_page_content]
  → get_page_content()

Agent Reasoning:
  "Search results loaded. I see 15 results on page 1.
   I notice pagination at the bottom (Page 1 of 5).
   I should extract results from all pages."

Agent: [Loop through pagination]
  For page 1:
    → extract_elements({ selector: ".book-result" })
    → Store results

  For page 2-5:
    → click({ selector: "a.next-page" })
    → wait({ type: "networkidle" })
    → extract_elements({ selector: ".book-result" })
    → Store results

Agent: "Completed! Found 73 books about AI across 5 pages."
```

---

## 4. Scenarios & Use Cases

### 4.1 Scenario Matrix: When Agent-Driven Excels

| Scenario                 | Traditional Crawler       | Agent-Driven Crawler       | Winner      |
| ------------------------ | ------------------------- | -------------------------- | ----------- |
| **Static HTML Site**     | ✅ Fast, efficient        | ⚠️ Works but slower        | Traditional |
| **Dropdown Menus**       | ❌ Must pre-configure     | ✅ Discovers and clicks    | **Agent**   |
| **Tabs Interface**       | ❌ Must pre-configure     | ✅ Clicks all tabs         | **Agent**   |
| **Infinite Scroll**      | ❌ Fixed scroll logic     | ✅ Adapts dynamically      | **Agent**   |
| **Multi-Step Forms**     | ❌ Very hard to configure | ✅ Fills intelligently     | **Agent**   |
| **Complex Navigation**   | ❌ Brittle rules          | ✅ Reasons about structure | **Agent**   |
| **Content Quality**      | ❌ Can't judge relevance  | ✅ Can filter by relevance | **Agent**   |
| **Unexpected Structure** | ❌ Breaks                 | ✅ Adapts                  | **Agent**   |
| **Authentication**       | ⚠️ Pre-configured         | ✅ Can handle dynamically  | **Agent**   |
| **CAPTCHAs**             | ❌ Fails                  | ⚠️ Can ask user for help   | **Agent**   |

---

### 4.2 Specific Use Cases

#### Use Case 1: E-Commerce Product Catalog

**Challenge**: Products hidden behind filters, categories, pagination

**Agent Approach**:

```
1. Navigate to /products
2. Observe: "I see filters (category, price, brand)"
3. Decide: "I'll explore each category"
4. For each category:
   - Click category
   - Check for price filters
   - For each price range:
     - Apply filter
     - Paginate through results
     - Extract products
5. Result: Complete product catalog
```

**Traditional Approach**: Would need to pre-configure every filter combination (combinatorial explosion!)

---

#### Use Case 2: Documentation with Tabbed Content

**Challenge**: Content split across tabs, not all visible initially

**Agent Approach**:

```
1. Navigate to /docs/api
2. Observe: "I see 5 tabs (Overview, Parameters, Examples, Errors, Changelog)"
3. Decide: "I should click each tab to get all content"
4. For each tab:
   - Click tab
   - Wait for content to load
   - Extract content
   - Store with tab name as context
5. Result: Complete documentation from all tabs
```

**Traditional Approach**: Would miss content in hidden tabs unless specifically programmed

---

#### Use Case 3: Forum Thread with "Load More Comments"

**Challenge**: Comments loaded incrementally via button clicks

**Agent Approach**:

```
1. Navigate to /forum/thread/123
2. Observe: "I see 10 comments and a 'Load More' button"
3. Decide: "I should click 'Load More' until all comments visible"
4. Loop:
   - Click "Load More"
   - Wait for new comments
   - Check if button still exists
   - If exists, continue
   - If not, all comments loaded
5. Extract all comments
6. Result: All 127 comments extracted
```

**Traditional Approach**: Would need fixed click count or complex detection logic

---

#### Use Case 4: Search Results with Filters

**Challenge**: Must apply various filters to see all results

**Agent Approach**:

```
1. Navigate to /search?q=laptops
2. Observe: "I see filters (Brand, Price, Rating, Availability)"
3. Decide: "Let me try different filter combinations to get comprehensive results"
4. Strategy:
   - First: All results (baseline)
   - Then: By brand (Dell, HP, Lenovo, etc.)
   - Then: By price range (< $500, $500-$1000, > $1000)
   - Then: By rating (5 stars, 4 stars, etc.)
5. Deduplicate results
6. Result: Comprehensive product list with all variations
```

**Traditional Approach**: Would need explicit configuration for each filter

---

## 5. Architecture Design

### 5.1 System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  User / ABL Agent                                           │
│  "Crawl https://example.com/products"                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Web Crawler Agent (ABL)                                    │
│  - Reasoning mode                                           │
│  - Access to crawler MCP tools                              │
│  - Makes decisions based on observations                    │
│  - Adapts strategy dynamically                              │
└────────────────────┬────────────────────────────────────────┘
                     │ calls MCP tools
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  MCP Server: Crawler Tools                                  │
│  - navigate(), click(), type(), scroll()                    │
│  - extract_links(), extract_elements()                      │
│  - get_page_content(), take_screenshot()                    │
└────────────────────┬────────────────────────────────────────┘
                     │ controls browser
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Browser Instance (Playwright/Puppeteer)                    │
│  - Real browser (Chrome/Firefox)                            │
│  - Executes user-like actions                               │
│  - Renders JavaScript, handles events                       │
└─────────────────────────────────────────────────────────────┘
```

---

### 5.2 Data Flow

```
Step 1: Agent receives task
  User: "Crawl https://docs.python.org"
  ↓

Step 2: Agent makes initial observation
  Agent calls: navigate({ url: "https://docs.python.org" })
  Agent calls: get_page_content()
  ↓
  Agent receives: {
    url, title, html, text, screenshot
  }
  ↓

Step 3: Agent reasons
  LLM prompt: "I'm looking at a documentation site.
               Here's what I see: [page content]
               What should I do next?"
  ↓
  LLM response: "I see a navigation menu with categories.
                 I should extract all category links first."
  ↓

Step 4: Agent acts
  Agent calls: extract_links({ filter: "/docs/" })
  ↓
  Agent receives: { links: [...] }
  ↓

Step 5: Agent continues reasoning
  LLM prompt: "I found 25 documentation pages.
               Should I visit each one?"
  ↓
  LLM response: "Yes, visit each page and extract content."
  ↓

Step 6: Agent loops
  For each link:
    - navigate(link)
    - get_page_content()
    - extract relevant content
    - store in database
  ↓

Step 7: Agent reports
  "Completed! Crawled 25 pages, indexed 10,000 text chunks."
```

---

## 6. Implementation Details

### 6.1 MCP Server Setup

```typescript
// apps/crawler-mcp-server/src/index.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium, Browser, Page } from 'playwright';

class CrawlerMCPServer {
  private server: Server;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'crawler',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupTools();
  }

  private setupTools() {
    // Register all tools
    this.server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'navigate',
          description: 'Navigate to a URL',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              wait_for: { type: 'string', enum: ['load', 'networkidle', 'domcontentloaded'] },
            },
            required: ['url'],
          },
        },
        // ... all other tools
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;

      // Initialize browser if needed
      if (!this.browser) {
        this.browser = await chromium.launch({ headless: true });
        this.page = await this.browser.newPage();
      }

      // Route to appropriate handler
      return await this.handleToolCall(name, args);
    });
  }

  private async handleToolCall(tool: string, args: any) {
    // Implementation from section 2.2
    // ...
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('Crawler MCP Server running on stdio');
  }
}

// Start server
const server = new CrawlerMCPServer();
server.start();
```

---

### 6.2 ABL Runtime Integration

```typescript
// apps/runtime/src/tools/mcp-crawler-binding.ts

import { ToolBinding } from '../types.js';

export class MCPCrawlerBinding implements ToolBinding {
  type = 'mcp';

  async execute(toolName: string, params: any): Promise<any> {
    // Connect to MCP server
    const mcpClient = await this.connectToMCPServer('crawler');

    // Call tool
    const result = await mcpClient.callTool(toolName, params);

    return result;
  }

  private async connectToMCPServer(serverName: string) {
    // Use MCP client SDK to connect to crawler MCP server
    // ...
  }
}
```

---

### 6.3 Agent Execution Flow

```typescript
// Agent reasoning loop
async function executeWebCrawlerAgent(targetUrl: string) {
  const agent = await loadAgent('web_crawler_agent');
  const context = createAgentContext({
    goal: `Crawl ${targetUrl} and extract all content`,
    availableTools: [
      'navigate',
      'get_page_content',
      'click',
      'type_text',
      'scroll',
      'extract_links',
      'extract_elements',
    ],
  });

  // Agent makes first move
  let action = await agent.reason(context);

  while (!action.isComplete) {
    // Execute tool call
    const result = await executeTool(action.tool, action.params);

    // Update context with result
    context.addToolResult(action.tool, result);

    // Agent reasons about next action
    action = await agent.reason(context);
  }

  return context.getExtractedContent();
}
```

---

## 7. Comparison: Traditional vs Agent-Driven

### 7.1 Configuration Complexity

**Traditional:**

```typescript
// Must pre-configure everything
const config = {
  maxDepth: 5,
  concurrency: 100,
  selectors: {
    content: 'article.post-content',
    title: 'h1.post-title',
    date: 'time.post-date',
  },
  interactions: {
    clickDropdowns: true,
    dropdownSelectors: ['select.category'],
    fillForms: false,
    handleModals: true,
  },
  pagination: {
    type: 'button',
    selector: '.load-more',
    maxClicks: 50,
  },
  // ... 50+ more configuration options
};
```

**Agent-Driven:**

```typescript
// Just provide the goal
const task = {
  url: 'https://example.com',
  goal: 'Extract all product information',
};

// Agent figures out everything else
```

---

### 7.2 Handling Unexpected Situations

**Traditional:**

```
Crawler encounters: Login modal blocking content
  ↓
Crawler behavior: Stuck (not configured to handle this)
  ↓
Result: Crawl fails
```

**Agent-Driven:**

```
Agent encounters: Login modal blocking content
  ↓
Agent reasons: "This is a login modal. I should check if I can dismiss it."
  ↓
Agent tries: Click "Continue as Guest" button
  ↓
Result: Successfully continues crawling
```

---

### 7.3 Content Quality Judgment

**Traditional:**

```
Extracts: All text matching selector 'article'
Result: Includes ads, related posts, comments (noise)
```

**Agent-Driven:**

```
Agent extracts: Text matching 'article'
Agent reasons: "This looks like the main content. But these related posts at the bottom are not part of the main article."
Agent filters: Keeps only the main article text
Result: Clean, relevant content only
```

---

### 7.4 Performance Comparison

| Metric             | Traditional (Pre-configured)    | Agent-Driven (Reasoning)             |
| ------------------ | ------------------------------- | ------------------------------------ |
| **Setup Time**     | Hours (complex config)          | Minutes (just provide URL)           |
| **Adaptability**   | Low (breaks on changes)         | High (adapts automatically)          |
| **Coverage**       | Limited (only configured paths) | Comprehensive (explores dynamically) |
| **Maintenance**    | High (update config per site)   | Low (agent adapts)                   |
| **Speed**          | Fast (no reasoning overhead)    | Slower (LLM reasoning per action)    |
| **Cost**           | Low (compute only)              | Higher (LLM API calls)               |
| **Quality**        | Variable (depends on config)    | High (intelligent filtering)         |
| **Error Handling** | Brittle (fails on unexpected)   | Robust (adapts to errors)            |

---

### 7.5 When to Use Each Approach

**Use Traditional Crawler When:**

- ✅ Crawling same site repeatedly (amortize config cost)
- ✅ Site structure is stable and well-known
- ✅ Speed is critical (millions of pages)
- ✅ Cost must be minimized
- ✅ Simple, static HTML sites

**Use Agent-Driven Crawler When:**

- ✅ Exploring new sites (unknown structure)
- ✅ Site requires complex interactions
- ✅ Quality is more important than speed
- ✅ Sites change frequently
- ✅ Need to handle unexpected situations
- ✅ One-time or infrequent crawls

---

## 8. Hybrid Approach: Best of Both Worlds

### 8.1 Architecture

```
┌────────────────────────────────────────────────────────┐
│  Agent as Strategist                                   │
│  - Analyzes site initially                             │
│  - Generates crawl configuration                       │
│  - Delegates bulk work to traditional crawler          │
│  - Handles edge cases that crawler can't               │
└────────────┬───────────────────────────────────────────┘
             │
      ┌──────┴──────┐
      │             │
      ▼             ▼
┌──────────────┐  ┌──────────────────────┐
│  Traditional │  │  Agent-Driven        │
│  Crawler     │  │  (for edge cases)    │
│  (90% work)  │  │  (10% work)          │
└──────────────┘  └──────────────────────┘
```

**Example:**

```
Step 1: Agent explores site
  → Discovers sitemap with 10,000 URLs
  → Analyzes: "This is a static documentation site"

Step 2: Agent generates config
  → Creates traditional crawler config
  → Specifies selectors, pagination rules

Step 3: Traditional crawler executes
  → Crawls 9,000 pages (standard structure)

Step 4: Agent handles edge cases
  → 1,000 pages have non-standard structure
  → Agent crawls these with reasoning

Result: Fast (traditional for bulk) + Comprehensive (agent for edge cases)
```

---

## 9. Summary

### Research Findings

**Key Insight**: Treating crawler as a "mouse" (tool) and agent as "human" (decision-maker) is fundamentally more flexible than autonomous crawlers.

**Architecture Pattern**:

```
Primary: Agent-Driven Crawler
  - User provides URL
  - Agent navigates intelligently
  - Handles any site structure
  - Adapts to unexpected situations

Fallback: Traditional Crawler (for bulk work)
  - Agent delegates to traditional crawler when site is simple
  - Saves time and cost

Integration: MCP Tools
  - Crawler exposed as MCP tools
  - Agent uses tools like a human uses a mouse
  - Can be used by any ABL agent
```

**Research Components**:

1. MCP Crawler Server (primitive operations)
2. Web Crawler Agent (ABL definition)
3. Complex site handling (dropdowns, tabs, forms)
4. Hybrid approach (traditional crawler for optimization)

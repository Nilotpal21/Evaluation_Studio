# Web Crawler Problem Taxonomy & Solutions

> **Date**: 2026-02-12
> **Status**: Complete ✅
> **Objective**: Systematically categorize web crawling challenges before framework selection
> **Approach**: Problem-first, solution-second

**📖 Part of SearchAI Design**: See [SEARCHAI_DESIGN_INDEX.md](./SEARCHAI_DESIGN_INDEX.md) for complete design overview

**Summary**: 21 problem categories, 130+ specific challenges identified and analyzed. This taxonomy informed our decision to pursue an agent-driven crawler approach for handling complex scenarios.

---

## Executive Summary

### The Challenge

Web crawling at scale faces **130+ distinct problems** across **21 categories**. Traditional crawlers require hours of site-specific configuration and still miss 30-40% of content. This taxonomy captures the complete problem space.

### Problem Distribution

| Category                        | Problems                             | Who Solves         | Solution                |
| ------------------------------- | ------------------------------------ | ------------------ | ----------------------- |
| **Discovery** (12+)             | Sitemaps, pagination, hidden content | Colly + Agent      | 70% automated           |
| **Access Control** (8+)         | Auth, sessions, cookies              | Agent + Playwright | Complex auth flows      |
| **Anti-Bot** (18+)              | Rate limits, fingerprinting, CAPTCHA | Agent + Playwright | Real browser behavior   |
| **Content Rendering** (15+)     | JavaScript, SPAs, lazy loading       | Playwright         | Full JS execution       |
| **Interactive Content** (10+)   | Dropdowns, tabs, modals              | Agent + Playwright | Intelligent interaction |
| **Dynamic Loading** (8+)        | Infinite scroll, AJAX                | Playwright         | Wait strategies         |
| **URL Complexity** (6+)         | Relative paths, encoding             | Colly + Playwright | Auto-normalization      |
| **Architecture Detection** (5+) | Site structure analysis              | **Agent only**     | LLM reasoning           |
| **Navigation & Routing** (4+)   | Client-side routing                  | Playwright         | SPA support             |
| **Extraction** (15+)            | Content vs boilerplate               | Colly + Agent      | Smart extraction        |
| **Media & Assets** (8+)         | Images, videos, PDFs                 | Colly (fast path)  | Parallel downloads      |
| **Form & Input** (7+)           | Search, filters, multi-step          | Agent + Playwright | Form intelligence       |
| **Content Variants** (5+)       | Mobile/desktop, AMP                  | Playwright         | Device emulation        |
| **Encoding & Format** (4+)      | Character sets, malformed HTML       | Colly + goquery    | Robust parsing          |
| **Temporal & Session** (6+)     | Time-based, geographic               | Playwright         | Session management      |
| **Security & Privacy** (7+)     | SSL, CSP, CORS, cookies              | Playwright         | Security compliance     |
| **Redirect & Status** (5+)      | Chains, soft 404s                    | Colly + Playwright | Follow/detect           |
| **Duplicate & Canonical** (4+)  | Same content, different URLs         | Colly (fast)       | Deduplication           |
| **Multilingual & i18n** (4+)    | hreflang, language detection         | Agent              | Language routing        |
| **Scale & Performance** (12+)   | Millions of URLs, memory             | Colly (10k req/s)  | Horizontal scaling      |
| **Reliability** (8+)            | Failures, retries, timeouts          | Colly + BullMQ     | Retry logic             |

### Solution Matrix

**Traditional Approach** (Pre-configured crawler):

- ❌ User configures 50+ parameters per site
- ❌ Breaks when site changes
- ❌ Cannot handle unexpected situations
- ❌ 60-80% content coverage
- ❌ High maintenance

**Our Approach** (Agent-driven + hybrid workers):

- ✅ **70% of problems**: Solved by Colly (static HTML, fast, cheap)
- ✅ **20% of problems**: Solved by Playwright (JS, interactions, expensive)
- ✅ **10% of problems**: Solved by Agent (intelligence, decision-making)
- ✅ **Zero configuration** required from user
- ✅ **95%+ content coverage**
- ✅ **68% cost savings** through intelligent worker selection

### Key Insights

**Insight 1: 70/30 Split**

- 70-80% of web content is **static HTML** (docs, blogs, news)
- 20-30% requires **JavaScript** (SPAs, complex interactions)
- Use fast static crawler (Colly) by default, browser (Playwright) only when needed

**Insight 2: Agent as Decision Maker**

- Agent analyzes site → Reasons → Decides strategy
- Handles **unexpected situations** (just like a human)
- Uses crawlers as **tools**, not autonomous systems

**Insight 3: Problem Hierarchy**

- **Base layer** (Colly): URL handling, HTML parsing, extraction - FAST
- **JS layer** (Playwright): Rendering, interaction, complex content - SLOW
- **Intelligence layer** (Agent): Decision-making, adaptation, quality - SMART

### Quick Reference

**When you encounter...**

- Sitemap detection → Colly handles
- JavaScript framework → Playwright handles
- Dropdown menu → Agent decides to click + Playwright executes
- Infinite scroll → Agent detects + Playwright scrolls
- Rate limiting → Colly respects robots.txt
- CAPTCHA → Agent may escalate to user
- Unknown site structure → Agent analyzes first

**Cost Optimization Formula:**

```
Total Cost = (Static URLs × $0.10/M) + (JS URLs × $4.30/M)
Naive: 1M URLs × $4.30 = $4.30
Optimized: (700k × $0.10) + (300k × $4.30) = $1.36 (68% savings)
```

---

## Problem Categories

1. [Discovery Problems](#1-discovery-problems) - Finding what to crawl
2. [Access Control Problems](#2-access-control-problems) - Getting permission to crawl
3. [Anti-Bot Problems](#3-anti-bot-problems) - Avoiding detection/blocking
4. [Content Rendering Problems](#4-content-rendering-problems) - Getting actual content
5. [Interactive Content Problems](#5-interactive-content-problems) - Click, hover, dropdown interactions
6. [Dynamic Loading Problems](#6-dynamic-loading-problems) - Infinite scroll, lazy loading
7. [URL & Path Complexity](#7-url--path-complexity) - Relative paths, base URLs, encoding
8. [Architecture Detection Problems](#8-architecture-detection-problems) - Understanding site structure
9. [Navigation & Routing Problems](#9-navigation--routing-problems) - Client-side routing, hash routing
10. [Extraction Problems](#10-extraction-problems) - Parsing content correctly
11. [Media & Assets Problems](#11-media--assets-problems) - Images, videos, PDFs, iframes
12. [Form & Input Problems](#12-form--input-problems) - Search, filters, multi-step forms
13. [Content Variants Problems](#13-content-variants-problems) - Mobile/desktop, AMP, print versions
14. [Encoding & Format Problems](#14-encoding--format-problems) - Character sets, malformed HTML
15. [Temporal & Session Problems](#15-temporal--session-problems) - Time-based, geographic, A/B testing
16. [Security & Privacy Problems](#16-security--privacy-problems) - SSL, CSP, CORS, cookies
17. [Redirect & Status Problems](#17-redirect--status-problems) - Redirect chains, soft 404s
18. [Duplicate & Canonicalization](#18-duplicate--canonicalization) - Same content, different URLs
19. [Multilingual & i18n Problems](#19-multilingual--i18n-problems) - hreflang, language detection
20. [Scale & Performance Problems](#20-scale--performance-problems) - Handling volume
21. [Reliability Problems](#21-reliability-problems) - Dealing with failures

---

## 1. Discovery Problems

### 1.1 Sitemap Detection & Analysis

#### Problem: Sitemap Not Present or Incomplete

**Scenarios:**

- No `sitemap.xml` at standard locations (`/sitemap.xml`, `/sitemap_index.xml`)
- Sitemap not declared in `robots.txt`
- Multiple sitemaps without index
- Dynamic/paginated sitemaps
- Compressed sitemaps (`.xml.gz`)
- Non-standard sitemap URLs

**Detection Strategy:**

```
Step 1: Check robots.txt for Sitemap directive
Step 2: Try standard locations:
  - /sitemap.xml
  - /sitemap_index.xml
  - /sitemap-index.xml
  - /sitemap1.xml
Step 3: Look for sitemap references in HTML:
  - <link rel="sitemap">
  - Common CMS patterns (/wp-sitemap.xml, /sitemap-misc.xml)
Step 4: Check common CMS paths:
  - WordPress: /wp-sitemap.xml
  - Drupal: /sitemap.xml
  - Joomla: /sitemap.xml
  - Shopify: /sitemap.xml
Step 5: If none found, assume no sitemap → use crawling
```

**Why Sitemap Missing:**

1. **Small sites**: Manually maintained, no automation
2. **Dynamic content**: Hard to enumerate all URLs
3. **Security**: Intentionally hidden to prevent scraping
4. **Old technology**: Site predates sitemap standard
5. **Misconfiguration**: Sitemap generation broken

**Fallback:**

- Start with seed URL
- Extract all links from homepage
- Use breadth-first search (BFS)

---

### 1.2 robots.txt Incompleteness

#### Problem: robots.txt Doesn't List All Crawlable Paths

**Reality:**

- robots.txt is **advisory**, not comprehensive
- Only lists what's **disallowed**, not what exists
- May be outdated (site changed, robots.txt didn't)
- May intentionally hide valuable content

**Example:**

```
# robots.txt
User-agent: *
Disallow: /admin/
Disallow: /api/
# This doesn't mean /blog/, /docs/, /products/ are only pages!
```

**What robots.txt Doesn't Tell You:**

- ❌ All available pages
- ❌ Site structure
- ❌ Deep nested paths
- ❌ Query parameter pages
- ❌ JavaScript-generated routes

**Strategy:**

- Parse robots.txt for **politeness** (crawl-delay, disallowed paths)
- Don't rely on it for **discovery**
- Use BFS/DFS crawling to discover actual URLs

---

### 1.3 Deep Link Discovery

#### Problem: Content Hidden Behind Navigation/Forms

**Scenarios:**

- Paginated lists (e.g., `/products?page=50`)
- Search results (e.g., `/search?q=term`)
- Filtered views (e.g., `/items?category=X&sort=Y`)
- Date-based archives (e.g., `/2023/12/`)
- Hidden in dropdowns/modals (JS-rendered links)

**Detection Challenges:**

1. **Infinite scroll**: No "next page" link, JS loads more
2. **AJAX pagination**: Links generated by JavaScript
3. **Form-based navigation**: POST requests, CSRF tokens
4. **Hash-based routing**: `/#!/page` (client-side routing)

**Discovery Strategies:**

```
1. Extract all <a href> links (static)
2. Execute JavaScript, extract generated links
3. Detect pagination patterns:
   - ?page=N
   - /page/N/
   - rel="next" links
4. Detect infinite scroll:
   - Observe DOM changes while scrolling
   - Capture XHR/Fetch requests
5. Detect AJAX load-more:
   - Monitor network requests
   - Extract JSON API endpoints
```

---

## 2. Access Control Problems

### 2.1 Authentication Requirements

#### Problem: Content Behind Login

**Scenarios:**

- Intranets (SharePoint, Confluence)
- Paywalls (news sites, academic papers)
- Membership sites (forums, communities)
- SaaS dashboards
- Social media (LinkedIn, Facebook)

**Authentication Types:**

1. **Session-based**: Cookies after login form POST
2. **OAuth 2.0**: Token-based (SharePoint, Google)
3. **API keys**: Header-based (`Authorization: Bearer <token>`)
4. **HTTP Basic Auth**: Username/password in headers
5. **SAML/SSO**: Enterprise single sign-on
6. **JWT**: JSON Web Tokens

**Solution Architecture:**

```typescript
interface Connector {
  type: ConnectionType;
  authConfig: {
    type: 'oauth' | 'api_key' | 'basic' | 'session' | 'saml';
    credentials: {
      // OAuth
      clientId?: string;
      clientSecret?: string;
      refreshToken?: string;

      // API Key
      apiKey?: string;
      apiKeyHeader?: string; // e.g., "X-API-Key"

      // Basic Auth
      username?: string;
      password?: string;

      // Session-based
      cookies?: Record<string, string>;
      sessionUrl?: string; // Login endpoint

      // SAML
      idpUrl?: string;
      certificate?: string;
    };
  };
}
```

**Implementation:**

```go
// Go: OAuth example
func (c *Crawler) authenticateOAuth(config OAuthConfig) error {
    token, err := oauth2.Config{
        ClientID:     config.ClientID,
        ClientSecret: config.ClientSecret,
        Endpoint:     microsoft.AzureADEndpoint("common"),
    }.Token(context.Background())

    c.collector.OnRequest(func(r *colly.Request) {
        r.Headers.Set("Authorization", "Bearer " + token.AccessToken)
    })
    return nil
}
```

---

### 2.2 Network Access (Proxies, VPNs)

#### Problem: Site Blocks Datacenter IPs

**Scenarios:**

- Cloudflare bot detection
- Geographic restrictions (only accessible from certain countries)
- Corporate intranets (only accessible via VPN)
- Rate limiting by IP (need IP rotation)

**Detection:**

```
User tries to crawl → Gets 403 Forbidden or 429 Too Many Requests
Need: Proxy rotation or residential IPs
```

**Proxy Types:**

1. **Datacenter proxies**: Fast, cheap, easily detected
2. **Residential proxies**: Real user IPs, expensive, undetectable
3. **Mobile proxies**: Mobile carrier IPs, very expensive
4. **Rotating proxies**: Automatic IP rotation

**Solution Architecture:**

```typescript
interface ProxyConfig {
  enabled: boolean;
  type: 'http' | 'socks5' | 'residential';
  endpoints: string[]; // ["http://proxy1.com:8080", ...]
  rotation: {
    strategy: 'round-robin' | 'random' | 'smart';
    rotateEveryN: number; // Requests per IP
  };
  authentication?: {
    username: string;
    password: string;
  };
}
```

**Go Implementation:**

```go
func (c *Crawler) setupProxy(config ProxyConfig) {
    proxyIndex := 0
    proxies := config.Endpoints

    c.collector.OnRequest(func(r *colly.Request) {
        // Rotate proxy
        proxy := proxies[proxyIndex % len(proxies)]
        r.ProxyURL = proxy
        proxyIndex++
    })
}
```

---

## 3. Anti-Bot Problems

### 3.1 Bot Detection Mechanisms

#### Problem: Sites Actively Block Crawlers

**Detection Methods:**

1. **User-Agent checks**: Block known crawler UAs
2. **JavaScript challenges**: Cloudflare, Imperva
3. **Browser fingerprinting**: Canvas, WebGL, fonts
4. **Behavioral analysis**: Mouse movements, timing
5. **CAPTCHA**: reCAPTCHA, hCaptcha
6. **TLS fingerprinting**: Detect headless browsers
7. **HTTP/2 fingerprinting**: Request patterns
8. **IP reputation**: Block datacenter IPs

**Challenge Examples:**

**Cloudflare Challenge:**

```html
<!-- Browser sees this for 5 seconds -->
<script>
  // JavaScript challenge
  // Solves crypto puzzle before allowing access
</script>
```

**reCAPTCHA:**

```html
<!-- User must solve CAPTCHA -->
<div class="g-recaptcha" data-sitekey="..."></div>
```

**Fingerprinting:**

```javascript
// Site checks:
- navigator.webdriver === true (headless browser)
- window.chrome === undefined (detection)
- Canvas fingerprint (unique per browser)
- WebGL fingerprint
- Plugin list mismatch
```

---

### 3.2 Evasion Strategies

#### Strategy 1: Realistic User-Agent

```go
// Bad: Obvious bot
User-Agent: Go-http-client/1.1

// Good: Real browser
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
```

**Rotate User-Agents:**

```go
var userAgents = []string{
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0",
}

c.OnRequest(func(r *colly.Request) {
    r.Headers.Set("User-Agent", randomChoice(userAgents))
})
```

#### Strategy 2: Full Browser Emulation (Playwright/Puppeteer)

```typescript
// Use real Chrome browser (harder to detect)
const browser = await playwright.chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
});

// Patch detection
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});
```

#### Strategy 3: Stealth Plugins

```typescript
// puppeteer-extra with stealth plugin
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

// Evades most detection
const browser = await puppeteer.launch();
```

#### Strategy 4: Human-Like Behavior

```go
// Random delays between requests
delay := time.Duration(rand.Intn(3000) + 1000) * time.Millisecond
time.Sleep(delay)

// Random mouse movements (if using browser)
await page.mouse.move(
    Math.random() * 800,
    Math.random() * 600,
    { steps: 10 }
);

// Scroll like a human
await page.evaluate(() => {
    window.scrollBy(0, Math.random() * 500);
});
```

---

### 3.3 CAPTCHA Handling

#### Problem: Site Requires CAPTCHA Solving

**Options:**

**1. Avoid CAPTCHA (Best)**

- Use authenticated APIs instead (SharePoint API vs scraping)
- Crawl slower (don't trigger rate limits)
- Use residential proxies

**2. CAPTCHA Solving Services**

- **2Captcha**: Human solvers, $1-3 per 1000 CAPTCHAs
- **Anti-Captcha**: Similar pricing
- **CapMonster**: Cheaper, automated

```typescript
import { TwoCaptcha } from '2captcha';

const solver = new TwoCaptcha(API_KEY);

async function solveCaptcha(siteKey: string, pageUrl: string) {
  const result = await solver.recaptcha({
    sitekey: siteKey,
    pageurl: pageUrl,
  });
  return result.data; // Token to submit
}
```

**3. Manual Intervention**

- Pause crawler
- Notify user to solve CAPTCHA
- Resume after solved

---

## 4. Content Rendering Problems

### 4.1 JavaScript Rendering Detection

#### Problem: Content Not in Static HTML

**How to Detect:**

**Method 1: Compare Content Length**

```typescript
const staticHtml = await fetchStatic(url);
const renderedHtml = await fetchWithBrowser(url);

const staticText = extractText(staticHtml);
const renderedText = extractText(renderedHtml);

if (renderedText.length > staticText.length * 2) {
  // Significant content added by JS
  return 'js-required';
}
```

**Method 2: Look for SPA Indicators**

```typescript
function isSPA(html: string): boolean {
  // Check for SPA frameworks
  const indicators = [
    'react',
    'vue',
    'angular',
    'ember',
    '<div id="root">',
    '<div id="app">',
    'ng-app',
    'data-reactroot',
  ];

  const lowerHtml = html.toLowerCase();
  return indicators.some((indicator) => lowerHtml.includes(indicator));
}
```

**Method 3: Check for Empty Shells**

```typescript
function hasMinimalContent(html: string): boolean {
  const bodyText = extractTextFromTag(html, 'body');
  const wordCount = bodyText.split(/\s+/).length;

  // If body has < 50 words, likely SPA shell
  return wordCount < 50;
}
```

---

### 4.2 Rendering Strategy Selection

#### Decision Matrix

```
┌─────────────────────────────────────────────────────────┐
│ URL: https://example.com                                │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
         Fetch Static HTML
                 │
                 ▼
       ┌─────────────────┐
       │ Extract text    │
       │ Count words     │
       └────────┬────────┘
                │
        ┌───────┴───────┐
        │               │
    < 50 words      > 50 words
        │               │
        ▼               ▼
   [JS Required]   [Static OK]
        │               │
        │               └──> Use static HTML (fast)
        │
        ▼
   Try with Browser
        │
        ▼
   Compare results
        │
    ┌───┴────┐
    │        │
  Better   Same
    │        │
    ▼        ▼
  Use     Use static
 Browser   (save $)
```

**Implementation:**

```go
func (c *Crawler) smartFetch(url string) (string, error) {
    // 1. Try static first (fast)
    staticHTML, err := c.fetchStatic(url)
    if err != nil {
        return "", err
    }

    // 2. Check if content is sufficient
    staticWords := countWords(staticHTML)
    if staticWords > 100 {
        // Likely sufficient, use static
        return staticHTML, nil
    }

    // 3. Try with browser (slow)
    browserHTML, err := c.fetchWithBrowser(url)
    if err != nil {
        // Fallback to static
        return staticHTML, nil
    }

    // 4. Compare
    browserWords := countWords(browserHTML)
    if browserWords > staticWords * 2 {
        // Browser found significantly more content
        c.markAsJSRequired(extractDomain(url))
        return browserHTML, nil
    }

    return staticHTML, nil
}
```

---

### 4.3 Browser Selection

#### When to Use What?

**Static HTTP (Go net/http, Python requests):**

- ✅ Fastest (10-50ms per page)
- ✅ Lowest memory
- ✅ Highest concurrency (1000+)
- ❌ No JS execution
- **Use for**: Static sites, APIs, known non-SPA sites

**Headless Browser (Playwright, Puppeteer):**

- ✅ Full JS execution
- ✅ Handles SPAs perfectly
- ✅ Can interact (click, scroll, wait)
- ❌ Slow (1-5s per page)
- ❌ High memory (~50MB per browser instance)
- ❌ Limited concurrency (10-50)
- **Use for**: SPAs, JS-heavy sites, sites requiring interaction

**Hybrid (Go + rod library):**

```go
import "github.com/go-rod/rod"

browser := rod.New().MustConnect()
defer browser.MustClose()

page := browser.MustPage(url)
page.MustWaitLoad()
html := page.MustHTML()
```

- ✅ Go performance + browser rendering
- ✅ Better than Node.js browser automation
- ⚠️ Still slow compared to static

---

## 5. Architecture Detection Problems

### 5.1 Site Architecture Types

#### Type 1: Static HTML (Traditional)

**Characteristics:**

- Server renders full HTML
- Links in `<a href>`
- Forms with `<form action>`

**Detection:**

```typescript
function isStaticSite(html: string): boolean {
  const hasLinks = /<a\s+href="[^"]+"/i.test(html);
  const hasContent = extractText(html).length > 200;
  const noSPAFrameworks = !isSPA(html);

  return hasLinks && hasContent && noSPAFrameworks;
}
```

**Crawling Strategy:** Static HTTP client (fast)

---

#### Type 2: Server-Side Rendered (SSR)

**Characteristics:**

- React/Vue/Angular but server-rendered
- Full HTML on first load
- May hydrate with JS later

**Examples:** Next.js, Nuxt.js, Angular Universal

**Detection:**

```typescript
function isSSR(html: string): boolean {
  const hasSPAFramework = isSPA(html);
  const hasFullContent = extractText(html).length > 200;
  const hasHydrationMarkers = html.includes('__NEXT_DATA__') || html.includes('__NUXT__');

  return hasSPAFramework && hasFullContent;
}
```

**Crawling Strategy:** Static HTTP client (content is in HTML)

---

#### Type 3: Single Page Application (SPA)

**Characteristics:**

- Empty shell HTML
- All content loaded via JS
- Client-side routing (# or history API)

**Examples:** Create React App, Vue CLI app

**Detection:**

```typescript
function isSPA(html: string): boolean {
  const bodyText = extractTextFromTag(html, 'body');
  const hasMinimalContent = bodyText.split(/\s+/).length < 50;
  const hasSPARoot = /<div id="(root|app)"><\/div>/.test(html);

  return hasMinimalContent && hasSPARoot;
}
```

**Crawling Strategy:** Headless browser required

---

#### Type 4: Hybrid (Progressive Enhancement)

**Characteristics:**

- Works without JS (basic content)
- Enhanced with JS (full experience)

**Detection:**

```typescript
function isHybrid(html: string): boolean {
  const staticContent = extractText(html).length;
  // Need to compare with JS-rendered version
}
```

**Crawling Strategy:** Test both, use static if sufficient

---

#### Type 5: API-Driven (Headless CMS)

**Characteristics:**

- Frontend fetches from REST/GraphQL API
- HTML is minimal shell
- All content via JSON

**Examples:** Contentful, Strapi, Sanity

**Detection:**

```typescript
function isAPIFirst(html: string): boolean {
  // Look for API endpoint patterns in scripts
  const apiPatterns = [
    /fetch\(['"]https?:\/\/[^'"]+\/api\//,
    /axios\.get\(['"]https?:\/\//,
    /graphql/i,
  ];

  return apiPatterns.some((pattern) => pattern.test(html));
}
```

**Optimal Strategy:** Discover and crawl the API directly!

```typescript
// Instead of rendering pages, fetch JSON
const data = await fetch('https://api.site.com/posts');
// Much faster and cleaner
```

---

### 5.2 URL Pattern Detection

#### Problem: Understanding URL Structure

**Patterns to Detect:**

**1. Pagination:**

```
/articles?page=2
/articles/page/2/
/articles?offset=20&limit=10
```

**Detection:**

```typescript
function detectPagination(url: string): PaginationInfo | null {
  // Query param style
  const queryMatch = url.match(/[?&]page=(\d+)/);
  if (queryMatch) {
    return {
      type: 'query',
      current: parseInt(queryMatch[1]),
      pattern: url.replace(/page=\d+/, 'page={N}'),
    };
  }

  // Path style
  const pathMatch = url.match(/\/page\/(\d+)\//);
  if (pathMatch) {
    return {
      type: 'path',
      current: parseInt(pathMatch[1]),
      pattern: url.replace(/\/page\/\d+\//, '/page/{N}/'),
    };
  }

  return null;
}
```

**2. Taxonomy (Categories, Tags):**

```
/blog/category/tech
/products?category=electronics&brand=sony
/articles/tag/javascript
```

**3. Date Archives:**

```
/2024/01/
/posts?year=2024&month=01
```

**4. Dynamic IDs:**

```
/user/12345
/product/SKU-ABC-123
/post/slug-url-here
```

---

## 6. Extraction Problems

### 6.1 Content vs Boilerplate Separation

#### Problem: Extract Main Content, Ignore Nav/Footer/Ads

**Challenges:**

- Navigation menus
- Footers
- Sidebars
- Ads
- Cookie banners
- Social media widgets
- Comments sections (maybe want, maybe don't)

**Approach 1: Readability Algorithms**

```typescript
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(html, { url });
const reader = new Readability(dom.window.document);
const article = reader.parse();

// article.textContent = clean main content
```

**Approach 2: CSS Selectors (Site-Specific)**

```typescript
// User configures per site
const config = {
  contentSelector: 'article, .main-content, #content',
  excludeSelectors: 'nav, footer, .ads, .sidebar',
};

const $ = cheerio.load(html);
$(config.excludeSelectors).remove();
const content = $(config.contentSelector).text();
```

**Approach 3: Machine Learning**

```python
# Train classifier on: content vs boilerplate
from sklearn.ensemble import RandomForestClassifier

# Features: tag name, class names, position, text density
model.predict(element_features)  # 0 = boilerplate, 1 = content
```

---

### 6.2 Structured Data Extraction

#### Problem: Extract Metadata (Title, Author, Date, etc.)

**Sources:**

**1. HTML Meta Tags:**

```html
<meta property="og:title" content="Article Title" />
<meta name="author" content="John Doe" />
<meta property="article:published_time" content="2024-01-15" />
```

**2. JSON-LD (Schema.org):**

```html
<script type="application/ld+json">
  {
    "@type": "Article",
    "headline": "Article Title",
    "author": { "@type": "Person", "name": "John Doe" },
    "datePublished": "2024-01-15"
  }
</script>
```

**3. Microdata:**

```html
<article itemscope itemtype="http://schema.org/Article">
  <h1 itemprop="headline">Article Title</h1>
  <span itemprop="author">John Doe</span>
</article>
```

**Extraction Strategy:**

```typescript
function extractMetadata(html: string): Metadata {
  const $ = cheerio.load(html);

  // Priority 1: JSON-LD
  const jsonLd = $('script[type="application/ld+json"]').text();
  if (jsonLd) {
    const data = JSON.parse(jsonLd);
    return {
      title: data.headline,
      author: data.author?.name,
      date: data.datePublished,
    };
  }

  // Priority 2: Open Graph
  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (ogTitle) {
    return {
      title: ogTitle,
      author: $('meta[name="author"]').attr('content'),
      date: $('meta[property="article:published_time"]').attr('content'),
    };
  }

  // Priority 3: HTML semantics
  return {
    title: $('h1').first().text(),
    author: $('[itemprop="author"]').text(),
    date: $('time').attr('datetime'),
  };
}
```

---

## 7. Scale & Performance Problems

### 7.1 Memory Management

#### Problem: Running Out of Memory

**Causes:**

- 10,000+ pages in memory simultaneously
- Large HTML documents (10MB+)
- Headless browser instances not closed
- Accumulated state (visited URLs set)

**Solutions:**

**1. Streaming/Chunking:**

```go
// Don't store all results in memory
func (c *Crawler) crawlAndStream(url string, handler func(result CrawlResult)) {
    c.collector.OnResponse(func(r *colly.Response) {
        result := CrawlResult{
            URL:  r.Request.URL.String(),
            HTML: string(r.Body),
        }
        handler(result) // Stream to disk/database immediately
    })
}
```

**2. Bounded Queues:**

```go
// Limit in-flight requests
c.collector.Limit(&colly.LimitRule{
    Parallelism: 100, // Max 100 concurrent
})
```

**3. Disk-Based Queues:**

```go
// Use Redis/database for URL queue instead of in-memory
type DiskQueue struct {
    redis *redis.Client
}

func (q *DiskQueue) Enqueue(url string) {
    q.redis.RPush("crawl:queue", url)
}
```

---

### 7.2 Rate Limiting (Politeness)

#### Problem: Overwhelming Target Server

**Consequences:**

- IP banned
- CAPTCHA
- Degraded site performance for real users
- Legal issues

**Solution: Multi-Level Rate Limiting**

**Level 1: Per-Domain Rate Limit**

```go
c.Limit(&colly.LimitRule{
    DomainGlob:  "*example.com",
    Parallelism: 5,           // Max 5 concurrent requests
    Delay:       2 * time.Second, // 2s between requests
})
```

**Level 2: Respect robots.txt Crawl-Delay**

```go
func (c *Crawler) parseRobotsTxt(url string) {
    robots := c.fetchRobotsTxt(url)
    crawlDelay := extractCrawlDelay(robots) // e.g., "Crawl-delay: 5"

    c.Limit(&colly.LimitRule{
        DomainGlob: extractDomain(url),
        Delay:      time.Duration(crawlDelay) * time.Second,
    })
}
```

**Level 3: Adaptive Rate Limiting**

```go
func (c *Crawler) adaptiveRateLimit() {
    errorCount := 0

    c.collector.OnError(func(r *colly.Response, err error) {
        if r.StatusCode == 429 { // Too Many Requests
            errorCount++
            if errorCount > 3 {
                // Slow down
                c.increaseDelay(2.0) // 2x delay
            }
        }
    })

    c.collector.OnResponse(func(r *colly.Response) {
        if r.StatusCode == 200 {
            errorCount = 0 // Reset on success
        }
    })
}
```

---

## 8. Reliability Problems

### 8.1 Failure Handling

#### Problem: Network Errors, Timeouts, 404s

**Failure Types:**

1. **Network errors**: DNS, connection refused, timeout
2. **HTTP errors**: 404, 403, 500, 503
3. **Content errors**: Invalid HTML, encoding issues
4. **Rate limit errors**: 429 Too Many Requests

**Retry Strategy:**

```go
type RetryConfig struct {
    MaxRetries     int
    BackoffFactor  float64
    RetryableStatusCodes []int
}

func (c *Crawler) setupRetry(config RetryConfig) {
    attemptMap := make(map[string]int)

    c.collector.OnError(func(r *colly.Response, err error) {
        url := r.Request.URL.String()
        attempts := attemptMap[url]

        // Check if retryable
        if !isRetryable(r.StatusCode, err) {
            return // Don't retry
        }

        if attempts < config.MaxRetries {
            // Exponential backoff
            delay := time.Duration(
                math.Pow(config.BackoffFactor, float64(attempts)),
            ) * time.Second

            time.Sleep(delay)
            attemptMap[url]++
            r.Request.Retry()
        } else {
            // Max retries reached, log and skip
            logFailedURL(url, err)
        }
    })
}

func isRetryable(statusCode int, err error) bool {
    // Retry on network errors
    if err != nil {
        return true
    }

    // Retry on server errors (5xx)
    if statusCode >= 500 && statusCode < 600 {
        return true
    }

    // Retry on rate limit
    if statusCode == 429 {
        return true
    }

    // Don't retry on 4xx (client errors)
    return false
}
```

---

### 8.2 Duplicate Detection

#### Problem: Crawling Same URL Multiple Times

**Causes:**

- Multiple links to same page
- Query parameters (e.g., `?utm_source=X`)
- URL fragments (e.g., `#section`)
- Trailing slashes (e.g., `/page` vs `/page/`)
- Protocol differences (http vs https)

**Normalization:**

```go
func normalizeURL(rawURL string) string {
    u, _ := url.Parse(rawURL)

    // 1. Force HTTPS
    u.Scheme = "https"

    // 2. Remove fragment
    u.Fragment = ""

    // 3. Remove tracking params
    q := u.Query()
    trackingParams := []string{"utm_source", "utm_medium", "fbclid"}
    for _, param := range trackingParams {
        q.Del(param)
    }
    u.RawQuery = q.Encode()

    // 4. Remove trailing slash
    u.Path = strings.TrimSuffix(u.Path, "/")

    // 5. Lowercase domain
    u.Host = strings.ToLower(u.Host)

    return u.String()
}
```

**Bloom Filter (Memory-Efficient):**

```go
import "github.com/bits-and-blooms/bloom/v3"

filter := bloom.NewWithEstimates(1000000, 0.01) // 1M URLs, 1% false positive

func (c *Crawler) hasVisited(url string) bool {
    normalized := normalizeURL(url)
    if filter.Test([]byte(normalized)) {
        return true // Probably visited
    }
    filter.Add([]byte(normalized))
    return false
}
```

---

## 5. Interactive Content Problems

### 5.1 Click-to-Reveal Content

#### Problem: Content Hidden Behind User Interactions

**Scenarios:**

**1. Dropdown Menus:**

```html
<!-- Content only visible after clicking dropdown -->
<select id="category" onchange="loadContent()">
  <option value="tech">Technology</option>
  <option value="business">Business</option>
</select>
<div id="content"></div>
<!-- Populated by JS after selection -->
```

**Static crawler sees:** Empty div
**Need:** Simulate selection of each dropdown option

**2. Click-to-Expand:**

```html
<!-- Accordion/collapsible content -->
<button onclick="expand('section1')">Show More</button>
<div id="section1" style="display:none">Hidden content here</div>
```

**3. Tabs:**

```html
<!-- Tab interface -->
<div class="tabs">
  <button data-tab="tab1" class="active">Tab 1</button>
  <button data-tab="tab2">Tab 2</button>
  <button data-tab="tab3">Tab 3</button>
</div>
<div id="tab1" class="active">Content 1</div>
<div id="tab2" style="display:none">Content 2</div>
<div id="tab3" style="display:none">Content 3</div>
```

**4. Modals/Overlays:**

```html
<button onclick="openModal()">View Details</button>
<div id="modal" style="display:none">
  <p>Detailed information only visible in modal</p>
</div>
```

**5. Hover-Triggered Content:**

```html
<!-- Mega menu, tooltips -->
<div class="nav-item" onmouseover="showSubmenu()">
  Products
  <div class="submenu" style="display:none">
    <a href="/product1">Product 1</a>
    <a href="/product2">Product 2</a>
  </div>
</div>
```

**Detection Strategy:**

```typescript
async function detectInteractiveContent(page: Page): Promise<InteractiveElement[]> {
  const interactive = [];

  // 1. Find dropdowns
  const selects = await page.$$('select');
  for (const select of selects) {
    const options = await select.$$eval('option', (opts) => opts.map((o) => o.value));
    interactive.push({ type: 'select', element: select, options });
  }

  // 2. Find expandable sections
  const expandButtons = await page.$$('[onclick*="expand"], [data-toggle="collapse"]');
  interactive.push(...expandButtons.map((btn) => ({ type: 'expand', element: btn })));

  // 3. Find tabs
  const tabs = await page.$$('[data-tab], [role="tab"]');
  interactive.push(...tabs.map((tab) => ({ type: 'tab', element: tab })));

  // 4. Find modal triggers
  const modalTriggers = await page.$$('[data-toggle="modal"], [onclick*="Modal"]');
  interactive.push(...modalTriggers.map((t) => ({ type: 'modal', element: t })));

  return interactive;
}
```

**Crawling Strategy:**

```typescript
async function crawlInteractiveContent(page: Page, url: string) {
  await page.goto(url);

  const interactive = await detectInteractiveContent(page);
  const contentVariants = [];

  for (const elem of interactive) {
    switch (elem.type) {
      case 'select':
        // Try each dropdown option
        for (const option of elem.options) {
          await elem.element.selectOption(option);
          await page.waitForTimeout(500); // Let content load
          const content = await page.content();
          contentVariants.push({ trigger: `select:${option}`, html: content });
        }
        break;

      case 'expand':
      case 'tab':
      case 'modal':
        // Click to reveal
        await elem.element.click();
        await page.waitForTimeout(500);
        const content = await page.content();
        contentVariants.push({ trigger: elem.type, html: content });
        break;
    }
  }

  return contentVariants;
}
```

**Challenges:**

- **State explosion**: N dropdowns with M options = M^N combinations
- **Timing**: Need to wait for content to load after interaction
- **Cleanup**: Need to reset state between interactions
- **Performance**: Very slow (each interaction = page load time)

**Optimization:**

```typescript
// Heuristic: Only interact with navigation-related elements
function isNavigationElement(elem: Element): boolean {
  const navKeywords = ['menu', 'nav', 'category', 'filter', 'tab'];
  const classes = elem.className.toLowerCase();
  const id = elem.id.toLowerCase();

  return navKeywords.some((kw) => classes.includes(kw) || id.includes(kw));
}
```

---

### 5.2 Progressive Disclosure Patterns

#### Problem: Content Revealed in Stages

**Patterns:**

**1. Accordion Menus:**

```
[+] Section 1
[+] Section 2
[+] Section 3

User clicks → [-] Section 1
               Content here...
             [+] Section 2
             [+] Section 3
```

**2. Nested Dropdowns:**

```
Category → Subcategory → Product
                       → Product
         → Subcategory → Product
```

**3. Wizard/Multi-Step:**

```
Step 1: Select category
  ↓ (reveals Step 2)
Step 2: Select filters
  ↓ (reveals Step 3)
Step 3: View results
```

**Strategy:**

```typescript
async function crawlNestedInteractions(page: Page, maxDepth: number = 3) {
  async function recurse(depth: number, path: string[]) {
    if (depth > maxDepth) return;

    const interactive = await detectInteractiveContent(page);

    for (const elem of interactive) {
      // Interact
      await elem.element.click();
      await page.waitForNetworkIdle();

      // Capture state
      const content = await page.content();
      yield { path: [...path, elem.type], content };

      // Recurse into newly revealed content
      yield* recurse(depth + 1, [...path, elem.type]);

      // Reset (go back or reload)
      await page.goBack();
    }
  }

  yield* recurse(0, []);
}
```

---

## 6. Dynamic Loading Problems

### 6.1 Infinite Scroll

#### Problem: Content Loads as User Scrolls

**Characteristics:**

- No "next page" button
- New content appears at bottom as scroll reaches end
- Common on social media, image galleries, product listings

**Detection:**

```typescript
async function detectInfiniteScroll(page: Page): Promise<boolean> {
  const initialHeight = await page.evaluate(() => document.body.scrollHeight);

  // Scroll to bottom
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000); // Wait for potential load

  const newHeight = await page.evaluate(() => document.body.scrollHeight);

  // If height increased, infinite scroll detected
  return newHeight > initialHeight;
}
```

**Crawling Strategy:**

```typescript
async function crawlInfiniteScroll(page: Page, maxScrolls: number = 50) {
  let scrollCount = 0;
  let previousHeight = 0;
  const contentSnapshots = [];

  while (scrollCount < maxScrolls) {
    // Get current height
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

    if (currentHeight === previousHeight) {
      // No new content loaded, reached end
      break;
    }

    // Capture current content
    const content = await page.content();
    contentSnapshots.push(content);

    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // Wait for new content to load
    await page.waitForTimeout(1000);

    // Alternative: Wait for network idle
    // await page.waitForLoadState('networkidle');

    previousHeight = currentHeight;
    scrollCount++;
  }

  return contentSnapshots;
}
```

**Challenges:**

- **Performance**: Very slow (wait after each scroll)
- **Detection of end**: How to know when to stop?
- **Memory**: Accumulating content in memory
- **Duplicate content**: Same items may appear in multiple snapshots

**Optimization: Incremental Extraction**

```typescript
async function crawlInfiniteScrollIncremental(page: Page) {
  let previousItemCount = 0;
  const seenUrls = new Set<string>();

  while (true) {
    // Extract items incrementally
    const items = await page.$$eval('.item', (items) =>
      items.map((item) => ({
        url: item.querySelector('a')?.href,
        title: item.querySelector('.title')?.textContent,
      })),
    );

    // Extract only new items
    const newItems = items.filter((item) => !seenUrls.has(item.url));

    if (newItems.length === 0) {
      // No new items, reached end
      break;
    }

    // Process new items immediately (don't accumulate)
    for (const item of newItems) {
      seenUrls.add(item.url);
      yield item; // Stream to processor
    }

    // Scroll for more
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
  }
}
```

---

### 6.2 "Load More" Buttons

#### Problem: Pagination via Button Clicks

**Pattern:**

```html
<div class="items">
  <!-- First 10 items -->
</div>
<button id="load-more" onclick="loadMore()">Load More</button>
```

**Crawling Strategy:**

```typescript
async function crawlLoadMore(page: Page, maxClicks: number = 50) {
  let clickCount = 0;

  while (clickCount < maxClicks) {
    // Find "Load More" button
    const loadMoreButton = await page.$(
      'button:has-text("Load More"), button:has-text("Show More"), .load-more',
    );

    if (!loadMoreButton) {
      // No button found, reached end
      break;
    }

    // Check if button is disabled/hidden
    const isVisible = await loadMoreButton.isVisible();
    if (!isVisible) break;

    // Click button
    await loadMoreButton.click();

    // Wait for new content
    await page.waitForTimeout(1000);

    clickCount++;
  }

  // Extract all content at once
  return await page.content();
}
```

---

### 6.3 AJAX Pagination

#### Problem: Pagination via API Calls (No Page Reload)

**Pattern:**

```javascript
// Page 1 loads initially
// User clicks "Next" → AJAX call → Updates div
fetch('/api/products?page=2')
  .then((res) => res.json())
  .then((data) => {
    document.getElementById('results').innerHTML = renderProducts(data);
  });
```

**Detection:**

```typescript
async function detectAJAXPagination(page: Page): Promise<string[]> {
  const apiEndpoints = [];

  // Monitor network requests
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/') || url.includes('page=') || url.includes('offset=')) {
      apiEndpoints.push(url);
    }
  });

  // Trigger pagination (click next button)
  const nextButton = await page.$('a:has-text("Next"), button:has-text("Next")');
  if (nextButton) {
    await nextButton.click();
    await page.waitForTimeout(1000);
  }

  return apiEndpoints;
}
```

**Optimal Strategy: Crawl API Directly**

```typescript
async function crawlAPI(apiEndpoint: string, maxPages: number = 100) {
  const results = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${apiEndpoint}?page=${page}`;
    const response = await fetch(url);

    if (!response.ok) break;

    const data = await response.json();

    if (data.items.length === 0) break; // No more data

    results.push(...data.items);
  }

  return results;
}
```

**Benefits:**

- ✅ 10-100x faster than browser automation
- ✅ Cleaner data (JSON vs HTML parsing)
- ✅ Lower resource usage

---

### 6.4 Virtual Scrolling

#### Problem: Only Visible Items Rendered (Performance Optimization)

**Pattern:**

```
Large list (10,000 items)
  ↓
Only render 20 visible items
  ↓
As user scrolls, render next 20, unrender previous 20
```

**Example:**

```html
<!-- Virtual scroll library like react-window -->
<div style="height: 500px; overflow: auto">
  <!-- Only items 50-70 are in DOM -->
  <div data-index="50">Item 50</div>
  <div data-index="51">Item 51</div>
  ...
  <div data-index="70">Item 70</div>
</div>
```

**Challenge:**

- Content not in DOM until scrolled into view
- Need to scroll through entire list to capture all items

**Strategy:**

```typescript
async function crawlVirtualScroll(page: Page) {
  const items = [];
  let previousItemCount = 0;

  while (true) {
    // Extract currently visible items
    const visibleItems = await page.$$eval('[data-index]', (items) =>
      items.map((item) => ({
        index: item.dataset.index,
        content: item.textContent,
      })),
    );

    items.push(...visibleItems);

    // Scroll down by viewport height
    await page.evaluate(() => {
      const container = document.querySelector('.virtual-scroll-container');
      container.scrollTop += container.clientHeight;
    });

    await page.waitForTimeout(100); // Wait for render

    // Check if we've reached the end
    const currentItemCount = (await page.$$('[data-index]')).length;
    if (currentItemCount === previousItemCount) {
      break; // No new items rendered
    }

    previousItemCount = currentItemCount;
  }

  // Deduplicate by index
  return Array.from(new Map(items.map((item) => [item.index, item])).values());
}
```

---

## 7. URL & Path Complexity

### 7.1 Relative URL Resolution

#### Problem: Links Specified Relative to Current Page

**URL Types:**

**1. Absolute URL:**

```html
<a href="https://example.com/page">Link</a>
<!-- ✅ Clear, no ambiguity -->
```

**2. Root-Relative URL:**

```html
<a href="/products/item1">Link</a>
<!-- Resolves to: https://example.com/products/item1 -->
```

**3. Path-Relative URL:**

```html
<!-- Current page: https://example.com/blog/2024/post1 -->
<a href="post2">Link</a>
<!-- Resolves to: https://example.com/blog/2024/post2 -->
```

**4. Parent-Relative URL:**

```html
<!-- Current page: https://example.com/blog/2024/01/post1 -->
<a href="../02/post2">Link</a>
<!-- Resolves to: https://example.com/blog/2024/02/post2 -->

<a href="../../2023/post3">Link</a>
<!-- Resolves to: https://example.com/blog/2023/post3 -->
```

**5. Protocol-Relative URL:**

```html
<a href="//cdn.example.com/image.jpg">Link</a>
<!-- Resolves to: https://cdn.example.com/image.jpg (if current page is HTTPS) -->
```

**Resolution Algorithm:**

```go
func resolveURL(baseURL, relativeURL string) (string, error) {
    base, err := url.Parse(baseURL)
    if err != nil {
        return "", err
    }

    rel, err := url.Parse(relativeURL)
    if err != nil {
        return "", err
    }

    // Resolve relative to base
    resolved := base.ResolveReference(rel)
    return resolved.String(), nil
}

// Examples:
resolveURL("https://example.com/blog/2024/post1", "post2")
// → https://example.com/blog/2024/post2

resolveURL("https://example.com/blog/2024/01/post1", "../02/post2")
// → https://example.com/blog/2024/02/post2

resolveURL("https://example.com/page", "//cdn.example.com/img.jpg")
// → https://cdn.example.com/img.jpg
```

---

### 7.2 Base URL Tag

#### Problem: HTML <base> Tag Changes URL Resolution

**Pattern:**

```html
<html>
  <head>
    <base href="https://example.com/prefix/" />
  </head>
  <body>
    <a href="page1">Link</a>
    <!-- Resolves to: https://example.com/prefix/page1 (not relative to current page!) -->
  </body>
</html>
```

**Crawler Must:**

1. Parse `<base>` tag first
2. Use base URL for all relative links on page

**Implementation:**

```typescript
async function extractLinks(page: Page): Promise<string[]> {
  // 1. Get base URL (if exists)
  const baseHref = await page.$eval('base[href]', (base) => base.href).catch(() => page.url()); // Fallback to page URL

  // 2. Extract all links
  const relativeLinks = await page.$$eval('a[href]', (links) =>
    links.map((link) => link.getAttribute('href')),
  );

  // 3. Resolve relative to base
  const absoluteLinks = relativeLinks.map((link) => {
    const url = new URL(link, baseHref);
    return url.href;
  });

  return absoluteLinks;
}
```

---

### 7.3 URL Encoding & Special Characters

#### Problem: URLs with Spaces, Unicode, Special Characters

**Examples:**

```
Original:        /search?q=hello world
URL-encoded:     /search?q=hello%20world

Original:        /路径/文件
URL-encoded:     /%E8%B7%AF%E5%BE%84/%E6%96%87%E4%BB%B6

Original:        /page?filter=a&b
URL-encoded:     /page?filter=a%26b

Original:        /search?q=50%off
URL-encoded:     /search?q=50%25off
```

**Challenges:**

1. **Double encoding**: `/page%252Ftest` (encoded twice)
2. **Mixed encoding**: `/encoded%20/notencoded /mixed`
3. **Query param encoding**: `?key=value&other=a+b` (+ vs %20)

**Normalization:**

```go
func normalizeURL(rawURL string) (string, error) {
    u, err := url.Parse(rawURL)
    if err != nil {
        return "", err
    }

    // 1. Decode path
    decodedPath, _ := url.PathUnescape(u.Path)

    // 2. Re-encode properly
    u.Path = url.PathEscape(decodedPath)

    // 3. Normalize query params
    q := u.Query()
    u.RawQuery = q.Encode() // Proper encoding

    return u.String(), nil
}
```

---

### 7.4 International Domain Names (IDN)

#### Problem: Non-ASCII Domain Names

**Examples:**

```
Original:     http://münchen.de
Punycode:     http://xn--mnchen-3ya.de

Original:     http://中国.cn
Punycode:     http://xn--fiqs8s.cn
```

**Handling:**

```go
import "golang.org/x/net/idna"

func normalizeIDN(domain string) string {
    // Convert to Punycode
    ascii, err := idna.ToASCII(domain)
    if err != nil {
        return domain // Return original if conversion fails
    }
    return ascii
}

// Example:
normalizeIDN("münchen.de") // → "xn--mnchen-3ya.de"
```

---

### 7.5 Fragment Identifiers & Hash Routing

#### Problem: # in URLs with Different Meanings

**Case 1: Traditional Fragments (Anchor Links)**

```html
<a href="#section2">Jump to Section 2</a>
<!-- Same page, different section -->
<!-- Should NOT crawl as separate URL -->
```

**Case 2: Hash-Based Routing (Old SPAs)**

```html
<!-- Angular 1.x, old apps -->
https://example.com/#!/products https://example.com/#!/products/123 https://example.com/#!/about

<!-- Each is a different "page" -->
<!-- SHOULD crawl as separate URLs -->
```

**Detection:**

```typescript
function isHashRoute(url: string): boolean {
  const hashPart = new URL(url).hash;

  // Hash routing patterns
  const hashRoutePatterns = [
    /^#!\//, // #!/path
    /^#\//, // #/path
    /^#[^#]+\//, // #something/path
  ];

  return hashRoutePatterns.some((pattern) => pattern.test(hashPart));
}

// Examples:
isHashRoute('https://example.com/#/products'); // true
isHashRoute('https://example.com/#!/products'); // true
isHashRoute('https://example.com/#section2'); // false
```

**Strategy:**

```typescript
async function crawlHashRoutes(page: Page, baseUrl: string) {
  // Extract hash routes from JS
  const hashRoutes = await page.evaluate(() => {
    const routes = [];
    // Look for route definitions in JS
    // Angular: .when('#/path', ...)
    // Simple detection: find all #! or #/ in onclick handlers
    document.querySelectorAll('[onclick], [href*="#/"], [href*="#!/"]').forEach(el => {
      const href = el.getAttribute('href') || el.getAttribute('onclick');
      if (href && (href.includes('#/') || href.includes('#!/'))) {
        routes.push(href);
      }
    });
    return routes;
  });

  // Crawl each hash route
  for (const route of hashRoutes) {
    const fullUrl = baseUrl + route;
    await page.goto(fullUrl);
    await page.waitForLoadState('networkidle');
    const content = await page.content();
    yield { url: fullUrl, content };
  }
}
```

---

### 7.6 Data URLs & JavaScript URLs

#### Problem: Non-HTTP URL Schemes

**Examples:**

**Data URLs:**

```html
<a href="data:text/html,<h1>Hello</h1>">Link</a>
<!-- Should NOT follow (embedded content) -->
```

**JavaScript URLs:**

```html
<a href="javascript:void(0)" onclick="loadPage()">Link</a>
<!-- Should NOT follow (not a real URL) -->
```

**Other Schemes:**

```html
<a href="mailto:contact@example.com">Email</a>
<a href="tel:+1234567890">Phone</a>
<a href="ftp://files.example.com/file.zip">FTP</a>
```

**Filtering:**

```typescript
function isValidCrawlURL(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only HTTP(S)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    // Exclude data/javascript URLs
    if (url.startsWith('data:') || url.startsWith('javascript:')) {
      return false;
    }

    return true;
  } catch {
    return false; // Invalid URL
  }
}
```

---

## 20. Comprehensive Problem-Solution Matrix

| #      | Problem Category           | Specific Challenges                                         | Solution Approaches                                                   | Complexity |
| ------ | -------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| **1**  | **Discovery**              | No sitemap, incomplete robots.txt                           | Multi-location sitemap check, BFS/DFS crawling                        | Medium     |
| **2**  | **Access Control**         | OAuth, API keys, sessions, proxies, VPNs                    | Auth middleware, proxy rotation, credential management                | High       |
| **3**  | **Anti-Bot**               | User-Agent blocking, JS challenges, fingerprinting, CAPTCHA | Stealth browser, residential proxies, CAPTCHA services                | Very High  |
| **4**  | **Content Rendering**      | Static vs JS-rendered, SPA detection                        | Smart detection (compare static vs browser), adaptive switching       | High       |
| **5**  | **Interactive Content**    | Dropdowns, tabs, modals, hover menus, accordions            | Browser automation, simulate clicks/selections, state management      | Very High  |
| **6**  | **Dynamic Loading**        | Infinite scroll, load more, AJAX pagination, virtual scroll | Scroll simulation, button clicking, API discovery                     | High       |
| **7**  | **URL Complexity**         | Relative paths, ../ navigation, base tags, encoding, IDN    | URL resolution algorithms, normalization, Punycode                    | Medium     |
| **8**  | **Architecture Detection** | Static, SSR, SPA, API-driven, hybrid sites                  | Pattern detection, framework fingerprinting, smart routing            | High       |
| **9**  | **Navigation & Routing**   | Client-side routing, hash routes, subdomains, cross-domain  | SPA route extraction, domain scope configuration                      | Medium     |
| **10** | **Extraction**             | Content vs boilerplate, metadata extraction                 | Readability algorithms, CSS selectors, structured data parsing        | Medium     |
| **11** | **Media & Assets**         | Lazy-loaded images, iframes, embedded PDFs, videos          | Scroll-based loading, iframe context switching, PDF parsing           | Medium     |
| **12** | **Forms & Input**          | Search forms, filters, faceted search, multi-step forms     | Autocomplete extraction, combinatorial optimization, API discovery    | High       |
| **13** | **Content Variants**       | Mobile/desktop, AMP, print versions                         | Multi-UA crawling, canonical detection, version comparison            | Medium     |
| **14** | **Encoding & Format**      | Character encoding, malformed HTML, XML vs HTML             | Encoding detection, lenient parsing, auto-fixing                      | Medium     |
| **15** | **Temporal & Session**     | Time-based, geographic, A/B testing, cookie consent         | Time mocking, geo-proxies, banner dismissal                           | High       |
| **16** | **Security & Privacy**     | SSL errors, CSP, CORS, mixed content, cookie flags          | Certificate handling, header manipulation, cookie management          | Medium     |
| **17** | **Redirects & Status**     | Redirect chains, soft 404s, status inconsistencies          | Redirect following with limits, soft 404 detection                    | Low        |
| **18** | **Duplicates**             | Same content at different URLs, canonical tags              | URL normalization, canonical tag parsing, content hashing             | Medium     |
| **19** | **Multilingual**           | Multiple languages, hreflang tags, language detection       | hreflang parsing, Accept-Language headers, multi-version crawling     | Medium     |
| **20** | **Scale & Performance**    | Memory limits, rate limiting, concurrency                   | Streaming, bounded queues, adaptive rate limiting, disk-based storage | High       |
| **21** | **Reliability**            | Network errors, timeouts, failures, duplicate detection     | Retry with backoff, error classification, Bloom filters               | Medium     |

---

## 21. Problem Frequency & Impact Analysis

### High-Frequency Problems (Will Encounter on Most Sites)

1. ✅ **URL Complexity** - Relative paths, query params (95% of sites)
2. ✅ **Content Extraction** - Separating content from boilerplate (90% of sites)
3. ✅ **Rate Limiting** - Need politeness for all crawling (100% of sites)
4. ✅ **Duplicates** - Same content at different URLs (80% of sites)
5. ✅ **Redirects** - 301/302 redirects (70% of sites)
6. ✅ **Character Encoding** - Various encodings (60% of sites)

### Medium-Frequency Problems (Common but Not Universal)

7. ⚠️ **JavaScript Rendering** - SPAs, dynamic content (40-50% of modern sites)
8. ⚠️ **Lazy Loading** - Images, infinite scroll (40% of sites)
9. ⚠️ **Interactive Content** - Dropdowns, tabs (30% of sites)
10. ⚠️ **Mobile/Desktop Variants** - Responsive or separate (50% of sites)
11. ⚠️ **Cookie Banners** - GDPR compliance (70% of EU sites, 30% US sites)

### Low-Frequency But High-Impact Problems

12. 🔴 **Anti-Bot Detection** - Cloudflare, bot blockers (20% of sites, but critical)
13. 🔴 **CAPTCHA** - Aggressive anti-scraping (5-10% of sites)
14. 🔴 **Authentication** - Login-required content (varies by use case)
15. 🔴 **Geographic Restrictions** - IP-based blocking (10% of sites)
16. 🔴 **Time-Based Content** - Flash sales, limited offers (5% of sites)

### Rare But Must Handle

17. ⭐ **Multi-Step Forms** - Complex interactions (5% of sites)
18. ⭐ **Virtual Scrolling** - Performance optimization (2% of sites)
19. ⭐ **Soft 404s** - Misleading status codes (10% of sites)
20. ⭐ **Malformed HTML** - Broken markup (15% of sites)

---

## 22. Framework Requirements Matrix

Based on all problems, what must a crawler framework support?

| Requirement                | Priority        | Why Critical                   |
| -------------------------- | --------------- | ------------------------------ |
| **URL Resolution**         | 🔴 Must Have    | Every site has relative links  |
| **Concurrency Control**    | 🔴 Must Have    | Scale + politeness             |
| **Retry Logic**            | 🔴 Must Have    | Network is unreliable          |
| **Duplicate Detection**    | 🔴 Must Have    | Avoid re-crawling              |
| **Static HTTP**            | 🔴 Must Have    | Baseline for all crawling      |
| **Headless Browser**       | 🔴 Must Have    | 40-50% of modern sites need it |
| **Proxy Support**          | 🔴 Must Have    | Anti-bot evasion               |
| **Cookie Management**      | 🔴 Must Have    | Sessions, banners              |
| **Encoding Detection**     | 🔴 Must Have    | International sites            |
| **Redirect Handling**      | 🔴 Must Have    | Common pattern                 |
| **Rate Limiting**          | 🔴 Must Have    | Politeness                     |
| **robots.txt Parsing**     | 🔴 Must Have    | Politeness                     |
| **Sitemap Parsing**        | 🔴 Must Have    | Efficient discovery            |
| **Interactive Simulation** | 🟢 Nice to Have | Advanced scenarios             |
| **API Discovery**          | 🟢 Nice to Have | Optimization                   |
| **CAPTCHA Solving**        | 🟢 Nice to Have | Rare but valuable              |

---

## 9. Navigation & Routing Problems

### 9.1 Client-Side Routing (SPA History API)

#### Problem: URL Changes Without Page Reload

**Pattern (React Router, Vue Router):**

```javascript
// User clicks link
<Link to="/products">Products</Link>

// No page reload, but URL changes
// https://example.com/products
```

**Challenge:**

- Browser's navigation events don't fire
- `page.goto()` may not work (page already loaded)
- Need to detect and handle client-side navigation

**Detection:**

```typescript
async function detectClientSideRouting(page: Page): Promise<boolean> {
  const hasRouterLibrary = await page.evaluate(() => {
    return !!(
      window.ReactRouter ||
      window.VueRouter ||
      document.querySelector('[data-react-router]') ||
      document.querySelector('[data-v-router]')
    );
  });

  return hasRouterLibrary;
}
```

**Strategy:**

```typescript
async function crawlSPARoutes(page: Page, baseUrl: string) {
  await page.goto(baseUrl);

  // Extract all route links
  const routeLinks = await page.$$eval('a[href]', links =>
    links
      .map(link => link.getAttribute('href'))
      .filter(href => href && !href.startsWith('http'))
  );

  for (const route of routeLinks) {
    // Click link to trigger client-side routing
    await page.click(`a[href="${route}"]`);
    await page.waitForTimeout(1000); // Wait for transition

    // Capture content
    const content = await page.content();
    yield { url: page.url(), content };

    // Go back
    await page.goBack();
    await page.waitForTimeout(500);
  }
}
```

---

### 9.2 Subdomain & Cross-Domain Navigation

#### Problem: Links Across Different Domains

**Scenarios:**

**1. Subdomain Navigation:**

```
Main site:    https://example.com
Blog:         https://blog.example.com
Docs:         https://docs.example.com
Shop:         https://shop.example.com
```

**Should you follow?**

- Same organization, but different subdomain
- May want to crawl all subdomains
- Or limit to specific subdomain

**2. CDN Links:**

```
Page:  https://example.com/page
Image: https://cdn.example.com/image.jpg
Asset: https://assets.example.com/style.css
```

**Should you follow?**

- Usually no (assets, not pages)

**3. External Links:**

```
Page:     https://example.com/page
External: https://other-site.com/page
```

**Should you follow?**

- Usually no (out of scope)
- Unless crawling related sites

**Configuration:**

```go
type CrawlScope struct {
    AllowSubdomains   bool
    AllowedDomains    []string
    ExcludedDomains   []string
    FollowExternal    bool
    MaxDomainDepth    int // How far from seed domain
}

func shouldFollowLink(currentURL, targetURL string, scope CrawlScope) bool {
    current, _ := url.Parse(currentURL)
    target, _ := url.Parse(targetURL)

    currentDomain := extractDomain(current.Host)
    targetDomain := extractDomain(target.Host)

    // Same domain - always follow
    if currentDomain == targetDomain {
        return true
    }

    // Check if subdomain
    if scope.AllowSubdomains {
        if strings.HasSuffix(target.Host, "." + currentDomain) {
            return true
        }
    }

    // Check whitelist
    if len(scope.AllowedDomains) > 0 {
        for _, allowed := range scope.AllowedDomains {
            if targetDomain == allowed {
                return true
            }
        }
        return false
    }

    // Check external
    return scope.FollowExternal
}
```

---

## 11. Media & Assets Problems

### 11.1 Lazy-Loaded Images

#### Problem: Images Not in Initial HTML

**Patterns:**

**1. Intersection Observer (Modern):**

```html
<img data-src="image.jpg" class="lazy" src="placeholder.jpg" />

<script>
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.src = entry.target.dataset.src;
      }
    });
  });
  document.querySelectorAll('.lazy').forEach((img) => observer.observe(img));
</script>
```

**2. Scroll-Based Loading:**

```html
<img data-src="image.jpg" class="lazy" />

<script>
  window.addEventListener('scroll', () => {
    document.querySelectorAll('.lazy').forEach((img) => {
      if (isInViewport(img)) {
        img.src = img.dataset.src;
      }
    });
  });
</script>
```

**Static Crawler Sees:**

```html
<img src="placeholder.jpg" />
<!-- Real image URL in data-src attribute -->
```

**Extraction Strategy:**

```typescript
async function extractAllImages(page: Page): Promise<string[]> {
  // 1. Scroll to load all lazy images
  await autoScroll(page);

  // 2. Extract final src attributes
  const loadedImages = await page.$$eval('img', (imgs) => imgs.map((img) => img.src));

  // 3. Also extract data-src (in case some didn't load)
  const lazyImages = await page.$$eval('img[data-src]', (imgs) =>
    imgs.map((img) => img.dataset.src),
  );

  return [...loadedImages, ...lazyImages];
}

async function autoScroll(page: Page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve(null);
        }
      }, 100);
    });
  });
}
```

---

### 11.2 Embedded Content (iframes, PDFs, Videos)

#### Problem: Content in Different Contexts

**1. iframes:**

```html
<iframe src="https://external-site.com/widget"></iframe>
<!-- Separate document, needs separate crawl -->
```

**Extraction:**

```typescript
async function extractIframeContent(page: Page): Promise<IframeContent[]> {
  const frames = page.frames();
  const content = [];

  for (const frame of frames) {
    if (frame.url() === 'about:blank') continue;

    const frameContent = await frame.content();
    content.push({
      url: frame.url(),
      html: frameContent,
    });
  }

  return content;
}
```

**2. Embedded PDFs:**

```html
<embed src="document.pdf" type="application/pdf" />
<object data="document.pdf" type="application/pdf"></object>
<iframe src="document.pdf"></iframe>
```

**Extraction:**

```typescript
async function extractEmbeddedPDFs(page: Page): Promise<string[]> {
  const pdfUrls = await page.$$eval(
    'embed[src$=".pdf"], object[data$=".pdf"], iframe[src$=".pdf"]',
    elements => elements.map(el =>
      el.getAttribute('src') || el.getAttribute('data')
    )
  );

  // Download and parse PDFs separately
  for (const pdfUrl of pdfUrls) {
    const pdfBuffer = await downloadPDF(pdfUrl);
    const text = await extractPDFText(pdfBuffer);
    yield { url: pdfUrl, text };
  }
}
```

---

## 12. Form & Input Problems

### 12.1 Search Forms

#### Problem: Content Behind Search Interface

**Pattern:**

```html
<form action="/search" method="GET">
  <input name="q" type="text" placeholder="Search..." />
  <button type="submit">Search</button>
</form>
```

**Challenge:**

- Need to know what search terms to try
- Can't enumerate all possible searches

**Strategies:**

**1. Extract Autocomplete Suggestions:**

```typescript
async function extractSearchSuggestions(page: Page): Promise<string[]> {
  const searchInput = await page.$('input[type="search"], input[name="q"]');

  const suggestions = [];
  const testQueries = ['a', 'b', 'c']; // Try common letters

  for (const query of testQueries) {
    await searchInput.fill(query);
    await page.waitForTimeout(500); // Wait for autocomplete

    const autocompleteSuggestions = await page.$$eval(
      '.autocomplete-suggestion, [role="option"]',
      (options) => options.map((opt) => opt.textContent),
    );

    suggestions.push(...autocompleteSuggestions);
  }

  return suggestions;
}
```

**2. Use Site's Tag Cloud/Categories:**

```typescript
async function extractSearchTerms(page: Page): Promise<string[]> {
  // Look for tag clouds, categories, popular searches
  const terms = await page.$$eval('.tag, .category, .popular-search', (elements) =>
    elements.map((el) => el.textContent),
  );

  return terms;
}
```

---

### 12.2 Filter & Faceted Search

#### Problem: Content Behind Multiple Filters

**Pattern:**

```html
<form>
  <select name="category">
    <option value="electronics">Electronics</option>
    <option value="books">Books</option>
  </select>

  <select name="price">
    <option value="0-50">$0-$50</option>
    <option value="50-100">$50-$100</option>
  </select>

  <input type="checkbox" name="inStock" value="true" /> In Stock
  <button type="submit">Filter</button>
</form>
```

**Challenge:**

- Combinatorial explosion: N filters with M options = M^N combinations
- Example: 5 filters × 10 options each = 100,000 combinations

**Optimization Strategy:**

```typescript
// Don't try all combinations - use heuristics
const importantFilters = {
  category: ['electronics', 'books'], // Try main categories
  price: ['0-50'], // Try one price range
  inStock: [true], // Always in stock
};

// Generate only important combinations
const combinations = generateCombinations(importantFilters);
// Result: 2 × 1 × 1 = 2 combinations (manageable)
```

**Alternative: API Discovery:**

```typescript
// Monitor network requests while interacting with filters
page.on('request', (request) => {
  const url = request.url();
  if (url.includes('/api/products')) {
    console.log('API endpoint:', url);
    // Example: /api/products?category=electronics&price=0-50
  }
});

// Then crawl API directly with filter combinations
```

---

## 13. Content Variants Problems

### 13.1 Mobile vs Desktop Versions

#### Problem: Different Content for Different Devices

**Patterns:**

**1. Responsive (Same HTML):**

```html
<!-- Same HTML, CSS changes layout -->
<div class="content">
  <div class="desktop-only">Desktop content</div>
  <div class="mobile-only" style="display:none">Mobile content</div>
</div>
```

**2. Separate URLs:**

```
Desktop: https://example.com/page
Mobile:  https://m.example.com/page
```

**3. User-Agent Based:**

```
Request with desktop UA → Desktop HTML
Request with mobile UA → Mobile HTML (same URL)
```

**Strategy:**

```typescript
async function crawlBothVersions(url: string) {
  // 1. Desktop version
  const desktopPage = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
  });
  await desktopPage.goto(url);
  const desktopContent = await desktopPage.content();

  // 2. Mobile version
  const mobilePage = await browser.newPage({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Safari/604.1',
  });
  await mobilePage.goto(url);
  const mobileContent = await mobilePage.content();

  // 3. Compare
  if (desktopContent !== mobileContent) {
    return { desktop: desktopContent, mobile: mobileContent };
  } else {
    return { desktop: desktopContent }; // Same content
  }
}
```

---

### 13.2 AMP (Accelerated Mobile Pages)

#### Problem: Separate AMP Versions

**Pattern:**

```html
<!-- Regular page -->
<link rel="amphtml" href="https://example.com/page.amp.html" />

<!-- AMP page -->
<link rel="canonical" href="https://example.com/page.html" />
```

**URLs:**

```
Regular: https://example.com/article
AMP:     https://example.com/article.amp
         https://example.com/amp/article
         https://amp.example.com/article
```

**Strategy:**

```typescript
async function detectAMPVersion(page: Page): Promise<string | null> {
  const ampUrl = await page.$eval('link[rel="amphtml"]', (link) => link.href).catch(() => null);

  return ampUrl;
}

// Decide which version to crawl
const crawlStrategy = 'canonical'; // or 'both' or 'amp-only'

if (crawlStrategy === 'canonical') {
  // Crawl regular version only
} else if (crawlStrategy === 'both') {
  // Crawl both versions
} else {
  // Prefer AMP if available
}
```

---

## 14. Encoding & Format Problems

### 14.1 Character Encoding Detection

#### Problem: Page Doesn't Declare Encoding or Uses Wrong Encoding

**Scenarios:**

**1. Missing Encoding Declaration:**

```html
<html>
  <head>
    <!-- No charset meta tag -->
  </head>
  <body>
    Hêllö Wörld
  </body>
</html>
```

**2. Wrong Encoding:**

```html
<meta charset="ISO-8859-1" />
<!-- But actual content is UTF-8 -->
<body>
  Résumé
</body>
<!-- Displays as: RÃ©sumÃ© -->
```

**Detection:**

```go
import "golang.org/x/net/html/charset"

func detectEncoding(body []byte) (string, error) {
    // 1. Check BOM (Byte Order Mark)
    if bytes.HasPrefix(body, []byte{0xEF, 0xBB, 0xBF}) {
        return "UTF-8", nil
    }

    // 2. Try charset.DetermineEncoding
    encoding, _, _ := charset.DetermineEncoding(body, "")
    return encoding, nil
}
```

---

### 14.2 Malformed HTML

#### Problem: HTML Doesn't Follow Spec

**Common Issues:**

**1. Unclosed Tags:**

```html
<div>
  <p>Paragraph</p>
  <p>
    Another paragraph
    <!-- Missing </p>, </div> -->
  </p>
</div>
```

**2. Mismatched Tags:**

```html
<div>
  <span>Text</div>
</span>
```

**3. Invalid Nesting:**

```html
<p>
  <div>Block inside inline</div>
</p>
```

**Solution: Lenient Parser**

```typescript
// Use parser that auto-fixes HTML
import * as cheerio from 'cheerio';

const $ = cheerio.load(malformedHTML, {
  xmlMode: false,
  decodeEntities: true,
  lowerCaseAttributeNames: true,
});

// Cheerio auto-fixes most issues
```

---

## 15. Temporal & Session Problems

### 15.1 Time-Based Content

#### Problem: Content Changes Based on Time

**Scenarios:**

**1. Limited-Time Content:**

```javascript
// Show banner only during sale period
if (Date.now() < saleEndDate) {
  showSaleBanner();
}
```

**2. Schedule-Based:**

```javascript
// Different content for business hours vs after hours
const hour = new Date().getHours();
if (hour >= 9 && hour < 17) {
  showBusinessHoursContent();
} else {
  showAfterHoursContent();
}
```

**3. Timezone-Based:**

```javascript
// Show content based on user's timezone
const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
showContentForTimezone(userTimezone);
```

**Challenge:**

- Crawler sees content at crawl time only
- May miss time-specific content

**Strategy:**

- Crawl at multiple times (if critical)
- Or mock system time in browser:

```typescript
await page.addInitScript(() => {
  // Mock Date to specific time
  const fakeNow = new Date('2024-01-15T10:00:00Z').getTime();
  Date.now = () => fakeNow;
});
```

---

### 15.2 Geographic/IP-Based Content

#### Problem: Different Content for Different Locations

**Scenarios:**

**1. IP Geolocation:**

```javascript
// Show different content based on IP location
fetch('/api/detect-location')
  .then((res) => res.json())
  .then(({ country }) => {
    if (country === 'US') {
      showUSContent();
    } else {
      showInternationalContent();
    }
  });
```

**2. Language Detection:**

```javascript
// Auto-detect language from headers
const lang = navigator.language; // 'en-US'
loadContent(lang);
```

**Strategy:**

- Use proxies in different geographic locations
- Or mock geolocation API:

```typescript
await page.evaluateOnNewDocument(() => {
  navigator.geolocation.getCurrentPosition = (success) => {
    success({
      coords: {
        latitude: 37.7749, // San Francisco
        longitude: -122.4194,
        accuracy: 100,
      },
    });
  };
});
```

---

## 16. Security & Privacy Problems

### 16.1 Cookie Consent Banners

#### Problem: Content Blocked by Cookie Banner

**Pattern:**

```html
<div class="cookie-banner" style="position:fixed; bottom:0; width:100%">
  <p>We use cookies. Accept?</p>
  <button id="accept-cookies">Accept</button>
</div>
<!-- Banner blocks interaction with page -->
```

**Strategy:**

```typescript
async function dismissCookieBanner(page: Page) {
  // Try common selectors
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    '#accept-cookies',
    '.cookie-accept',
    '[aria-label="Accept cookies"]',
  ];

  for (const selector of selectors) {
    try {
      const button = await page.$(selector);
      if (button) {
        await button.click();
        await page.waitForTimeout(500);
        return true;
      }
    } catch {}
  }

  return false; // Couldn't find/dismiss banner
}
```

---

## 17. Redirect & Status Problems

### 17.1 Redirect Chains

#### Problem: Multiple Redirects Before Final Page

**Example:**

```
Request: http://example.com/old-page
  → 301 → http://example.com/page
  → 301 → https://example.com/page
  → 301 → https://www.example.com/page
  → 200 → Final content
```

**Challenge:**

- Performance (multiple round-trips)
- Infinite redirect loops
- Redirect limits (browsers stop at ~20)

**Strategy:**

```go
func followRedirects(url string, maxRedirects int) (string, error) {
    client := &http.Client{
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            if len(via) >= maxRedirects {
                return fmt.Errorf("too many redirects")
            }
            return nil
        },
    }

    resp, err := client.Get(url)
    if err != nil {
        return "", err
    }

    return resp.Request.URL.String(), nil // Final URL
}
```

---

### 17.2 Soft 404s

#### Problem: Page Returns 200 but Content Says "Not Found"

**Example:**

```
HTTP/1.1 200 OK

<html>
<body>
  <h1>Page Not Found</h1>
  <p>The page you're looking for doesn't exist.</p>
</body>
</html>
```

**Detection:**

```typescript
function isSoft404(html: string): boolean {
  const soft404Phrases = [
    'page not found',
    '404',
    'does not exist',
    'page no longer available',
    'removed or deleted',
  ];

  const lowerHTML = html.toLowerCase();
  return soft404Phrases.some((phrase) => lowerHTML.includes(phrase));
}
```

---

## 18. Duplicate & Canonicalization

### 18.1 Duplicate Content Problem

#### Problem: Same Content at Multiple URLs

**Examples:**

```
https://example.com/page
https://www.example.com/page
http://example.com/page
https://example.com/page/
https://example.com/page?utm_source=twitter
https://example.com/page?ref=123
https://example.com/page#section
```

**All serve identical content!**

**Solution: URL Normalization**

```go
func normalizeURL(rawURL string) string {
    u, _ := url.Parse(rawURL)

    // 1. Force HTTPS
    u.Scheme = "https"

    // 2. Remove www (or add it - be consistent)
    u.Host = strings.TrimPrefix(u.Host, "www.")

    // 3. Remove fragment
    u.Fragment = ""

    // 4. Remove tracking params
    q := u.Query()
    trackingParams := []string{"utm_source", "utm_medium", "utm_campaign", "fbclid", "ref"}
    for _, param := range trackingParams {
        q.Del(param)
    }
    u.RawQuery = q.Encode()

    // 5. Remove trailing slash (except root)
    if u.Path != "/" {
        u.Path = strings.TrimSuffix(u.Path, "/")
    }

    // 6. Sort query params (for consistency)
    if u.RawQuery != "" {
        u.RawQuery = sortQueryParams(u.RawQuery)
    }

    return u.String()
}
```

---

### 18.2 Canonical Tags

#### Problem: Sites Declare Preferred URL

**Pattern:**

```html
<!-- Current URL: https://example.com/page?ref=123 -->
<link rel="canonical" href="https://example.com/page" />
<!-- Site says: "https://example.com/page" is the canonical version -->
```

**Strategy:**

```typescript
async function getCanonicalURL(page: Page): Promise<string> {
  // Check for canonical tag
  const canonical = await page
    .$eval('link[rel="canonical"]', (link) => link.href)
    .catch(() => null);

  if (canonical) {
    return canonical;
  }

  // Fallback to current URL
  return page.url();
}

// Use canonical URL as identifier
const canonicalUrl = await getCanonicalURL(page);
if (hasCrawled(canonicalUrl)) {
  return; // Skip, already crawled
}
```

---

## 19. Multilingual & i18n Problems

### 19.1 Language Detection

#### Problem: Multiple Languages, Same Site

**Patterns:**

**1. Subdomain-Based:**

```
English: https://en.example.com/page
French:  https://fr.example.com/page
Spanish: https://es.example.com/page
```

**2. Path-Based:**

```
English: https://example.com/en/page
French:  https://example.com/fr/page
Spanish: https://example.com/es/page
```

**3. Query-Based:**

```
https://example.com/page?lang=en
https://example.com/page?lang=fr
```

**4. Header-Based:**

```
Request with Accept-Language: en-US → English content
Request with Accept-Language: fr-FR → French content
```

**Detection:**

```typescript
async function detectLanguageVersions(page: Page): Promise<string[]> {
  // Check hreflang tags
  const hreflangLinks = await page.$$eval('link[rel="alternate"][hreflang]', (links) =>
    links.map((link) => ({
      lang: link.getAttribute('hreflang'),
      url: link.href,
    })),
  );

  return hreflangLinks;
}
```

**Strategy:**

```typescript
// Crawl all language versions?
const languages = await detectLanguageVersions(page);

for (const { lang, url } of languages) {
  await crawl(url, { language: lang });
}
```

---

## 20. Problem-Solution Matrix

Now that we've categorized problems, let's evaluate frameworks:

### Based on 21 Problem Categories (130+ Specific Challenges):

**For Tier 1 (Basic Crawling):**

- **Best**: Go (Colly) - Fast, low memory, handles 50% of sites
- **Alternative**: Python (Scrapy) - Rich ecosystem, good docs

**For Tier 2 (Intermediate - 70-80% coverage):**

- **Best**: Hybrid (Go Colly + Go rod) - Fast static + browser when needed
- **Alternative**: TypeScript (Crawlee + Playwright) - Unified stack

**For Tier 3 (Advanced - 90% coverage):**

- **Best**: Go rod or TypeScript Playwright with stealth plugins
- **Requirements**: Proxy support, stealth mode, advanced interaction

**For Tier 4 (Enterprise - 100% coverage):**

- **Architecture**: Microservices
  - Go (Colly) - Static crawling service
  - Go (rod) or TS (Playwright) - Browser service
  - Python - Content extraction service
  - CAPTCHA solving service - External API (2Captcha)

---

## 26. Complete Evaluation Criteria (Updated)

Now evaluating frameworks against ALL 21 problem categories:

| Criterion             | Go (Colly)               | Go (rod)              | Python (Scrapy)   | TS (Crawlee)         | TS (Playwright) |
| --------------------- | ------------------------ | --------------------- | ----------------- | -------------------- | --------------- |
| **1. Discovery**      | ✅ Excellent             | ✅ Excellent          | ✅ Excellent      | ✅ Excellent         | ✅ Excellent    |
| **2. Access Control** | ⚠️ Manual                | ⚠️ Manual             | ⚠️ Manual         | ⚠️ Manual            | ⚠️ Manual       |
| **3. Anti-Bot**       | ❌ Weak                  | ✅ Good               | ⚠️ Medium         | ✅✅ Excellent       | ✅✅ Excellent  |
| **4. Rendering**      | ❌ None                  | ✅✅ Native           | ⚠️ Via Splash     | ✅✅ Native          | ✅✅ Native     |
| **5. Interactive**    | ❌ None                  | ✅✅ Excellent        | ⚠️ Via Playwright | ✅✅ Excellent       | ✅✅ Excellent  |
| **6. Dynamic Load**   | ❌ None                  | ✅✅ Excellent        | ⚠️ Via Playwright | ✅✅ Excellent       | ✅✅ Excellent  |
| **7. URL Complexity** | ✅✅ Excellent           | ✅✅ Excellent        | ✅ Good           | ✅ Good              | ✅ Good         |
| **8. Arch Detection** | ⚠️ Manual                | ⚠️ Manual             | ⚠️ Manual         | ⚠️ Manual            | ⚠️ Manual       |
| **9. Navigation**     | ✅ Good                  | ✅✅ Excellent        | ✅ Good           | ✅✅ Excellent       | ✅✅ Excellent  |
| **10. Extraction**    | ⚠️ Medium                | ⚠️ Medium             | ✅✅ Excellent    | ✅ Good              | ✅ Good         |
| **11. Media/Assets**  | ❌ Limited               | ✅ Good               | ✅ Good           | ✅✅ Excellent       | ✅✅ Excellent  |
| **12. Forms**         | ❌ None                  | ✅✅ Excellent        | ⚠️ Via Playwright | ✅✅ Excellent       | ✅✅ Excellent  |
| **13. Variants**      | ⚠️ UA only               | ✅ Full               | ✅ Full           | ✅ Full              | ✅ Full         |
| **14. Encoding**      | ✅ Good                  | ✅ Good               | ✅✅ Excellent    | ✅ Good              | ✅ Good         |
| **15. Temporal**      | ⚠️ Limited               | ✅ Good               | ⚠️ Limited        | ✅ Good              | ✅ Good         |
| **16. Security**      | ✅ Good                  | ✅✅ Excellent        | ✅ Good           | ✅✅ Excellent       | ✅✅ Excellent  |
| **17. Redirects**     | ✅✅ Excellent           | ✅✅ Excellent        | ✅✅ Excellent    | ✅✅ Excellent       | ✅✅ Excellent  |
| **18. Duplicates**    | ⚠️ Manual                | ⚠️ Manual             | ✅ Built-in       | ⚠️ Manual            | ⚠️ Manual       |
| **19. Multilingual**  | ✅ Good                  | ✅ Good               | ✅ Good           | ✅ Good              | ✅ Good         |
| **20. Scale/Perf**    | ✅✅✅ Best              | ✅✅ Very Good        | ✅ Good           | ⚠️ Medium            | ⚠️ Medium       |
| **21. Reliability**   | ✅✅ Excellent           | ✅✅ Excellent        | ✅✅ Excellent    | ✅ Good              | ✅ Good         |
|                       |                          |                       |                   |                      |                 |
| **Total Score**       | 13/21 ✅                 | 18/21 ✅              | 16/21 ✅          | 17/21 ✅             | 17/21 ✅        |
| **Best For**          | Static sites, High scale | Modern sites, Balance | Mature projects   | Modern web, TS stack | Full coverage   |
| **Coverage**          | ~50% of web              | ~95% of web           | ~90% of web       | ~95% of web          | ~95% of web     |
| **Speed**             | ⚡⚡⚡ Fastest           | ⚡⚡ Fast             | ⚡ Medium         | ⚡ Medium            | ⚡ Medium       |
| **Memory**            | 💚 50MB                  | 💚 150MB              | 💛 400MB          | 💛 500MB             | 💛 500MB        |

**Legend:**

- ✅✅ Excellent - Native, first-class support
- ✅ Good - Supported, may need light config
- ⚠️ Medium - Requires additional libraries/effort
- ❌ Weak/None - Not supported or very difficult

---

## 27. Final Recommendation: Hybrid Architecture

### Recommended Approach: **Multi-Service Architecture**

```
┌─────────────────────────────────────────────────────────────┐
│  apps/search-ai (TypeScript)                                │
│  - Orchestrator & API                                       │
│  - Connection management                                    │
│  - Job queue (BullMQ)                                       │
│  - Document storage                                         │
└────────┬────────────────────────────────────────────────────┘
         │
         │ Creates crawl jobs
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Decision Engine (TypeScript)                               │
│  - Detect site architecture                                 │
│  - Route to appropriate crawler                             │
│  - Smart caching (avoid re-detection)                       │
└────┬────────────────────────────────────┬───────────────────┘
     │                                    │
     │ Static HTML (70% of pages)        │ JS Required (30%)
     ▼                                    ▼
┌──────────────────────┐        ┌──────────────────────────┐
│  Static Crawler      │        │  Browser Crawler         │
│  (Go + Colly)        │        │  (Go + rod or TS +       │
│  - Fast (1000+/min)  │        │   Playwright)            │
│  - Low memory        │        │  - Slower (50-200/min)   │
│  - High concurrency  │        │  - Interactive support   │
└──────────┬───────────┘        └──────────┬───────────────┘
           │                               │
           └───────────┬───────────────────┘
                       │ HTML content
                       ▼
           ┌───────────────────────┐
           │  Content Extractor    │
           │  (Python - Optional)  │
           │  - trafilatura        │
           │  - ML-based cleaning  │
           └───────────┬───────────┘
                       │
                       ▼
           ┌───────────────────────┐
           │  searchAI Pipeline    │
           │  - Chunking           │
           │  - Embedding          │
           │  - Indexing           │
           └───────────────────────┘
```

### Why This Architecture?

**1. Handles All 21 Problem Categories:**

- Discovery → Both crawlers
- Access Control → TypeScript orchestrator manages auth
- Anti-Bot → Browser crawler with stealth
- Rendering → Browser crawler for JS sites
- Interactive → Browser crawler
- Dynamic Loading → Browser crawler
- URL Complexity → Both crawlers (normalized in orchestrator)
- All other problems → Appropriate routing

**2. Performance Optimized:**

- 70% of pages use fast static crawler (Go Colly)
- 30% of pages use browser crawler only when needed
- Overall: 2-3x faster than browser-only approach

**3. Cost Optimized:**

- Static crawling: ~$1 per 100k pages (compute)
- Browser crawling: ~$50 per 100k pages (compute + memory)
- Hybrid: ~$20 per 100k pages (70% static + 30% browser)

**4. Scalable:**

- Scale static crawler horizontally (1000+ workers)
- Scale browser crawler independently (50-100 workers)
- Queue-based coordination (BullMQ/Redis)

**5. Maintainable:**

- Clear separation of concerns
- Each component can be updated independently
- TypeScript API provides unified interface

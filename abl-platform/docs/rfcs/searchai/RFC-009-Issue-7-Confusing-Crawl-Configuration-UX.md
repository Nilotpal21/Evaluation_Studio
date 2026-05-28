# RFC-001 Issue #7: Confusing Crawl Configuration (User Experience Problem)

**Severity**: HIGH (P1 - Architectural/UX Issue)
**Component**: Crawler Configuration Design
**Date**: 2026-02-23

## Executive Summary

The current crawler configuration uses **technical parameters** (`maxPages`, `maxDepth`, `followLinks`) that users don't understand. This is a **fundamental UX problem** - users shouldn't need to know:

- How many pages a site has (for `maxPages`)
- What crawl depth means (for `maxDepth`)
- Whether to follow links vs use sitemap (technical implementation detail)

**Better Approach**: Use **high-level crawl strategies** that users can understand and choose from.

## Current Configuration (Problems)

### API Request Body

```json
{
  "urls": ["https://docs.kore.ai/"],
  "options": {
    "maxPages": 50, // ❌ How does user know what to set?
    "maxDepth": 3, // ❌ Technical concept
    "followLinks": true, // ❌ When would this be false?
    "extractMetadata": true,
    "useSitemap": true // ❌ Another boolean flag
  }
}
```

### Problems

1. **maxPages**: "How many pages should I crawl?"
   - User doesn't know site size beforehand
   - Too low: Misses important content
   - Too high: Wastes time/resources
   - Default (50) is arbitrary
   - **Question users ask**: "How do I know what number to use?"

2. **maxDepth**: "How deep should I go?"
   - Technical concept (depth-first vs breadth-first traversal)
   - Most users don't understand graph traversal
   - Depth=1 vs Depth=3 - what's the difference in practice?
   - **Question users ask**: "What depth do I need?"

3. **followLinks**: "Should I follow links?"
   - When would a user set this to `false`?
   - If true, why also need `maxDepth` and `maxPages`?
   - Confusing interaction with `useSitemap`
   - **Question users ask**: "What's the difference between following links and using sitemap?"

4. **useSitemap**: "Should I use sitemap?"
   - Why would user ever say "no" if sitemap exists?
   - If user says "yes" but no sitemap exists, then what?
   - Implementation detail exposed to user
   - **Question users ask**: "I don't know if the site has a sitemap"

## User Mental Models

Users think in terms of **WHAT they want to crawl**, not **HOW to crawl it**:

### User Intent → Current Mapping (Broken)

| User Wants                       | Current Config Required                           | Problem              |
| -------------------------------- | ------------------------------------------------- | -------------------- |
| "Crawl this single page"         | `maxPages: 1, followLinks: false`                 | Why two settings?    |
| "Crawl the entire docs site"     | `maxPages: ???, maxDepth: ???`                    | Don't know values    |
| "Crawl whatever is in sitemap"   | `useSitemap: true, maxPages: ???`                 | Conflicting concepts |
| "Crawl 100 pages from this site" | `maxPages: 100, maxDepth: ???, followLinks: true` | Still need depth     |
| "Just crawl everything"          | `maxPages: 999999, maxDepth: 10?`                 | No good way          |

## Proposed Solution: Crawl Strategies

### Strategy-Based Configuration

```json
{
  "urls": ["https://docs.kore.ai/"],
  "strategy": "sitemap", // ✅ Clear intent
  "limits": {
    // ✅ Optional safety limits
    "maxPages": 1000,
    "maxDurationMinutes": 30
  }
}
```

### Available Strategies

#### 1. `"single-page"` - Crawl Only This URL

```json
{
  "urls": ["https://docs.kore.ai/getting-started/"],
  "strategy": "single-page"
}
```

**Behavior:**

- Crawl exactly the URL(s) provided
- No link following, no sitemap
- Fastest option

**Use Cases:**

- Testing a specific page
- Extracting content from one article
- Quick verification

---

#### 2. `"sitemap"` - Use Sitemap.xml

```json
{
  "urls": ["https://docs.kore.ai/"],
  "strategy": "sitemap",
  "limits": {
    "maxPages": 500 // Optional limit
  }
}
```

**Behavior:**

- Detect and parse sitemap.xml
- Crawl all URLs from sitemap (or up to maxPages)
- Error if no sitemap found (or fallback option)
- Respects sitemap priorities

**Use Cases:**

- Documentation sites (almost all have sitemaps)
- Well-structured corporate sites
- Efficient crawling of large sites

**Fallback Options:**

```json
{
  "strategy": "sitemap",
  "fallbackStrategy": "smart" // If no sitemap, use smart crawl
}
```

---

#### 3. `"smart"` - Intelligent Discovery (Default)

```json
{
  "urls": ["https://docs.kore.ai/"],
  "strategy": "smart",
  "limits": {
    "maxPages": 100
  }
}
```

**Behavior:**

1. Check for sitemap.xml
   - If found: Use sitemap (most efficient)
   - If not found: Follow links intelligently
2. Automatically determine depth based on site structure
3. Apply smart filtering (skip obvious non-content pages)

**Use Cases:**

- Default option for most users
- "Just crawl this site" - let system decide how
- Best balance of coverage and efficiency

---

#### 4. `"full-site"` - Crawl Everything

```json
{
  "urls": ["https://docs.kore.ai/"],
  "strategy": "full-site",
  "limits": {
    "maxPages": 10000, // Safety limit
    "maxDurationMinutes": 120 // Safety timeout
  }
}
```

**Behavior:**

- Crawl all discoverable pages
- Use sitemap + follow all links
- No artificial depth limits
- Only stops at safety limits

**Use Cases:**

- Complete site archival
- Comprehensive search index
- Research/analysis projects

**Safety Features:**

- Required safety limits to prevent runaway crawls
- Progress notifications
- Ability to pause/resume

---

#### 5. `"limited"` - Crawl N Pages

```json
{
  "urls": ["https://docs.kore.ai/"],
  "strategy": "limited",
  "limits": {
    "maxPages": 50 // Required for this strategy
  }
}
```

**Behavior:**

- Use best discovery method (sitemap or links)
- Stop after N pages
- Prioritize important pages (sitemap priority, depth 0 first)

**Use Cases:**

- Sample crawl for testing
- Budget-limited crawling
- Preview before full crawl

---

### Strategy Comparison Table

| Strategy      | Speed       | Coverage | Use Sitemap?   | Follow Links? | User Complexity     |
| ------------- | ----------- | -------- | -------------- | ------------- | ------------------- |
| `single-page` | ⚡ Fastest  | Minimal  | No             | No            | ✅ Simplest         |
| `sitemap`     | ⚡⚡ Fast   | High\*   | Yes (required) | No            | ✅ Simple           |
| `smart`       | ⚡⚡ Fast   | High     | Auto           | Auto          | ✅ Simple (default) |
| `limited`     | ⚡⚡ Medium | Medium   | Auto           | Auto          | ✅ Simple           |
| `full-site`   | 🐌 Slow     | Complete | Yes            | Yes           | ⚠️ Needs limits     |

\*Coverage depends on sitemap completeness

---

## Configuration Schema (Revised)

```typescript
interface CrawlRequest {
  // Required: Starting URL(s)
  urls: string[];

  // Required: Crawl strategy
  strategy: 'single-page' | 'sitemap' | 'smart' | 'limited' | 'full-site';

  // Optional: Fallback if primary strategy fails
  fallbackStrategy?: 'single-page' | 'smart' | 'limited';

  // Optional: Safety limits (required for 'full-site', 'limited')
  limits?: {
    maxPages?: number; // Max pages to crawl
    maxDurationMinutes?: number; // Max time to spend
    maxDepth?: number; // Advanced: override auto-depth
  };

  // Optional: Advanced options (most users won't need)
  advanced?: {
    respectRobotsTxt?: boolean; // Default: true
    sameDomainOnly?: boolean; // Default: true
    urlFilters?: string[]; // Regex patterns to exclude
    includeSubdomains?: boolean; // Default: true
  };

  // Ingestion details (unchanged)
  tenantId: string;
  indexId: string;
  sourceId: string;
}
```

---

## Migration Path

### Phase 1: Add Strategy Support (Keep Old API)

```json
// NEW: Strategy-based (recommended)
{ "urls": [...], "strategy": "smart" }

// OLD: Still works, maps to strategy internally
{ "urls": [...], "options": { "maxPages": 50, "followLinks": true } }
```

**Internal Mapping:**

```typescript
// Old options → Strategy mapping
if (options.maxPages === 1 && !options.followLinks) {
  strategy = 'single-page';
} else if (options.useSitemap && !options.followLinks) {
  strategy = 'sitemap';
} else {
  strategy = 'smart'; // Default
}
```

### Phase 2: Deprecate Old Options (3 months)

- Add deprecation warnings
- Update documentation
- Migrate existing integrations

### Phase 3: Remove Old Options (6 months)

- Strategy-only API
- Cleaner, simpler code

---

## UI Implications

### Before (Confusing Form)

```
┌─────────────────────────────────────┐
│ Crawl Settings                      │
├─────────────────────────────────────┤
│ Start URL: [________________]       │
│                                     │
│ Max Pages: [50___] ⓘ               │
│ Max Depth: [3____] ⓘ               │
│ ☑ Follow Links                      │
│ ☑ Use Sitemap                       │
│ ☑ Extract Metadata                  │
│                                     │
│ [Cancel]  [Start Crawl]             │
└─────────────────────────────────────┘
```

### After (Clear Strategies)

```
┌─────────────────────────────────────┐
│ Crawl Settings                      │
├─────────────────────────────────────┤
│ Start URL: [________________]       │
│                                     │
│ What do you want to crawl?          │
│                                     │
│ ○ Just this page                    │
│   Fastest. Crawls only the URL.    │
│                                     │
│ ● Smart Crawl (Recommended)         │
│   Uses sitemap or follows links.   │
│   Limit: [100] pages                │
│                                     │
│ ○ From Sitemap                      │
│   Uses sitemap.xml if available.   │
│                                     │
│ ○ Entire Site                       │
│   ⚠️ May take hours. Safety limits  │
│   required.                         │
│                                     │
│ [Cancel]  [Start Crawl]             │
└─────────────────────────────────────┘
```

Much clearer what each option does!

---

## Implementation Impact

### Components Affected

1. **API Contract** (`apps/search-ai/src/routes/crawl.ts`)
   - Accept `strategy` field
   - Map strategy to internal crawl parameters
   - Validate strategy-specific requirements

2. **Decision Engine** (`@abl/crawler`)
   - Currently makes strategy decisions
   - Should **assist** strategy, not decide it
   - User's strategy choice overrides AI decision

3. **Go Worker** (no change needed)
   - Still receives URLs to crawl
   - Implementation details hidden from user

4. **Documentation**
   - Rewrite API docs with strategy examples
   - Add strategy selection guide
   - Migration guide for existing users

---

## Benefits

### For Users

- ✅ **Clarity**: "What do you want to crawl?" vs "Set maxDepth"
- ✅ **Simplicity**: Choose strategy, not configure parameters
- ✅ **Predictability**: Strategies have clear behavior
- ✅ **Flexibility**: Advanced users can still use limits

### For Developers

- ✅ **Maintainability**: Clear strategy implementations
- ✅ **Testability**: Test each strategy independently
- ✅ **Extensibility**: Easy to add new strategies

### For Product

- ✅ **Lower support burden**: Fewer "what should I set?" questions
- ✅ **Better defaults**: "smart" strategy works for 90% of cases
- ✅ **Upsell opportunities**: "full-site" vs "limited" for pricing tiers

---

## Open Questions for Discussion

1. **Strategy Naming**:
   - `"smart"` vs `"auto"` vs `"intelligent"`?
   - `"full-site"` vs `"complete"` vs `"everything"`?
   - User-friendly names vs technical accuracy?

2. **Default Strategy**:
   - Should default be `"smart"` (auto-decide)?
   - Or require explicit strategy choice?
   - Impact on existing integrations?

3. **Fallback Behavior**:
   - Strategy `"sitemap"` but no sitemap → fail or fallback?
   - Should fallback be automatic or explicit?
   - User notification when fallback happens?

4. **Safety Limits**:
   - Should `"smart"` have implicit limits (e.g., 1000 pages)?
   - Or require explicit limits for safety?
   - How to prevent accidental huge crawls?

5. **Pricing Implications**:
   - Should different strategies have different costs?
   - `"full-site"` clearly more expensive than `"single-page"`
   - Tiered limits based on user plan?

6. **Backward Compatibility**:
   - Support old API indefinitely?
   - Force migration after X months?
   - Dual API versions (v1 vs v2)?

---

## Success Criteria

### User Testing

- ✅ Non-technical users can choose strategy without help
- ✅ <5% of users ask "what should I choose?"
- ✅ Strategy descriptions are self-explanatory

### Technical

- ✅ All strategies implemented and tested
- ✅ Old API parameters map correctly to strategies
- ✅ Documentation updated with clear examples

### Business

- ✅ Support tickets about configuration decrease by 50%+
- ✅ User satisfaction with crawler UX increases
- ✅ Adoption of smart/auto features increases

---

## Conclusion

The current parameter-based approach exposes **implementation details** (maxDepth, followLinks) to users who just want to **accomplish a goal** ("crawl this site").

**Strategy-based configuration** aligns with user mental models:

- "Crawl this page" → `strategy: "single-page"`
- "Crawl this site" → `strategy: "smart"`
- "Crawl everything" → `strategy: "full-site"`

This is a **UX-first redesign** that happens to make the implementation cleaner too.

**Recommendation**: Implement strategy support (Phase 1) alongside sitemap URL extraction (Issue #6) as part of the same effort. Both are architectural improvements that should be done together.

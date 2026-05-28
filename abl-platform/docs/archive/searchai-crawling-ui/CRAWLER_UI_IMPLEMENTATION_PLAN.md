# Web Crawler UI - Implementation Plan & Checklist

## 📋 Executive Summary

### What We're Building

A smart, user-friendly web crawling interface that leverages the existing intelligent backend (FastProfiler, DecisionEngine, StrategyResolver) to make web content ingestion effortless.

### Key Differentiators

1. **Intelligence-First**: System makes 90% of decisions automatically
2. **Progressive Disclosure**: Complexity revealed only when needed
3. **Learning System**: Gets smarter with each crawl (saved preferences)
4. **Real-Time Transparency**: Live dashboard with quality metrics
5. **Mobile-Friendly**: Works seamlessly on all devices

### Success Metrics

- ⏱️ **Time to first crawl**: <60 seconds
- ✅ **Completion rate**: >85%
- 🎯 **User satisfaction**: >4.5/5
- 🤖 **Auto-decide rate**: >70% (no prompts needed)

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (Studio App)                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ CrawlerTab   │  │ JobProgress  │  │ JobHistory   │     │
│  │              │  │              │  │              │     │
│  │ - Form       │  │ - Dashboard  │  │ - Past Jobs  │     │
│  │ - Preview    │  │ - Metrics    │  │ - Re-crawl   │     │
│  │ - Strategy   │  │ - Errors     │  │ - Compare    │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                  │                  │              │
│         └──────────────────┼──────────────────┘              │
│                            │                                 │
└────────────────────────────┼─────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Layer (Studio API)                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  /api/search-ai/crawl/                                       │
│  ├─ POST   /batch           (Submit crawl job)             │
│  ├─ POST   /batch/respond   (Answer prompts)               │
│  ├─ GET    /status/:jobId   (Poll job status)              │
│  ├─ GET    /dashboard/:jobId (Aggregated metrics)          │
│  └─ WS     /ws/crawl/:jobId (Real-time updates)            │
│                                                              │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend (SearchAI Service)                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ✓ FastProfiler          (Site analysis)                    │
│  ✓ DecisionEngine        (Strategy selection)               │
│  ✓ PromptEvaluator       (Skip rules)                       │
│  ✓ QuestionGenerator     (Contextual prompts)               │
│  ✓ StrategyResolver      (Config resolution)                │
│  ✓ ResponseProcessor     (User input handling)              │
│  ✓ CrawlerIngestion      (Content processing)               │
│  ✓ BullMQ Queues         (Job orchestration)                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 Component Breakdown

### 1. **CrawlerTab** (Main Container)

**Location**: `apps/studio/src/components/search-ai/CrawlerTab.tsx`

**Responsibilities**:

- Tab navigation integration
- State management (URL, mode, job tracking)
- Conditional rendering (empty state, form, progress, history)

**Props**:

```typescript
interface CrawlerTabProps {
  indexId: string;
  onJobComplete?: (jobId: string) => void;
}
```

**State**:

```typescript
interface CrawlerTabState {
  view: 'empty' | 'form' | 'progress' | 'history';
  activeJobId?: string;
  jobs: CrawlJob[];
}
```

---

### 2. **CrawlJobForm** (URL Input & Configuration)

**Location**: `apps/studio/src/components/search-ai/CrawlJobForm.tsx`

**Responsibilities**:

- URL input with real-time validation
- Site preview fetching
- Strategy selection (simple or advanced)
- Form submission

**Sub-components**:

- `URLInput` - Input with validation states
- `SitePreviewCard` - Profiling results display
- `StrategySelector` - Visual strategy cards
- `AdvancedOptionsPanel` - Collapsible detailed config

**Key Features**:

```typescript
// Real-time URL validation
const validateURL = useDebouncedCallback((url: string) => {
  // 1. Format validation (URL constructor)
  // 2. Accessibility check (HEAD request)
  // 3. Site profiling (FastProfiler)
}, 500);

// Profiling preview
const fetchSitePreview = async (url: string) => {
  const response = await fetch('/api/search-ai/crawl/profile', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  return response.json(); // { domain, siteType, estimatedSize, etc. }
};
```

---

### 3. **CrawlJobProgress** (Real-Time Dashboard)

**Location**: `apps/studio/src/components/search-ai/CrawlJobProgress.tsx`

**Responsibilities**:

- Real-time progress visualization
- Phase tracking (crawl → ingest → extract → embed → index)
- Quality metrics display
- Error aggregation

**Sub-components**:

- `PhaseIndicator` - Multi-step progress
- `ProgressBar` - Animated percentage bar
- `TimelineDisplay` - Start/end/estimated times
- `QualityMetrics` - Score cards
- `ErrorList` - Expandable error messages
- `RecentActivity` - Live event feed

**Data Fetching**:

```typescript
// WebSocket connection (preferred)
const ws = useWebSocket(`/api/search-ai/crawl/ws/${jobId}`);

// Polling fallback (5s interval)
const { data: dashboard } = useQuery({
  queryKey: ['crawl-dashboard', jobId],
  queryFn: () => fetch(`/api/search-ai/crawl/dashboard/${jobId}`).then((r) => r.json()),
  refetchInterval: 5000,
  enabled: !ws.connected,
});
```

---

### 4. **CrawlJobHistory** (Past Crawls)

**Location**: `apps/studio/src/components/search-ai/CrawlJobHistory.tsx`

**Responsibilities**:

- List past crawl jobs
- Filtering (status, date, strategy)
- Re-crawl actions
- Comparison view

**Features**:

- Infinite scroll (paginated API)
- Status badges (queued, complete, failed)
- Quick actions (view, re-crawl, delete)
- Comparison mode (before/after metrics)

---

### 5. **CrawlPreferences** (Saved Settings)

**Location**: `apps/studio/src/components/search-ai/CrawlPreferences.tsx`

**Responsibilities**:

- Display saved domain preferences
- CRUD operations (create, edit, delete)
- Auto-decide toggle
- Wildcard pattern support

**Data Model**:

```typescript
interface CrawlPreference {
  id: string;
  domainPattern: string; // "docs.example.com" or "*.wikipedia.org"
  strategy: CrawlStrategy;
  maxPages?: number;
  maxDepth?: number;
  autoDecide: boolean;
  useCount: number;
  lastUsed: Date;
}
```

---

## 🎨 Design System Integration

### Using Studio's Existing Components

| Studio Component | Usage                          |
| ---------------- | ------------------------------ |
| `Button`         | Primary actions, cancellations |
| `Input`          | URL input, numeric limits      |
| `Select`         | Dropdowns (strategy, limits)   |
| `Dialog`         | Modal forms, confirmations     |
| `Badge`          | Status indicators, tags        |
| `DataTable`      | Crawl history list             |
| `EmptyState`     | No jobs yet screen             |
| `Tooltip`        | Contextual help                |
| `Progress`       | Percentage bars                |
| `Card`           | Site preview, metrics          |

### New Custom Components

| Component        | Purpose                   |
| ---------------- | ------------------------- |
| `StrategyCard`   | Visual strategy selector  |
| `PhaseIndicator` | Multi-step progress       |
| `QualityScore`   | Circular score gauge      |
| `SitePreview`    | URL preview with metadata |
| `ErrorItem`      | Expandable error display  |

---

## 🔌 API Integration

### Existing Endpoints (Already Implemented)

#### 1. Submit Crawl Job

```typescript
POST /api/search-ai/crawl/batch

Request:
{
  urls: string[];
  tenantId: string;
  indexId: string;
  sourceId: string;
  strategy?: 'single-page' | 'sitemap' | 'smart' | 'limited' | 'full-site';
  limits?: {
    maxPages?: number;
    maxDurationMinutes?: number;
    maxDepth?: number;
  };
}

Response (High Confidence):
{
  success: true,
  needsUserInput: false,
  jobId: string,
  batchId: string,
  status: 'queued',
  strategy: { ... },
}

Response (Low Confidence - Needs Prompts):
{
  success: true,
  needsUserInput: true,
  pendingId: string,
  questions: PromptQuestion[],
  decision: CrawlDecision,
  profile: SiteProfile,
}
```

#### 2. Respond to Prompts

```typescript
POST /api/search-ai/crawl/batch/respond

Request:
{
  pendingId: string,
  responses: Array<{
    questionId: string,
    answer: string | number | boolean,
  }>,
}

Response:
{
  success: true,
  jobId: string,
  batchId: string,
  status: 'queued',
}
```

#### 3. Job Status

```typescript
GET /api/search-ai/crawl/status?jobId=xxx

Response:
{
  success: true,
  jobId: string,
  state: 'waiting' | 'active' | 'completed' | 'failed',
  progress: number | object,
  returnvalue?: object,
  failedReason?: string,
}
```

#### 4. Dashboard (Aggregated Metrics)

```typescript
GET /api/search-ai/crawl/dashboard/:jobId

Response:
{
  success: true,
  jobId: string,
  timeline: { submitted, started, completed, duration },
  phase: 'queued' | 'crawling' | 'ingesting' | 'indexing' | 'completed' | 'failed',
  crawl: { status, progress, urlsQueued, urlsCrawled, urlsFailed },
  ingestion: { documentsCreated, documentsFailed, documentsIndexed, avgQualityScore },
  extraction: { documentsProcessed, chunksCreated, avgChunksPerDoc },
  queues: { status: 'healthy' | 'degraded' | 'critical' },
  errors: Array<{ timestamp, phase, message }>,
}
```

### New Endpoints to Implement

#### 1. Site Profiling (Preview)

```typescript
POST /api/search-ai/crawl/profile

Request:
{
  url: string,
}

Response:
{
  success: true,
  domain: string,
  siteType: 'static' | 'spa' | 'hybrid' | 'unknown',
  estimatedSize: number,
  hasSitemap: boolean,
  jsRequired: boolean,
  avgResponseTime: number,
  metadata: {
    title?: string,
    description?: string,
    favicon?: string,
  },
}
```

**Backend**: Thin wrapper around `FastProfiler.profile()`

#### 2. Crawl History

```typescript
GET /api/search-ai/crawl/history?indexId=xxx&limit=20&offset=0

Response:
{
  success: true,
  jobs: Array<{
    id: string,
    urls: { original, expanded, crawled, failed },
    status: string,
    strategy: string,
    timeline: { submittedAt, completedAt },
    results: { documentsCreated, documentsIndexed, avgQualityScore },
  }>,
  total: number,
  hasMore: boolean,
}
```

**Backend**: Query `CrawlJob` model with pagination

#### 3. User Preferences

```typescript
GET /api/search-ai/crawl/preferences
POST /api/search-ai/crawl/preferences
PUT /api/search-ai/crawl/preferences/:id
DELETE /api/search-ai/crawl/preferences/:id
```

**Backend**: CRUD operations on `UserCrawlPreference` model

---

## 🚀 Implementation Phases

### Phase 1: MVP (Week 1-2) - Core Functionality

#### Tasks:

- [ ] **Setup routing**: Add CrawlerTab to SearchAI index management
- [ ] **Create CrawlerTab container**: Empty state, tab navigation
- [ ] **Build CrawlJobForm**: URL input, simple mode
- [ ] **Integrate with /batch endpoint**: Submit jobs
- [ ] **Create basic CrawlJobProgress**: Polling-based status
- [ ] **Implement CrawlJobHistory**: List past jobs
- [ ] **Add profile endpoint**: Site preview API

#### Components:

```
✓ CrawlerTab.tsx
✓ CrawlJobForm.tsx
  ├─ URLInput.tsx
  └─ SitePreviewCard.tsx
✓ CrawlJobProgress.tsx (basic)
✓ CrawlJobHistory.tsx (simple list)
```

#### Acceptance Criteria:

- [ ] User can paste URL and start crawl
- [ ] Site preview shows basic info (domain, estimated pages)
- [ ] Progress shows percentage and phase
- [ ] History shows past crawls with status

---

### Phase 2: Intelligence (Week 3-4) - Smart Features

#### Tasks:

- [ ] **Implement StrategySelector**: Visual cards
- [ ] **Add AdvancedOptionsPanel**: Collapsible config
- [ ] **Integrate with /batch/respond**: Handle prompts
- [ ] **Build QuestionDialog**: Contextual prompts UI
- [ ] **Enhance CrawlJobProgress**: Quality metrics, errors
- [ ] **Add preferences API**: CRUD endpoints
- [ ] **Create CrawlPreferences component**: Manage saved settings

#### Components:

```
✓ StrategySelector.tsx (visual cards)
✓ AdvancedOptionsPanel.tsx
✓ QuestionDialog.tsx
✓ CrawlJobProgress.tsx (enhanced)
  ├─ PhaseIndicator.tsx
  ├─ QualityMetrics.tsx
  └─ ErrorList.tsx
✓ CrawlPreferences.tsx
```

#### Acceptance Criteria:

- [ ] System auto-detects strategy (high confidence)
- [ ] Low confidence shows contextual questions
- [ ] User can save preferences per domain
- [ ] Progress shows quality scores and errors
- [ ] Advanced options work for power users

---

### Phase 3: Polish (Week 5-6) - Real-Time & UX

#### Tasks:

- [ ] **Add WebSocket support**: Real-time updates
- [ ] **Implement dashboard endpoint**: Aggregated metrics
- [ ] **Build RecentActivity feed**: Live event stream
- [ ] **Add comparison view**: Before/after metrics
- [ ] **Implement bulk URL import**: Textarea + file upload
- [ ] **Add keyboard shortcuts**: Cmd+K to open
- [ ] **Mobile optimization**: Responsive layouts
- [ ] **Accessibility audit**: WCAG AA compliance

#### Components:

```
✓ WebSocketProvider.tsx
✓ RecentActivity.tsx
✓ ComparisonView.tsx
✓ BulkURLImport.tsx
```

#### Acceptance Criteria:

- [ ] Progress updates in <1s without polling
- [ ] Dashboard shows all pipeline stages
- [ ] Re-crawl shows comparison with previous
- [ ] Bulk import accepts 1000 URLs
- [ ] All interactions keyboard accessible
- [ ] Works on mobile/tablet

---

### Phase 4: Advanced (Week 7+) - Power Features

#### Tasks:

- [ ] **Scheduling**: Recurring crawls (daily, weekly)
- [ ] **Webhooks**: Notify external systems on completion
- [ ] **API access**: Direct API for power users
- [ ] **Custom rules**: XPath/CSS selectors for extraction
- [ ] **Duplicate handling**: Smart re-crawl suggestions
- [ ] **Export**: Download results as JSON/CSV

#### Components:

```
✓ ScheduleDialog.tsx
✓ WebhookConfig.tsx
✓ CustomRulesEditor.tsx
✓ DuplicateDialog.tsx
```

#### Acceptance Criteria:

- [ ] Users can schedule daily/weekly crawls
- [ ] Webhooks notify on completion
- [ ] API documented and working
- [ ] Custom extraction rules functional
- [ ] Duplicate detection prevents waste

---

## 🧪 Testing Strategy

### Unit Tests

```typescript
// Component tests (Vitest + React Testing Library)
describe('CrawlJobForm', () => {
  it('validates URL format', () => { ... });
  it('shows site preview on valid URL', () => { ... });
  it('disables submit button when invalid', () => { ... });
  it('calls onSubmit with correct data', () => { ... });
});

describe('StrategySelector', () => {
  it('highlights recommended strategy', () => { ... });
  it('shows tooltips on hover', () => { ... });
  it('emits selection event', () => { ... });
});
```

### Integration Tests

```typescript
// API integration (Playwright)
test('submit crawl job end-to-end', async ({ page }) => {
  await page.goto('/search-ai/indexes/xxx');
  await page.click('text=Crawler');
  await page.fill('[name="url"]', 'https://docs.example.com');
  await page.waitForSelector('.site-preview');
  await page.click('text=Start Crawling');
  await expect(page.locator('.progress-bar')).toBeVisible();
});
```

### E2E Tests

```typescript
// Full flow (Playwright)
test('complete crawl workflow', async ({ page, context }) => {
  // 1. Navigate to crawler
  // 2. Submit URL
  // 3. Wait for profiling
  // 4. Handle prompts (if needed)
  // 5. Monitor progress
  // 6. Verify completion
  // 7. Check documents created
});
```

---

## 📊 Analytics Events

Track these events for product insights:

```typescript
// Event tracking
analytics.track('crawler.url_entered', { domain, siteType });
analytics.track('crawler.strategy_selected', { strategy, source: 'auto' | 'manual' });
analytics.track('crawler.job_submitted', { jobId, urls: count, strategy });
analytics.track('crawler.job_completed', { jobId, duration, documentsCreated, quality });
analytics.track('crawler.job_failed', { jobId, phase, error });
analytics.track('crawler.preference_saved', { domainPattern, strategy });
analytics.track('crawler.advanced_options_opened', {});
analytics.track('crawler.prompts_shown', { confidence, questionCount });
analytics.track('crawler.prompts_answered', { saved: boolean });
```

---

## 🎯 Performance Targets

| Metric                 | Target | Measurement         |
| ---------------------- | ------ | ------------------- |
| **Initial Load**       | <200ms | Time to interactive |
| **URL Validation**     | <100ms | Debounced check     |
| **Site Profiling**     | <3s    | FastProfiler call   |
| **Form Submission**    | <500ms | API response time   |
| **Progress Update**    | <1s    | WebSocket latency   |
| **History Load**       | <300ms | Paginated query     |
| **Mobile Performance** | >60fps | Scroll/animation    |

---

## 🔒 Security Considerations

### Input Validation

- **URL sanitization**: Prevent SSRF attacks
- **Max URLs limit**: 1000 per batch (prevent abuse)
- **Rate limiting**: 10 submissions per minute per user
- **Domain allowlist**: Optional enterprise feature

### Data Isolation

- **Tenant scoping**: All queries include `tenantId`
- **User permissions**: Check `requireProjectPermission`
- **No cross-tenant access**: 404 on unauthorized

### Sensitive Data

- **No credentials stored**: Use secure credential vault
- **HTTPS only**: Enforce SSL for crawl targets
- **PII detection**: Warn if found in crawled content

---

## 📚 Documentation Plan

### User Documentation

1. **Quick Start Guide**: "Crawl your first website in 60 seconds"
2. **Strategy Comparison**: When to use each strategy
3. **Advanced Options**: Deep dive into configuration
4. **Troubleshooting**: Common errors and solutions
5. **Best Practices**: Optimize crawl quality

### Developer Documentation

1. **API Reference**: Endpoint specs with examples
2. **Component Library**: Reusable components
3. **Architecture Guide**: How it all fits together
4. **Testing Guide**: Writing tests for crawler UI

---

## 🎓 Onboarding Flow

### First-Time User Experience

1. **Welcome Tooltip** (on first visit to CrawlerTab)

   ```
   👋 New to web crawling?
   Just paste a URL and we'll handle the rest!
   Our AI automatically detects the best way to crawl.
   [Try it now] [Take a tour]
   ```

2. **Interactive Tour** (optional, 5 steps)
   - Step 1: "Enter any website URL"
   - Step 2: "We analyze the site automatically"
   - Step 3: "Watch real-time progress"
   - Step 4: "Content appears in your knowledge base"
   - Step 5: "Save preferences for next time"

3. **Example URLs** (in empty state)
   - https://docs.anthropic.com
   - https://nextjs.org/docs
   - https://react.dev

---

## ✅ Definition of Done

### Feature Completeness

- [ ] All Phase 1-3 tasks completed
- [ ] All acceptance criteria met
- [ ] UI matches design system
- [ ] Responsive on mobile/tablet/desktop

### Quality

- [ ] Unit test coverage >80%
- [ ] Integration tests passing
- [ ] E2E tests for critical paths
- [ ] No console errors/warnings
- [ ] Accessibility audit passed (WCAG AA)

### Documentation

- [ ] User guide written
- [ ] API docs updated
- [ ] Component docs in Storybook
- [ ] Demo video recorded

### Performance

- [ ] All performance targets met
- [ ] Lighthouse score >90
- [ ] Bundle size <500KB (gzipped)
- [ ] No memory leaks

### Security

- [ ] Security review completed
- [ ] Input validation tested
- [ ] Tenant isolation verified
- [ ] No PII leaks

---

## 🚧 Known Limitations & Future Enhancements

### Current Limitations

1. **No OAuth crawling**: Can't crawl sites requiring user login
2. **Max 1000 URLs**: Bulk import limited
3. **No custom headers**: Can't set User-Agent, cookies
4. **English only**: Readability optimized for English content

### Future Enhancements

1. **Authenticated crawling**: OAuth integration
2. **Incremental updates**: Only crawl changed pages
3. **Content filtering**: Extract specific sections (e.g., "only articles")
4. **Multi-language**: Support non-English sites
5. **Visual testing**: Screenshot comparison for re-crawls
6. **Rate limiting**: Configurable request delays
7. **Proxy support**: Enterprise proxy servers

---

## 🤝 Collaboration & Reviews

### Code Review Checklist

- [ ] TypeScript strict mode passing
- [ ] ESLint/Prettier formatting correct
- [ ] Tests written and passing
- [ ] Bundle size impact acceptable (<50KB)
- [ ] Accessibility features included
- [ ] Performance profiled (no regressions)
- [ ] Error handling comprehensive
- [ ] Loading states implemented
- [ ] Empty states designed
- [ ] Mobile responsive

### Design Review Checklist

- [ ] Matches Figma mockups
- [ ] Uses Studio design tokens
- [ ] Animations smooth (60fps)
- [ ] Spacing consistent (8px grid)
- [ ] Typography correct (Inter font)
- [ ] Color contrast WCAG AA
- [ ] Focus states visible
- [ ] Hover states implemented

---

## 📞 Open Questions & Decisions Needed

1. **Should we expose raw vs cleaned HTML URLs?**
   - Pro: Transparency, debugging
   - Con: Confusing for users

2. **Should preferences be account-level or workspace-level?**
   - Account: User-specific across workspaces
   - Workspace: Team-shared preferences

3. **How to handle very large sitemaps (>10,000 URLs)?**
   - Option A: Prompt user to set max pages
   - Option B: Auto-paginate into multiple jobs
   - Option C: Reject and suggest manual URL list

4. **Should we allow scheduling in MVP or Phase 4?**
   - MVP: More valuable upfront
   - Phase 4: Less scope creep

5. **Expose internal strategy names or user-friendly names?**
   - Internal: "browser", "bulk", "hybrid"
   - Friendly: "Smart", "Fast", "Thorough"

---

## 🎉 Success Criteria

### User Metrics

- [ ] **Adoption**: >60% of SearchAI users try crawler
- [ ] **Completion**: >85% of started crawls finish
- [ ] **Satisfaction**: >4.5/5 user rating
- [ ] **Efficiency**: <2 minutes avg time to first crawl

### Technical Metrics

- [ ] **Reliability**: >99% job success rate
- [ ] **Performance**: <3s profiling, <1s updates
- [ ] **Quality**: >85 avg quality score
- [ ] **Scale**: Handles 1000 URLs without degradation

### Business Metrics

- [ ] **Engagement**: Users crawl 3+ sites per week
- [ ] **Retention**: >80% return within 7 days
- [ ] **Growth**: 20% MoM increase in crawl jobs
- [ ] **Value**: 50% of SearchAI content from crawler

---

**Last Updated**: 2026-03-04
**Owner**: Platform Team
**Status**: Ready for Implementation
**Next Steps**: Review with team → Create Figma mockups → Start Phase 1

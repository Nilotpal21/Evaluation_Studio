# Web Crawler UI Design Proposal

## Smart, User-Friendly Crawling Experience

> **Design Philosophy**: Make the complex simple. Our backend is intelligent enough to handle 90% of decisions automatically. The UI should reflect this intelligence and only surface complexity when truly needed.

---

## 🎯 Design Principles

### 1. **Progressive Disclosure** (Matches Backend Logic)

- Start with the simplest possible interface (just URL + button)
- Reveal advanced options only when:
  - User explicitly requests them
  - System detects ambiguity (low confidence <80%)
  - User has history of customization

### 2. **Intelligence First**

- Let the FastProfiler + DecisionEngine do the heavy lifting
- Show users _what_ the system decided and _why_
- Allow override with single click, not complex forms

### 3. **Instant Feedback**

- Real-time URL validation and preview
- Site profiling results shown immediately
- Visual confidence indicators

### 4. **Learning System**

- Remember user preferences per domain
- Fewer prompts over time (aligns with backend's skip rules)
- Smart defaults based on history

---

## 🎨 UI Flow Design

### **Flow 1: Simple Crawl (90% of users)**

```
┌─────────────────────────────────────────────────────────┐
│  🔍  Add Web Content to Knowledge Base                  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Enter website URL                                       │
│  ┌─────────────────────────────────────────────────┐   │
│  │ https://docs.example.com                        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                          │
│  [✓] Auto-detect best crawl strategy                    │
│  [Advanced Options ▼]                                   │
│                                                          │
│         [Cancel]              [Start Crawling]          │
└─────────────────────────────────────────────────────────┘
```

**UX Features:**

- **As-you-type validation** with visual feedback (green checkmark, red x)
- **Real-time site preview** (fetch favicon, title, description)
- **One-click action** for 90% of cases
- **Minimalist** by default

### **Flow 2: Intelligent Profiling (Auto-detection)**

When user clicks "Start Crawling", show progress overlay:

```
┌─────────────────────────────────────────────────────────┐
│  🧠  Analyzing Website...                               │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────────────┐      │
│  │  ✓  Site profiled                            │      │
│  │  ✓  Structure analyzed                       │      │
│  │  ✓  Strategy selected                        │      │
│  │  ⏳  Preparing crawl...                      │      │
│  └──────────────────────────────────────────────┘      │
│                                                          │
│  📊  Detection Results                                  │
│  ─────────────────────────────────────────────────      │
│  Site Type:     Documentation (98% confidence)          │
│  Pages Found:   ~250 pages via sitemap                  │
│  Strategy:      Smart crawl with sitemap                │
│  Est. Time:     2-3 minutes                             │
│                                                          │
│  💡 This looks great! Starting automatic crawl...       │
│                                                          │
│  [Wait, I want to customize ▼]                          │
└─────────────────────────────────────────────────────────┘
```

**UX Features:**

- **2-3 second profiling** (show actual FastProfiler results)
- **High confidence (≥80%)** → proceed automatically after 2s countdown
- **Low confidence (<80%)** → show customization prompt
- **Transparent AI** - show what was detected and why

### **Flow 3: Customization Prompt (Low Confidence)**

When confidence is low, show intelligent questions:

```
┌─────────────────────────────────────────────────────────┐
│  🤔  Help us crawl this site better                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  We detected: E-commerce site (mixed content)           │
│  Confidence: 62%                                         │
│                                                          │
│  ❓ What type of content do you want to capture?        │
│                                                          │
│  ○  Product pages and descriptions                      │
│  ○  Blog posts and articles                             │
│  ○  Documentation and help pages                        │
│  ●  Everything (comprehensive crawl)                    │
│                                                          │
│  ❓ How deep should we crawl?                           │
│                                                          │
│  ─────●──────────────────── 250 pages                  │
│  1                    500                 1000          │
│                                                          │
│  [✓] Remember my preference for example.com             │
│                                                          │
│         [Cancel]              [Start Crawling]          │
└─────────────────────────────────────────────────────────┘
```

**UX Features:**

- **Contextual questions** (generated by QuestionGenerator)
- **Visual slider** instead of number input
- **Domain memory** (checkbox to save preference)
- **2-4 questions max** (not overwhelming)

### **Flow 4: Advanced Options (Power Users)**

When user clicks "Advanced Options":

```
┌─────────────────────────────────────────────────────────┐
│  ⚙️  Crawl Configuration                                │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Crawl Strategy                                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Auto-detect (Recommended)               [✓]    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                          │
│  Or choose manually:                                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │ • Single Page Only                              │   │
│  │ • Sitemap Discovery                             │   │
│  │ • Smart Crawl (pages + depth)                   │   │
│  │ • Limited (max pages)                           │   │
│  │ • Full Site                                     │   │
│  └─────────────────────────────────────────────────┘   │
│                                                          │
│  Limits                                                  │
│  Max Pages:     [  250  ▼]  (1-1000)                   │
│  Max Depth:     [   3   ▼]  (1-10)                     │
│  Max Duration:  [  30   ▼]  minutes                    │
│                                                          │
│  Discovery                                               │
│  [✓] Use sitemap for URL expansion                      │
│  [✓] Follow internal links                              │
│  [✓] Respect robots.txt                                 │
│  [ ] Extract metadata                                    │
│                                                          │
│  JavaScript Handling                                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Auto-detect (Recommended)               [✓]    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                          │
│         [Reset to Defaults]       [Start Crawling]      │
└─────────────────────────────────────────────────────────┘
```

**UX Features:**

- **Collapsible sections** (only show when needed)
- **Tooltips** with examples for each option
- **Presets** for common scenarios
- **Reset** button to clear customizations

---

## 📊 Real-Time Progress Dashboard

Based on `/api/crawl/dashboard/:jobId` endpoint:

```
┌─────────────────────────────────────────────────────────────────────┐
│  🚀  Crawling: docs.example.com                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ████████████████████████░░░░░░░░  65%  (Phase: Ingesting)         │
│                                                                      │
│  ┌──────────────────┬──────────────────┬──────────────────────┐    │
│  │  📥 Crawling     │  📝 Ingesting    │  🧠 Embedding        │    │
│  │                  │                  │                      │    │
│  │  152 / 250       │  98 / 152        │  45 / 98            │    │
│  │  ✓ Complete      │  ⏳ Active       │  ⏳ Pending         │    │
│  └──────────────────┴──────────────────┴──────────────────────┘    │
│                                                                      │
│  Timeline                                                            │
│  Started:    2:45 PM  (3 minutes ago)                               │
│  Est. End:   2:52 PM  (4 minutes remaining)                         │
│                                                                      │
│  Quality Metrics                                                     │
│  Avg Quality:     92/100  (Excellent)                               │
│  Success Rate:    97%                                                │
│  Chunks/Doc:      8.5 avg                                           │
│                                                                      │
│  ⚠️  Issues (3)                                                      │
│  • 2 pages failed (timeout)                                         │
│  • 1 page blocked by robots.txt                                     │
│                                                                      │
│         [View Details ▶]              [Cancel Crawl]                │
└─────────────────────────────────────────────────────────────────────┘
```

**UX Features:**

- **Multi-phase progress** (crawl → ingest → extract → embed → index)
- **Real-time updates** via WebSocket
- **Quality indicators** (from backend metrics)
- **Expandable errors** (not overwhelming)
- **Estimated time** (learning-based)

---

## 🔍 Smart URL Input Component

### Features:

#### 1. **Instant Validation**

```typescript
// As user types:
- ✓ Valid URL
- ✗ Invalid format
- ⚠️ Requires authentication
- 📝 Detected: Documentation site
```

#### 2. **Site Preview Card**

When user pauses typing (500ms debounce):

```
┌─────────────────────────────────────────────────────────┐
│  📄  Site Preview                                        │
├─────────────────────────────────────────────────────────┤
│  🌐  Acme Corp Documentation                            │
│  📊  ~250 pages detected via sitemap                    │
│  🏷️  Static HTML site (fast crawl)                      │
│  ⏱️  Est. 2-3 minutes                                    │
│                                                          │
│  💡  Tip: We can auto-discover all pages via sitemap!   │
└─────────────────────────────────────────────────────────┘
```

#### 3. **Bulk URL Input (Advanced)**

```
┌─────────────────────────────────────────────────────────┐
│  Enter URLs (one per line, up to 1000)                  │
│  ┌─────────────────────────────────────────────────┐   │
│  │ https://docs.example.com/getting-started        │   │
│  │ https://docs.example.com/api-reference          │   │
│  │ https://docs.example.com/tutorials              │   │
│  │                                                  │   │
│  └─────────────────────────────────────────────────┘   │
│                                                          │
│  ✓  3 valid URLs                                        │
│  ⚠️  Tip: Enter just the root URL to crawl entire site  │
│                                                          │
│  [Clear]  [Import from file...]                         │
└─────────────────────────────────────────────────────────┘
```

---

## 🎯 Strategy Selection (Visual)

Instead of dropdown, use **visual cards**:

```
┌──────────────────────────────────────────────────────────────────┐
│  Choose Crawl Strategy                                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐│
│  │ 📄 Single  │  │ 🗺️ Sitemap │  │ 🧠 Smart   │  │ 🌐 Full    ││
│  │  Page      │  │  Discovery │  │   Crawl    │  │  Site      ││
│  │            │  │            │  │            │  │            ││
│  │ Just this  │  │ Use        │  │ Auto-      │  │ Everything ││
│  │ one page   │  │ sitemap to │  │ discover & │  │ (careful!) ││
│  │            │  │ find pages │  │ follow     │  │            ││
│  │ ⚡ Instant │  │ ⚡ Fast    │  │ ⚖️ Balanced│  │ 🐌 Slow   ││
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘│
│                                   ↑ Recommended                  │
└──────────────────────────────────────────────────────────────────┘
```

**UX Features:**

- **Visual metaphors** (icons convey meaning)
- **Speed indicators** (instant, fast, balanced, slow)
- **Recommended badge** (based on profiling)
- **Hover tooltips** with details

---

## 🚦 Status Indicators (Visual Language)

### Crawl Phase Badges:

```
🟦 Queued      →  🟨 Crawling  →  🟧 Ingesting  →
🟩 Indexed     or  🟥 Failed
```

### Quality Scores (Color-coded):

```
95-100: 🟢 Excellent
80-94:  🟡 Good
60-79:  🟠 Fair
<60:    🔴 Poor
```

### Confidence Indicators:

```
≥80%:   High confidence   (auto-proceed)
60-79%: Medium confidence (ask 1-2 questions)
<60%:   Low confidence    (show customization)
```

---

## 🎓 Onboarding & Education

### First-Time User Experience:

```
┌─────────────────────────────────────────────────────────┐
│  👋  Welcome to Smart Web Crawling!                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Just paste a URL and we'll handle the rest:            │
│                                                          │
│  ✓  Automatically detect site structure                 │
│  ✓  Choose the best crawl strategy                      │
│  ✓  Extract clean, readable content                     │
│  ✓  Index for instant search                            │
│                                                          │
│  Try it with a docs site like:                          │
│  • https://docs.anthropic.com                           │
│  • https://nextjs.org/docs                              │
│                                                          │
│         [Got it!]              [Take a tour →]          │
└─────────────────────────────────────────────────────────┘
```

### Contextual Help (Tooltips):

- **Strategy names**: Hover to see explanation + example sites
- **Limits**: Show impact ("250 pages = ~5 min crawl time")
- **Options**: Link to docs for deep dives

---

## 📱 Responsive Design Considerations

### Mobile/Tablet:

- **Simplified form** (auto-detect only, no advanced options)
- **Bottom sheet** for progress (not modal)
- **Swipe gestures** for crawl history

### Desktop:

- **Split view** (form left, preview right)
- **Keyboard shortcuts** (Cmd+Enter to submit)
- **Drag & drop** for bulk URL files

---

## 🔄 User Preference Learning

### Saved Preferences UI:

```
┌─────────────────────────────────────────────────────────┐
│  🧠  Your Crawl Preferences                             │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  docs.example.com                                        │
│  Strategy: Sitemap Discovery • Max: 500 pages           │
│  [Edit]  [Delete]                                       │
│  ────────────────────────────────────────────────────   │
│                                                          │
│  *.wikipedia.org                                         │
│  Strategy: Single Page • Auto-decide: Yes               │
│  [Edit]  [Delete]                                       │
│  ────────────────────────────────────────────────────   │
│                                                          │
│         [Clear All Preferences]                          │
└─────────────────────────────────────────────────────────┘
```

**Features:**

- **Domain patterns** (exact or wildcard)
- **Quick edit** inline
- **Clear all** for reset

---

## 🎨 Visual Design System

### Color Palette:

```
Primary Actions:   #3B82F6  (Blue - trustworthy)
Success States:    #10B981  (Green - complete)
Warning States:    #F59E0B  (Amber - caution)
Error States:      #EF4444  (Red - failed)
Neutral:           #6B7280  (Gray - metadata)
Background:        #F9FAFB  (Light gray)
```

### Typography:

```
Headings:          Inter SemiBold, 16-24px
Body:              Inter Regular, 14px
Code/URLs:         JetBrains Mono, 13px
Status Text:       Inter Medium, 12px
```

### Spacing:

```
Compact:           8px  (between related items)
Standard:          16px (between sections)
Generous:          24px (between major areas)
```

---

## 🧪 Smart Features (Leveraging Backend Intelligence)

### 1. **Auto-Retry with Strategy Fallback**

```
If Smart Crawl fails → Try Sitemap Discovery
If Sitemap fails → Fallback to Bulk Crawl
```

**UI**: Show fallback notification with reason

### 2. **Quality-Based Recommendations**

```
If avg quality < 70% → Suggest:
"This site has a lot of ads and navigation.
 Try enabling 'Aggressive Cleanup' mode?"
[Yes, re-crawl]  [No, keep as-is]
```

### 3. **Duplicate Detection**

```
⚠️  This URL was already crawled 2 days ago (250 pages).

Options:
○  Skip (use existing content)
○  Update changed pages only
●  Re-crawl everything

[Continue]
```

### 4. **Comparison View** (After Re-crawl)

```
┌─────────────────────────────────────────────────────────┐
│  📊  Crawl Comparison                                   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Previous:   250 pages • 85/100 quality                 │
│  Current:    265 pages • 92/100 quality  (+7 ✓)        │
│                                                          │
│  Changes:                                                │
│  • 15 new pages added                                   │
│  • 8 pages updated                                      │
│  • Quality improved +7pts                               │
│                                                          │
│  [View Details]                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 🔧 Technical Implementation Notes

### Frontend Stack:

```typescript
// Component structure
/components/search-ai/
  CrawlerTab.tsx              // Main tab in SearchAI UI
  CrawlJobForm.tsx            // URL input + options
  CrawlJobProgress.tsx        // Real-time dashboard
  CrawlJobHistory.tsx         // Past crawls list
  CrawlPreferences.tsx        // Saved preferences

// API calls
/api/search-ai/
  crawl.ts                    // POST /batch, /batch/respond, GET /status

// Real-time updates
- WebSocket connection to /api/crawl/dashboard/:jobId
- Polling fallback (5s interval)
```

### State Management:

```typescript
interface CrawlState {
  // Form state
  url: string;
  mode: 'simple' | 'advanced';
  customStrategy?: Strategy;

  // Profiling state
  isProfiled: boolean;
  profile?: SiteProfile;
  confidence: number;

  // Execution state
  jobId?: string;
  phase: CrawlPhase;
  progress: number;

  // Results
  dashboard?: CrawlDashboard;
  errors: CrawlError[];
}
```

### Accessibility:

- **ARIA labels** for all interactive elements
- **Keyboard navigation** (Tab, Enter, Escape)
- **Screen reader** announcements for status changes
- **Focus management** in modals
- **Color contrast** WCAG AA compliant

---

## 📊 Analytics & Metrics

Track these metrics to improve UX:

1. **Conversion Rate**: % users who complete crawl after starting
2. **Strategy Selection**: Which strategies are most popular?
3. **Customization Rate**: % users who use advanced options
4. **Question Skip Rate**: How often do users skip prompts?
5. **Re-crawl Frequency**: Do users re-crawl same sites?

---

## 🚀 Phased Rollout

### Phase 1: MVP (Week 1-2)

- Simple URL input
- Auto-detect strategy
- Basic progress indicator
- Job history list

### Phase 2: Intelligence (Week 3-4)

- Site profiling with preview
- Progressive disclosure prompts
- Advanced options panel
- Saved preferences

### Phase 3: Polish (Week 5-6)

- Real-time dashboard
- Quality metrics display
- Comparison view
- Bulk URL import

### Phase 4: Advanced (Week 7+)

- Scheduling & recurring crawls
- Webhook notifications
- API access for power users
- Custom extraction rules

---

## 💡 Key UX Decisions & Rationale

| Decision                   | Rationale                                  | Backend Alignment                         |
| -------------------------- | ------------------------------------------ | ----------------------------------------- |
| **Auto-detect by default** | 90% of users don't want to choose strategy | FastProfiler + DecisionEngine handle this |
| **Progressive disclosure** | Only show complexity when needed           | Matches PromptEvaluator's 5 skip rules    |
| **Visual strategy cards**  | Easier to understand than dropdown         | Aligns with strategy types in backend     |
| **Real-time dashboard**    | Users want transparency during crawl       | `/dashboard/:jobId` provides all data     |
| **Save preferences**       | Reduce friction for repeat crawls          | UserCrawlPreference model supports this   |
| **Quality indicators**     | Help users understand results              | Backend already calculates these metrics  |

---

## 🎯 Success Metrics

### User Experience:

- **Time to first crawl**: <60 seconds from URL paste
- **Completion rate**: >85% of started crawls finish
- **Customization rate**: <20% (most users use defaults)
- **User satisfaction**: >4.5/5 rating

### Technical:

- **Profiling time**: <3 seconds
- **UI responsiveness**: <100ms interactions
- **Real-time updates**: <1s latency
- **Error recovery**: Auto-retry 95% of transient failures

---

## 📚 Inspiration & Research

### Best Practices Analyzed:

1. **Vercel Deploy UI** - Progressive disclosure, real-time status
2. **GitHub Actions** - Phase-based progress, expandable errors
3. **Algolia Crawler** - Smart detection, visual strategy cards
4. **Apify** - Bulk URL handling, scheduling
5. **Google Search Console** - URL inspection, quality scores

### Academic Research:

- **Progressive Disclosure** (Nielsen Norman Group): Show options gradually
- **Recognition over Recall** (Hick's Law): Visual cards > dropdowns
- **Feedback Loops** (UX Laws): Show status constantly during async tasks
- **Smart Defaults** (Design of Everyday Things): 80/20 rule - optimize for common case

---

## 🎬 Next Steps

1. **Review & Discuss** this proposal with team
2. **Prototype** simple flow in Figma/Sketch
3. **User Testing** with 5-10 target users
4. **Iterate** based on feedback
5. **Implement** in phases (MVP → Intelligence → Polish)

---

## 📞 Questions for Product/Design Review

1. Should we prioritize mobile experience or desktop-first?
2. Do we want scheduling/recurring crawls in MVP or Phase 4?
3. Should we expose "force re-crawl" or auto-detect duplicates?
4. How much technical detail (strategy internals) should we show?
5. Should preferences be account-level or workspace-level?

---

**Created**: 2026-03-04
**Author**: Claude (Platform Architect)
**Backend Analysis**: Based on `/apps/search-ai/src/routes/crawl.ts` + `/packages/crawler/`
**Status**: Draft for Review

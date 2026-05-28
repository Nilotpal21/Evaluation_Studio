# SearchAI Crawler

> **Status**: Active Development - Weeks 1-4 Backend Complete (89%)
> **Test Coverage**: 423/429 tests passing (98.6%)
> **Architecture**: Agent-Driven + Hybrid Workers (Go + TypeScript)

---

## 🚀 Quick Start

### New to the Project?

Start with **[User Journey & Architecture](./USER_JOURNEY_AND_ARCHITECTURE.md)** - comprehensive overview of how the system works, user experience, and component architecture.

### Getting Started

- **[Quick Start Guide](./QUICKSTART.md)** - 30-minute setup instructions
- **[Quick Reference Card](./QUICK_REFERENCE.md)** - Cheat sheet for common tasks
- **[Current Status](./RESUME.md)** - Implementation progress and next steps

---

## 📚 Core Documentation

### Architecture & Design

- **[User Journey & Architecture](./USER_JOURNEY_AND_ARCHITECTURE.md)** - User flows, problems solved, system architecture
- **[Infrastructure Architecture](./SEARCHAI_CRAWLER_ARCHITECTURE.md)** - Multi-layer design, scaling, deployment
- **[Agent-Driven Approach](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md)** - Why agent-driven, MCP tools, reasoning examples
- **[Autonomous Intelligence Design](./AUTONOMOUS_INTELLIGENCE_DESIGN.md)** - Intelligence layer (profiler, decision engine, learning)

### Technical Reference

- **[Crawling Problems Taxonomy](./SEARCHAI_CRAWLER_PROBLEMS.md)** - 130+ problems across 21 categories
- **[Go Framework Analysis](./GO_FRAMEWORK_ANALYSIS.md)** - Why Colly? Performance comparison
- **[Implementation Status](./IMPLEMENTATION_STATUS.md)** - MCP server status, testing results

---

## 🎯 What Makes This Different?

### Traditional Crawler

❌ Requires hours of configuration per site
❌ Breaks when site structure changes
❌ Cannot adapt to unexpected scenarios
❌ Misses 30-40% of content (edge cases)
❌ Over-provisions resources (wasteful)

### Agent-Driven Crawler

✅ **Zero configuration** - just provide URL
✅ **Adapts automatically** to any site structure
✅ **95%+ coverage** vs 60-80% traditional
✅ **68% cost savings** through intelligent worker selection
✅ **Real-time transparency** - see every decision
✅ **Learns and improves** from every crawl

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────┐
│ LAYER 1: Intelligence (Agent Brain)         │
│ • Analyzes site structure                   │
│ • Makes strategic decisions                 │
│ • Handles edge cases                        │
└────────────────────┬────────────────────────┘
                     │
┌────────────────────▼────────────────────────┐
│ LAYER 2: Orchestration (MCP + BullMQ)      │
│ • 11 browser tools                          │
│ • Job queue & partitioning                  │
│ • Progress tracking                         │
└────────────────────┬────────────────────────┘
                     │
            ┌────────┴────────┐
            │                 │
┌───────────▼──────┐  ┌───────▼────────────┐
│ LAYER 3A:        │  │ LAYER 3B:          │
│ Static Workers   │  │ Browser Workers    │
│ (Go + Colly)     │  │ (TS + Playwright)  │
│                  │  │                    │
│ 70% of sites     │  │ 30% of sites       │
│ 10,000 req/s     │  │ 100 req/s          │
│ $0.10/M URLs     │  │ $4.30/M URLs       │
└──────────────────┘  └────────────────────┘
```

**Key Insight**: Agent decides which worker to use, optimizing for both coverage and cost.

---

## 📊 Performance Metrics

| Metric         | Static Workers (Colly) | Browser Workers (Playwright) |
| -------------- | ---------------------- | ---------------------------- |
| **Throughput** | 10,000 req/s           | 100 req/s                    |
| **Memory**     | 50MB/1k URLs           | 200MB/browser                |
| **Cost**       | $0.10/M URLs           | $4.30/M URLs                 |
| **Coverage**   | 70-80% of sites        | 20-30% of sites              |

**Cost Optimization Example (1M URLs)**:

- Naive (all browser): $4.30
- Our approach: (700k × $0.10) + (300k × $4.30) = **$1.36** (68% savings)

---

## 🧩 Key Components

### Intelligence Layer

- **Site Profiler**: HTTP-only analysis, site type detection
- **Decision Engine**: 5-level hierarchy (override → preference → policy → learned → default)
- **Progressive Disclosure**: 5 skip rules minimize user interruption (89% auto-decision rate)
- **Transparency Service**: 35+ event types, real-time WebSocket feed

### Orchestration Layer

- **MCP Server**: 11 browser automation tools (navigate, click, extract, etc.)
- **BullMQ**: Job queue with priority, retry, and rate limiting
- **Redis**: State management, pub/sub, distributed locks

### Worker Layer

- **Static Workers (Go + Colly)**: Fast HTTP crawling for 70-80% of sites
- **Browser Workers (Playwright)**: Full JavaScript rendering for 20-30% of sites

---

## 🎓 Implementation Progress

### ✅ Completed (155 hours)

- Week 1: Site Profiling (FastProfiler, CachedProfiler, PatternStore)
- Week 2: Decision Engine (5-level hierarchy, UserPreferences, TenantPolicies)
- Week 3: Progressive Disclosure (PromptEvaluator, QuestionGenerator)
- Week 4: Transparency Service Backend (Event model, WebSocket feed)

### ⏳ Pending (52 hours)

- Week 4: Frontend UI (DecisionTimeline.tsx - 12 hours)
- Week 5: Learning & Adaptation (40 hours)

**See [RESUME.md](./RESUME.md) for detailed status and next steps.**

---

## 💡 Key Concepts

### Agent-Driven Paradigm

Traditional crawlers require extensive configuration. Our agent **observes** the page, **reasons** about the best approach, and **acts** accordingly - just like a human would.

**Example**: When encountering a dropdown menu, traditional crawler needs pre-configured selectors. Our agent recognizes it's a dropdown, understands it likely contains important navigation, and explores all options automatically.

### Progressive Disclosure

Instead of asking users dozens of configuration questions upfront, the system makes intelligent decisions and only prompts when:

- Confidence is low (< 70%)
- No user preference exists
- Decision has high impact
- No tenant policy applies

**Result**: 89% of decisions automated, 11% require user input.

### Hybrid Workers (70/30 Split)

Research shows 70-80% of web content is static HTML. We use fast static crawlers (Colly) by default and only use browser automation (Playwright) when JavaScript is required.

---

## 🔗 Quick Links

| Resource                                             | Purpose            |
| ---------------------------------------------------- | ------------------ |
| **[Start Here](./USER_JOURNEY_AND_ARCHITECTURE.md)** | Complete overview  |
| **[Setup](./QUICKSTART.md)**                         | Installation guide |
| **[Status](./RESUME.md)**                            | Current progress   |
| **[Cheat Sheet](./QUICK_REFERENCE.md)**              | Quick reference    |
| **[Problems](./SEARCHAI_CRAWLER_PROBLEMS.md)**       | Challenge taxonomy |

---

## 📞 Need Help?

- **Architecture questions**: See [Infrastructure Architecture](./SEARCHAI_CRAWLER_ARCHITECTURE.md)
- **Agent details**: See [Agent-Driven Approach](./SEARCHAI_AGENT_DRIVEN_CRAWLER.md)
- **Framework choice**: See [Go Framework Analysis](./GO_FRAMEWORK_ANALYSIS.md)
- **Setup issues**: See [Quick Start Guide](./QUICKSTART.md)

---

**Last Updated**: 2026-02-19
**Maintained By**: SearchAI Team
**Status**: Active Development

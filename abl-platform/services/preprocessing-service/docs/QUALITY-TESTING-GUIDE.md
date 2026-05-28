# Quality Testing Guide: Measuring Preprocessing Impact on Retrieval

## Executive Summary

This guide explains how to measure whether adaptive preprocessing actually improves search quality, not just whether it makes "correct" preprocessing decisions.

**Three testing approaches:**

1. **Isolated Testing** (No service dependencies) - Fast, deterministic, good for development/CI
2. **End-to-End Testing** (Real services) - Realistic, tests full integration, good for staging
3. **Production A/B Testing** (Real users) - Ground truth, measures business impact

## Problem Statement

Current testing only validates:

- ✅ Does adaptive system select the right preprocessing strategy? (59% match rate)
- ✅ Does detection logic work correctly? (86% passing failure scenarios)

**But doesn't measure:**

- ❓ Does preprocessing actually improve search results?
- ❓ Do users find better documents faster?
- ❓ Does adaptive selection maintain quality while reducing cost?

## Solution: Multi-Level Quality Testing

### Level 1: Isolated Testing (Development/CI)

**Purpose:** Fast feedback during development, no infrastructure dependencies

**Setup:**

```bash
cd tests/quality
pip install -r requirements.txt
python3 test_retrieval_quality.py
```

**Architecture:**

```
Query → Preprocessing (Python) → Embedding (TF-IDF) → Vector Search (NumPy) → Metrics
```

**Metrics Measured:**

- **Recall@10**: % of relevant docs in top 10 results (0-1)
- **Precision@10**: % of top 10 results that are relevant (0-1)
- **MRR**: Mean Reciprocal Rank of first relevant result (0-1)
- **NDCG@10**: Ranking quality with graded relevance (0-1)

**Example Output:**

```
Configuration     Recall@10    Precision@10    MRR      NDCG@10
--------------------------------------------------------------------------------
baseline          0.653        0.420           0.712    0.681
full              0.782        0.534           0.823    0.792    (+16% NDCG)
adaptive          0.771        0.521           0.815    0.783    (+15% NDCG)
optimal           0.798        0.548           0.835    0.805    (+18% NDCG)
```

**Interpretation:**

- Full preprocessing improves NDCG by 16% vs baseline
- Adaptive achieves 97% of optimal quality (0.783 / 0.805)
- Adaptive is good enough for production

**Pros:**

- ✅ Fast (< 1 minute for 100 queries)
- ✅ Deterministic (same results every run)
- ✅ No service dependencies
- ✅ Easy to debug
- ✅ Works in CI/CD

**Cons:**

- ❌ Simplified embeddings (TF-IDF, not production-quality)
- ❌ Small corpus (20-100 docs, not realistic scale)
- ❌ Doesn't test service integration

**When to Use:**

- Development iterations
- Pre-commit testing
- CI/CD quality gates
- Quick validation of changes

### Level 2: End-to-End Testing (Staging)

**Purpose:** Validate with real services before production

**Setup:**

```bash
# Start services locally or use staging
cd tests/quality
python3 test_e2e_quality.py --env staging
```

**Architecture:**

```
Query → Preprocessing Service (HTTP) → Embedding Service (HTTP) → Vector DB (Qdrant) → Metrics
```

**Additional Metrics:**

- **Latency**: End-to-end query processing time
- **Error Rate**: % of queries that fail
- **Cache Hit Rate**: % of queries served from cache

**Example Output:**

```
Configuration     Recall@10    Precision@10    MRR      Latency (ms)
--------------------------------------------------------------------------------
baseline          0.698        0.445           0.734    12.3
full              0.814        0.567           0.851    45.7    (+3.7x latency)
adaptive          0.806        0.559           0.843    28.4    (+2.3x latency)
```

**Interpretation:**

- Full preprocessing: +16.6% quality, +271% latency
- Adaptive preprocessing: +15.5% quality, +131% latency
- Adaptive achieves 99% of full quality at 62% of the latency cost

**Pros:**

- ✅ Production-realistic embedding quality
- ✅ Tests full service integration
- ✅ Measures real latency impact
- ✅ Can test against staging data

**Cons:**

- ❌ Slower (network + service overhead)
- ❌ Requires infrastructure
- ❌ Non-deterministic (service availability)
- ❌ Harder to debug failures

**When to Use:**

- Pre-production validation
- Integration testing
- Performance benchmarking
- Staging environment verification

### Level 3: Production A/B Testing (Real Users)

**Purpose:** Measure real business impact with real queries and users

**Setup:**

```typescript
// In search service
const strategy = Math.random() < 0.1 ? 'adaptive' : 'full';

const preprocessed = await preprocessingService.preprocess(query, {
  strategy,
  tenantId,
  experimentGroup: strategy,
});

// Log event for analysis
await analytics.track({
  event: 'search_performed',
  experimentGroup: strategy,
  query,
  resultsCount: results.length,
  hadClick: false, // Updated on click
});
```

**Metrics Measured:**

- **CTR (Click-Through Rate)**: % of queries with ≥1 click
- **Null Result Rate**: % of queries with 0 results
- **Query Reformulation Rate**: % of queries followed by retry within 30s
- **Session Success Rate**: % of sessions ending with click (not reformulation)
- **Mean Time to Click**: Average time from query to first click
- **Cost per Query**: Compute cost (latency × CPU)

**Example Dashboard:**

```
Metric                    Baseline    Full        Adaptive    Improvement
------------------------------------------------------------------------------
CTR                       42.3%       48.7%       48.1%       +13.7%
Null Result Rate          12.5%       8.3%        8.7%        -30.4%
Query Reformulation       18.2%       14.1%       14.6%       -19.8%
Mean Time to Click (s)    8.4         7.1         7.3         -13.1%
Avg Latency (ms)          15          52          31          +107%
Cost per Query            $0.0012     $0.0041     $0.0024     +100%
```

**Interpretation:**

- Adaptive improves CTR by 13.7% vs baseline
- Reduces null results by 30.4%
- Costs 2x baseline but 41% less than full preprocessing
- **ROI**: 13.7% better UX at 100% cost → positive

**Implementation:**

```python
# Sample size calculation
from scipy import stats

def required_sample_size(baseline_ctr=0.42, mde=0.02, alpha=0.05, power=0.8):
    """
    Calculate required sample size for A/B test

    baseline_ctr: Current CTR (42%)
    mde: Minimum detectable effect (2% absolute improvement)
    alpha: Significance level (5%)
    power: Statistical power (80%)
    """
    z_alpha = stats.norm.ppf(1 - alpha/2)
    z_beta = stats.norm.ppf(power)

    p1 = baseline_ctr
    p2 = baseline_ctr + mde
    p_pooled = (p1 + p2) / 2

    n = ((z_alpha + z_beta) ** 2 * 2 * p_pooled * (1 - p_pooled)) / (p2 - p1) ** 2

    return int(n) * 2  # Per group, so total = 2n

# Example: Detecting 2% CTR improvement
n = required_sample_size(baseline_ctr=0.42, mde=0.02)
print(f"Need {n:,} queries per group = {n*2:,} total queries")
# Output: Need 3,842 queries per group = 7,684 total queries

# At 1000 queries/day → 8 days of testing
```

**Pros:**

- ✅ Ground truth (real users, real queries)
- ✅ Measures business impact (CTR, null rate)
- ✅ Validates assumptions at scale
- ✅ Detects unexpected issues

**Cons:**

- ❌ Slow (need statistical significance)
- ❌ Risk of degrading UX (mitigation: start at 1-5% traffic)
- ❌ Complex analysis (confounding factors)
- ❌ Can't test everything (too many combinations)

**When to Use:**

- Final validation before full rollout
- Measuring business impact
- Validating improvements vs. baselines
- Long-term monitoring

## Ground Truth Dataset Creation

**Goal:** 100-200 queries with relevance judgments (which docs are relevant?)

### Option 1: Manual Curation (Recommended for Precision)

**Process:**

1. Sample 200 representative queries from production logs
   - 40% typo queries (spelling errors)
   - 30% synonym queries (need term expansion)
   - 20% conversational queries (natural language)
   - 10% mixed edge cases

2. For each query, search and mark relevant docs:
   - 0 = Not relevant
   - 1 = Marginally relevant
   - 2 = Relevant
   - 3 = Highly relevant

3. Have 2-3 annotators label each query independently
4. Resolve disagreements (accept if 2/3 agree, discuss others)
5. Compute inter-annotator agreement (Cohen's kappa > 0.7 is good)

**Example:**

```json
{
  "query_id": "001",
  "query": "how to deplyo kubernetes app",
  "relevant_docs": [
    { "doc_id": "doc_001", "relevance": 3, "annotator_agreement": 1.0 },
    { "doc_id": "doc_003", "relevance": 2, "annotator_agreement": 0.67 },
    { "doc_id": "doc_011", "relevance": 1, "annotator_agreement": 1.0 }
  ],
  "expected_improvement_with_preprocessing": true,
  "preprocessing_helps_with": ["typo_correction: deplyo → deploy"]
}
```

**Cost:** ~2-4 hours per annotator for 200 queries

### Option 2: Crowdsourcing (Recommended for Scale)

**Process:**

1. Upload queries + candidate docs to crowdsourcing platform (MTurk, Scale AI)
2. Ask workers: "Is this document relevant to the query?"
3. Get 3-5 judgments per query-doc pair
4. Use majority vote or weighted average
5. Filter low-quality workers (inconsistent judgments)

**Cost:** ~$500-1000 for 200 queries × 10 docs × 3 workers = 6,000 judgments

### Option 3: Implicit Feedback (Production Data)

**Process:**

1. Log query → results → clicks for 1-2 weeks
2. Assume clicked docs are relevant (CTR as implicit relevance)
3. Weigh by dwell time (clicked + stayed 30s = highly relevant)
4. Use SERP position bias correction (lower results less likely to be clicked)

**Formula:**

```
relevance_score = (clicks / impressions) * dwell_time_weight * position_bias_correction
```

**Pros:**

- ✅ Free (uses existing data)
- ✅ Large scale (thousands of queries)
- ✅ Real user behavior

**Cons:**

- ❌ Noisy (clicks ≠ relevance always)
- ❌ Position bias (top results clicked more)
- ❌ Cold start (need existing traffic)

## Recommended Testing Strategy

### Phase 1: Development (Weeks 1-2)

- ✅ Create ground truth dataset (100 queries, manual curation)
- ✅ Implement isolated quality testing framework
- ✅ Run baseline measurements
- ✅ Target: NDCG@10 improvement of +10% (full vs baseline)

### Phase 2: Staging Validation (Week 3)

- ✅ Deploy to staging environment
- ✅ Run end-to-end tests with real services
- ✅ Validate latency within budget (<50ms P95)
- ✅ Target: <5% quality degradation vs full preprocessing

### Phase 3: Production A/B Test (Weeks 4-6)

- ✅ Roll out to 1% of traffic
- ✅ Monitor CTR, null rate, latency for 1 week
- ✅ If metrics hold: increase to 10%, then 50%, then 100%
- ✅ Target: +10% CTR, -20% null rate, <2x latency vs baseline

### Phase 4: Continuous Monitoring (Ongoing)

- ✅ Daily dashboard: CTR, null rate, latency, cost
- ✅ Weekly quality check: NDCG@10 on test set
- ✅ Monthly model retraining: Update complexity analyzer with production data

## FAQ

**Q: Why not just test in production without isolated/E2E testing?**
A: Risk of deploying broken changes that degrade UX. Isolated/E2E tests catch bugs before users see them.

**Q: How many queries do I need for statistical significance in A/B test?**
A: Depends on baseline CTR and minimum detectable effect. For 42% CTR and 2% absolute improvement: ~8,000 queries total (~4 days at 2000 queries/day).

**Q: What if adaptive preprocessing is worse than full preprocessing?**
A: That's valuable data! It means either: (1) complexity detection is wrong, or (2) all queries benefit from preprocessing (no need for adaptive). Use isolated tests to debug which.

**Q: Can I test without a vector database?**
A: Yes! Isolated testing uses in-memory numpy arrays. Good enough for development and CI.

**Q: How do I handle multilingual queries in quality testing?**
A: Either: (1) create multilingual ground truth dataset (annotators fluent in those languages), or (2) test per-language separately with native annotators.

**Q: What's a good NDCG@10 score?**
A: Depends on domain. Search engines: 0.7-0.8 is good. Internal knowledge base: 0.5-0.6 is common. Compare vs baseline, not absolute numbers.

## Next Steps

1. ✅ Review this guide
2. ✅ Create ground truth dataset (start with 50 queries manually)
3. ✅ Run isolated quality test: `python3 test_retrieval_quality.py`
4. ✅ Measure improvement: Does full preprocessing help? (+10% NDCG target)
5. ✅ Validate adaptive: Does adaptive match full quality? (>95% of full NDCG)
6. ✅ Deploy to staging: Run E2E tests
7. ✅ A/B test in production: 1% → 10% → 50% → 100% rollout

## References

- [Information Retrieval Metrics](<https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval)>)
- [NDCG Explained](https://en.wikipedia.org/wiki/Discounted_cumulative_gain)
- [A/B Testing Sample Size Calculator](https://www.evanmiller.org/ab-testing/sample-size.html)
- [Crowdsourcing Relevance Judgments](https://dl.acm.org/doi/10.1145/1376616.1376746)

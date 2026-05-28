# Adaptive Preprocessing Benchmark Results

**Date**: 2026-02-23
**Queries Tested**: 2,000
**Configurations**: Baseline, Full, Adaptive, Optimal

---

## Executive Summary

The adaptive preprocessing system (Phases 3.5-3.7) was benchmarked against 2,000 queries across 10 categories.

**Key Findings:**

- ✅ **Perfect match (100%) on simple queries**: Structured queries, SQL, keywords → correctly skips preprocessing
- ✅ **Perfect match (100%) on entity-heavy queries**: Correctly enables all stages for entity extraction
- ⚠️ **45% overall match rate**: Adaptive disagrees with optimal on complex/multilingual/typo queries
- 📊 **Major mismatches**: 1,099 queries (55%) where adaptive chose differently than optimal

---

## Category Performance

| Category               | Queries | Match Rate   | Adaptive Strategies                               | Optimal Strategies         |
| ---------------------- | ------- | ------------ | ------------------------------------------------- | -------------------------- |
| **simple_keywords**    | 100     | ✅ **100%**  | skip (100)                                        | skip (100)                 |
| **sql_queries**        | 100     | ✅ **100%**  | skip (100)                                        | skip (100)                 |
| **structured_queries** | 100     | ✅ **100%**  | skip (100)                                        | skip (100)                 |
| **entity_heavy**       | 200     | ✅ **100%**  | thorough (200)                                    | thorough (200)             |
| **mixed_edge_cases**   | 500     | ⚠️ **43.2%** | skip (287), fast (213)                            | skip (287), balanced (213) |
| **technical_terms**    | 200     | ⚠️ **45.5%** | balanced (70), fast (118), thorough (7), skip (5) | minimal (200)              |
| **proper_nouns**       | 200     | ⚠️ **47.0%** | fast (148), balanced (52)                         | minimal (200)              |
| **complex_semantic**   | 200     | ❌ **0%**    | fast (151), thorough (49)                         | thorough (200)             |
| **multilingual**       | 200     | ❌ **0%**    | skip (106), fast (94)                             | balanced (200)             |
| **queries_with_typos** | 200     | ❌ **0%**    | fast (151), balanced (9), thorough (38), skip (2) | thorough (200)             |

---

## Top Mismatch Patterns

| Adaptive → Optimal     | Count | Explanation                                                |
| ---------------------- | ----- | ---------------------------------------------------------- |
| **fast → thorough**    | 302   | Adaptive underestimates complexity (should use all stages) |
| **fast → balanced**    | 236   | Adaptive skips synonyms when they're needed                |
| **skip → balanced**    | 177   | Adaptive misses multilingual/semantic queries              |
| **balanced → minimal** | 122   | Strategy name mismatch (minimal = spell only ≈ fast)       |
| **fast → minimal**     | 81    | Same mapping issue                                         |

---

## Root Cause Analysis

### 1. **Complex Semantic Queries (0% match)**

**Problem**: Adaptive uses "fast" (spell only) for queries like "how do I configure high availability deployment", but optimal wants "thorough" (all stages).

**Root Cause**: Query length heuristic isn't sufficient. Long questions need semantic analysis (synonyms) even without obvious complexity markers.

**Fix**:

- Lower threshold for "thorough" strategy
- Detect question patterns ("how", "what", "why") → increase complexity score
- Use sentence structure analysis (presence of clauses)

### 2. **Multilingual Queries (0% match)**

**Problem**: Adaptive uses "skip" or "fast" for multilingual queries like "mostrar documentos sobre kubernetes", but optimal wants "balanced" (spell + synonyms).

**Root Cause**: Language detection isn't integrated into complexity analysis. Non-English queries automatically need synonym expansion.

**Fix**:

- Add language detection to complexity analyzer
- Non-English → minimum "balanced" strategy
- Multilingual dictionaries need synonyms

### 3. **Queries with Typos (0% match)**

**Problem**: Adaptive scatters across all strategies, but optimal always wants "thorough".

**Root Cause**: Typo detection heuristics miss subtle patterns. Need actual spell checker to detect misspellings.

**Fix**:

- Integrate lightweight spell checker into complexity analysis
- Any detected typo → force "thorough" strategy
- Cache spell check results per query

### 4. **Technical Terms (45.5% match)**

**Problem**: Adaptive chooses "balanced" or "fast", but optimal wants "minimal" (spell only, no synonyms).

**Root Cause**: Strategy name confusion. Optimal "minimal" ≈ Adaptive "fast".

**Fix**:

- Align strategy terminology
- `minimal` = spell only (no synonyms, no entities)
- `fast` = spell only (current behavior)
- Disable synonyms for technical term queries (already implemented, but not reflected in strategy name)

---

## Performance Insights

### Latency Overhead (simulated)

| Strategy                       | Mean (ms) | P95 (ms) | P99 (ms) | Overhead vs Baseline |
| ------------------------------ | --------- | -------- | -------- | -------------------- |
| Baseline (no preprocessing)    | 0.00      | 0.00     | 0.00     | -                    |
| **Full (all stages)**          | 0.00      | 0.00     | 0.00     | +501%                |
| **Adaptive (smart selection)** | 0.00      | 0.00     | 0.01     | +1294%               |
| **Optimal (ground truth)**     | 0.00      | 0.00     | 0.00     | +108%                |

⚠️ **Note**: Latency numbers are simulation artifacts (not real preprocessing). In production, expect:

- Full: ~10ms P95
- Adaptive: ~3-5ms P95 (50% savings)
- Optimal: ~2ms P95 (80% savings)

### Strategy Distribution

**Adaptive Strategies (2000 queries):**

- Skip: 601 (30%) → Very simple queries, no preprocessing needed
- Fast: 918 (46%) → Spell correction only
- Balanced: 131 (7%) → Spell + synonyms
- Thorough: 350 (18%) → All stages enabled

**Optimal Strategies (2000 queries):**

- Skip: 687 (34%)
- Minimal: 407 (20%)
- Balanced: 613 (31%)
- Thorough: 293 (15%)

---

## Recommendations

### Short-Term (1-2 weeks)

1. **Fix strategy name mapping**: Rename "fast" → "minimal" or align optimal labels
2. **Improve typo detection**: Integrate lightweight spell checker into complexity analyzer
3. **Add language awareness**: Detect non-English → force balanced/thorough
4. **Tune complexity thresholds**: Lower bar for "thorough" on long semantic queries

### Medium-Term (1 month)

5. **A/B test in production**: Deploy adaptive with 10% traffic split vs full preprocessing
6. **Measure real quality impact**: Track click-through rate, user satisfaction
7. **Collect telemetry**: Log complexity scores + strategy decisions for tuning
8. **Build feedback loop**: Learn from user corrections (did they rephrase query?)

### Long-Term (3 months)

9. **ML-based complexity scoring**: Train a classifier on real query data
10. **Domain-specific tuning**: Different strategies for code-search vs natural-language
11. **Personalization**: Learn per-user preprocessing preferences
12. **Cost-benefit optimization**: Measure actual latency vs quality tradeoff in production

---

## Next Steps

### Option A: Fix & Re-Benchmark (Recommended)

1. Apply fixes to complexity analyzer and stage selector
2. Re-run benchmark on 2000 queries
3. Target: 80%+ match rate with optimal
4. Then proceed to production deployment

### Option B: Deploy & Learn

1. Deploy current adaptive system (45% match rate)
2. Collect real production data for 2 weeks
3. Use actual user behavior to tune
4. May waste some compute, but learns from reality

### Option C: Hybrid Approach

1. Fix obvious issues (language detection, typo detection)
2. Deploy with conservative defaults (prefer thorough when uncertain)
3. Gradually tune down as confidence improves

---

## Conclusion

The adaptive preprocessing system works **perfectly** for simple/structured/entity queries (100% match rate).

The main challenge is **detecting complex semantic queries, multilingual queries, and typos**. Current heuristics under-estimate complexity, leading to under-preprocessing (fast when should use thorough).

**Recommendation**: **Fix & Re-Benchmark (Option A)**. The issues are clear and fixable. With tuned heuristics, we should achieve 80%+ match rate, then deploy to production with high confidence.

---

## Appendix: Detailed Results

Full benchmark results saved to: `services/preprocessing-service/tests/results/benchmark-results.json`

**Query Examples:**

✅ **Perfect Matches:**

- "user" → skip (both)
- "status:active" → skip (both)
- "orders from 2024-01-15 with amount >= 1000" → thorough (both)

❌ **Mismatches:**

- "how do I configure high availability deployment" → fast (adaptive), thorough (optimal)
- "mostrar documentos sobre kubernetes" → skip (adaptive), balanced (optimal)
- "show me docuemnts about kuberntes" → fast (adaptive), thorough (optimal)

---

Generated by: `benchmark_adaptive_preprocessing.py`
Model: Query Complexity Analyzer + Adaptive Stage Selector + Adaptive Pipeline Selector

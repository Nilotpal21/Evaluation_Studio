# Quick Start: Get Real Search Latency Numbers

**Time Required**: 5 minutes  
**Your KB ID**: `019d7c23-6b7a-7d73-a04d-b5788427fab7`

---

## Step 1: Get Fresh Auth Token (30 seconds)

```bash
# Open Studio in browser
open http://localhost:5173

# 1. Open DevTools (Cmd+Option+I on Mac, F12 on Windows)
# 2. Go to Network tab
# 3. Make any search query in Studio
# 4. Click on the /query request
# 5. Find "Authorization: Bearer ..." in Request Headers
# 6. Copy the entire token (starts with "eyJh...")
```

---

## Step 2: Update Benchmark Script (10 seconds)

```bash
# Open the file
code tools/real-kb-benchmark.ts

# Find line 6 and replace the token:
const AUTH_TOKEN = 'Bearer <PASTE_YOUR_TOKEN_HERE>';

# Save the file (Cmd+S / Ctrl+S)
```

---

## Step 3: Run Benchmark (2 minutes)

```bash
npx tsx tools/real-kb-benchmark.ts
```

**What happens**:

- Runs 20 different queries against your KB
- Measures total latency, search time, rerank time
- Collects result counts and relevance scores
- Calculates statistics (avg, P50, P90, P95)
- Saves results to JSON file

---

## Step 4: View Results (2 minutes)

### Console Output

You'll see something like:

```
================================================================================
ANALYTICS SUMMARY
================================================================================

Total Queries: 20
Successful: 20 (100.0%)

Overall Latency Statistics:
  Average: 847ms
  Min: 118ms
  Max: 1432ms
  P50 (median): 823ms
  P75: 1089ms
  P90: 1285ms
  P95: 1374ms

Latency by Query Type:
  SEMANTIC: avg=912ms, min=485ms, max=1432ms (n=7)
  HYBRID: avg=834ms, min=658ms, max=1108ms (n=5)
  STRUCTURED: avg=134ms, min=118ms, max=175ms (n=4)
  AGGREGATION: avg=228ms, min=189ms, max=287ms (n=4)

Reranking Impact:
  With Rerank: 891ms (n=12)
  Without Rerank: 402ms (n=8)
  Overhead: 489ms (54.9%)

Average Stage Breakdown:
  Vocabulary Resolution: 8ms (0.9%)
  Search Execution: 371ms (43.8%)
  Rerank: 442ms (52.2%)
  Total: 847ms

================================================================================
DETAILED RESULTS
================================================================================

Query                              | Type    | Total  | Search | Rerank | Results | Score
-----------------------------------------------------------------------------------------------
Q1: Semantic + Rerank (short)      | semanti | 912ms  | 450ms  | 462ms  |      10 |  0.89
Q2: Semantic + Rerank (medium)     | semanti | 934ms  | 438ms  | 496ms  |      10 |  0.92
Q3: Semantic No Rerank             | vector  | 458ms  | 458ms  |   -    |      10 |  0.84
Q4: Semantic + Rerank (long)       | semanti | 1089ms | 567ms  | 522ms  |      10 |  0.88
Q5: Hybrid + Rerank                | hybrid  | 845ms  | 402ms  | 443ms  |      10 |  0.91
Q6: Hybrid + Rerank + Filter       | hybrid  | 823ms  | 385ms  | 438ms  |       8 |  0.94
Q7: Hybrid No Rerank               | hybrid  | 395ms  | 395ms  |   -    |      10 |  0.87
Q8: Structured (single filter)     | structu | 118ms  | 118ms  |   -    |      15 |  N/A
Q9: Structured (multi filter)      | structu | 142ms  | 142ms  |   -    |      12 |  N/A
Q10: Aggregation (source_type)     | aggrega | 189ms  | 189ms  |   -    |       3 |  N/A
Q11: Aggregation (language)        | aggrega | 224ms  | 224ms  |   -    |       2 |  N/A
Q12: Semantic Short Query          | semanti | 845ms  | 398ms  | 447ms  |       5 |  0.86
Q13: Semantic topK=20              | semanti | 1124ms | 612ms  | 512ms  |      20 |  0.91
Q14: Semantic Full Pipeline        | semanti | 1432ms | 908ms  | 524ms  |      10 |  0.90
Q15: Hybrid Full Pipeline          | hybrid  | 1108ms | 643ms  | 465ms  |      10 |  0.93
Q16: Hybrid Multi-Filter           | hybrid  | 778ms  | 356ms  | 422ms  |       8 |  0.95
Q17: Vector Only                   | vector  | 423ms  | 423ms  |   -    |      10 |  0.83
Q18: Very Short                    | semanti | 867ms  | 402ms  | 465ms  |      10 |  0.81
Q19: Complex Query                 | semanti | 1045ms | 523ms  | 522ms  |      10 |  0.89
Q20: Structured Complex            | structu | 175ms  | 175ms  |   -    |      18 |  N/A
```

### JSON File

```bash
# View full results
cat tools/real-kb-benchmark-results.json

# Or open in editor
code tools/real-kb-benchmark-results.json
```

---

## Step 5: Interpret Your Results (2 minutes)

### Key Numbers to Look At

1. **Average Latency**: `847ms` in example above
   - **Good**: < 500ms
   - **Acceptable**: 500-1000ms
   - **Needs Optimization**: > 1000ms

2. **Rerank Overhead**: `489ms (54.9%)` in example
   - This is your **#1 optimization target**
   - Disabling rerank would save 489ms per query

3. **Query Type Performance**:
   - **Structured is 7x faster** than semantic (118ms vs 912ms)
   - Use structured queries for "list all X" operations

4. **P95 Latency**: `1374ms` in example
   - This is what your slowest users experience
   - Should be < 2000ms for acceptable UX

### What Your Numbers Mean

**If your average is 600-1000ms**:

- ✅ Normal for semantic search with reranking
- 💡 Consider disabling rerank for low-latency use cases

**If your average is > 1500ms**:

- ⚠️ Something is slow
- Check rerank overhead (should be ~400-500ms)
- Check search execution (should be ~300-500ms)
- May need GPU acceleration or faster APIs

**If your average is < 300ms**:

- 🎉 Excellent! Already optimized
- Likely using structured queries or no reranking

---

## Common Issues & Fixes

### Issue: All queries return 0 results

**Cause**: Auth token expired or wrong tenant ID

**Fix**:

```bash
# Get fresh token (Step 1)
# Update AUTH_TOKEN in tools/real-kb-benchmark.ts
# Run again
```

---

### Issue: "Invalid or expired token" error

**Cause**: Token expired (they last 15 minutes)

**Fix**: Get fresh token from DevTools (Step 1)

---

### Issue: Very fast queries (< 50ms) with 0 results

**Cause**: Index is empty or wrong index ID

**Fix**:

```bash
# Check if your KB has documents
mongo mongodb://localhost:27017/abl_platform --eval \
  "db.searchindexes.findOne({_id: '019d7c23-6b7a-7d73-a04d-b5788427fab7'})"

# Look for documentCount > 0
```

---

### Issue: Queries succeed but no latency breakdown

**Cause**: Search-ai-runtime not returning latency object

**Fix**: Total latency (wall-clock time) is still accurate. The breakdown shows:

- **Total**: Full end-to-end time
- **Search**: Embedding + kNN/BM25 time
- **Rerank**: Reranking API time

---

## What to Do With Your Numbers

### If Rerank Overhead > 400ms

**Recommendation**: Disable reranking for low-latency queries

```typescript
// In your search requests
{
  rerank: false; // Saves ~450ms, loses 5-15% relevance
}
```

**When to disable**:

- Chat interfaces (conversational queries)
- List/filter operations
- Simple lookups
- Any time you need < 500ms latency

**When to keep**:

- Research assistants
- Document discovery
- When relevance is critical
- When 800-1000ms is acceptable

---

### If Semantic Queries > 1200ms

**Recommendation**: Use hybrid or structured queries

```typescript
// Instead of semantic:
{ queryType: 'semantic', query: 'show PDFs', rerank: true }
// 1200ms

// Use structured:
{ queryType: 'structured', filters: [{field: 'source_type', operator: 'eq', value: 'pdf'}] }
// 120ms (10x faster!)
```

---

### If P95 > 2000ms

**Recommendation**: Optimize your slowest queries

1. **Check query type distribution** in results
2. **Identify slow patterns** (long queries? complex filters?)
3. **Set up monitoring** to track P95 over time
4. **Consider query timeout** (fail fast after 2s)

---

## Next Steps

### Today

- ✅ Run benchmark (you just did!)
- 📊 Analyze your specific bottlenecks
- 🎯 Pick top 1-2 optimizations

### This Week

- 🔧 Implement optimizations
- 📈 Set up ClickHouse monitoring dashboard
- 🔄 Re-run benchmark to measure improvement

### Ongoing

- 📊 Monitor P95 latency in production
- 🎯 Track optimization impact
- 🔄 Iterate based on real user feedback

---

## Full Documentation

For deeper analysis, see:

- **Architecture details**: `docs/analysis/search-tool-latency-breakdown.md`
- **Query patterns**: `docs/analysis/search-multi-query-analytics.md`
- **Benchmarking guide**: `docs/analysis/REAL-LATENCY-ANALYSIS-FRAMEWORK.md`
- **Overview**: `docs/analysis/README-LATENCY-ANALYSIS.md`

---

## Summary

You now have:

- ✅ Benchmark script ready to run
- ✅ Your KB ID configured
- ✅ Step-by-step instructions

**Just need**: Fresh auth token (30 seconds to get)

**Then run**: `npx tsx tools/real-kb-benchmark.ts`

**Get**: Real latency numbers specific to your system!

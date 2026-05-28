# A/B Test Plan: Sub-Product Hierarchy Validation

> **Status**: Ready for Execution
> **RFC**: RFC-001 Phase 1
> **Date**: 2026-03-04
> **Owner**: Search-AI Team
> **Blocking Requirement**: MUST pass before deploying Phase 1 sub-products

---

## Executive Summary

This A/B test validates that expanding the Financial Services taxonomy from **11 flat products** to **30 hierarchical products** (12 parent + 18 sub-products) does NOT degrade classification accuracy, latency, or cost beyond acceptable thresholds.

**Decision Framework:**

- ✅ **Deploy sub-products** if all acceptance criteria pass
- ❌ **Keep 11 flat products** if any criterion fails

---

## Test Hypothesis

**H0 (Null Hypothesis):**
Adding sub-product hierarchy has NO SIGNIFICANT negative impact on:

1. Classification accuracy (≥ -5% acceptable degradation)
2. Latency (≤ +100ms acceptable increase)
3. Cost per document (≤ +20% acceptable increase)

**H1 (Alternative Hypothesis):**
Sub-product hierarchy degrades classification quality, speed, or cost beyond acceptable thresholds.

**Test Type:** Two-tailed (we care about both improvements and degradations)

**Confidence Level:** 95% (p < 0.05)

---

## Test Variants

### Variant A: Flat Taxonomy (Current Production)

**Products (11 total):**

1. Mutual Funds
2. ETFs (Exchange-Traded Funds)
3. Individual Stocks
4. Bonds
5. 401(k) Plans
6. IRA (Individual Retirement Accounts)
7. Annuities
8. Wealth Management Services
9. Retirement Planning Services
10. Tax Planning Services
11. Life Insurance

**Characteristics:**

- Single-level hierarchy (no sub-products)
- Each document classified to one of 11 products
- Current production configuration

### Variant B: Hierarchical Taxonomy (Proposed)

**Products (30 total = 12 parent + 18 sub-products):**

**Parent Products (12):**

1. Mutual Funds
   - Index Funds
   - Actively Managed Funds
   - Target-Date Funds
2. ETFs
   - Equity ETFs
   - Bond ETFs
3. Individual Stocks
   - Growth Stocks
   - Value Stocks
   - Dividend Stocks
4. Bonds
   - Treasury Bonds
   - Municipal Bonds
5. 401(k) Plans
   - Traditional 401(k)
   - Roth 401(k)
6. IRA
   - Traditional IRA
   - Roth IRA
7. Annuities
   - Fixed Annuities
   - Variable Annuities
8. Wealth Management Services
9. Retirement Planning Services
10. Tax Planning Services
11. Life Insurance
    - Term Life Insurance
    - Permanent Life Insurance
12. Long-Term Care Insurance (NEW parent product)

**Characteristics:**

- Two-level hierarchy (parent + sub-products)
- Documents classified to sub-product if applicable, otherwise parent product
- Maintains backward compatibility (all original 11 products still exist)

---

## Test Dataset

### Sample Size

**Total Documents:** 1,000 financial services documents

**Distribution by Product (Variant A - 11 products):**

| Product                      | Document Count | Percentage |
| ---------------------------- | -------------- | ---------- |
| Mutual Funds                 | 200            | 20%        |
| ETFs                         | 100            | 10%        |
| Individual Stocks            | 150            | 15%        |
| Bonds                        | 100            | 10%        |
| 401(k) Plans                 | 100            | 10%        |
| IRA                          | 100            | 10%        |
| Annuities                    | 50             | 5%         |
| Wealth Management Services   | 50             | 5%         |
| Retirement Planning Services | 50             | 5%         |
| Tax Planning Services        | 50             | 5%         |
| Life Insurance               | 50             | 5%         |
| **Total**                    | **1,000**      | **100%**   |

**Rationale for Distribution:**

- Weighted toward high-volume products (Mutual Funds, Stocks, Bonds)
- Matches real-world document distribution in financial services knowledge bases
- Ensures statistical significance for each product (minimum 50 docs per product)

### Ground Truth Labeling

**Labeling Process:**

1. **Human Expert Review:** 3 financial services subject matter experts (SMEs) independently label each document
2. **Consensus Requirement:** Majority agreement (≥2/3) required for ground truth label
3. **Conflict Resolution:** Documents with no consensus excluded from test set
4. **Dual Labeling (Variant B):** SMEs also label documents with sub-product granularity
   - Example: "Index Fund" (sub-product) vs "Mutual Funds" (parent product)
   - If sub-product cannot be determined, label as parent product only

**Quality Gates:**

- Inter-rater agreement (Cohen's Kappa) ≥ 0.80 required
- If κ < 0.80, refine labeling guidelines and re-label

### Document Sources

**Real-World Documents from:**

- Vanguard prospectuses and fact sheets
- Fidelity investment guides
- Financial planning case studies
- Retirement account documentation
- Tax planning white papers
- Insurance policy summaries

**Document Types:**

- PDF prospectuses (40%)
- Markdown guides (20%)
- HTML web content (20%)
- DOCX policy documents (20%)

---

## Metrics and Measurement

### Primary Metrics

#### 1. Classification Accuracy

**Definition:** Percentage of documents correctly classified to ground truth product

**Formula:**

```
Accuracy = (Correct Classifications) / (Total Documents) × 100%
```

**Acceptance Criterion:**

```
Accuracy_B ≥ Accuracy_A - 5%
```

**Example:**

- If Variant A achieves 85% accuracy, Variant B must achieve ≥ 80% accuracy

#### 2. Precision per Product

**Definition:** For each product, what percentage of documents classified as that product are actually correct?

**Formula:**

```
Precision_product = (True Positives) / (True Positives + False Positives)
```

**Analysis:**

- Calculate precision for each of the 11 products in Variant A
- Calculate precision for each of the 30 products in Variant B
- **Report:**
  - Macro-average precision (average across all products)
  - Per-product precision for products with >50 documents

**Interpretation:**

- High precision = few false positives
- Low precision = classifier over-predicts this product

#### 3. Recall per Product

**Definition:** For each product, what percentage of actual documents for that product were correctly identified?

**Formula:**

```
Recall_product = (True Positives) / (True Positives + False Negatives)
```

**Analysis:**

- Calculate recall for each of the 11 products in Variant A
- Calculate recall for each of the 30 products in Variant B
- **Report:**
  - Macro-average recall (average across all products)
  - Per-product recall for products with >50 documents

**Interpretation:**

- High recall = few false negatives
- Low recall = classifier misses many documents for this product

#### 4. F1 Score

**Definition:** Harmonic mean of precision and recall

**Formula:**

```
F1 = 2 × (Precision × Recall) / (Precision + Recall)
```

**Analysis:**

- Macro-average F1 score across all products
- Per-product F1 score for major products

**Interpretation:**

- Balances precision and recall
- Better metric than accuracy for imbalanced datasets

### Secondary Metrics

#### 5. Average Confidence Score

**Definition:** Mean confidence score reported by Claude Haiku for classifications

**Formula:**

```
Avg_Confidence = Σ(Confidence_i) / N
```

**Analysis:**

- Compare Variant A vs Variant B average confidence
- Histogram of confidence distributions
- Correlation between confidence and correctness

**Interpretation:**

- Higher confidence = model is more certain
- Low confidence on correct classifications = under-confident
- High confidence on incorrect classifications = over-confident (calibration issue)

#### 6. Latency

**Definition:** Time taken to classify a single document

**Metrics:**

- **p50 (Median):** 50th percentile latency
- **p95:** 95th percentile latency
- **p99:** 99th percentile latency

**Acceptance Criterion:**

```
Latency_B_p95 ≤ Latency_A_p95 + 100ms
```

**Measurement:**

- Start timer before LLM API call
- Stop timer after classification result received
- Exclude network latency (measure LLM processing time only)

**Interpretation:**

- Longer prompt (30 products vs 11) → potentially longer latency
- +100ms is acceptable for improved granularity

#### 7. Cost per Document

**Definition:** LLM API cost to classify a single document

**Formula:**

```
Cost_per_doc = (Input_tokens × Input_price + Output_tokens × Output_price)
```

**Claude Haiku Pricing (as of 2026-03):**

- Input: $0.25 per 1M tokens
- Output: $1.25 per 1M tokens

**Acceptance Criterion:**

```
Cost_B ≤ Cost_A × 1.20 (≤ +20% increase)
```

**Measurement:**

- Track `input_tokens` and `output_tokens` from Anthropic API response
- Calculate cost per document
- Average across all 1,000 documents

**Interpretation:**

- Longer taxonomy prompt → more input tokens
- 20% cost increase acceptable for improved classification granularity

---

## Test Execution Plan

### Phase 1: Environment Setup

**Duration:** 1 day

**Tasks:**

1. **Create Test Index:**
   - Create two test search indexes in non-production environment:
     - `test-financial-a-flat` (Variant A)
     - `test-financial-b-hierarchical` (Variant B)
2. **Configure Taxonomies:**
   - Variant A: Load 11-product flat taxonomy
   - Variant B: Load 30-product hierarchical taxonomy (from `apps/search-ai/docs/knowledge-graph/domain-definitions/financial-services.md`)
3. **Upload Test Dataset:**
   - Upload same 1,000 documents to both indexes
   - Disable all workers except `kg-enrichment` (classification only)
   - Track document IDs for 1:1 comparison

### Phase 2: Variant A (Baseline) Execution

**Duration:** 2-4 hours (depending on concurrency)

**Process:**

1. Run `kg-enrichment-worker` on all 1,000 documents in `test-financial-a-flat`
2. **Log for each document:**
   - Document ID
   - Classified product
   - Confidence score
   - Start timestamp
   - End timestamp (for latency calculation)
   - Input tokens
   - Output tokens
3. **Store results:**
   - Export to CSV: `test-results/variant-a-results.csv`
   - Columns: `document_id, ground_truth_product, classified_product, confidence, latency_ms, input_tokens, output_tokens`

### Phase 3: Variant B (Hierarchical) Execution

**Duration:** 2-4 hours (depending on concurrency)

**Process:**

1. Run `kg-enrichment-worker` on all 1,000 documents in `test-financial-b-hierarchical`
2. **Log for each document:**
   - Document ID
   - Classified product (parent or sub-product)
   - Confidence score
   - Start timestamp
   - End timestamp (for latency calculation)
   - Input tokens
   - Output tokens
3. **Store results:**
   - Export to CSV: `test-results/variant-b-results.csv`
   - Columns: `document_id, ground_truth_product, classified_product, parent_product, confidence, latency_ms, input_tokens, output_tokens`

**Note:** For Variant B, if sub-product is classified, also record the parent product for hierarchical analysis.

### Phase 4: Results Analysis

**Duration:** 1 day

**Analysis Steps:**

1. **Load Results:**
   - Import `variant-a-results.csv` and `variant-b-results.csv` into analysis script
   - Join with ground truth labels
2. **Calculate Metrics:**
   - For each variant, calculate all primary and secondary metrics (see Metrics section)
   - Generate confusion matrices (11×11 for A, 30×30 for B)
3. **Statistical Significance:**
   - Run two-proportion z-test for accuracy difference
   - Run Welch's t-test for latency difference
   - Report p-values and confidence intervals
4. **Per-Product Analysis:**
   - Identify products with largest accuracy changes (positive or negative)
   - Identify sub-products with low recall (potential labeling issues)
5. **Generate Report:**
   - Summary table with all metrics
   - Visualizations (accuracy comparison, latency histograms, confusion matrices)
   - Recommendations based on acceptance criteria

---

## Success Criteria and Decision Framework

### Acceptance Criteria

| Criterion                   | Formula                               | Threshold | Status   |
| --------------------------- | ------------------------------------- | --------- | -------- |
| **Classification Accuracy** | Accuracy_B ≥ Accuracy_A - 5%          | ≥ -5%     | BLOCKING |
| **Latency (p95)**           | Latency_B_p95 ≤ Latency_A_p95 + 100ms | ≤ +100ms  | BLOCKING |
| **Cost per Document**       | Cost_B ≤ Cost_A × 1.20                | ≤ +20%    | BLOCKING |

**ALL criteria must pass for sub-products to be deployed to production.**

### Decision Matrix

| Scenario                                          | Decision                                            |
| ------------------------------------------------- | --------------------------------------------------- |
| ✅ All 3 criteria pass                            | **Deploy sub-products** to production               |
| ❌ Accuracy fails (B < A - 5%)                    | **Do NOT deploy**, keep 11 flat products            |
| ❌ Latency fails (B > A + 100ms)                  | **Do NOT deploy**, investigate prompt optimization  |
| ❌ Cost fails (B > A × 1.20)                      | **Do NOT deploy**, investigate token reduction      |
| ⚠️ 2/3 pass, 1 marginal (within 10% of threshold) | **Rerun test** with larger sample (2,000 docs)      |
| ⚠️ Accuracy improves but latency/cost fail        | **Investigate trade-offs**, consider opt-in feature |

### Edge Cases

#### Case 1: Accuracy Improves, but Cost Increases >20%

**Scenario:**

- Variant B accuracy: 90% (Variant A: 85%) → +5% improvement ✅
- Variant B cost: $0.015/doc (Variant A: $0.010/doc) → +50% increase ❌

**Decision:**

- Do NOT deploy to all tenants
- **Alternative:** Deploy as opt-in feature for tenants willing to pay premium for higher accuracy
- **Action:** Create configuration flag `features.kg.subProducts.enabled` (default: false)

#### Case 2: Sub-Products Improve Some Products, Degrade Others

**Scenario:**

- Mutual Funds accuracy: 95% (A) → 98% (B) → +3% ✅
- Bonds accuracy: 80% (A) → 70% (B) → -10% ❌
- Overall accuracy: 85% (A) → 82% (B) → -3% ✅ (within -5% threshold)

**Decision:**

- **Pass with caveat:** Overall accuracy within threshold, but investigate Bonds sub-product labeling
- **Action:** Review Bonds sub-products (Treasury vs Municipal) for disambiguation clarity
- **Recommendation:** Consider removing sub-products for Bonds only, keep for other products

#### Case 3: Parent Product Recall Decreases (Documents Misclassified to Wrong Sub-Product)

**Scenario:**

- Variant A: "Mutual Funds" recall: 90%
- Variant B: "Mutual Funds" (parent + all sub-products) recall: 80%
  - Cause: Documents classified to "Index Funds" when they should be "Actively Managed Funds"

**Decision:**

- **Root Cause:** Sub-product disambiguation keywords insufficiently distinct
- **Action:** Refine disambiguation keywords in domain definition
- **Rerun Test:** After refinement, rerun Variant B

---

## Implementation Details

### Test Harness Script

**Location:** `apps/search-ai/src/__tests__/integration/a-b-test-harness.ts`

**Functionality:**

```typescript
/**
 * A/B Test Harness for Sub-Product Hierarchy Validation
 *
 * Usage:
 *   pnpm --filter @agent-platform/search-ai run-ab-test \
 *     --variant a \
 *     --index test-financial-a-flat \
 *     --output test-results/variant-a-results.csv
 */

interface TestResult {
  documentId: string;
  groundTruthProduct: string;
  classifiedProduct: string;
  confidence: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

async function runABTest(variant: 'a' | 'b', indexId: string, outputPath: string): Promise<void> {
  // 1. Load ground truth labels
  const groundTruth = await loadGroundTruth('test-data/ground-truth.json');

  // 2. For each document, run classification
  const results: TestResult[] = [];
  for (const doc of groundTruth) {
    const startTime = Date.now();
    const classification = await classifyDocument(indexId, doc.documentId);
    const endTime = Date.now();

    results.push({
      documentId: doc.documentId,
      groundTruthProduct: doc.product,
      classifiedProduct: classification.product,
      confidence: classification.confidence,
      latencyMs: endTime - startTime,
      inputTokens: classification.usage.input_tokens,
      outputTokens: classification.usage.output_tokens,
    });
  }

  // 3. Write results to CSV
  await writeResultsToCsv(results, outputPath);

  // 4. Calculate and log metrics
  const metrics = calculateMetrics(results);
  console.log(JSON.stringify(metrics, null, 2));
}
```

### Analysis Script

**Location:** `apps/search-ai/src/__tests__/integration/analyze-ab-results.ts`

**Functionality:**

```typescript
/**
 * Analyze A/B Test Results
 *
 * Usage:
 *   pnpm --filter @agent-platform/search-ai analyze-ab-results \
 *     --variant-a test-results/variant-a-results.csv \
 *     --variant-b test-results/variant-b-results.csv \
 *     --output test-results/ab-test-report.md
 */

interface ABTestReport {
  variantA: VariantMetrics;
  variantB: VariantMetrics;
  comparison: ComparisonMetrics;
  decision: 'deploy' | 'do-not-deploy';
  recommendations: string[];
}

async function analyzeResults(variantAPath: string, variantBPath: string): Promise<ABTestReport> {
  const resultsA = await loadResults(variantAPath);
  const resultsB = await loadResults(variantBPath);

  const metricsA = calculateAllMetrics(resultsA);
  const metricsB = calculateAllMetrics(resultsB);

  const comparison = compareVariants(metricsA, metricsB);

  const decision = evaluateCriteria(comparison);

  return {
    variantA: metricsA,
    variantB: metricsB,
    comparison,
    decision,
    recommendations: generateRecommendations(comparison, decision),
  };
}

function evaluateCriteria(comparison: ComparisonMetrics): 'deploy' | 'do-not-deploy' {
  const accuracyPass = comparison.accuracyDelta >= -5.0;
  const latencyPass = comparison.latencyP95Delta <= 100;
  const costPass = comparison.costPerDocRatio <= 1.2;

  return accuracyPass && latencyPass && costPass ? 'deploy' : 'do-not-deploy';
}
```

---

## Risks and Mitigations

### Risk 1: Insufficient Ground Truth Quality

**Risk:**

- Ground truth labels have errors or inconsistencies
- Inter-rater agreement (κ) < 0.80

**Impact:**

- Test results unreliable
- False negatives (variant fails when it should pass)

**Mitigation:**

- Use 3 independent SME raters (not involved in taxonomy design)
- Require ≥2/3 consensus for each label
- Calculate Cohen's Kappa; if κ < 0.80, refine guidelines and re-label
- For Variant B, provide SMEs with sub-product definitions and examples

### Risk 2: Sample Size Too Small

**Risk:**

- 1,000 documents insufficient for statistical significance
- Per-product samples <50 may have high variance

**Impact:**

- Type II error (fail to detect real differences)
- Confidence intervals too wide

**Mitigation:**

- Power analysis: 1,000 docs provides 95% power to detect 5% accuracy difference (α=0.05)
- If results are inconclusive (p-value between 0.05-0.10), rerun with 2,000 documents
- Focus on macro-average metrics (less affected by small per-product samples)

### Risk 3: Model Behavior Differs in Production

**Risk:**

- Test uses synthetic test environment
- Production traffic patterns differ (document types, user corrections)

**Impact:**

- Test results don't generalize to production

**Mitigation:**

- Use real production documents (not synthetic)
- Match document type distribution to production (PDF 40%, Markdown 20%, HTML 20%, DOCX 20%)
- After deployment, monitor production metrics for 2 weeks
- If production accuracy drops >5%, roll back sub-products

### Risk 4: Taxonomy Refinement Needed Mid-Test

**Risk:**

- During test, discover disambiguation keywords are ambiguous
- Need to refine taxonomy mid-test

**Impact:**

- Test invalidated, need to restart

**Mitigation:**

- **Pre-test review:** Have 2 independent reviewers validate taxonomy before test
- **Dry run:** Run pilot test with 100 documents first
- **Freeze taxonomy:** Do NOT modify taxonomy during test execution

---

## Timeline and Resources

### Timeline

| Phase               | Duration   | Dependencies           |
| ------------------- | ---------- | ---------------------- |
| Environment Setup   | 1 day      | Test indexes created   |
| Variant A Execution | 4 hours    | Ground truth ready     |
| Variant B Execution | 4 hours    | Variant A complete     |
| Results Analysis    | 1 day      | Both variants complete |
| Decision Meeting    | 2 hours    | Analysis complete      |
| **Total**           | **3 days** | -                      |

### Resources Required

**People:**

- 1× ML Engineer (test harness implementation, metrics calculation)
- 3× Financial Services SMEs (ground truth labeling, 2 hours each)
- 1× Data Analyst (results analysis, report generation)
- 1× Product Manager (decision meeting, stakeholder communication)

**Infrastructure:**

- Non-production test environment
- Claude Haiku API quota (estimate: 2,000 API calls × $0.001/call = $2.00)
- MongoDB test database
- OpenSearch test cluster

---

## Appendix A: Statistical Formulas

### Two-Proportion Z-Test (Accuracy Comparison)

**Null Hypothesis:** Accuracy_A = Accuracy_B

**Test Statistic:**

```
z = (p̂_A - p̂_B) / sqrt(p̂(1-p̂)(1/n_A + 1/n_B))

where:
  p̂_A = Accuracy_A (proportion correct in Variant A)
  p̂_B = Accuracy_B (proportion correct in Variant B)
  p̂ = (x_A + x_B) / (n_A + n_B) (pooled proportion)
  n_A = n_B = 1,000 (sample size)
```

**Decision Rule:**

- If p-value < 0.05, reject H0 (significant difference)
- If p-value ≥ 0.05, fail to reject H0 (no significant difference)

### Welch's T-Test (Latency Comparison)

**Null Hypothesis:** Latency_A = Latency_B

**Test Statistic:**

```
t = (x̄_A - x̄_B) / sqrt(s²_A/n_A + s²_B/n_B)

where:
  x̄_A = mean latency for Variant A
  x̄_B = mean latency for Variant B
  s²_A, s²_B = sample variances
  n_A = n_B = 1,000
```

**Degrees of Freedom (Welch-Satterthwaite):**

```
df = (s²_A/n_A + s²_B/n_B)² / [(s²_A/n_A)²/(n_A-1) + (s²_B/n_B)²/(n_B-1)]
```

---

## Appendix B: Example Results Table

### Variant A: Flat Taxonomy (11 Products)

| Metric              | Value   |
| ------------------- | ------- |
| Overall Accuracy    | 85.2%   |
| Macro-Avg Precision | 83.4%   |
| Macro-Avg Recall    | 84.1%   |
| Macro-Avg F1 Score  | 83.7%   |
| Avg Confidence      | 0.872   |
| Latency p50         | 1,240ms |
| Latency p95         | 2,180ms |
| Latency p99         | 3,450ms |
| Avg Input Tokens    | 3,200   |
| Avg Output Tokens   | 150     |
| Cost per Document   | $0.0010 |

### Variant B: Hierarchical Taxonomy (30 Products)

| Metric              | Value   | Delta vs A         | Pass? |
| ------------------- | ------- | ------------------ | ----- |
| Overall Accuracy    | 82.8%   | -2.4% (✅ >-5%)    | ✅    |
| Macro-Avg Precision | 81.2%   | -2.2%              | N/A   |
| Macro-Avg Recall    | 82.5%   | -1.6%              | N/A   |
| Macro-Avg F1 Score  | 81.8%   | -1.9%              | N/A   |
| Avg Confidence      | 0.865   | -0.007             | N/A   |
| Latency p50         | 1,310ms | +70ms              | N/A   |
| Latency p95         | 2,250ms | +70ms (✅ <+100ms) | ✅    |
| Latency p99         | 3,520ms | +70ms              | N/A   |
| Avg Input Tokens    | 3,680   | +480 (+15%)        | N/A   |
| Avg Output Tokens   | 165     | +15 (+10%)         | N/A   |
| Cost per Document   | $0.0011 | +10% (✅ <+20%)    | ✅    |

### Decision

**Result:** ✅ **DEPLOY SUB-PRODUCTS**

**Rationale:**

- Accuracy delta: -2.4% (within -5% threshold) ✅
- Latency delta: +70ms (within +100ms threshold) ✅
- Cost delta: +10% (within +20% threshold) ✅

**Statistical Significance:**

- Accuracy difference: p = 0.03 (statistically significant, but within acceptable threshold)
- Latency difference: p = 0.12 (not statistically significant)

**Recommendation:**

- Deploy sub-products to production
- Monitor accuracy for 2 weeks post-deployment
- If production accuracy drops >5%, roll back immediately

---

## Appendix C: Confusion Matrix Interpretation

### Variant A: 11×11 Confusion Matrix

**Row:** Ground truth product
**Column:** Classified product

Example interpretation:

- **Diagonal values (high):** Correct classifications
- **Off-diagonal values (low):** Misclassifications
- **Common confusions:**
  - Mutual Funds ↔ ETFs (both are funds)
  - Traditional IRA ↔ Roth IRA (both are IRAs, differ in tax treatment)
  - Term Life ↔ Whole Life (both are life insurance)

### Variant B: 30×30 Confusion Matrix

**Additional analysis:**

- **Parent-to-parent confusions:** Same as Variant A
- **Sub-product-to-sub-product confusions:** Within same parent (e.g., Index Funds → Actively Managed Funds)
- **Sub-product-to-parent confusions:** Document too generic to determine sub-product

**Key Question:**

- Do sub-products reduce parent-level confusion (e.g., fewer "Mutual Funds" ↔ "ETFs" errors)?
- If yes, sub-products are working as intended

---

## Appendix D: Rollback Plan

If sub-products fail acceptance criteria or cause production issues:

**Rollback Steps:**

1. **Revert Taxonomy:**
   - Update `financial-services.md` to Version 1.0 (11 flat products)
   - Remove `subProducts` fields from `IKGProduct`
2. **Reclassify Documents:**
   - Enqueue `kg-reclassify` jobs for all documents in affected indexes
   - Parent products map 1:1, so reclassification is lossless
3. **Update Documentation:**
   - Mark Phase 1 as "Not Deployed" in RFC-001
   - Document reasons for rollback in postmortem
4. **Notify Stakeholders:**
   - Send email to affected tenants (if any were on opt-in beta)
   - Update release notes

**Rollback Duration:** <4 hours (depending on document volume)

---

**END OF A/B TEST PLAN**

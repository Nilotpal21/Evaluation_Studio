# Org Profile Generator Benchmark

Comprehensive benchmark suite for testing the OrgProfileGenerator service against real-world organization data.

## Overview

This benchmark tests the LLM-assisted organization profile generation across **12 organizations** spanning **6 industries** (2 orgs per industry):

| Industry           | Organizations                  |
| ------------------ | ------------------------------ |
| Financial Services | Vanguard, Fidelity             |
| Healthcare         | Mayo Clinic, Kaiser Permanente |
| Technology         | Salesforce, ServiceNow         |
| Manufacturing      | Boeing, Caterpillar            |
| Retail             | Walmart, Target                |
| Energy             | ExxonMobil, Chevron            |

## Test Modes

The benchmark tests **2 generation modes** (URL mode excluded due to requiring real endpoints):

1. **Name-Industry Mode**: Generates profile from organization name + industry
2. **Paragraph Mode**: Generates profile from a descriptive paragraph

## Metrics Measured

### Performance Metrics

- **Latency**: Average duration per profile generation (target: <10s)
- **Cost**: Average cost per profile (target: <$0.03)
- **Success Rate**: Percentage of successful generations (target: >80%)

### Quality Metrics

- **Org Name Accuracy**: Correct organization name extraction (target: >90%)
- **Industry Accuracy**: Correct industry classification (target: >90%)
- **Key Terms Overlap**: % of expected key terms found in generated profile (target: >40%)
- **Acronyms Overlap**: % of expected acronyms found in generated profile (target: >30%)

## Running the Benchmark

### Prerequisites

1. **LLM API Credentials**: Set either:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   # OR
   export OPENAI_API_KEY=sk-...
   ```

2. **Build Database Package**:
   ```bash
   pnpm build --filter @agent-platform/database
   ```

### Run Benchmark

```bash
# Full benchmark (all modes, all profiles)
pnpm test -- --run src/__tests__/org-profile-benchmark.test.ts

# Name-Industry mode only
pnpm test -- --run src/__tests__/org-profile-benchmark.test.ts -t "Name-Industry"

# Paragraph mode only
pnpm test -- --run src/__tests__/org-profile-benchmark.test.ts -t "Paragraph"
```

### Expected Runtime

- **Name-Industry Mode**: ~12 profiles × 5-8s = 60-100 seconds
- **Paragraph Mode**: ~12 profiles × 5-8s = 60-100 seconds
- **Full Benchmark**: ~24 tests = 2-4 minutes

### Expected Cost

- **Per Profile**: ~$0.015-0.02 (Claude Sonnet 4.5)
- **Name-Industry Mode**: 12 profiles × $0.0165 = ~$0.20
- **Paragraph Mode**: 12 profiles × $0.0165 = ~$0.20
- **Full Benchmark**: ~$0.40

## Interpreting Results

### Console Output

The benchmark logs detailed results for each profile:

```
✓ vanguard: 4523ms, $0.0165, Quality: 68.2% key terms
✓ fidelity: 3892ms, $0.0165, Quality: 71.4% key terms
...

=== Name-Industry Mode Summary ===
Success Rate: 100.0%
Avg Duration: 4207ms
Avg Cost: $0.0165
Total Cost: $0.1980
Org Name Accuracy: 100.0%
Industry Accuracy: 100.0%
Key Terms Overlap: 64.3%
Acronyms Overlap: 42.5%
```

### Quality Metrics Interpretation

**Org Name & Industry Accuracy** (target: >90%)

- **100%**: Perfect extraction
- **90-99%**: Excellent (minor variations like "Mayo Clinic Health System" vs "Mayo Clinic")
- **<90%**: Needs investigation (hallucination or input ambiguity)

**Key Terms Overlap** (target: >40%)

- **>60%**: Excellent domain knowledge
- **40-60%**: Good (LLM adds related terms not in expected list)
- **<40%**: Poor (missing domain-specific terminology)

**Acronyms Overlap** (target: >30%)

- **>50%**: Excellent (captures domain acronyms)
- **30-50%**: Good (common acronyms captured)
- **<30%**: Poor (missing industry-specific acronyms)

**Note**: LLM may generate valid terms/acronyms not in the expected set, so overlap <100% doesn't necessarily indicate poor quality.

### Mode Comparison

The benchmark identifies optimal modes for different use cases:

- **Most Reliable**: Highest success rate (usually name-industry)
- **Most Cost-Effective**: Lowest cost per profile (usually similar across modes)
- **Fastest**: Lowest average latency (depends on LLM response time)

## Benchmark Data Quality

All benchmark profiles follow strict quality standards:

✅ 10-20 key terms per profile
✅ 5-10 acronyms per profile
✅ 2-5 department boundaries with reasoning
✅ Product-specific names for disambiguation
✅ No duplicate terms within profile
✅ Uppercase acronym keys
✅ Descriptive reasoning (10-500 chars)

See `validate-all.test.ts` for validation tests.

## Troubleshooting

### Tests Skipped

**Symptom**: `3 skipped` with no results
**Cause**: No LLM credentials set
**Fix**: Export `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

### Circuit Breaker Open

**Symptom**: All tests fail with "Circuit breaker is OPEN"
**Cause**: Repeated LLM API failures triggered circuit breaker
**Fix**: Wait 30 seconds for circuit to reset, check API key validity

### Low Quality Scores

**Symptom**: Key terms overlap <40%
**Investigation**:

1. Check generated profile manually - may contain valid related terms
2. Review expected profile - may be too restrictive
3. Try different LLM model (Claude vs GPT)

### High Latency

**Symptom**: Average duration >10s
**Causes**:

- LLM API slow response (check status.anthropic.com)
- Network latency
- Complex profiles requiring more tokens

## Expected Results (Reference)

Based on development testing with Claude Sonnet 4.5:

### Name-Industry Mode

- Success Rate: **95-100%**
- Avg Duration: **4-6 seconds**
- Avg Cost: **$0.016-0.018**
- Org Name Accuracy: **100%**
- Industry Accuracy: **100%**
- Key Terms Overlap: **60-70%** (LLM adds related terms)
- Acronyms Overlap: **40-50%**

### Paragraph Mode

- Success Rate: **90-100%** (depends on description quality)
- Avg Duration: **5-7 seconds**
- Avg Cost: **$0.016-0.018**
- Org Name Accuracy: **95-100%**
- Industry Accuracy: **90-100%**
- Key Terms Overlap: **50-65%** (less context than name-industry)
- Acronyms Overlap: **35-45%**

### Recommendations

**For Production Use:**

- **Primary Mode**: Name-Industry (most reliable, 100% org name accuracy)
- **Fallback Mode**: Paragraph (when only description available)
- **Cost**: Budget $0.017 per profile
- **Latency**: Plan for 5-8s per profile (add 30% buffer for API variance)

**Quality Thresholds:**

- Reject if org name accuracy <90%
- Reject if industry mismatch (manual review)
- Accept if key terms overlap >40% (LLM provides value-add)

## Related Files

- `apps/search-ai/src/__tests__/org-profile-benchmark.test.ts` - Benchmark implementation
- `apps/search-ai/src/services/org-profile-generator.service.ts` - Generator service
- `apps/search-ai/src/schemas/org-profile.schema.ts` - Zod validation schema
- `apps/search-ai/src/routes/kg-taxonomy.ts` - API endpoint with telemetry

## Future Enhancements

### URL Mode Testing

- Requires mocked HTTP responses or archived content
- Could use Wayback Machine API for historical snapshots
- Would test web scraping + extraction pipeline

### Adversarial Testing

- Ambiguous names (common words: "Apple", "Amazon")
- Multi-industry orgs (conglomerates)
- Regional variants (Kaiser Permanente Northern California vs Southern California)

### Cross-Model Comparison

- Test Claude Sonnet vs GPT-4 vs Gemini
- Compare quality, cost, and latency
- Identify optimal model per use case

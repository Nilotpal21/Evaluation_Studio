# IR Dataset Recommendations - Executive Summary

## TL;DR

**Best dataset combination for preprocessing quality testing:**

1. **StackOverflow** (primary) - Real technical queries with typos
2. **MS MARCO + synthetic typos** (secondary) - Spell correction testing
3. **BEIR CQADupStack** (validation) - Standardized benchmark

**Implementation priority**: Start with BEIR (easiest), add synthetic typos (moderate), then StackOverflow (most effort but best match).

---

## Quick Comparison Matrix

| Dataset               | Domain Match    | Has Typos    | Relevance   | Effort    | License       | Score    |
| --------------------- | --------------- | ------------ | ----------- | --------- | ------------- | -------- |
| **StackOverflow**     | ✅✅✅ Perfect  | ✅ Natural   | ✅ Implicit | 🔴 High   | ✅ CC BY-SA   | **9/10** |
| **MS MARCO + Typos**  | ⚠️ General      | ✅ Synthetic | ✅ Human    | 🟡 Medium | ✅ MIT        | **7/10** |
| **BEIR**              | ⚠️ Multi-domain | ❌ No        | ✅ Varied   | 🟢 Low    | ✅ Apache 2.0 | **8/10** |
| **CodeSearchNet**     | ✅✅ Tech       | ❌ No        | ⚠️ Weak     | 🟡 Medium | ✅ MIT        | **8/10** |
| **Natural Questions** | ❌ Wikipedia    | ❌ No        | ✅ Human    | 🟡 Medium | ✅ Apache 2.0 | **6/10** |
| **TREC-DL**           | ⚠️ General      | ❌ No        | ✅✅ Graded | 🟢 Low    | ✅ Public     | **7/10** |

---

## Recommended Approach

### Phase 1: Quick Start (Week 1)

**Objective**: Get quality testing running with minimal effort

```bash
# 1. Use existing ground truth (already working)
pytest tests/quality/test_retrieval_quality.py

# 2. Download BEIR CQADupStack (30 minutes)
pip install beir
python scripts/download_beir.py --dataset=cqadupstack

# 3. Run first benchmark
pytest tests/quality/ --dataset=beir-cqadupstack
```

**Effort**: 2-3 hours
**Storage**: 100MB
**Value**: Standardized benchmark, easy to implement

### Phase 2: Spell Correction Testing (Week 2)

**Objective**: Test typo correction with controlled dataset

```bash
# 1. Download MS MARCO subset (1 hour)
wget https://msmarco.blob.core.windows.net/msmarcoranking/collectionandqueries.tar.gz

# 2. Generate synthetic typos (30 minutes)
python scripts/generate_typos.py --num-queries=500

# 3. Run spell correction tests
pytest tests/quality/test_spell_correction.py --typo-dataset=msmarco-typos.json
```

**Effort**: 4-5 hours
**Storage**: 1GB
**Value**: Direct spell correction validation

### Phase 3: Technical Domain Testing (Week 3-4)

**Objective**: Test on real technical queries with natural typos

```bash
# 1. Download StackOverflow dump (requires planning)
# Option A: Full dump (80GB) - best quality
wget https://archive.org/download/stackexchange/stackoverflow.com-Posts.7z

# Option B: BigQuery subset (faster for testing)
# Query: technical tags (kubernetes, docker, devops)
# Export to JSON

# 2. Parse and convert (2-3 hours)
python scripts/parse_stackoverflow.py --max-queries=1000

# 3. Run comprehensive evaluation
pytest tests/quality/ --all-datasets
```

**Effort**: 1-2 days
**Storage**: 5GB
**Value**: Best domain match, real typos, large scale

---

## Dataset Details

### 1. StackOverflow ⭐ BEST OVERALL

**Why it's the best**:

- Perfect domain match (DevOps, infrastructure, software engineering)
- Natural typos in real user queries
- Large scale (millions of questions)
- Clear relevance signals (accepted answers, upvotes)
- Free to use (CC BY-SA)

**What you get**:

- Questions as queries (titles + bodies)
- Answers as documents
- Relevance: accepted answer (3), high upvotes (2), other (1)
- Tags for filtering technical content

**Example query**:

```
"How to deplyo Kubernetes application with Helm charts?"
(typo: deplyo → deploy)
```

**Implementation complexity**: 🔴 Medium-High

- Need to parse XML (80GB file)
- Or query BigQuery (easier but limited free tier)
- Convert to IR format
- Build relevance judgments

**Recommendation**: Use for production ground truth dataset

---

### 2. MS MARCO + Synthetic Typos ⭐ BEST FOR SPELL TESTING

**Why it's good**:

- Clean baseline queries → inject controlled typos
- Human relevance judgments
- Large scale (1M queries)
- MIT license

**What you get**:

- 1M queries (general web)
- 8.8M passages
- Binary relevance (0/1)

**Typo injection example**:

```
Original: "kubernetes deployment strategies"
Typo:     "kuberntes deplyoment strategies"
```

**Implementation complexity**: 🟡 Medium

- Download dataset (6.5GB)
- Generate synthetic typos (straightforward)
- Test spell correction impact

**Recommendation**: Use for spell correction validation

---

### 3. BEIR ⭐ BEST FOR STANDARDIZED EVAL

**Why it's good**:

- Unified framework (17 datasets)
- Easy to use (pip install beir)
- Includes technical content (CQADupStack = StackOverflow)
- Apache 2.0 license

**What you get**:

- CQADupStack: 40K StackOverflow duplicate questions
- Multiple domains for generalization testing
- Standard evaluation protocol

**Implementation complexity**: 🟢 Easy

- One command to download
- Pre-formatted for IR evaluation
- Python API

**Recommendation**: Start here for quick wins

---

### 4. CodeSearchNet - Code Domain

**Why it's useful**:

- Pure code/technical content
- 2M+ query-code pairs
- 6 programming languages

**Limitation**: Docstring queries are very clean, need to inject typos

**Use case**: Technical term preservation, entity extraction

---

### 5. Natural Questions - General QA

**Why it's less ideal**:

- Wikipedia domain (not technical)
- QA-focused, not pure retrieval
- No typos

**Use case**: Multilingual testing (if using TyDi QA variant)

---

## Dataset Combination Strategy

### For Comprehensive Testing

```python
DATASET_MIX = {
    'stackoverflow': {
        'queries': 500,
        'purpose': 'Technical domain + real typos',
        'weight': 0.4,
    },
    'msmarco_typos': {
        'queries': 300,
        'purpose': 'Spell correction',
        'weight': 0.3,
    },
    'beir_cqadupstack': {
        'queries': 200,
        'purpose': 'Standardized eval',
        'weight': 0.2,
    },
    'codesearchnet': {
        'queries': 100,
        'purpose': 'Code/technical terms',
        'weight': 0.1,
    },
}

# Total: 1100 queries
# Weighted NDCG@10 = sum(dataset_score * weight)
```

---

## Quick Decision Tree

**Q: Do you need to test spell correction?**

- Yes → Use MS MARCO + synthetic typos
- No → Skip

**Q: Is technical domain critical?**

- Yes → Use StackOverflow (primary)
- No → Use BEIR multi-domain

**Q: Need multilingual testing?**

- Yes → Add TyDi QA
- No → Skip

**Q: Want standardized benchmarking?**

- Yes → Use BEIR
- No → Custom dataset OK

**Q: Limited time/resources?**

- Yes → Start with BEIR CQADupStack (easiest)
- No → Go for StackOverflow (best)

---

## Storage Planning

| Dataset       | Download Size          | Processed Size | Keep Raw?                    |
| ------------- | ---------------------- | -------------- | ---------------------------- |
| StackOverflow | 50GB (7z) → 80GB (xml) | 2-5GB (JSON)   | No - delete after processing |
| MS MARCO      | 6.5GB                  | 500MB subset   | Optional                     |
| BEIR          | 100MB                  | 50MB           | Yes - small                  |
| CodeSearchNet | 20GB                   | 1GB subset     | No                           |

**Strategy**: Download → Process → Delete raw files

**Minimum storage**: ~3GB (processed datasets only)

---

## Licensing Summary

✅ **Safe for commercial use**:

- MS MARCO (MIT)
- BEIR (Apache 2.0)
- CodeSearchNet (MIT)
- Natural Questions (Apache 2.0)
- TREC datasets (Public Domain)

⚠️ **Attribution required**:

- StackOverflow (CC BY-SA 4.0) - must credit

❌ **Avoid**:

- AOL Query Log (privacy concerns, restricted)
- Bing datasets (proprietary)

---

## Expected Quality Improvements

Based on similar IR systems:

| Preprocessing Stage                     | Expected NDCG@10 Improvement |
| --------------------------------------- | ---------------------------- |
| Spell Correction (on typo queries)      | +15-25%                      |
| Synonym Expansion (on semantic queries) | +8-15%                       |
| Full Pipeline (adaptive)                | +10-20% overall              |
| Baseline (no preprocessing)             | 0% (reference)               |

**Validation target**: NDCG@10 improvement > 10% on combined dataset

---

## Next Steps

1. **Immediate** (this week):
   - Run existing quality tests with `quality-ground-truth.json` ✅ (already working)
   - Download BEIR CQADupStack for validation

2. **Short-term** (next 2 weeks):
   - Generate MS MARCO synthetic typos
   - Test spell correction impact
   - Document baseline metrics

3. **Medium-term** (next month):
   - Parse StackOverflow dataset (1000 queries)
   - Build production ground truth
   - Run comprehensive evaluation

4. **Long-term** (quarterly):
   - Expand to 2000+ queries
   - Add multilingual testing
   - Continuous quality monitoring

---

## Questions & Answers

**Q: Why not just use MS MARCO?**
A: MS MARCO is general web domain, not DevOps/technical. StackOverflow is a better domain match.

**Q: Can we use these datasets for training?**
A: Yes for MS MARCO, BEIR. StackOverflow requires attribution. Check license per dataset.

**Q: How do we measure improvement?**
A: Compare NDCG@10 across configurations: baseline vs full vs adaptive preprocessing.

**Q: What if we can't download large datasets?**
A: Start with BEIR (small) + synthetic typos on existing queries. Still valuable.

**Q: Should we create our own dataset?**
A: Eventually yes, but start with public datasets for faster iteration. Use StackOverflow as template.

---

**Document Version**: 1.0
**Last Updated**: 2026-02-23
**Author**: Search AI Team
**Status**: Ready for Implementation

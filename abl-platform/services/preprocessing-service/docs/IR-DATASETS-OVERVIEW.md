# IR Datasets for Query Preprocessing Quality Testing - Overview

## Purpose

This document provides an overview of the IR dataset research conducted for the preprocessing-service quality testing framework. It points to detailed documentation for implementation.

## Research Completed

We surveyed existing Information Retrieval (IR) datasets to find suitable sources for testing query preprocessing quality, specifically:

1. ✅ Spell correction (queries with typos)
2. ✅ Synonym expansion (semantic understanding)
3. ✅ Technical domain (DevOps/software engineering)
4. ✅ Multilingual queries
5. ✅ Relevance judgments (ground truth)

## Key Findings

### Best Dataset Combination

| Dataset                        | Purpose           | Domain Match       | Has Typos       | Size        | Effort      | Score |
| ------------------------------ | ----------------- | ------------------ | --------------- | ----------- | ----------- | ----- |
| **StackOverflow**              | Primary testing   | Excellent (DevOps) | Yes (natural)   | 20M posts   | Medium-High | 9/10  |
| **MS MARCO + Synthetic Typos** | Spell correction  | General web        | Yes (synthetic) | 1M queries  | Medium      | 7/10  |
| **BEIR CQADupStack**           | Standardized eval | Good (tech subset) | No              | 40K queries | Low         | 8/10  |

### Top 3 Recommendations

1. **Start with BEIR** (easiest, 30 min setup)
   - Pre-packaged datasets
   - Python API
   - Includes StackOverflow subset (CQADupStack)

2. **Add synthetic typos** (moderate effort, 2-3 hours)
   - Take clean queries (MS MARCO or existing)
   - Inject controlled typos
   - Test spell correction directly

3. **Build StackOverflow dataset** (best quality, 1-2 days)
   - Real technical queries
   - Natural typos
   - Best domain match

## Documentation Structure

```
docs/
├── IR-DATASETS-OVERVIEW.md           ← YOU ARE HERE
├── IR-DATASETS-RESEARCH.md           ← Full research (10 datasets)
├── DATASET-RECOMMENDATIONS.md        ← Executive summary
└── DATASET-IMPLEMENTATION-GUIDE.md   ← Step-by-step setup
```

### 📄 IR-DATASETS-RESEARCH.md (19KB)

**Full research report covering 10+ datasets:**

- MS MARCO (1M queries, MIT license)
- BEIR (17 datasets, Apache 2.0)
- Natural Questions (307K queries, Wikipedia)
- CodeSearchNet (2M+ code queries)
- TREC Deep Learning (200 queries, graded relevance)
- StackOverflow (20M posts, CC BY-SA)
- GitHub Issues/PRs (millions, various licenses)
- TyDi QA (multilingual, 11 languages)
- Misspelling corpora (typo pairs)

**Each dataset includes:**

- Source and download links
- Statistics (size, domain, format)
- Has typos? Relevance judgments?
- License and commercial use
- Pros/cons analysis
- Match score (0-10)

**Read this if**: You want deep understanding of all options

---

### 📄 DATASET-RECOMMENDATIONS.md (9KB)

**Executive summary with decision guidance:**

- Quick comparison matrix
- 3-phase implementation roadmap
- Dataset combination strategy
- Decision tree (which dataset for which need?)
- Storage planning
- Expected quality improvements
- FAQ

**Read this if**: You want actionable recommendations without all the details

---

### 📄 DATASET-IMPLEMENTATION-GUIDE.md (19KB)

**Step-by-step implementation instructions:**

1. **StackOverflow**: XML parsing, relevance construction
2. **MS MARCO**: Download, synthetic typo generation
3. **BEIR**: Installation, API usage
4. **Integration**: CI setup, storage organization

**Includes**:

- Complete Python scripts
- Command-line examples
- Directory structure
- CI/CD integration
- Quick start guide (no download needed)

**Read this if**: You're ready to implement and need code

---

## Quick Start (No Downloads)

You can start testing immediately with the existing dataset:

```bash
cd /Users/Bharat.Rekha/kore/rewrite/abl-platform/services/preprocessing-service

# Run quality tests with existing ground truth
pytest tests/quality/test_retrieval_quality.py \
    --ground-truth=tests/fixtures/quality-ground-truth.json

# Expected output:
# Configuration    Recall@10    Precision@10    MRR      NDCG@10
# baseline         0.650        0.180           0.542    0.456
# full             0.720        0.210           0.612    0.523
# adaptive         0.710        0.205           0.598    0.512
# optimal          0.730        0.215           0.620    0.530
```

**Current dataset**: 20 documents, 15 queries (DevOps/technical content)

This is sufficient for initial development and CI integration.

---

## Implementation Roadmap

### Phase 1: Quick Win (Week 1) - BEIR

**Effort**: 2-3 hours
**Storage**: 100MB
**Value**: Standardized benchmark

```bash
pip install beir
python scripts/download_beir.py --dataset=cqadupstack
pytest tests/quality/ --dataset=beir-cqadupstack
```

**Deliverable**: BEIR integration working, baseline metrics

---

### Phase 2: Spell Correction (Week 2) - Synthetic Typos

**Effort**: 4-5 hours
**Storage**: 1GB
**Value**: Direct spell correction validation

```bash
# Download MS MARCO subset
wget https://msmarco.blob.core.windows.net/msmarcoranking/collectionandqueries.tar.gz

# Generate typos
python scripts/generate_typos.py --num-queries=500

# Test
pytest tests/quality/test_spell_correction.py
```

**Deliverable**: 500 typo queries, spell correction metrics

---

### Phase 3: Technical Domain (Week 3-4) - StackOverflow

**Effort**: 1-2 days
**Storage**: 5GB
**Value**: Production-quality ground truth

```bash
# Option A: Full dump (best quality)
wget https://archive.org/download/stackexchange/stackoverflow.com-Posts.7z
7z x stackoverflow.com-Posts.7z
python scripts/parse_stackoverflow.py --max-queries=1000

# Option B: BigQuery subset (faster)
# Query technical tags, export JSON
python scripts/parse_stackoverflow_bigquery.py
```

**Deliverable**: 1000 StackOverflow Q&A pairs, comprehensive evaluation

---

## Dataset Comparison Summary

### By Primary Need

**Need spell correction testing?**
→ MS MARCO + synthetic typos

**Need technical domain?**
→ StackOverflow (best) or BEIR CQADupStack (easier)

**Need standardized benchmark?**
→ BEIR

**Need multilingual?**
→ TyDi QA

**Need code-specific?**
→ CodeSearchNet

**Limited time/resources?**
→ Use existing `quality-ground-truth.json` + BEIR

---

### By Implementation Effort

| Effort Level  | Dataset               | Setup Time | Value                   |
| ------------- | --------------------- | ---------- | ----------------------- |
| 🟢 **Easy**   | BEIR                  | 30 min     | High (standardized)     |
| 🟢 **Easy**   | Existing ground truth | 0 min      | Medium (small)          |
| 🟡 **Medium** | MS MARCO + typos      | 3 hours    | High (spell correction) |
| 🟡 **Medium** | CodeSearchNet         | 2 hours    | Medium (code domain)    |
| 🔴 **Hard**   | StackOverflow         | 1-2 days   | Very High (best match)  |
| 🔴 **Hard**   | Custom annotation     | Weeks      | Highest (tailored)      |

---

## Key Metrics to Track

Once datasets are integrated, track these metrics:

| Metric             | Formula                             | Target | Purpose           |
| ------------------ | ----------------------------------- | ------ | ----------------- |
| **Recall@10**      | Relevant in top 10 / Total relevant | > 0.7  | Coverage          |
| **Precision@10**   | Relevant in top 10 / 10             | > 0.3  | Accuracy          |
| **MRR**            | 1 / rank of first relevant          | > 0.6  | Ranking quality   |
| **NDCG@10**        | Discounted cumulative gain          | > 0.5  | Overall quality   |
| **Spell Fix Rate** | Typos corrected / Total typos       | > 0.85 | Spell correction  |
| **Synonym Recall** | Queries improved by synonyms        | > 0.6  | Synonym expansion |

### Expected Improvements

| Configuration              | NDCG@10 Improvement vs Baseline |
| -------------------------- | ------------------------------- |
| Spell correction only      | +15-25% (on typo queries)       |
| Synonym expansion only     | +8-15% (on semantic queries)    |
| Full preprocessing         | +10-20% (overall)               |
| Adaptive (smart selection) | +10-18% (efficiency optimized)  |

---

## Storage Requirements

### Minimal Setup (Quick Start)

```
Total: ~200MB

tests/fixtures/
└── quality-ground-truth.json (1MB)
└── beir-cqadupstack/ (100MB)
```

### Recommended Setup (Production)

```
Total: ~3-5GB

datasets/processed/
├── stackoverflow-ir-dataset.json (2-3GB)
├── msmarco-typos.json (500MB)
├── beir-cqadupstack.json (100MB)
└── codesearchnet-subset.json (500MB)
```

### Full Setup (All Options)

```
Total: ~6-8GB processed (delete raw files after)

Raw downloads: ~87GB (can delete after processing)
- StackOverflow XML: 80GB
- MS MARCO: 6.5GB
- BEIR: 500MB
```

**Recommendation**: Download → Process → Delete raw → Keep processed only

---

## License Summary

✅ **Commercial use allowed:**

- MS MARCO (MIT)
- BEIR (Apache 2.0)
- CodeSearchNet (MIT)
- Natural Questions (Apache 2.0)
- TREC (Public Domain)

⚠️ **Attribution required:**

- StackOverflow (CC BY-SA 4.0)

❌ **Avoid:**

- AOL Query Log (privacy concerns)
- Proprietary Bing datasets

---

## Integration with Existing Code

### Current Quality Testing

The service already has:

- ✅ Quality testing framework (`tests/quality/test_retrieval_quality.py`)
- ✅ Ground truth dataset (20 docs, 15 queries)
- ✅ Metrics: Recall@10, Precision@10, MRR, NDCG@10
- ✅ Mock embedder (TF-IDF for isolated testing)

### What's New

This research provides:

- 📦 **10+ dataset options** with detailed analysis
- 📋 **Implementation scripts** for downloading/parsing
- 🎯 **Recommendations** for dataset selection
- 📊 **Roadmap** for phased integration

### Next Steps

1. **Decide on dataset priority** (see recommendations)
2. **Follow implementation guide** (download + parse)
3. **Integrate with existing tests** (update fixtures path)
4. **Run baseline evaluation** (establish metrics)
5. **Set up CI integration** (automated quality checks)

---

## References

### Research Documents (This Repo)

- `IR-DATASETS-RESEARCH.md` - Full research report
- `DATASET-RECOMMENDATIONS.md` - Executive summary
- `DATASET-IMPLEMENTATION-GUIDE.md` - Step-by-step setup
- `tests/quality/README.md` - Quality testing overview

### External Links

- MS MARCO: https://microsoft.github.io/msmarco/
- BEIR: https://github.com/beir-cellar/beir
- StackOverflow Data Dump: https://archive.org/details/stackexchange
- CodeSearchNet: https://github.com/github/CodeSearchNet
- Natural Questions: https://ai.google.com/research/NaturalQuestions
- TREC: https://trec.nist.gov/

### Academic Papers

1. Nguyen et al., "MS MARCO: A Human Generated MAchine Reading COmprehension Dataset" (2016)
2. Thakur et al., "BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models" (2021)
3. Kwiatkowski et al., "Natural Questions: A Benchmark for Question Answering Research" (2019)
4. Husain et al., "CodeSearchNet Challenge: Evaluating the State of Semantic Code Search" (2019)

---

## FAQ

**Q: Which dataset should I start with?**
A: BEIR CQADupStack - easiest to set up, technical content, standardized.

**Q: Do I need all datasets?**
A: No. Start with one (BEIR), add more as needed for specific validation (typos, technical domain).

**Q: Can I use these for training?**
A: Yes, most allow it. Check license per dataset. StackOverflow requires attribution.

**Q: What if I can't download large files?**
A: Use existing `quality-ground-truth.json` + BEIR (small). Still valuable for testing.

**Q: How do I measure if preprocessing helps?**
A: Compare NDCG@10: baseline vs full vs adaptive. Target: +10-20% improvement.

**Q: Should I create my own dataset?**
A: Eventually yes, but start with public datasets for faster iteration. Use StackOverflow as a template.

**Q: What's the minimum viable dataset?**
A: Existing ground truth (20 docs, 15 queries) is sufficient for development and CI. Add more for production validation.

---

## Contact & Contribution

**Maintained by**: Search AI Team
**Last Updated**: 2026-02-23
**Version**: 1.0

For questions or updates:

1. Check existing documentation first
2. Review implementation scripts
3. Consult BEIR/MS MARCO official docs
4. Update this documentation if you add new datasets

---

**End of Overview**

👉 **Next Steps**:

1. Read `DATASET-RECOMMENDATIONS.md` for quick guidance
2. Follow `DATASET-IMPLEMENTATION-GUIDE.md` for setup
3. Check `IR-DATASETS-RESEARCH.md` for deep dives

Happy testing! 🚀

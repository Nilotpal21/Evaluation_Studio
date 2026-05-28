# Information Retrieval Datasets Research

## Executive Summary

This document surveys existing IR datasets that could be used for testing query preprocessing quality in the preprocessing-service. The focus is on datasets with:

1. Queries with typos/spelling errors (to test spell correction)
2. Queries needing semantic understanding/synonyms (to test synonym expansion)
3. Technical/DevOps/software engineering content (relevant to our domain)
4. Multilingual queries (to test language handling)
5. Relevance judgments (which documents are relevant to each query)

**Key Finding**: While many large-scale IR datasets exist, few have significant typo coverage or technical domain focus. The best approach is to use multiple datasets for different aspects of preprocessing validation.

---

## Dataset Comparison Table

| Dataset                  | Size                       | Domain             | Typos? | Relevance Judgments | License     | Match Score |
| ------------------------ | -------------------------- | ------------------ | ------ | ------------------- | ----------- | ----------- |
| MS MARCO                 | 1M queries, 8.8M docs      | General web        | No     | Yes (sparse)        | MIT         | 7/10        |
| BEIR                     | 17 datasets, 250K+ queries | Multi-domain       | No     | Yes                 | Apache 2.0  | 8/10        |
| Natural Questions        | 307K queries               | Wikipedia          | No     | Yes                 | Apache 2.0  | 6/10        |
| CodeSearchNet            | 2M+ queries                | Code/tech          | No     | Yes (weak)          | MIT         | 8/10        |
| TREC Deep Learning       | 200K queries               | Web                | No     | Yes (graded)        | Public      | 7/10        |
| TREC-COVID               | 50 queries                 | Medical/scientific | No     | Yes                 | Public      | 4/10        |
| TyDi QA                  | 200K queries               | Wikipedia          | No     | Yes                 | Apache 2.0  | 5/10        |
| StackOverflow Posts      | 20M posts                  | Programming        | No     | Yes (upvotes)       | CC BY-SA    | 9/10        |
| GitHub Issues/PRs        | Millions                   | Software eng       | No     | Implicit            | Various     | 8/10        |
| AOL Query Log            | 20M queries                | Web                | Yes    | No                  | Restricted  | 3/10        |
| Misspelling Corpus       | 4,000 misspellings         | General            | Yes    | No                  | Public      | 5/10        |
| Bing Spell Check Dataset | Large                      | Web                | Yes    | No                  | Proprietary | N/A         |

---

## Detailed Dataset Profiles

### 1. MS MARCO (Microsoft Machine Reading Comprehension)

**Source**: https://microsoft.github.io/msmarco/

**Description**: Large-scale dataset from Bing search logs with human-annotated relevance judgments.

**Statistics**:

- 1,010,916 queries
- 8,841,823 passages
- 532,761 queries with relevance judgments
- Average 1.1 relevant docs per query

**Domain**: General web queries (e-commerce, informational, navigational)

**Has Typos?**: No - cleaned real user queries

**Relevance Judgments**: Yes - binary relevance (0/1), sparse (most queries have 1-2 relevant docs)

**License**: MIT License (commercial use allowed)

**Format**: JSON/TSV files

```json
{
  "query": "what is a corporation",
  "passages": [{ "passage_id": "123", "text": "A corporation is...", "is_selected": 1 }]
}
```

**Pros**:

- Very large scale
- Real user queries
- Clean relevance judgments
- Multiple versions (passage, document)

**Cons**:

- No typos (pre-cleaned)
- Not technical domain specific
- Sparse judgments (most queries have 1 relevant doc)

**Match Score**: 7/10

- Good for synonym expansion and semantic understanding
- Not useful for spell correction testing
- General domain, not technical

**Download**: https://github.com/microsoft/MSMARCO-Passage-Ranking

---

### 2. BEIR (Benchmarking IR)

**Source**: https://github.com/beir-cellar/beir

**Description**: Heterogeneous benchmark combining 17 diverse IR datasets for zero-shot evaluation.

**Statistics**:

- 17 datasets across different domains
- 250K+ total queries
- Datasets include: MS MARCO, TREC-COVID, NFCorpus, NQ, HotpotQA, etc.

**Domains**:

- Scientific papers (TREC-COVID, NFCorpus, SCIFACT)
- Question answering (NQ, HotpotQA)
- Fact verification (FEVER, Climate-FEVER)
- Argument retrieval (Touche-2020)
- Duplicate question detection (CQADupStack, Quora)

**Has Typos?**: No - cleaned queries

**Relevance Judgments**: Yes - binary or graded (varies by dataset)

**License**: Apache 2.0

**Format**: Unified API, HuggingFace datasets

```python
from beir import util
dataset = "msmarco"
url = f"https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/{dataset}.zip"
data_path = util.download_and_unzip(url, "datasets")
```

**Pros**:

- Multiple domains in one framework
- Standardized evaluation protocol
- Easy to use with sentence-transformers
- Good for testing generalization

**Cons**:

- No typos
- Not focused on technical/DevOps domain
- Some datasets are small (50-100 queries)

**Match Score**: 8/10

- Excellent for testing semantic understanding across domains
- Unified evaluation framework
- No spell correction testing
- Includes some technical datasets (StackOverflow via CQADupStack)

**Download**: https://github.com/beir-cellar/beir

---

### 3. Natural Questions (Google)

**Source**: https://ai.google.com/research/NaturalQuestions

**Description**: Questions from Google search with Wikipedia articles as documents.

**Statistics**:

- 307,373 training questions
- 7,830 dev questions
- Wikipedia as corpus

**Domain**: General knowledge (Wikipedia)

**Has Typos?**: No - cleaned questions

**Relevance Judgments**: Yes - long answer + short answer annotations

**License**: Apache 2.0

**Format**: JSON with annotations

```json
{
  "question_text": "when was the last time the bears won the super bowl",
  "document_url": "https://en.wikipedia.org/wiki/Super_Bowl_XX",
  "long_answer": { "start_token": 123, "end_token": 456 },
  "short_answers": [{ "start_token": 234, "end_token": 238 }]
}
```

**Pros**:

- Large scale
- High quality annotations
- Real user questions

**Cons**:

- No typos
- Wikipedia domain (not technical)
- Designed for QA, not pure retrieval

**Match Score**: 6/10

- Good for semantic understanding
- Not technical domain
- No spell correction testing
- QA-focused, not pure IR

**Download**: https://github.com/google-research-datasets/natural-questions

---

### 4. CodeSearchNet

**Source**: https://github.com/github/CodeSearchNet

**Description**: Code search dataset with natural language queries and code snippets.

**Statistics**:

- 2M+ (query, code) pairs
- 6 programming languages (Python, Java, Go, PHP, JavaScript, Ruby)
- 2M functions from GitHub

**Domain**: Software engineering / code search

**Has Typos?**: No - curated docstrings

**Relevance Judgments**: Yes - weak supervision (docstring → code pairs)

**License**: MIT + source code licenses

**Format**: JSON Lines

```json
{
  "repo": "owner/repo",
  "path": "path/to/file.py",
  "func_name": "function_name",
  "original_string": "def function_name(): ...",
  "docstring": "Compute the sum of two numbers",
  "language": "python"
}
```

**Pros**:

- Highly relevant to technical domain
- Large scale
- Multiple programming languages
- Real code from GitHub

**Cons**:

- No typos (cleaned docstrings)
- Weak relevance (docstring ↔ code, not human judgments)
- Code-specific, not general DevOps queries

**Match Score**: 8/10

- Excellent domain match (software engineering)
- Good for technical term handling
- No spell correction testing
- Could augment with synthetic typos

**Download**: https://github.com/github/CodeSearchNet

---

### 5. TREC Deep Learning Track

**Source**: https://microsoft.github.io/msmarco/TREC-Deep-Learning

**Description**: TREC competition using MS MARCO corpus with additional annotations.

**Statistics**:

- 200 queries (2019), 54 queries (2020, 2021)
- 8.8M passages from MS MARCO
- Graded relevance judgments (0-3)

**Domain**: General web

**Has Typos?**: No

**Relevance Judgments**: Yes - graded (0=not relevant, 1=related, 2=highly relevant, 3=perfectly relevant)

**License**: Public domain (TREC data)

**Format**: TREC standard format

```
query_id Q0 doc_id rank score run_name
1 Q0 doc123 1 0.95 myrun
```

**Pros**:

- High quality graded judgments
- Well-established benchmark
- NDCG evaluation standard

**Cons**:

- Small query set (200 queries)
- No typos
- General domain

**Match Score**: 7/10

- Good for quality evaluation (NDCG)
- Too small for training
- No typos or technical domain

**Download**: https://microsoft.github.io/msmarco/TREC-Deep-Learning

---

### 6. StackOverflow Dataset

**Source**: https://archive.org/details/stackexchange

**Description**: Stack Exchange data dump with all posts, questions, answers, and votes.

**Statistics**:

- 20M+ questions on StackOverflow
- 30M+ answers
- Tags, upvotes, accepted answers
- Covering all Stack Exchange sites (StackOverflow, ServerFault, SuperUser, etc.)

**Domain**: Programming, DevOps, system administration

**Has Typos?**: Yes - real user queries with natural errors

**Relevance Judgments**: Yes - implicit (accepted answers, upvotes)

**License**: CC BY-SA 4.0 (attribution required)

**Format**: XML data dump

```xml
<row Id="123" PostTypeId="1" CreationDate="2008-07-31"
     Score="456" ViewCount="123456" Body="..."
     Title="How to deploy Kubernetes cluster?"
     Tags="&lt;kubernetes&gt;&lt;deployment&gt;"
     AnswerCount="5" AcceptedAnswerId="789" />
```

**Pros**:

- Perfect domain match (DevOps, programming)
- Real user queries with typos
- Large scale
- Implicit relevance via voting
- Multiple technical topics

**Cons**:

- Requires preprocessing (XML parsing)
- Implicit relevance (not explicit judgments)
- Need to construct query-document pairs

**Match Score**: 9/10

- Excellent domain match
- Has natural typos
- Large scale
- Technical content
- Needs some engineering to create IR test set

**Download**: https://archive.org/details/stackexchange

**Construction Approach**:

1. Questions = queries
2. Answers = documents
3. Relevance = accepted answer (rel=3), high upvotes (rel=2), other answers (rel=1)

---

### 7. GitHub Issues & Pull Requests

**Source**: GitHub API / GHArchive

**Description**: Public GitHub issues, PRs, and commits with natural language descriptions.

**Statistics**:

- Millions of issues/PRs
- Searchable via GitHub API or GHArchive
- DevOps, CI/CD, infrastructure repos

**Domain**: Software engineering, DevOps, infrastructure

**Has Typos?**: Yes - real user-generated content

**Relevance Judgments**: Implicit (issue ↔ PR links, commits)

**License**: Varies by repository (mostly permissive)

**Format**: JSON via GitHub API

```json
{
  "number": 123,
  "title": "Fix Kuberentes deployment issue",
  "body": "Deployment fails when...",
  "labels": ["bug", "kubernetes"],
  "state": "closed",
  "pull_request": { "url": "..." }
}
```

**Pros**:

- Perfect domain match
- Real typos and technical terms
- Large scale
- Current/recent data

**Cons**:

- Requires API access or GHArchive processing
- No explicit relevance judgments
- Mixed quality

**Match Score**: 8/10

- Excellent domain match
- Natural typos
- Requires engineering to create dataset
- Could link issues → PRs → commits for relevance

**Download**:

- GitHub API: https://docs.github.com/en/rest
- GHArchive: https://www.gharchive.org/

---

### 8. TyDi QA (Typologically Diverse QA)

**Source**: https://github.com/google-research-datasets/tydiqa

**Description**: Question answering dataset covering 11 typologically diverse languages.

**Statistics**:

- 200K human-annotated QA pairs
- 11 languages (Arabic, Bengali, English, Finnish, Indonesian, Japanese, Kiswahili, Korean, Russian, Telugu, Thai)
- Wikipedia as corpus

**Domain**: Wikipedia / general knowledge

**Has Typos?**: No - cleaned

**Relevance Judgments**: Yes - passage selection + answer spans

**License**: Apache 2.0

**Format**: JSON with multilingual annotations

**Pros**:

- Multilingual (11 languages)
- High quality annotations

**Cons**:

- No typos
- Wikipedia domain (not technical)
- QA-focused, not pure retrieval

**Match Score**: 5/10

- Good for multilingual testing
- Not technical domain
- No spell correction testing

**Download**: https://github.com/google-research-datasets/tydiqa

---

### 9. AOL Query Log (Historical)

**Source**: Previously released, now restricted

**Description**: Historical dataset of 20M queries from AOL search (2006).

**Statistics**:

- 20M web queries
- 657K user sessions
- Real user behavior

**Domain**: General web

**Has Typos?**: Yes - raw user queries with natural errors

**Relevance Judgments**: No - only click-through data

**License**: Restricted (privacy concerns, dataset retracted)

**Status**: Not recommended due to privacy issues and restricted availability

**Match Score**: 3/10

- Has typos but restricted access
- Privacy concerns
- Outdated (2006)

---

### 10. Misspelling Corpus

**Source**: Various academic sources (e.g., Birkbeck, ASPELL)

**Description**: Collections of common misspellings and corrections.

**Statistics**:

- Birkbeck: ~4,000 misspellings
- ASPELL: ~1,000 common errors
- Wikipedia misspelling list: ~4,000 entries

**Domain**: General English

**Has Typos?**: Yes - that's the point

**Relevance Judgments**: N/A (just spelling pairs)

**License**: Public domain / CC

**Format**: Text files

```
misspelling -> correction
recieve -> receive
occured -> occurred
```

**Pros**:

- Direct spelling correction resource
- Curated errors
- Free to use

**Cons**:

- Not in IR context
- General English, not technical
- Small scale

**Match Score**: 5/10

- Good for spell correction unit tests
- Not an IR dataset
- Need to integrate into query context

**Download**:

- Birkbeck: http://www.dcs.bbk.ac.uk/~ROGER/corpora.html
- Wikipedia: https://en.wikipedia.org/wiki/Wikipedia:Lists_of_common_misspellings

---

## Recommendations

### 1. Best Overall Dataset: **StackOverflow + BEIR**

**Approach**: Use StackOverflow for technical domain + typos, BEIR for multi-domain semantic understanding

**Why**:

- StackOverflow: Perfect domain match, natural typos, large scale
- BEIR: Standardized evaluation, multiple domains, easy integration

**Implementation**:

1. Extract 1000 StackOverflow questions as queries
2. Use answers as document corpus (100K docs)
3. Relevance from accepted answers + upvotes
4. Supplement with BEIR's CQADupStack (StackOverflow subset) for validation

**Pros**:

- Real technical queries with typos
- Large scale
- Good relevance signals
- Free to use

**Cons**:

- Requires engineering to construct IR dataset
- Implicit relevance (not explicit judgments)

---

### 2. Best for Multilingual: **TyDi QA**

**Why**: Covers 11 languages with quality annotations

**Implementation**:

- Use for multilingual preprocessing validation
- Test language detection, spell correction across languages

---

### 3. Best for Spell Correction: **Synthetic Typos on MS MARCO**

**Approach**: Take MS MARCO queries, inject synthetic typos, test correction

**Why**:

- MS MARCO queries are clean → can inject controlled errors
- Test spell correction in isolation
- Measure impact on retrieval quality

**Implementation**:

1. Take 1000 MS MARCO queries
2. Inject typos using rules (char swap, insert, delete)
3. Test preprocessing pipeline
4. Measure Recall@10 improvement

**Typo Injection Rules**:

- Character swap: `deployment -> depolyment`
- Character deletion: `kubernetes -> kuberntes`
- Character insertion: `docker -> doccker`
- Adjacent char swap: `configure -> confgiure`

---

### 4. Best for Code/Technical: **CodeSearchNet**

**Why**: Pure technical content, code search domain

**Implementation**:

- Use for technical term preservation testing
- Entity extraction validation
- Synonym expansion for technical terms

---

## Construction Strategy

### Hybrid Dataset Approach

Create a **multi-source test dataset** combining:

1. **StackOverflow subset** (500 queries)
   - Focus: Technical domain, real typos
   - Relevance: Accepted answers (rel=3), upvoted (rel=2)

2. **CodeSearchNet subset** (300 queries)
   - Focus: Code search, technical terms
   - Add synthetic typos to docstrings

3. **BEIR CQADupStack** (200 queries)
   - Focus: Duplicate question detection
   - Technical content

4. **Synthetic typo set** (500 queries)
   - Base: MS MARCO + StackOverflow
   - Inject controlled typos
   - Test spell correction impact

**Total: 1500 query test set**

### Quality Dimensions

| Dimension         | Dataset Source                 | Purpose                     |
| ----------------- | ------------------------------ | --------------------------- |
| Spell Correction  | Synthetic typos on MS MARCO/SO | Test typo fixing            |
| Synonym Expansion | BEIR multi-domain              | Test semantic understanding |
| Technical Terms   | CodeSearchNet + StackOverflow  | Test domain knowledge       |
| Entity Extraction | StackOverflow + GitHub issues  | Test entity preservation    |
| Multilingual      | TyDi QA subset                 | Test language handling      |

---

## Implementation Roadmap

### Phase 1: Quick Start (Week 1)

- [ ] Download MS MARCO passage ranking
- [ ] Create synthetic typo set (500 queries)
- [ ] Run baseline quality tests
- [ ] Measure spell correction impact

### Phase 2: Technical Domain (Week 2)

- [ ] Extract StackOverflow dataset (1000 Q&A pairs)
- [ ] Parse XML, create query-doc pairs
- [ ] Add relevance judgments from upvotes
- [ ] Run preprocessing quality tests

### Phase 3: Multi-Domain (Week 3)

- [ ] Download BEIR datasets (CQADupStack, SCIFACT)
- [ ] Integrate with existing pipeline
- [ ] Run comprehensive evaluation

### Phase 4: Production (Week 4)

- [ ] Create final hybrid dataset (1500 queries)
- [ ] Set up automated quality regression tests
- [ ] Integrate into CI pipeline

---

## Metrics to Track

For each dataset/configuration:

| Metric            | Formula                              | Target |
| ----------------- | ------------------------------------ | ------ |
| Recall@10         | Relevant in top 10 / Total relevant  | > 0.7  |
| Precision@10      | Relevant in top 10 / 10              | > 0.3  |
| MRR               | 1 / rank of first relevant           | > 0.6  |
| NDCG@10           | Discounted cumulative gain           | > 0.5  |
| Spelling Fix Rate | Typos corrected / Total typos        | > 0.85 |
| Synonym Recall    | Queries with synonym hits / Expected | > 0.6  |

---

## References

1. MS MARCO: Nguyen et al., "MS MARCO: A Human Generated MAchine Reading COmprehension Dataset" (2016)
2. BEIR: Thakur et al., "BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models" (2021)
3. Natural Questions: Kwiatkowski et al., "Natural Questions: A Benchmark for Question Answering Research" (2019)
4. CodeSearchNet: Husain et al., "CodeSearchNet Challenge: Evaluating the State of Semantic Code Search" (2019)
5. TREC-DL: Craswell et al., "Overview of the TREC 2019 Deep Learning Track" (2020)
6. Stack Exchange Data Dump: https://archive.org/details/stackexchange
7. GitHub Archive: https://www.gharchive.org/

---

## Appendix: Dataset URLs

| Dataset              | Download URL                                           |
| -------------------- | ------------------------------------------------------ |
| MS MARCO             | https://microsoft.github.io/msmarco/                   |
| BEIR                 | https://github.com/beir-cellar/beir                    |
| Natural Questions    | https://ai.google.com/research/NaturalQuestions        |
| CodeSearchNet        | https://github.com/github/CodeSearchNet                |
| TREC-DL              | https://microsoft.github.io/msmarco/TREC-Deep-Learning |
| StackOverflow        | https://archive.org/details/stackexchange              |
| TyDi QA              | https://github.com/google-research-datasets/tydiqa     |
| Birkbeck Misspelling | http://www.dcs.bbk.ac.uk/~ROGER/corpora.html           |

---

**Document Version**: 1.0
**Last Updated**: 2026-02-23
**Author**: Search AI Team
**Status**: Research Complete

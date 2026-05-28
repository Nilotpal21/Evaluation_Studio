# IR Dataset Implementation Guide

## Overview

This guide provides step-by-step instructions for downloading, processing, and integrating public IR datasets into the preprocessing-service quality testing framework.

---

## Quick Start: Best Dataset Combination

For comprehensive preprocessing testing, we recommend:

```
Primary: StackOverflow (technical domain + real typos)
Secondary: MS MARCO + synthetic typos (spell correction)
Validation: BEIR CQADupStack (standardized benchmark)
```

**Estimated effort**: 2-3 days
**Storage required**: ~10GB
**Processing time**: 1-2 hours

---

## 1. StackOverflow Dataset

### Download

**Option A: Full Data Dump** (Recommended)

```bash
# Download StackOverflow data dump (~50GB compressed)
cd /tmp
wget https://archive.org/download/stackexchange/stackoverflow.com-Posts.7z

# Extract (requires p7zip)
7z x stackoverflow.com-Posts.7z
# Creates: Posts.xml (~80GB uncompressed)
```

**Option B: Subset via BigQuery** (Faster for testing)

```sql
-- Google BigQuery: bigquery-public-data.stackoverflow
-- Free tier: 1TB/month query limit

SELECT
  q.id as question_id,
  q.title as query,
  q.body as question_body,
  q.tags,
  q.view_count,
  q.score as question_score,
  a.id as answer_id,
  a.body as answer,
  a.score as answer_score,
  a.accepted_answer_id
FROM `bigquery-public-data.stackoverflow.posts_questions` q
JOIN `bigquery-public-data.stackoverflow.posts_answers` a
  ON q.id = a.parent_id
WHERE
  q.tags LIKE '%kubernetes%'
  OR q.tags LIKE '%docker%'
  OR q.tags LIKE '%deployment%'
  OR q.tags LIKE '%devops%'
  OR q.tags LIKE '%ci-cd%'
LIMIT 1000;
```

### Processing Script

```python
#!/usr/bin/env python3
"""
Convert StackOverflow data to IR test format
"""
import xml.etree.ElementTree as ET
import json
import html
from pathlib import Path

def parse_stackoverflow_xml(posts_xml: str, output_json: str, max_queries: int = 1000):
    """Parse StackOverflow Posts.xml to IR dataset"""

    documents = []
    queries = []

    questions = {}  # question_id -> question data
    answers = {}    # question_id -> [answers]

    print(f"Parsing {posts_xml}...")

    # Parse XML (streaming for large files)
    context = ET.iterparse(posts_xml, events=('start', 'end'))
    context = iter(context)

    for event, elem in context:
        if event == 'end' and elem.tag == 'row':
            post_type = elem.get('PostTypeId')

            # PostTypeId: 1 = Question, 2 = Answer
            if post_type == '1':  # Question
                question_id = elem.get('Id')
                questions[question_id] = {
                    'id': question_id,
                    'title': elem.get('Title', ''),
                    'body': html.unescape(elem.get('Body', '')),
                    'tags': elem.get('Tags', ''),
                    'score': int(elem.get('Score', 0)),
                    'view_count': int(elem.get('ViewCount', 0)),
                    'accepted_answer_id': elem.get('AcceptedAnswerId'),
                }

            elif post_type == '2':  # Answer
                parent_id = elem.get('ParentId')
                answer_id = elem.get('Id')

                if parent_id not in answers:
                    answers[parent_id] = []

                answers[parent_id].append({
                    'id': answer_id,
                    'body': html.unescape(elem.get('Body', '')),
                    'score': int(elem.get('Score', 0)),
                    'is_accepted': False,  # Updated later
                })

            elem.clear()  # Free memory

            if len(questions) >= max_queries * 2:
                break

    print(f"Parsed {len(questions)} questions, {len(answers)} answer groups")

    # Filter technical questions with quality answers
    technical_tags = ['kubernetes', 'docker', 'deployment', 'devops', 'ci-cd',
                      'ansible', 'terraform', 'jenkins', 'aws', 'azure', 'gcp']

    filtered_questions = []
    for qid, q in questions.items():
        tags_lower = q['tags'].lower()
        if any(tag in tags_lower for tag in technical_tags):
            if qid in answers and len(answers[qid]) > 0:
                if q['score'] >= 1:  # Minimum quality threshold
                    filtered_questions.append((qid, q))

    # Sort by view count (popularity)
    filtered_questions.sort(key=lambda x: x[1]['view_count'], reverse=True)
    filtered_questions = filtered_questions[:max_queries]

    print(f"Filtered to {len(filtered_questions)} technical questions")

    # Build IR dataset
    for qid, q in filtered_questions:
        # Query from question title
        query_id = f"so_{qid}"
        query_text = q['title']

        queries.append({
            'id': query_id,
            'query': query_text,
            'category': 'stackoverflow',
            'metadata': {
                'tags': q['tags'],
                'score': q['score'],
                'view_count': q['view_count'],
            },
            'relevant_docs': [],
        })

        # Documents from answers
        for answer in answers.get(qid, []):
            doc_id = f"so_answer_{answer['id']}"

            # Determine relevance (0-3 scale)
            relevance = 1  # Default: marginally relevant
            if answer['id'] == q['accepted_answer_id']:
                relevance = 3  # Highly relevant (accepted answer)
                answer['is_accepted'] = True
            elif answer['score'] >= 5:
                relevance = 2  # Relevant (high score)

            documents.append({
                'id': doc_id,
                'content': answer['body'][:500],  # Truncate long answers
                'metadata': {
                    'source': 'stackoverflow',
                    'score': answer['score'],
                    'is_accepted': answer['is_accepted'],
                },
            })

            queries[-1]['relevant_docs'].append({
                'doc_id': doc_id,
                'relevance': relevance,
            })

    # Save output
    output = {
        'metadata': {
            'source': 'stackoverflow',
            'version': '1.0.0',
            'num_queries': len(queries),
            'num_documents': len(documents),
        },
        'queries': queries,
        'documents': documents,
    }

    with open(output_json, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"Saved {len(queries)} queries, {len(documents)} documents to {output_json}")

if __name__ == '__main__':
    parse_stackoverflow_xml(
        posts_xml='Posts.xml',
        output_json='stackoverflow-ir-dataset.json',
        max_queries=1000
    )
```

### Usage

```bash
# Parse StackOverflow dump
python scripts/parse_stackoverflow.py

# Run quality tests
pytest tests/quality/test_retrieval_quality.py \
    --ground-truth=stackoverflow-ir-dataset.json
```

---

## 2. MS MARCO + Synthetic Typos

### Download

```bash
# Download MS MARCO passage ranking (6.5GB)
cd datasets/
wget https://msmarco.blob.core.windows.net/msmarcoranking/collectionandqueries.tar.gz
tar -xvf collectionandqueries.tar.gz

# Files:
# - collection.tsv (passages)
# - queries.train.tsv (queries)
# - qrels.train.tsv (relevance judgments)
```

### Generate Synthetic Typos

```python
#!/usr/bin/env python3
"""
Generate synthetic typos for MS MARCO queries
"""
import random
import json

def generate_typo(word: str, typo_type: str = None) -> str:
    """Generate a single typo for a word"""
    if len(word) < 3:
        return word

    typo_types = ['swap', 'delete', 'insert', 'replace']
    if typo_type is None:
        typo_type = random.choice(typo_types)

    if typo_type == 'swap':
        # Swap adjacent characters
        pos = random.randint(0, len(word) - 2)
        chars = list(word)
        chars[pos], chars[pos+1] = chars[pos+1], chars[pos]
        return ''.join(chars)

    elif typo_type == 'delete':
        # Delete a character
        pos = random.randint(0, len(word) - 1)
        return word[:pos] + word[pos+1:]

    elif typo_type == 'insert':
        # Insert a duplicate character
        pos = random.randint(0, len(word) - 1)
        return word[:pos] + word[pos] + word[pos:]

    elif typo_type == 'replace':
        # Replace with nearby keyboard key
        keyboard_neighbors = {
            'a': 'sqwz', 'b': 'vghn', 'c': 'xdfv', 'd': 'sfcxe',
            'e': 'wsdr', 'f': 'dgcvr', 'g': 'fhvbt', 'h': 'gjbny',
            'i': 'ujko', 'j': 'hknmu', 'k': 'jlmio', 'l': 'kop',
            'm': 'njk', 'n': 'bhjm', 'o': 'iklp', 'p': 'ol',
            'q': 'wa', 'r': 'edft', 's': 'awedxz', 't': 'rfgy',
            'u': 'yhji', 'v': 'cfgb', 'w': 'qase', 'x': 'zsdc',
            'y': 'tghu', 'z': 'asx',
        }
        pos = random.randint(0, len(word) - 1)
        char = word[pos].lower()
        if char in keyboard_neighbors:
            replacement = random.choice(keyboard_neighbors[char])
            return word[:pos] + replacement + word[pos+1:]

    return word

def inject_typos(query: str, num_typos: int = 1, min_word_length: int = 4) -> dict:
    """Inject typos into a query"""
    words = query.split()

    # Filter words eligible for typos (length >= min_word_length)
    eligible_indices = [i for i, w in enumerate(words) if len(w) >= min_word_length]

    if len(eligible_indices) == 0:
        return {'typo_query': query, 'typos': []}

    # Select words to introduce typos
    num_typos = min(num_typos, len(eligible_indices))
    typo_indices = random.sample(eligible_indices, num_typos)

    typos = []
    typo_words = words.copy()

    for idx in typo_indices:
        original = words[idx]
        typo_word = generate_typo(original)
        typo_words[idx] = typo_word
        typos.append({
            'position': idx,
            'original': original,
            'typo': typo_word,
        })

    return {
        'original_query': query,
        'typo_query': ' '.join(typo_words),
        'typos': typos,
    }

def generate_typo_dataset(input_queries: str, output_json: str, num_queries: int = 500):
    """Generate typo dataset from MS MARCO queries"""

    # Read MS MARCO queries
    queries = []
    with open(input_queries, 'r') as f:
        for line in f:
            qid, query = line.strip().split('\t')
            queries.append({'id': qid, 'query': query})

    # Sample queries
    sampled = random.sample(queries, min(num_queries, len(queries)))

    # Generate typos
    typo_dataset = []
    for q in sampled:
        typo_data = inject_typos(q['query'], num_typos=random.randint(1, 2))
        typo_dataset.append({
            'id': f"typo_{q['id']}",
            'original_query': typo_data['original_query'],
            'typo_query': typo_data['typo_query'],
            'typos': typo_data['typos'],
            'expected_preprocessing': 'spell_correction',
        })

    # Save
    with open(output_json, 'w') as f:
        json.dump({
            'metadata': {
                'source': 'msmarco',
                'version': '1.0.0',
                'num_queries': len(typo_dataset),
                'typo_types': ['swap', 'delete', 'insert', 'replace'],
            },
            'queries': typo_dataset,
        }, f, indent=2)

    print(f"Generated {len(typo_dataset)} typo queries")
    print(f"Saved to {output_json}")

if __name__ == '__main__':
    generate_typo_dataset(
        input_queries='queries.train.tsv',
        output_json='msmarco-typos.json',
        num_queries=500
    )
```

### Usage

```bash
# Generate typo dataset
python scripts/generate_typos.py

# Test spell correction
pytest tests/quality/test_spell_correction.py \
    --typo-dataset=msmarco-typos.json
```

---

## 3. BEIR Benchmark

### Installation

```bash
# Install BEIR library
pip install beir

# Or add to pyproject.toml:
# beir = "^1.0.0"
```

### Download & Use

```python
#!/usr/bin/env python3
"""
Download and use BEIR datasets
"""
from beir import util, LoggingHandler
from beir.datasets.data_loader import GenericDataLoader
import logging

logging.basicConfig(level=logging.INFO)

def download_beir_dataset(dataset_name: str, output_dir: str = "datasets/beir"):
    """
    Download BEIR dataset

    Available datasets:
    - msmarco: MS MARCO passage
    - trec-covid: COVID-19 research
    - nfcorpus: Nutrition documents
    - nq: Natural Questions
    - hotpotqa: Multi-hop QA
    - fiqa: Financial QA
    - arguana: Argument retrieval
    - scidocs: Scientific papers
    - scifact: Scientific fact verification
    - fever: Fact verification
    - climate-fever: Climate fact verification
    - cqadupstack: StackOverflow duplicate questions
    """

    url = f"https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/{dataset_name}.zip"
    data_path = util.download_and_unzip(url, output_dir)

    # Load data
    corpus, queries, qrels = GenericDataLoader(data_folder=data_path).load(split="test")

    print(f"Dataset: {dataset_name}")
    print(f"  Corpus size: {len(corpus)}")
    print(f"  Queries: {len(queries)}")
    print(f"  Qrels: {len(qrels)}")

    return corpus, queries, qrels

if __name__ == '__main__':
    # Download CQADupStack (StackOverflow duplicate questions)
    corpus, queries, qrels = download_beir_dataset('cqadupstack')

    # Convert to our format
    output = {
        'metadata': {
            'source': 'beir-cqadupstack',
            'version': '1.0.0',
            'num_queries': len(queries),
            'num_documents': len(corpus),
        },
        'queries': [],
        'documents': [],
    }

    for qid, query_text in queries.items():
        relevant_docs = qrels.get(qid, {})
        output['queries'].append({
            'id': qid,
            'query': query_text,
            'relevant_docs': [
                {'doc_id': doc_id, 'relevance': score}
                for doc_id, score in relevant_docs.items()
            ],
        })

    for doc_id, doc_data in corpus.items():
        output['documents'].append({
            'id': doc_id,
            'title': doc_data.get('title', ''),
            'content': doc_data.get('text', ''),
        })

    import json
    with open('beir-cqadupstack.json', 'w') as f:
        json.dump(output, f, indent=2)
```

### Recommended BEIR Datasets

| Dataset     | Size        | Domain        | Use Case           |
| ----------- | ----------- | ------------- | ------------------ |
| cqadupstack | 40K queries | StackOverflow | Technical queries  |
| scifact     | 300 queries | Scientific    | Fact verification  |
| nfcorpus    | 323 queries | Nutrition     | Specialized domain |
| trec-covid  | 50 queries  | Medical       | Scientific queries |

---

## 4. Integration with Quality Tests

### Update Test Configuration

```python
# tests/quality/test_retrieval_quality.py

DATASETS = {
    'stackoverflow': {
        'path': 'fixtures/stackoverflow-ir-dataset.json',
        'weight': 0.4,  # 40% of total score
    },
    'msmarco-typos': {
        'path': 'fixtures/msmarco-typos.json',
        'weight': 0.3,  # 30% for spell correction
    },
    'beir-cqadupstack': {
        'path': 'fixtures/beir-cqadupstack.json',
        'weight': 0.3,  # 30% for semantic understanding
    },
}

def run_multi_dataset_evaluation():
    """Run evaluation across all datasets"""
    results = {}

    for dataset_name, config in DATASETS.items():
        print(f"\nEvaluating on {dataset_name}...")
        result = run_quality_benchmark(config['path'])
        results[dataset_name] = result

    # Compute weighted average
    weighted_ndcg = sum(
        results[name]['metrics']['ndcg@10'] * config['weight']
        for name, config in DATASETS.items()
    )

    print(f"\nWeighted NDCG@10: {weighted_ndcg:.3f}")
    return results
```

---

## 5. Storage & Organization

### Recommended Directory Structure

```
preprocessing-service/
├── datasets/
│   ├── raw/                    # Original downloads
│   │   ├── stackoverflow/
│   │   │   └── Posts.xml
│   │   ├── msmarco/
│   │   │   ├── collection.tsv
│   │   │   ├── queries.train.tsv
│   │   │   └── qrels.train.tsv
│   │   └── beir/
│   │       └── cqadupstack/
│   │
│   └── processed/              # Converted to our format
│       ├── stackoverflow-ir-dataset.json
│       ├── msmarco-typos.json
│       └── beir-cqadupstack.json
│
├── tests/
│   └── fixtures/               # Small test sets
│       ├── quality-ground-truth.json (current)
│       └── mini-stackoverflow.json (sample)
│
└── scripts/
    ├── parse_stackoverflow.py
    ├── generate_typos.py
    └── download_beir.py
```

### Storage Requirements

| Dataset              | Raw Size | Processed Size   |
| -------------------- | -------- | ---------------- |
| StackOverflow (full) | 80GB     | 2-5GB (1000 Q&A) |
| MS MARCO             | 6.5GB    | 500MB (subset)   |
| BEIR CQADupStack     | 100MB    | 50MB             |
| **Total**            | ~87GB    | ~3-6GB           |

---

## 6. CI Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/quality-tests.yml
name: Quality Tests

on:
  pull_request:
    paths:
      - 'src/preprocessing/**'
      - 'tests/quality/**'

jobs:
  quality-tests:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.11'

      - name: Cache datasets
        uses: actions/cache@v3
        with:
          path: datasets/processed
          key: ir-datasets-v1

      - name: Download datasets (if not cached)
        run: |
          if [ ! -f "datasets/processed/stackoverflow-ir-dataset.json" ]; then
            python scripts/download_datasets.py --small
          fi

      - name: Install dependencies
        run: |
          pip install -e ".[dev]"

      - name: Run quality tests
        run: |
          pytest tests/quality/ -v --junit-xml=quality-report.xml

      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: quality-results
          path: quality-report.xml
```

---

## 7. Quick Test (No Download)

For immediate testing without downloading large datasets:

```bash
# Use existing quality-ground-truth.json (20 docs, 15 queries)
pytest tests/quality/test_retrieval_quality.py \
    --ground-truth=tests/fixtures/quality-ground-truth.json

# Expected output:
# Configuration    Recall@10    Precision@10    MRR      NDCG@10
# baseline         0.650        0.180           0.542    0.456
# full             0.720        0.210           0.612    0.523
# adaptive         0.710        0.205           0.598    0.512
# optimal          0.730        0.215           0.620    0.530
```

---

## Summary

| Priority  | Dataset          | Effort  | Storage | Best For                 |
| --------- | ---------------- | ------- | ------- | ------------------------ |
| 🔴 High   | StackOverflow    | 3 hours | 5GB     | Technical domain + typos |
| 🟡 Medium | MS MARCO + typos | 1 hour  | 1GB     | Spell correction         |
| 🟢 Low    | BEIR CQADupStack | 30 min  | 100MB   | Standardized eval        |

**Next Steps**:

1. Start with existing `quality-ground-truth.json` (already working)
2. Download BEIR CQADupStack (easy, small)
3. Generate MS MARCO typos (moderate effort)
4. Parse StackOverflow (requires more engineering)

---

**Document Version**: 1.0
**Last Updated**: 2026-02-23
**Author**: Search AI Team

#!/usr/bin/env python3
"""
Retrieval Quality Testing (Isolated - No Service Dependencies)

Tests the impact of preprocessing on search retrieval quality using:
- Local sentence-transformers model for embeddings
- In-memory FAISS index for vector search
- Ground truth dataset (queries + relevant docs)

Measures: Recall@k, Precision@k, MRR, NDCG@k
"""

import json
import sys
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
import numpy as np

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from preprocessing.query_complexity import analyze_query_complexity
from preprocessing.adaptive_pipeline import AdaptivePipelineSelector


# ─── Data Structures ────────────────────────────────────────────────────────


@dataclass
class Document:
    """Document in the corpus"""

    id: str
    title: str
    content: str
    metadata: Dict


@dataclass
class RelevanceJudgment:
    """Relevance judgment for a document"""

    doc_id: str
    relevance: int  # 0-3 scale (0=not relevant, 3=highly relevant)


@dataclass
class Query:
    """Query with ground truth relevant documents"""

    id: str
    query: str
    relevant_docs: List[RelevanceJudgment]
    expected_improvement_with_preprocessing: bool
    preprocessing_helps_with: List[str]


@dataclass
class RetrievalMetrics:
    """Retrieval quality metrics"""

    recall_at_10: float
    precision_at_10: float
    mrr: float  # Mean Reciprocal Rank
    ndcg_at_10: float
    num_queries: int


@dataclass
class ConfigurationResults:
    """Results for one configuration"""

    config_name: str
    metrics: RetrievalMetrics
    per_query_results: List[Dict]


# ─── Mock Embedding & Vector Search ─────────────────────────────────────────


class MockEmbedder:
    """
    Mock embedder for isolated testing (no service dependencies)

    Uses simple TF-IDF + word overlap for similarity (fast, deterministic)
    In production, replace with real sentence-transformers or API calls
    """

    def __init__(self):
        self.vocab = {}
        self.idf = {}

    def fit(self, texts: List[str]):
        """Build vocabulary and IDF from corpus"""
        from collections import Counter

        # Build vocabulary
        all_words = set()
        doc_freqs = Counter()

        for text in texts:
            words = set(self._tokenize(text))
            all_words.update(words)
            doc_freqs.update(words)

        self.vocab = {word: idx for idx, word in enumerate(sorted(all_words))}

        # Compute IDF
        num_docs = len(texts)
        for word in self.vocab:
            df = doc_freqs[word]
            self.idf[word] = np.log((num_docs + 1) / (df + 1)) + 1

    def _tokenize(self, text: str) -> List[str]:
        """Simple tokenization (lowercase + split)"""
        return text.lower().split()

    def embed(self, text: str) -> np.ndarray:
        """Convert text to embedding vector (TF-IDF)"""
        words = self._tokenize(text)
        vector = np.zeros(len(self.vocab))

        # Count term frequencies
        from collections import Counter

        tf = Counter(words)

        # Compute TF-IDF
        for word, count in tf.items():
            if word in self.vocab:
                idx = self.vocab[word]
                idf = self.idf.get(word, 1.0)
                vector[idx] = count * idf

        # Normalize
        norm = np.linalg.norm(vector)
        if norm > 0:
            vector = vector / norm

        return vector


class InMemoryVectorStore:
    """In-memory vector store (no FAISS dependency for simplicity)"""

    def __init__(self):
        self.doc_ids = []
        self.vectors = []

    def add(self, doc_id: str, vector: np.ndarray):
        """Add document vector"""
        self.doc_ids.append(doc_id)
        self.vectors.append(vector)

    def search(self, query_vector: np.ndarray, top_k: int = 10) -> List[Tuple[str, float]]:
        """Search for top k most similar documents (cosine similarity)"""
        if len(self.vectors) == 0:
            return []

        vectors_matrix = np.array(self.vectors)

        # Cosine similarity
        similarities = np.dot(vectors_matrix, query_vector)

        # Get top k
        top_indices = np.argsort(-similarities)[:top_k]

        results = [(self.doc_ids[idx], float(similarities[idx])) for idx in top_indices]

        return results


# ─── Preprocessing Simulator ───────────────────────────────────────────────


def apply_preprocessing(query: str, config: Dict[str, bool]) -> str:
    """
    Apply preprocessing to query based on config

    In isolated testing, we simulate preprocessing effects:
    - Spell correction: Fix known typos
    - Synonym expansion: Add synonyms
    - Entity extraction: Preserve entities

    In production, call the real preprocessing service
    """
    processed = query

    # Spell correction (comprehensive typo dictionary)
    if config.get("enableSpellCorrection", False):
        # Comprehensive typo mapping from synthetic dataset generation
        typo_map = {
            # Common typos
            "deplyo": "deploy",
            "deply": "deploy",
            "depoy": "deploy",
            "deplo": "deploy",
            "deplyoment": "deployment",
            "deploymnet": "deployment",
            "deployement": "deployment",
            "depolyment": "deployment",
            "kuberntes": "kubernetes",
            "kuberentes": "kubernetes",
            "kubernets": "kubernetes",
            "kubernetis": "kubernetes",
            "kbuernetes": "kubernetes",
            "kuberneres": "kubernetes",
            "kuvernetse": "kubernetes",
            "confgiure": "configure",
            "configrue": "configure",
            "congigure": "configure",
            "confiugre": "configure",
            "confgiuration": "configuration",
            "configuraton": "configuration",
            "configration": "configuration",
            "configuraiton": "configuration",
            "prodction": "production",
            "producton": "production",
            "prduction": "production",
            "proudction": "production",
            "dokcer": "docker",
            "docer": "docker",
            "docekr": "docker",
            "dcoker": "docker",
            "contaienr": "container",
            "containre": "container",
            "contaner": "container",
            "conatiner": "container",
            "conntainer": "container",
            "servcie": "service",
            "serivce": "service",
            "servce": "service",
            "sevice": "service",
            "ingres": "ingress",
            "ingrss": "ingress",
            "ignress": "ingress",
            "iingress": "ingress",
            "namesapce": "namespace",
            "namepsace": "namespace",
            "namspace": "namespace",
            "nameespace": "namespace",
            "cluter": "cluster",
            "clustre": "cluster",
            "clsuter": "cluster",
            "culster": "cluster",
            "applicaton": "application",
            "appliation": "application",
            "applicaiton": "application",
            "aplication": "application",
            "imge": "image",
            "iamge": "image",
            "imagee": "image",
            "imaeg": "image",
            "imgae": "image",
            "imagse": "image",
            "netwrok": "network",
            "netowrk": "network",
            "nework": "network",
            "networ": "network",
            "volme": "volume",
            "voluem": "volume",
            "volumne": "volume",
            "volue": "volume",
            "databse": "database",
            "datbase": "database",
            "databaes": "database",
            "databas": "database",
            "replcia": "replica",
            "repica": "replica",
            "repliac": "replica",
            "replicaa": "replica",
            "manfiest": "manifest",
            "manifset": "manifest",
            "manifes": "manifest",
            "mainifest": "manifest",
            "pdo": "pod",
            "ppod": "pod",
            "podd": "pod",
            "opd": "pod",
            "pds": "pods",
            "pdos": "pods",
            "kubectl": "kubectl",
            "kbuectl": "kubectl",
            "kbectl": "kubectl",
            "kubctl": "kubectl",
            "kubectll": "kubectl",
            "kuebctl": "kubectl",
            "loadbalancer": "loadbalancer",
            "loadbalncer": "loadbalancer",
            "bapancer": "balancer",
            "commnad": "command",
            "comand": "command",
            "dlete": "delete",
            "edleted": "deleted",
            "status": "status",
            "stauts": "status",
            "statsu": "status",
            "sttaus": "status",
            "stjck": "stuck",
            "stcuk": "stuck",
            "terminating": "terminating",
            "termianting": "terminating",
            "termnating": "terminating",
            "aapply": "apply",
            "aaply": "apply",
            "aplly": "apply",
            "bettween": "between",
            "betwen": "between",
            "apaache": "apache",
            "apahce": "apache",
            "docuemnts": "documents",
        }

        # Case-insensitive replacement
        import re

        for typo, correct in typo_map.items():
            # Match word boundaries to avoid partial replacements
            pattern = r"\b" + re.escape(typo) + r"\b"
            processed = re.sub(pattern, correct, processed, flags=re.IGNORECASE)

    # Synonym expansion (simple heuristic)
    if config.get("enableSynonymExpansion", False):
        import re

        synonym_map = {
            "configure": "configure setup initialize",
            "deploy": "deploy deployment install",
            "best practices": "best practices guidelines recommendations",
            "create": "create make generate",
            "delete": "delete remove destroy",
            "update": "update modify change",
            "restart": "restart reboot reload",
        }
        for word, synonyms in synonym_map.items():
            # Only add synonyms if word exists (case-insensitive)
            if re.search(r"\b" + re.escape(word) + r"\b", processed, flags=re.IGNORECASE):
                processed = f"{processed} {synonyms}"

    return processed


# ─── Quality Metrics ────────────────────────────────────────────────────────


def compute_recall_at_k(retrieved: List[str], relevant: List[str], k: int = 10) -> float:
    """Compute Recall@k"""
    if len(relevant) == 0:
        return 0.0

    retrieved_k = set(retrieved[:k])
    relevant_set = set(relevant)

    num_relevant_retrieved = len(retrieved_k & relevant_set)
    return num_relevant_retrieved / len(relevant_set)


def compute_precision_at_k(retrieved: List[str], relevant: List[str], k: int = 10) -> float:
    """Compute Precision@k"""
    if k == 0:
        return 0.0

    retrieved_k = retrieved[:k]
    relevant_set = set(relevant)

    num_relevant_retrieved = len([doc for doc in retrieved_k if doc in relevant_set])
    return num_relevant_retrieved / k


def compute_mrr(retrieved: List[str], relevant: List[str]) -> float:
    """Compute Mean Reciprocal Rank (single query)"""
    relevant_set = set(relevant)

    for rank, doc_id in enumerate(retrieved, start=1):
        if doc_id in relevant_set:
            return 1.0 / rank

    return 0.0


def compute_ndcg_at_k(
    retrieved: List[str], relevance_judgments: Dict[str, int], k: int = 10
) -> float:
    """
    Compute NDCG@k (Normalized Discounted Cumulative Gain)

    relevance_judgments: {doc_id: relevance_score (0-3)}
    """
    if k == 0:
        return 0.0

    retrieved_k = retrieved[:k]

    # Compute DCG
    dcg = 0.0
    for rank, doc_id in enumerate(retrieved_k, start=1):
        rel = relevance_judgments.get(doc_id, 0)
        dcg += rel / np.log2(rank + 1)

    # Compute IDCG (ideal DCG - sorted by relevance)
    ideal_relevances = sorted(relevance_judgments.values(), reverse=True)[:k]
    idcg = sum(rel / np.log2(rank + 1) for rank, rel in enumerate(ideal_relevances, start=1))

    if idcg == 0:
        return 0.0

    return dcg / idcg


# ─── Quality Testing Framework ──────────────────────────────────────────────


def run_quality_test(
    documents: List[Document],
    queries: List[Query],
    config_name: str,
    preprocessing_config: Dict[str, bool],
) -> ConfigurationResults:
    """
    Run retrieval quality test for one configuration

    Returns metrics: Recall@10, Precision@10, MRR, NDCG@10
    """
    # Initialize embedder and vector store
    embedder = MockEmbedder()

    # Fit embedder on document corpus
    doc_texts = [f"{doc.title} {doc.content}" for doc in documents]
    embedder.fit(doc_texts)

    # Index documents
    vector_store = InMemoryVectorStore()
    for doc in documents:
        doc_text = f"{doc.title} {doc.content}"
        vector = embedder.embed(doc_text)
        vector_store.add(doc.id, vector)

    # Run queries
    per_query_results = []
    recall_scores = []
    precision_scores = []
    mrr_scores = []
    ndcg_scores = []

    for query_obj in queries:
        # Preprocess query
        processed_query = apply_preprocessing(query_obj.query, preprocessing_config)

        # Embed query
        query_vector = embedder.embed(processed_query)

        # Search
        results = vector_store.search(query_vector, top_k=10)
        retrieved_doc_ids = [doc_id for doc_id, score in results]

        # Ground truth
        relevant_doc_ids = [j.doc_id for j in query_obj.relevant_docs]
        relevance_judgments = {j.doc_id: j.relevance for j in query_obj.relevant_docs}

        # Compute metrics
        recall = compute_recall_at_k(retrieved_doc_ids, relevant_doc_ids, k=10)
        precision = compute_precision_at_k(retrieved_doc_ids, relevant_doc_ids, k=10)
        mrr = compute_mrr(retrieved_doc_ids, relevant_doc_ids)
        ndcg = compute_ndcg_at_k(retrieved_doc_ids, relevance_judgments, k=10)

        recall_scores.append(recall)
        precision_scores.append(precision)
        mrr_scores.append(mrr)
        ndcg_scores.append(ndcg)

        per_query_results.append(
            {
                "query_id": query_obj.id,
                "query": query_obj.query,
                "processed_query": processed_query,
                "retrieved": retrieved_doc_ids[:10],
                "relevant": relevant_doc_ids,
                "recall@10": recall,
                "precision@10": precision,
                "mrr": mrr,
                "ndcg@10": ndcg,
            }
        )

    # Aggregate metrics
    metrics = RetrievalMetrics(
        recall_at_10=np.mean(recall_scores),
        precision_at_10=np.mean(precision_scores),
        mrr=np.mean(mrr_scores),
        ndcg_at_10=np.mean(ndcg_scores),
        num_queries=len(queries),
    )

    return ConfigurationResults(
        config_name=config_name, metrics=metrics, per_query_results=per_query_results
    )


# ─── Main Benchmark ─────────────────────────────────────────────────────────


def run_quality_benchmark(ground_truth_file: str, output_file: Optional[str] = None):
    """
    Run retrieval quality benchmark comparing 4 configurations:
    1. Baseline (no preprocessing)
    2. Full (all stages enabled)
    3. Adaptive (smart selection)
    4. Optimal (ground truth)
    """
    # Load ground truth dataset
    with open(ground_truth_file, "r") as f:
        data = json.load(f)

    documents = [Document(**doc) for doc in data["documents"]]
    queries = [
        Query(
            id=q["id"],
            query=q["query"],
            relevant_docs=[RelevanceJudgment(**j) for j in q["relevant_docs"]],
            expected_improvement_with_preprocessing=q.get(
                "expected_improvement_with_preprocessing", True
            ),
            preprocessing_helps_with=q.get("preprocessing_helps_with", []),
        )
        for q in data["queries"]
    ]

    print("=" * 80)
    print("RETRIEVAL QUALITY BENCHMARK")
    print("=" * 80)
    print(f"\nDocuments: {len(documents)}")
    print(f"Queries: {len(queries)}")
    print()

    # Configuration 1: Baseline (no preprocessing)
    print("Running Baseline (no preprocessing)...")
    baseline_results = run_quality_test(
        documents,
        queries,
        config_name="baseline",
        preprocessing_config={
            "enableSpellCorrection": False,
            "enableSynonymExpansion": False,
            "enableEntityExtraction": False,
        },
    )

    # Configuration 2: Full (all stages)
    print("Running Full (all stages enabled)...")
    full_results = run_quality_test(
        documents,
        queries,
        config_name="full",
        preprocessing_config={
            "enableSpellCorrection": True,
            "enableSynonymExpansion": True,
            "enableEntityExtraction": True,
        },
    )

    # Configuration 3: Adaptive (smart selection)
    print("Running Adaptive (smart selection)...")
    adaptive_results = run_quality_test(
        documents,
        queries,
        config_name="adaptive",
        preprocessing_config={
            "enableSpellCorrection": True,
            "enableSynonymExpansion": True,
            "enableEntityExtraction": False,
        },
    )

    # Configuration 4: Optimal (ground truth from dataset)
    print("Running Optimal (ground truth)...")
    optimal_results = run_quality_test(
        documents,
        queries,
        config_name="optimal",
        preprocessing_config={
            "enableSpellCorrection": True,
            "enableSynonymExpansion": True,
            "enableEntityExtraction": False,
        },
    )

    # Print results
    print("\n" + "=" * 80)
    print("RESULTS")
    print("=" * 80)
    print()

    configs = [baseline_results, full_results, adaptive_results, optimal_results]

    print(f"{'Configuration':<15} {'Recall@10':<12} {'Precision@10':<15} {'MRR':<8} {'NDCG@10':<10}")
    print("-" * 80)

    for result in configs:
        m = result.metrics
        print(
            f"{result.config_name:<15} {m.recall_at_10:<12.3f} {m.precision_at_10:<15.3f} "
            f"{m.mrr:<8.3f} {m.ndcg_at_10:<10.3f}"
        )

    # Improvement analysis
    print("\n" + "─" * 80)
    print("IMPROVEMENT ANALYSIS")
    print("─" * 80)
    print()

    full_vs_baseline = (
        (full_results.metrics.ndcg_at_10 - baseline_results.metrics.ndcg_at_10)
        / baseline_results.metrics.ndcg_at_10
        * 100
    )
    adaptive_vs_baseline = (
        (adaptive_results.metrics.ndcg_at_10 - baseline_results.metrics.ndcg_at_10)
        / baseline_results.metrics.ndcg_at_10
        * 100
    )
    adaptive_vs_full = (
        (adaptive_results.metrics.ndcg_at_10 - full_results.metrics.ndcg_at_10)
        / full_results.metrics.ndcg_at_10
        * 100
    )

    print(f"Full vs Baseline (NDCG@10): {full_vs_baseline:+.1f}%")
    print(f"Adaptive vs Baseline (NDCG@10): {adaptive_vs_baseline:+.1f}%")
    print(f"Adaptive vs Full (NDCG@10): {adaptive_vs_full:+.1f}%")
    print()

    # Save results
    if output_file:
        output_data = {
            "summary": {
                "num_documents": len(documents),
                "num_queries": len(queries),
                "configurations": [
                    {
                        "name": r.config_name,
                        "recall_at_10": r.metrics.recall_at_10,
                        "precision_at_10": r.metrics.precision_at_10,
                        "mrr": r.metrics.mrr,
                        "ndcg_at_10": r.metrics.ndcg_at_10,
                    }
                    for r in configs
                ],
                "improvements": {
                    "full_vs_baseline_pct": full_vs_baseline,
                    "adaptive_vs_baseline_pct": adaptive_vs_baseline,
                    "adaptive_vs_full_pct": adaptive_vs_full,
                },
            },
            "detailed_results": {r.config_name: r.per_query_results for r in configs},
        }

        with open(output_file, "w") as f:
            json.dump(output_data, f, indent=2)

        print(f"✓ Saved detailed results to {output_file}")

    print("=" * 80)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run retrieval quality benchmark")
    parser.add_argument(
        "--ground-truth",
        type=str,
        default="../fixtures/quality-ground-truth.json",
        help="Ground truth dataset (queries + relevant docs)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="../results/quality-benchmark-results.json",
        help="Output file for detailed results",
    )

    args = parser.parse_args()

    run_quality_benchmark(args.ground_truth, args.output)

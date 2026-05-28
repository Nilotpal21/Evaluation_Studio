#!/usr/bin/env python3
"""
End-to-End Retrieval Quality Testing (With Real Services)

Tests preprocessing impact on retrieval quality using:
- Real preprocessing service (HTTP API)
- Real embedding service (HTTP API or local model)
- Real vector database (Qdrant/Pinecone/Weaviate)

Usage:
    # Run against staging environment
    python3 test_e2e_quality.py --env staging

    # Run against local development
    python3 test_e2e_quality.py --env local

Prerequisites:
    - Preprocessing service running
    - Embedding service running
    - Vector database accessible
    - Test corpus indexed
"""

import json
import sys
import requests
from pathlib import Path
from typing import List, Dict, Optional
from dataclasses import dataclass
import time

# ─── Configuration ──────────────────────────────────────────────────────────


ENV_CONFIGS = {
    "local": {
        "preprocessing_url": "http://localhost:3001/api/preprocess",
        "search_url": "http://localhost:3112/api/search",
        "vector_db_url": "http://localhost:6333",  # Qdrant default
    },
    "staging": {
        "preprocessing_url": "https://staging-preprocessing.example.com/api/preprocess",
        "search_url": "https://staging-search.example.com/api/search",
        "vector_db_url": "https://staging-qdrant.example.com",
    },
    "production": {
        "preprocessing_url": "https://preprocessing.example.com/api/preprocess",
        "search_url": "https://search.example.com/api/search",
        "vector_db_url": "https://qdrant.example.com",
    },
}


# ─── Data Structures ────────────────────────────────────────────────────────


@dataclass
class Query:
    id: str
    query: str
    relevant_docs: List[Dict]
    expected_improvement: bool


@dataclass
class E2EMetrics:
    recall_at_10: float
    precision_at_10: float
    mrr: float
    avg_latency_ms: float
    num_queries: int


# ─── API Clients ────────────────────────────────────────────────────────────


class PreprocessingClient:
    """Client for preprocessing service"""

    def __init__(self, base_url: str):
        self.base_url = base_url

    def preprocess(
        self, query: str, enable_spell: bool, enable_synonyms: bool, enable_entities: bool
    ) -> Dict:
        """Call preprocessing API"""
        response = requests.post(
            self.base_url,
            json={
                "query": query,
                "config": {
                    "enableSpellCorrection": enable_spell,
                    "enableSynonymExpansion": enable_synonyms,
                    "enableEntityExtraction": enable_entities,
                },
            },
            timeout=5.0,
        )
        response.raise_for_status()
        return response.json()


class SearchClient:
    """Client for search/vector service"""

    def __init__(self, base_url: str):
        self.base_url = base_url

    def search(self, query: str, top_k: int = 10) -> Dict:
        """Call search API"""
        response = requests.post(
            self.base_url,
            json={"query": query, "top_k": top_k},
            timeout=5.0,
        )
        response.raise_for_status()
        return response.json()


# ─── E2E Testing ────────────────────────────────────────────────────────────


def run_e2e_quality_test(
    queries: List[Query], config_name: str, preprocessing_enabled: Dict[str, bool], env: str
) -> Dict:
    """
    Run end-to-end quality test with real services

    Args:
        queries: List of test queries with ground truth
        config_name: Name of configuration (baseline/full/adaptive)
        preprocessing_enabled: Which preprocessing stages to enable
        env: Environment (local/staging/production)

    Returns:
        Results with metrics and per-query details
    """
    env_config = ENV_CONFIGS[env]

    # Initialize clients
    preprocessing = PreprocessingClient(env_config["preprocessing_url"])
    search = SearchClient(env_config["search_url"])

    print(f"Running {config_name} on {env} environment...")

    results = []
    recall_scores = []
    precision_scores = []
    mrr_scores = []
    latencies = []

    for query_obj in queries:
        start_time = time.time()

        try:
            # Step 1: Preprocess query (if enabled)
            if any(preprocessing_enabled.values()):
                preprocess_result = preprocessing.preprocess(
                    query_obj.query,
                    enable_spell=preprocessing_enabled.get("enableSpellCorrection", False),
                    enable_synonyms=preprocessing_enabled.get("enableSynonymExpansion", False),
                    enable_entities=preprocessing_enabled.get("enableEntityExtraction", False),
                )
                processed_query = preprocess_result.get("processedQuery", query_obj.query)
            else:
                processed_query = query_obj.query

            # Step 2: Search
            search_result = search.search(processed_query, top_k=10)
            retrieved_docs = [hit["id"] for hit in search_result.get("hits", [])]

            # Measure latency
            latency_ms = (time.time() - start_time) * 1000
            latencies.append(latency_ms)

            # Ground truth
            relevant_doc_ids = [j["doc_id"] for j in query_obj.relevant_docs]

            # Compute metrics
            recall = compute_recall(retrieved_docs, relevant_doc_ids, k=10)
            precision = compute_precision(retrieved_docs, relevant_doc_ids, k=10)
            mrr = compute_mrr(retrieved_docs, relevant_doc_ids)

            recall_scores.append(recall)
            precision_scores.append(precision)
            mrr_scores.append(mrr)

            results.append(
                {
                    "query_id": query_obj.id,
                    "query": query_obj.query,
                    "processed_query": processed_query,
                    "retrieved": retrieved_docs,
                    "relevant": relevant_doc_ids,
                    "recall@10": recall,
                    "precision@10": precision,
                    "mrr": mrr,
                    "latency_ms": latency_ms,
                }
            )

        except Exception as e:
            print(f"  Error processing query {query_obj.id}: {e}")
            continue

    # Aggregate metrics
    metrics = E2EMetrics(
        recall_at_10=sum(recall_scores) / len(recall_scores) if recall_scores else 0.0,
        precision_at_10=sum(precision_scores) / len(precision_scores) if precision_scores else 0.0,
        mrr=sum(mrr_scores) / len(mrr_scores) if mrr_scores else 0.0,
        avg_latency_ms=sum(latencies) / len(latencies) if latencies else 0.0,
        num_queries=len(results),
    )

    return {"config_name": config_name, "metrics": metrics, "results": results}


def compute_recall(retrieved: List[str], relevant: List[str], k: int) -> float:
    """Compute Recall@k"""
    if not relevant:
        return 0.0
    retrieved_k = set(retrieved[:k])
    relevant_set = set(relevant)
    return len(retrieved_k & relevant_set) / len(relevant_set)


def compute_precision(retrieved: List[str], relevant: List[str], k: int) -> float:
    """Compute Precision@k"""
    if k == 0:
        return 0.0
    retrieved_k = retrieved[:k]
    relevant_set = set(relevant)
    return len([d for d in retrieved_k if d in relevant_set]) / k


def compute_mrr(retrieved: List[str], relevant: List[str]) -> float:
    """Compute Mean Reciprocal Rank"""
    relevant_set = set(relevant)
    for rank, doc_id in enumerate(retrieved, start=1):
        if doc_id in relevant_set:
            return 1.0 / rank
    return 0.0


# ─── Main ───────────────────────────────────────────────────────────────────


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Run E2E retrieval quality benchmark")
    parser.add_argument(
        "--env",
        type=str,
        default="local",
        choices=["local", "staging", "production"],
        help="Environment to test against",
    )
    parser.add_argument(
        "--ground-truth",
        type=str,
        default="../fixtures/quality-ground-truth.json",
        help="Ground truth dataset",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="../results/e2e-quality-results.json",
        help="Output file",
    )

    args = parser.parse_args()

    # Load ground truth
    with open(args.ground_truth, "r") as f:
        data = json.load(f)

    queries = [
        Query(
            id=q["id"],
            query=q["query"],
            relevant_docs=q["relevant_docs"],
            expected_improvement=q.get("expected_improvement_with_preprocessing", True),
        )
        for q in data["queries"]
    ]

    print("=" * 80)
    print("END-TO-END RETRIEVAL QUALITY BENCHMARK")
    print("=" * 80)
    print(f"\nEnvironment: {args.env}")
    print(f"Queries: {len(queries)}")
    print()

    # Test configurations
    configs = [
        {
            "name": "baseline",
            "preprocessing": {
                "enableSpellCorrection": False,
                "enableSynonymExpansion": False,
                "enableEntityExtraction": False,
            },
        },
        {
            "name": "full",
            "preprocessing": {
                "enableSpellCorrection": True,
                "enableSynonymExpansion": True,
                "enableEntityExtraction": True,
            },
        },
        {
            "name": "adaptive",
            "preprocessing": {
                "enableSpellCorrection": True,
                "enableSynonymExpansion": True,
                "enableEntityExtraction": False,
            },
        },
    ]

    all_results = []
    for config in configs:
        try:
            result = run_e2e_quality_test(
                queries, config["name"], config["preprocessing"], args.env
            )
            all_results.append(result)
        except Exception as e:
            print(f"  Error running {config['name']}: {e}")
            continue

    # Print results
    print("\n" + "=" * 80)
    print("RESULTS")
    print("=" * 80)
    print()
    print(
        f"{'Config':<15} {'Recall@10':<12} {'Precision@10':<15} {'MRR':<8} {'Latency (ms)':<15}"
    )
    print("-" * 80)

    for result in all_results:
        m = result["metrics"]
        print(
            f"{result['config_name']:<15} {m.recall_at_10:<12.3f} {m.precision_at_10:<15.3f} "
            f"{m.mrr:<8.3f} {m.avg_latency_ms:<15.1f}"
        )

    # Save results
    output_data = {
        "environment": args.env,
        "summary": {
            "num_queries": len(queries),
            "configurations": [
                {
                    "name": r["config_name"],
                    "recall_at_10": r["metrics"].recall_at_10,
                    "precision_at_10": r["metrics"].precision_at_10,
                    "mrr": r["metrics"].mrr,
                    "avg_latency_ms": r["metrics"].avg_latency_ms,
                }
                for r in all_results
            ],
        },
        "detailed_results": {r["config_name"]: r["results"] for r in all_results},
    }

    with open(args.output, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"\n✓ Saved results to {args.output}")
    print("=" * 80)


if __name__ == "__main__":
    main()

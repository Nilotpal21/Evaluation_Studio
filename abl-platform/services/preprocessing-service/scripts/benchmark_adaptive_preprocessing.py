#!/usr/bin/env python3
"""
Benchmark Adaptive Preprocessing (Phase 3.5-3.7)

Tests 2000 queries across 4 configurations:
1. Baseline (no preprocessing)
2. Full preprocessing (current default)
3. Adaptive preprocessing (new features)
4. Manual optimal (ground truth)

Generates detailed metrics and comparison report.
"""

import json
import time
import sys
from pathlib import Path
from typing import Dict, List, Any
from dataclasses import dataclass, asdict
import statistics

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from preprocessing.query_complexity import analyze_query_complexity
from preprocessing.adaptive_stages import select_stages
from preprocessing.adaptive_pipeline import AdaptivePipelineSelector
from preprocessing.models import PreprocessingConfig
# from preprocessing.pipeline import PreprocessingPipeline  # Not needed for benchmark simulation


@dataclass
class QueryBenchmarkResult:
    """Result for a single query benchmark"""

    query_id: str
    query: str
    category: str

    # Complexity analysis
    complexity_score: float
    complexity_recommendation: str

    # Strategy timings (ms)
    baseline_latency_ms: float
    full_latency_ms: float
    adaptive_latency_ms: float
    optimal_latency_ms: float

    # Strategy decisions
    adaptive_strategy: str
    optimal_strategy: str

    # Changes made
    baseline_changes: int
    full_changes: int
    adaptive_changes: int
    optimal_changes: int

    # Quality assessment (did preprocessing help?)
    baseline_quality: str  # "unchanged"
    full_quality: str  # "improved", "degraded", "unchanged"
    adaptive_quality: str
    optimal_quality: str

    # Ground truth comparison
    adaptive_matches_optimal: bool
    adaptive_vs_optimal_latency_diff_ms: float


@dataclass
class CategoryStats:
    """Statistics for a query category"""

    category: str
    query_count: int

    # Latency statistics
    avg_baseline_latency_ms: float
    avg_full_latency_ms: float
    avg_adaptive_latency_ms: float
    avg_optimal_latency_ms: float

    # Latency improvement vs baseline
    full_latency_overhead_pct: float
    adaptive_latency_overhead_pct: float
    optimal_latency_overhead_pct: float

    # Strategy distribution
    adaptive_strategy_dist: Dict[str, int]
    optimal_strategy_dist: Dict[str, int]

    # Match rate
    adaptive_matches_optimal_pct: float

    # Quality distribution
    full_quality_dist: Dict[str, int]
    adaptive_quality_dist: Dict[str, int]


class AdaptivePreprocessingBenchmark:
    """
    Benchmark framework for adaptive preprocessing

    Runs 2000 queries through 4 configurations and collects metrics
    """

    def __init__(self, queries_file: str):
        """
        Initialize benchmark

        Args:
            queries_file: Path to test-queries-full.json
        """
        with open(queries_file, "r") as f:
            self.dataset = json.load(f)

        self.queries = self.dataset["queries"]
        self.results: List[QueryBenchmarkResult] = []

        # Initialize adaptive selector
        self.adaptive_selector = AdaptivePipelineSelector()

    # ─── Run Benchmark ──────────────────────────────────────────────────────

    def run_benchmark(self, max_queries: int = None) -> List[QueryBenchmarkResult]:
        """
        Run benchmark on all queries

        Args:
            max_queries: Limit number of queries (for testing)

        Returns:
            List of QueryBenchmarkResult
        """

        queries_to_test = self.queries[:max_queries] if max_queries else self.queries

        print(f"Running benchmark on {len(queries_to_test)} queries...")
        print(f"Configurations: Baseline, Full, Adaptive, Optimal")
        print()

        for i, query_data in enumerate(queries_to_test, 1):
            if i % 100 == 0:
                print(f"  Progress: {i}/{len(queries_to_test)} ({i*100//len(queries_to_test)}%)")

            result = self._benchmark_query(query_data)
            self.results.append(result)

        print(f"\n✓ Completed {len(self.results)} query benchmarks\n")
        return self.results

    def _benchmark_query(self, query_data: Dict[str, Any]) -> QueryBenchmarkResult:
        """Benchmark a single query across all configurations"""

        query = query_data["query"]
        query_id = query_data["id"]
        category = query_data["category"]
        ground_truth = query_data["ground_truth"]

        # Analyze complexity
        complexity = analyze_query_complexity(query)

        # ─── Configuration 1: Baseline (no preprocessing) ───────────────────

        start = time.perf_counter()
        baseline_result = self._run_baseline(query)
        baseline_latency_ms = (time.perf_counter() - start) * 1000

        # ─── Configuration 2: Full preprocessing ────────────────────────────

        start = time.perf_counter()
        full_result = self._run_full_preprocessing(query)
        full_latency_ms = (time.perf_counter() - start) * 1000

        # ─── Configuration 3: Adaptive preprocessing ────────────────────────

        start = time.perf_counter()
        adaptive_result = self._run_adaptive_preprocessing(query, complexity)
        adaptive_latency_ms = (time.perf_counter() - start) * 1000

        # ─── Configuration 4: Optimal (ground truth) ────────────────────────

        start = time.perf_counter()
        optimal_result = self._run_optimal_preprocessing(query, ground_truth)
        optimal_latency_ms = (time.perf_counter() - start) * 1000

        # ─── Analyze Results ────────────────────────────────────────────────

        # Count changes made
        baseline_changes = self._count_changes(baseline_result)
        full_changes = self._count_changes(full_result)
        adaptive_changes = self._count_changes(adaptive_result)
        optimal_changes = self._count_changes(optimal_result)

        # Assess quality (simplified heuristic)
        baseline_quality = "unchanged"
        full_quality = self._assess_quality(query, full_result, ground_truth)
        adaptive_quality = self._assess_quality(query, adaptive_result, ground_truth)
        optimal_quality = self._assess_quality(query, optimal_result, ground_truth)

        # Compare adaptive vs optimal
        adaptive_matches_optimal = (
            adaptive_result["config"]["enableSpellCorrection"]
            == optimal_result["config"]["enableSpellCorrection"]
            and adaptive_result["config"]["enableSynonymExpansion"]
            == optimal_result["config"]["enableSynonymExpansion"]
            and adaptive_result["config"]["enableEntityExtraction"]
            == optimal_result["config"]["enableEntityExtraction"]
        )

        return QueryBenchmarkResult(
            query_id=query_id,
            query=query,
            category=category,
            complexity_score=complexity.overall,
            complexity_recommendation=complexity.recommendation,
            baseline_latency_ms=baseline_latency_ms,
            full_latency_ms=full_latency_ms,
            adaptive_latency_ms=adaptive_latency_ms,
            optimal_latency_ms=optimal_latency_ms,
            adaptive_strategy=adaptive_result["strategy"],
            optimal_strategy=optimal_result["strategy"],
            baseline_changes=baseline_changes,
            full_changes=full_changes,
            adaptive_changes=adaptive_changes,
            optimal_changes=optimal_changes,
            baseline_quality=baseline_quality,
            full_quality=full_quality,
            adaptive_quality=adaptive_quality,
            optimal_quality=optimal_quality,
            adaptive_matches_optimal=adaptive_matches_optimal,
            adaptive_vs_optimal_latency_diff_ms=adaptive_latency_ms - optimal_latency_ms,
        )

    # ─── Configuration Runners ──────────────────────────────────────────────

    def _run_baseline(self, query: str) -> Dict[str, Any]:
        """Baseline: no preprocessing"""
        return {
            "processed_query": query,
            "strategy": "baseline",
            "config": {
                "enableSpellCorrection": False,
                "enableSynonymExpansion": False,
                "enableEntityExtraction": False,
            },
            "changes": [],
        }

    def _run_full_preprocessing(self, query: str) -> Dict[str, Any]:
        """Full: all stages enabled (current default)"""
        config = PreprocessingConfig(
            enableSpellCorrection=True,
            enableSynonymExpansion=True,
            enableEntityExtraction=True,
            maxSynonyms=3,
        )

        # Simulate preprocessing (we're not actually running the service here)
        # In production, would call self.pipeline.preprocess(query, "test-tenant", config)

        return {
            "processed_query": query,  # Would be modified by actual preprocessing
            "strategy": "full",
            "config": {
                "enableSpellCorrection": True,
                "enableSynonymExpansion": True,
                "enableEntityExtraction": True,
            },
            "changes": [],  # Would contain actual corrections
        }

    def _run_adaptive_preprocessing(
        self, query: str, complexity
    ) -> Dict[str, Any]:
        """Adaptive: use new complexity analysis + stage selection"""

        # Select strategy based on complexity
        strategy = self.adaptive_selector.select_strategy(
            query, latency_budget_ms=100, complexity=complexity
        )

        return {
            "processed_query": query,
            "strategy": strategy.name,
            "config": {
                "enableSpellCorrection": strategy.config.enable_spell_correction,
                "enableSynonymExpansion": strategy.config.enable_synonym_expansion,
                "enableEntityExtraction": strategy.config.enable_entity_extraction,
            },
            "changes": [],
        }

    def _run_optimal_preprocessing(self, query: str, ground_truth: Dict) -> Dict[str, Any]:
        """Optimal: use ground truth configuration"""

        optimal_config = ground_truth.get("optimal_config", "balanced")

        # Map optimal config to actual config
        config_map = {
            "skip": (False, False, False),
            "minimal": (True, False, False),
            "balanced": (True, True, False),
            "thorough": (True, True, True),
        }

        spell, synonym, entity = config_map.get(optimal_config, (True, True, False))

        return {
            "processed_query": query,
            "strategy": optimal_config,
            "config": {
                "enableSpellCorrection": spell,
                "enableSynonymExpansion": synonym,
                "enableEntityExtraction": entity,
            },
            "changes": [],
        }

    # ─── Quality Assessment ─────────────────────────────────────────────────

    def _count_changes(self, result: Dict[str, Any]) -> int:
        """Count preprocessing changes made"""
        return len(result.get("changes", []))

    def _assess_quality(
        self, original_query: str, result: Dict[str, Any], ground_truth: Dict
    ) -> str:
        """
        Assess if preprocessing improved/degraded/unchanged quality

        Simplified heuristic (in production, use user feedback/CTR)
        """

        processed_query = result["processed_query"]
        config = result["config"]

        # If query unchanged, quality unchanged
        if processed_query == original_query:
            return "unchanged"

        # Check against ground truth expectations
        needs_spell = ground_truth.get("needs_spell_correction", False)
        needs_synonyms = ground_truth.get("needs_synonyms", False)
        needs_entities = ground_truth.get("needs_entities", False)

        enabled_spell = config["enableSpellCorrection"]
        enabled_synonyms = config["enableSynonymExpansion"]
        enabled_entities = config["enableEntityExtraction"]

        # Improved if enabled what was needed
        if (needs_spell and enabled_spell) or (needs_synonyms and enabled_synonyms) or (needs_entities and enabled_entities):
            return "improved"

        # Degraded if enabled what wasn't needed (over-processing)
        if (not needs_spell and enabled_spell) or (not needs_synonyms and enabled_synonyms):
            return "degraded"

        return "unchanged"

    # ─── Analysis & Reporting ───────────────────────────────────────────────

    def analyze_by_category(self) -> List[CategoryStats]:
        """Aggregate results by query category"""

        categories = {}

        for result in self.results:
            cat = result.category

            if cat not in categories:
                categories[cat] = []

            categories[cat].append(result)

        # Compute statistics per category
        category_stats = []

        for cat, results in sorted(categories.items()):
            stats = self._compute_category_stats(cat, results)
            category_stats.append(stats)

        return category_stats

    def _compute_category_stats(self, category: str, results: List[QueryBenchmarkResult]) -> CategoryStats:
        """Compute statistics for a category"""

        if not results:
            return None

        # Latency averages
        avg_baseline = statistics.mean(r.baseline_latency_ms for r in results)
        avg_full = statistics.mean(r.full_latency_ms for r in results)
        avg_adaptive = statistics.mean(r.adaptive_latency_ms for r in results)
        avg_optimal = statistics.mean(r.optimal_latency_ms for r in results)

        # Latency overhead vs baseline
        full_overhead = ((avg_full - avg_baseline) / max(0.001, avg_baseline)) * 100
        adaptive_overhead = ((avg_adaptive - avg_baseline) / max(0.001, avg_baseline)) * 100
        optimal_overhead = ((avg_optimal - avg_baseline) / max(0.001, avg_baseline)) * 100

        # Strategy distribution
        adaptive_strategies = {}
        optimal_strategies = {}
        for r in results:
            adaptive_strategies[r.adaptive_strategy] = adaptive_strategies.get(r.adaptive_strategy, 0) + 1
            optimal_strategies[r.optimal_strategy] = optimal_strategies.get(r.optimal_strategy, 0) + 1

        # Match rate
        matches = sum(1 for r in results if r.adaptive_matches_optimal)
        match_pct = (matches / len(results)) * 100

        # Quality distribution
        full_quality = {}
        adaptive_quality = {}
        for r in results:
            full_quality[r.full_quality] = full_quality.get(r.full_quality, 0) + 1
            adaptive_quality[r.adaptive_quality] = adaptive_quality.get(r.adaptive_quality, 0) + 1

        return CategoryStats(
            category=category,
            query_count=len(results),
            avg_baseline_latency_ms=avg_baseline,
            avg_full_latency_ms=avg_full,
            avg_adaptive_latency_ms=avg_adaptive,
            avg_optimal_latency_ms=avg_optimal,
            full_latency_overhead_pct=full_overhead,
            adaptive_latency_overhead_pct=adaptive_overhead,
            optimal_latency_overhead_pct=optimal_overhead,
            adaptive_strategy_dist=adaptive_strategies,
            optimal_strategy_dist=optimal_strategies,
            adaptive_matches_optimal_pct=match_pct,
            full_quality_dist=full_quality,
            adaptive_quality_dist=adaptive_quality,
        )

    def generate_report(self) -> Dict[str, Any]:
        """Generate comprehensive benchmark report"""

        if not self.results:
            return {"error": "No results to report"}

        category_stats = self.analyze_by_category()

        # Overall statistics
        total_queries = len(self.results)
        avg_baseline = statistics.mean(r.baseline_latency_ms for r in self.results)
        avg_full = statistics.mean(r.full_latency_ms for r in self.results)
        avg_adaptive = statistics.mean(r.adaptive_latency_ms for r in self.results)
        avg_optimal = statistics.mean(r.optimal_latency_ms for r in self.results)

        # Latency percentiles
        baseline_latencies = sorted(r.baseline_latency_ms for r in self.results)
        full_latencies = sorted(r.full_latency_ms for r in self.results)
        adaptive_latencies = sorted(r.adaptive_latency_ms for r in self.results)
        optimal_latencies = sorted(r.optimal_latency_ms for r in self.results)

        def percentile(data, p):
            idx = int(len(data) * p / 100)
            return data[min(idx, len(data) - 1)]

        # Overall match rate
        total_matches = sum(1 for r in self.results if r.adaptive_matches_optimal)
        overall_match_pct = (total_matches / total_queries) * 100

        # Quality distribution
        quality_counts = {"improved": 0, "degraded": 0, "unchanged": 0}
        for r in self.results:
            quality_counts[r.adaptive_quality] = quality_counts.get(r.adaptive_quality, 0) + 1

        return {
            "summary": {
                "total_queries": total_queries,
                "categories": len(category_stats),
                "adaptive_match_rate_pct": round(overall_match_pct, 2),
            },
            "latency": {
                "baseline": {
                    "mean": round(avg_baseline, 3),
                    "p50": round(percentile(baseline_latencies, 50), 3),
                    "p95": round(percentile(baseline_latencies, 95), 3),
                    "p99": round(percentile(baseline_latencies, 99), 3),
                },
                "full": {
                    "mean": round(avg_full, 3),
                    "p50": round(percentile(full_latencies, 50), 3),
                    "p95": round(percentile(full_latencies, 95), 3),
                    "p99": round(percentile(full_latencies, 99), 3),
                    "overhead_vs_baseline_pct": round(((avg_full - avg_baseline) / avg_baseline) * 100, 2),
                },
                "adaptive": {
                    "mean": round(avg_adaptive, 3),
                    "p50": round(percentile(adaptive_latencies, 50), 3),
                    "p95": round(percentile(adaptive_latencies, 95), 3),
                    "p99": round(percentile(adaptive_latencies, 99), 3),
                    "overhead_vs_baseline_pct": round(((avg_adaptive - avg_baseline) / avg_baseline) * 100, 2),
                    "savings_vs_full_pct": round(((avg_full - avg_adaptive) / avg_full) * 100, 2),
                },
                "optimal": {
                    "mean": round(avg_optimal, 3),
                    "p50": round(percentile(optimal_latencies, 50), 3),
                    "p95": round(percentile(optimal_latencies, 95), 3),
                    "p99": round(percentile(optimal_latencies, 99), 3),
                    "overhead_vs_baseline_pct": round(((avg_optimal - avg_baseline) / avg_baseline) * 100, 2),
                },
            },
            "quality": {
                "adaptive": {
                    "improved": quality_counts["improved"],
                    "degraded": quality_counts["degraded"],
                    "unchanged": quality_counts["unchanged"],
                    "improved_pct": round((quality_counts["improved"] / total_queries) * 100, 2),
                }
            },
            "categories": [asdict(stat) for stat in category_stats],
        }

    def save_results(self, output_file: str):
        """Save detailed results to JSON"""
        report = self.generate_report()
        report["detailed_results"] = [asdict(r) for r in self.results]

        with open(output_file, "w") as f:
            json.dump(report, f, indent=2)

        print(f"✓ Saved detailed results to {output_file}")

    def print_summary(self):
        """Print human-readable summary"""
        report = self.generate_report()

        print("=" * 80)
        print("ADAPTIVE PREPROCESSING BENCHMARK REPORT")
        print("=" * 80)
        print()
        print(f"Total Queries: {report['summary']['total_queries']}")
        print(f"Categories: {report['summary']['categories']}")
        print(f"Adaptive Match Rate: {report['summary']['adaptive_match_rate_pct']}%")
        print()
        print("─── Latency Comparison (ms) ───")
        print()
        print(f"                  Mean    P50     P95     P99     Overhead")
        print(f"Baseline:        {report['latency']['baseline']['mean']:6.2f}  {report['latency']['baseline']['p50']:6.2f}  {report['latency']['baseline']['p95']:6.2f}  {report['latency']['baseline']['p99']:6.2f}  -")
        print(f"Full:            {report['latency']['full']['mean']:6.2f}  {report['latency']['full']['p50']:6.2f}  {report['latency']['full']['p95']:6.2f}  {report['latency']['full']['p99']:6.2f}  +{report['latency']['full']['overhead_vs_baseline_pct']:5.1f}%")
        print(f"Adaptive:        {report['latency']['adaptive']['mean']:6.2f}  {report['latency']['adaptive']['p50']:6.2f}  {report['latency']['adaptive']['p95']:6.2f}  {report['latency']['adaptive']['p99']:6.2f}  +{report['latency']['adaptive']['overhead_vs_baseline_pct']:5.1f}%")
        print(f"Optimal:         {report['latency']['optimal']['mean']:6.2f}  {report['latency']['optimal']['p50']:6.2f}  {report['latency']['optimal']['p95']:6.2f}  {report['latency']['optimal']['p99']:6.2f}  +{report['latency']['optimal']['overhead_vs_baseline_pct']:5.1f}%")
        print()
        print(f"Adaptive Savings vs Full: {report['latency']['adaptive']['savings_vs_full_pct']}%")
        print()
        print("─── Quality Assessment ───")
        print()
        print(f"Improved:   {report['quality']['adaptive']['improved']} ({report['quality']['adaptive']['improved_pct']}%)")
        print(f"Degraded:   {report['quality']['adaptive']['degraded']}")
        print(f"Unchanged:  {report['quality']['adaptive']['unchanged']}")
        print()
        print("=" * 80)


# ─── Main ───────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    queries_file = "../tests/fixtures/test-queries-full.json"
    output_file = "../tests/results/benchmark-results.json"

    benchmark = AdaptivePreprocessingBenchmark(queries_file)

    # Run benchmark (test with 100 queries first, then run full 2000)
    max_queries = int(sys.argv[1]) if len(sys.argv) > 1 else None
    benchmark.run_benchmark(max_queries=max_queries)

    # Print summary
    benchmark.print_summary()

    # Save detailed results
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    benchmark.save_results(output_file)

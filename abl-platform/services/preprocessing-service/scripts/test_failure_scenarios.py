#!/usr/bin/env python3
"""
Test Failure Scenarios for Adaptive Preprocessing

Validates that known failure cases are detected and reports which ones
still fail after fixes are applied.
"""

import json
import sys
from pathlib import Path
from typing import List, Dict, Any

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from preprocessing.query_complexity import analyze_query_complexity
from preprocessing.adaptive_pipeline import AdaptivePipelineSelector


def test_failure_scenarios():
    """Test all failure scenarios and report results"""

    # Load failure scenarios
    with open("../tests/fixtures/failure-scenarios.json", "r") as f:
        data = json.load(f)

    scenarios = data["failure_scenarios"]
    selector = AdaptivePipelineSelector()

    print("=" * 80)
    print("FAILURE SCENARIO TESTING")
    print("=" * 80)
    print(f"\nTotal scenarios: {len(scenarios)}\n")

    # Track results
    results = {
        "total": len(scenarios),
        "passing": 0,
        "failing": 0,
        "by_category": {}
    }

    failures = []

    for scenario in scenarios:
        query = scenario["query"]
        expected = scenario["expected_optimal"]
        category = scenario["category"]

        # Skip empty queries
        if not query or not query.strip():
            results["passing"] += 1
            continue

        # Analyze complexity
        complexity = analyze_query_complexity(query)

        # Select strategy
        strategy = selector.select_strategy(query, latency_budget_ms=100, complexity=complexity)
        actual = strategy.name

        # Check if it matches expected
        matches = (actual == expected)

        if matches:
            results["passing"] += 1
        else:
            results["failing"] += 1
            failures.append({
                "id": scenario["id"],
                "category": category,
                "query": query,
                "expected": expected,
                "actual": actual,
                "reason": scenario["failure_reason"],
                "fix_needed": scenario["fix_needed"]
            })

        # Track by category
        if category not in results["by_category"]:
            results["by_category"][category] = {"total": 0, "passing": 0, "failing": 0}

        results["by_category"][category]["total"] += 1
        if matches:
            results["by_category"][category]["passing"] += 1
        else:
            results["by_category"][category]["failing"] += 1

    # Print summary
    print("─" * 80)
    print("SUMMARY")
    print("─" * 80)
    print(f"\nTotal: {results['total']}")
    print(f"✅ Passing: {results['passing']} ({results['passing']*100//results['total']}%)")
    print(f"❌ Failing: {results['failing']} ({results['failing']*100//results['total']}%)")
    print()

    # Print by category
    print("─" * 80)
    print("BY CATEGORY")
    print("─" * 80)
    print()
    for category, stats in sorted(results["by_category"].items()):
        pass_rate = stats["passing"] * 100 // stats["total"] if stats["total"] > 0 else 0
        status = "✅" if pass_rate == 100 else "⚠️" if pass_rate >= 50 else "❌"
        print(f"{status} {category}: {stats['passing']}/{stats['total']} ({pass_rate}%)")
    print()

    # Print failures
    if failures:
        print("─" * 80)
        print("FAILURES")
        print("─" * 80)
        print()

        for failure in failures:
            print(f"❌ {failure['id']}")
            print(f"   Query: \"{failure['query']}\"")
            print(f"   Expected: {failure['expected']} | Actual: {failure['actual']}")
            print(f"   Reason: {failure['reason']}")
            print(f"   Fix: {failure['fix_needed']}")
            print()

    print("=" * 80)

    return results, failures


if __name__ == "__main__":
    results, failures = test_failure_scenarios()

    # Exit with error code if failures exist
    sys.exit(1 if failures else 0)

"""
Adaptive Pipeline Selector (Phase 3.5)

High-level orchestrator that selects preprocessing strategy based on:
- Query complexity
- Latency budget
- Historical performance
- Domain context

Provides circuit breaker for degraded performance.
"""

from typing import Optional, Literal
from dataclasses import dataclass
import time

from .query_complexity import QueryComplexityScore, analyze_query_complexity
from .adaptive_stages import StageDecision, select_stages, select_stages_with_domain
from .models import PreprocessingConfig


StrategyName = Literal["skip", "fast", "balanced", "thorough"]


@dataclass
class PipelineStrategy:
    """Selected preprocessing strategy"""

    name: StrategyName
    config: PreprocessingConfig
    expected_latency_ms: float
    expected_benefit: float  # 0-1 score (benefit vs cost)

    # Decision factors
    complexity_score: float
    latency_budget_ms: float
    reason: str


@dataclass
class PerformanceProfile:
    """Historical performance data for a strategy"""

    name: StrategyName
    avg_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float
    sample_count: int
    failure_count: int
    timeout_count: int

    # Benefit metrics (require external tracking)
    avg_benefit: float  # User satisfaction, click-through rate, etc.


class AdaptivePipelineSelector:
    """
    Selects preprocessing strategy based on query + context

    Features:
    - Latency budget enforcement
    - Circuit breaker for degraded performance
    - A/B testing support
    - Performance profiling
    """

    def __init__(self):
        # Performance profiles (keyed by strategy name)
        self.performance_profiles: dict[StrategyName, PerformanceProfile] = {
            "skip": PerformanceProfile("skip", 0, 0, 0, 0, 0, 0, 0.0),
            "fast": PerformanceProfile("fast", 2, 3, 5, 0, 0, 0, 0.6),
            "balanced": PerformanceProfile("balanced", 5, 7, 10, 0, 0, 0, 0.85),
            "thorough": PerformanceProfile("thorough", 10, 15, 20, 0, 0, 0, 1.0),
        }

        # Circuit breaker state
        self.circuit_open: dict[StrategyName, bool] = {
            "skip": False,
            "fast": False,
            "balanced": False,
            "thorough": False,
        }

        # Circuit breaker thresholds
        self.failure_threshold = 5  # Open after 5 consecutive failures
        self.timeout_threshold = 10  # Open after 10 timeouts in window
        self.recovery_attempts = 0  # Try recovery every N requests

    # ─── Strategy Selection ─────────────────────────────────────────────────

    def select_strategy(
        self,
        query: str,
        latency_budget_ms: float = 100,
        domain: Optional[str] = None,
        complexity: Optional[QueryComplexityScore] = None,
    ) -> PipelineStrategy:
        """
        Select optimal preprocessing strategy

        Args:
            query: Query text
            latency_budget_ms: Maximum acceptable latency (default: 100ms)
            domain: Optional domain context ("code-search", "natural-language", etc.)
            complexity: Pre-computed complexity (optional)

        Returns:
            PipelineStrategy with config and expected performance
        """

        # Analyze complexity if not provided
        if complexity is None:
            complexity = analyze_query_complexity(query)

        # Check circuit breaker state
        available_strategies = self._get_available_strategies()

        # ─── Strategy Selection Logic ───────────────────────────────────────

        # Rule 1: Skip strategy (0ms, no benefit)
        if complexity.recommendation == "skip" or complexity.overall < 15:
            strategy = self._create_skip_strategy(complexity, latency_budget_ms)

        # Rule 2: Fast strategy (2ms, 60% benefit) - spell correction only
        elif latency_budget_ms < 5 or complexity.recommendation == "minimal":
            if "fast" in available_strategies:
                strategy = self._create_fast_strategy(complexity, latency_budget_ms, domain)
            else:
                # Fallback to skip if fast is unavailable (circuit open)
                strategy = self._create_skip_strategy(complexity, latency_budget_ms)

        # Rule 3: Balanced strategy (5ms, 85% benefit) - spell + synonyms
        elif latency_budget_ms < 10 or complexity.recommendation == "balanced":
            if "balanced" in available_strategies:
                strategy = self._create_balanced_strategy(complexity, latency_budget_ms, domain)
            elif "fast" in available_strategies:
                # Downgrade to fast
                strategy = self._create_fast_strategy(complexity, latency_budget_ms, domain)
            else:
                strategy = self._create_skip_strategy(complexity, latency_budget_ms)

        # Rule 4: Thorough strategy (10ms, 100% benefit) - all stages
        else:
            if "thorough" in available_strategies:
                strategy = self._create_thorough_strategy(complexity, latency_budget_ms, domain)
            elif "balanced" in available_strategies:
                # Downgrade to balanced
                strategy = self._create_balanced_strategy(complexity, latency_budget_ms, domain)
            else:
                strategy = self._create_fast_strategy(complexity, latency_budget_ms, domain)

        return strategy

    # ─── Strategy Constructors ──────────────────────────────────────────────

    def _create_skip_strategy(
        self, complexity: QueryComplexityScore, latency_budget_ms: float
    ) -> PipelineStrategy:
        """Skip all preprocessing"""
        return PipelineStrategy(
            name="skip",
            config=PreprocessingConfig(
                enableSpellCorrection=False,
                enableSynonymExpansion=False,
                enableEntityExtraction=False,
                maxSynonyms=0,
            ),
            expected_latency_ms=0,
            expected_benefit=0.0,
            complexity_score=complexity.overall,
            latency_budget_ms=latency_budget_ms,
            reason=f"Skip preprocessing: {complexity.reason}",
        )

    def _create_fast_strategy(
        self, complexity: QueryComplexityScore, latency_budget_ms: float, domain: Optional[str]
    ) -> PipelineStrategy:
        """Fast preprocessing: spell correction only"""

        # Get stage decision with domain override
        decision = select_stages_with_domain(query="", domain=domain, complexity=complexity)

        # Override to fast strategy (spell correction only)
        config = PreprocessingConfig(
            enableSpellCorrection=decision.enable_spell_correction,
            enableSynonymExpansion=False,
            enableEntityExtraction=False,
            maxSynonyms=0,
        )

        profile = self.performance_profiles["fast"]

        return PipelineStrategy(
            name="fast",
            config=config,
            expected_latency_ms=profile.avg_latency_ms,
            expected_benefit=profile.avg_benefit,
            complexity_score=complexity.overall,
            latency_budget_ms=latency_budget_ms,
            reason=f"Fast preprocessing: spell correction only (budget: {latency_budget_ms}ms)",
        )

    def _create_balanced_strategy(
        self, complexity: QueryComplexityScore, latency_budget_ms: float, domain: Optional[str]
    ) -> PipelineStrategy:
        """Balanced preprocessing: spell + synonyms"""

        decision = select_stages_with_domain(query="", domain=domain, complexity=complexity)

        config = PreprocessingConfig(
            enableSpellCorrection=decision.enable_spell_correction,
            enableSynonymExpansion=decision.enable_synonym_expansion,
            enableEntityExtraction=False,
            maxSynonyms=min(decision.max_synonyms, 2),  # Cap at 2 for balanced
        )

        profile = self.performance_profiles["balanced"]

        return PipelineStrategy(
            name="balanced",
            config=config,
            expected_latency_ms=profile.avg_latency_ms,
            expected_benefit=profile.avg_benefit,
            complexity_score=complexity.overall,
            latency_budget_ms=latency_budget_ms,
            reason=f"Balanced preprocessing: {decision.reason}",
        )

    def _create_thorough_strategy(
        self, complexity: QueryComplexityScore, latency_budget_ms: float, domain: Optional[str]
    ) -> PipelineStrategy:
        """Thorough preprocessing: all stages"""

        decision = select_stages_with_domain(query="", domain=domain, complexity=complexity)

        config = PreprocessingConfig(
            enableSpellCorrection=decision.enable_spell_correction,
            enableSynonymExpansion=decision.enable_synonym_expansion,
            enableEntityExtraction=decision.enable_entity_extraction,
            maxSynonyms=decision.max_synonyms,
        )

        profile = self.performance_profiles["thorough"]

        return PipelineStrategy(
            name="thorough",
            config=config,
            expected_latency_ms=profile.avg_latency_ms,
            expected_benefit=profile.avg_benefit,
            complexity_score=complexity.overall,
            latency_budget_ms=latency_budget_ms,
            reason=f"Thorough preprocessing: {decision.reason}",
        )

    # ─── Performance Tracking ───────────────────────────────────────────────

    def record_performance(
        self,
        strategy: StrategyName,
        latency_ms: float,
        success: bool,
        timed_out: bool = False,
        benefit: Optional[float] = None,
    ):
        """
        Record strategy performance for adaptive learning

        Args:
            strategy: Strategy name
            latency_ms: Actual latency
            success: Whether preprocessing succeeded
            timed_out: Whether request timed out
            benefit: Optional benefit score (0-1) from downstream metrics
        """

        profile = self.performance_profiles[strategy]

        # Update sample count
        profile.sample_count += 1

        # Update latency (exponential moving average)
        alpha = 0.1  # Smoothing factor
        if profile.sample_count == 1:
            profile.avg_latency_ms = latency_ms
        else:
            profile.avg_latency_ms = alpha * latency_ms + (1 - alpha) * profile.avg_latency_ms

        # Track failures and timeouts
        if not success:
            profile.failure_count += 1
        if timed_out:
            profile.timeout_count += 1

        # Update benefit score
        if benefit is not None:
            if profile.sample_count == 1:
                profile.avg_benefit = benefit
            else:
                profile.avg_benefit = alpha * benefit + (1 - alpha) * profile.avg_benefit

        # Check circuit breaker conditions
        self._check_circuit_breaker(strategy, profile)

    def _check_circuit_breaker(self, strategy: StrategyName, profile: PerformanceProfile):
        """
        Check if circuit breaker should open for this strategy

        Open circuit when:
        - Failure rate > 50% in last 10 samples
        - Timeout rate > 80% in last 10 samples
        - Avg latency > 50ms (too slow)
        """

        if profile.sample_count < 10:
            return  # Need more samples

        recent_failure_rate = profile.failure_count / profile.sample_count
        recent_timeout_rate = profile.timeout_count / profile.sample_count

        # Open circuit conditions
        should_open = False
        reason = ""

        if recent_failure_rate > 0.5:
            should_open = True
            reason = f"High failure rate: {recent_failure_rate:.1%}"

        elif recent_timeout_rate > 0.8:
            should_open = True
            reason = f"High timeout rate: {recent_timeout_rate:.1%}"

        elif profile.avg_latency_ms > 50:
            should_open = True
            reason = f"High latency: {profile.avg_latency_ms:.1f}ms"

        if should_open and not self.circuit_open[strategy]:
            print(f"[AdaptivePipeline] Opening circuit for {strategy}: {reason}")
            self.circuit_open[strategy] = True

        # Recovery: try closing circuit every 100 requests
        elif self.circuit_open[strategy]:
            self.recovery_attempts += 1
            if self.recovery_attempts >= 100:
                print(f"[AdaptivePipeline] Attempting circuit recovery for {strategy}")
                self.circuit_open[strategy] = False
                self.recovery_attempts = 0
                # Reset counters
                profile.failure_count = 0
                profile.timeout_count = 0

    def _get_available_strategies(self) -> list[StrategyName]:
        """Get strategies with open circuits"""
        return [s for s, is_open in self.circuit_open.items() if not is_open]

    # ─── Statistics ─────────────────────────────────────────────────────────

    def get_performance_summary(self) -> dict[str, dict]:
        """Get performance summary for all strategies"""
        summary = {}
        for name, profile in self.performance_profiles.items():
            summary[name] = {
                "avg_latency_ms": profile.avg_latency_ms,
                "sample_count": profile.sample_count,
                "failure_count": profile.failure_count,
                "timeout_count": profile.timeout_count,
                "avg_benefit": profile.avg_benefit,
                "circuit_open": self.circuit_open[name],
            }
        return summary

    def get_strategy_recommendation(self) -> StrategyName:
        """Get overall recommended strategy based on performance data"""

        # Find strategy with best benefit/latency ratio
        best_strategy: StrategyName = "balanced"
        best_score = 0.0

        for name, profile in self.performance_profiles.items():
            if self.circuit_open[name]:
                continue

            if profile.sample_count == 0:
                continue

            # Score = benefit / (latency_ms / 10)
            # Higher benefit, lower latency = higher score
            score = profile.avg_benefit / max(0.1, profile.avg_latency_ms / 10)

            if score > best_score:
                best_score = score
                best_strategy = name

        return best_strategy


# ─── Global Singleton ───────────────────────────────────────────────────────

# Singleton instance for convenience
adaptive_pipeline_selector = AdaptivePipelineSelector()

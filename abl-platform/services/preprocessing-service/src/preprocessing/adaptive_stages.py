"""
Adaptive Stage Selector (Phase 3.7)

Dynamically enables/disables preprocessing stages based on query characteristics:
- Spell correction: Skip for technical terms and proper nouns
- Synonym expansion: Skip for structured queries and proper nouns
- Entity extraction: Skip for low entity density queries
"""

from typing import Optional
from dataclasses import dataclass

from .query_complexity import QueryComplexityScore, analyze_query_complexity
from .models import PreprocessingConfig


@dataclass
class StageDecision:
    """Decision about which preprocessing stages to enable"""

    enable_spell_correction: bool
    enable_synonym_expansion: bool
    enable_entity_extraction: bool
    max_synonyms: int

    # Reasoning
    reason: str
    rules_applied: list[str]


# ─── Stage Selection Rules ──────────────────────────────────────────────────


def select_stages(
    query: str,
    complexity: Optional[QueryComplexityScore] = None,
    strategy: Optional[str] = None,
) -> StageDecision:
    """
    Select which preprocessing stages to enable based on query complexity

    Args:
        query: Query text
        complexity: Pre-computed complexity score (optional, will compute if None)
        strategy: Override strategy ("skip", "minimal", "balanced", "thorough")

    Returns:
        StageDecision with enabled stages and reasoning
    """

    # Analyze complexity if not provided
    if complexity is None:
        complexity = analyze_query_complexity(query)

    # Use provided strategy or recommendation from complexity analysis
    effective_strategy = strategy or complexity.recommendation

    # Track applied rules
    rules_applied = []

    # ─── Strategy-Based Defaults ────────────────────────────────────────────

    if effective_strategy == "skip":
        # No preprocessing
        return StageDecision(
            enable_spell_correction=False,
            enable_synonym_expansion=False,
            enable_entity_extraction=False,
            max_synonyms=0,
            reason="Skipping preprocessing (structured query or very simple)",
            rules_applied=["skip_all"],
        )

    elif effective_strategy == "minimal":
        # Only spell correction
        decision = StageDecision(
            enable_spell_correction=True,
            enable_synonym_expansion=False,
            enable_entity_extraction=False,
            max_synonyms=0,
            reason="Minimal preprocessing (spell correction only)",
            rules_applied=["minimal_strategy"],
        )

    elif effective_strategy == "balanced":
        # Spell correction + limited synonyms
        decision = StageDecision(
            enable_spell_correction=True,
            enable_synonym_expansion=True,
            enable_entity_extraction=False,
            max_synonyms=2,
            reason="Balanced preprocessing (spell + synonyms)",
            rules_applied=["balanced_strategy"],
        )

    elif effective_strategy == "thorough":
        # All stages enabled
        decision = StageDecision(
            enable_spell_correction=True,
            enable_synonym_expansion=True,
            enable_entity_extraction=True,
            max_synonyms=3,
            reason="Thorough preprocessing (all stages)",
            rules_applied=["thorough_strategy"],
        )

    else:
        # Fallback to balanced
        decision = StageDecision(
            enable_spell_correction=True,
            enable_synonym_expansion=True,
            enable_entity_extraction=False,
            max_synonyms=2,
            reason="Default balanced preprocessing",
            rules_applied=["default_balanced"],
        )

    # ─── Apply Fine-Tuning Rules ───────────────────────────────────────────

    # Rule 1: Disable spell correction for high technical term density
    if complexity.technical_term_count >= 2:
        if decision.enable_spell_correction:
            decision.enable_spell_correction = False
            rules_applied.append(f"disable_spell_correction_technical_terms_{complexity.technical_term_count}")
            decision.reason += f" (disabled spell correction: {complexity.technical_term_count} technical terms)"

    # Rule 2: Disable synonym expansion for high proper noun ratio
    if complexity.proper_noun_ratio > 0.4:
        if decision.enable_synonym_expansion:
            decision.enable_synonym_expansion = False
            rules_applied.append(f"disable_synonyms_proper_nouns_{complexity.proper_noun_ratio:.0%}")
            decision.reason += f" (disabled synonyms: {complexity.proper_noun_ratio:.0%} proper nouns)"

    # Rule 3: Disable entity extraction for low entity density
    if complexity.entity_density < 0.1:
        if decision.enable_entity_extraction:
            decision.enable_entity_extraction = False
            rules_applied.append(f"disable_entities_low_density_{complexity.entity_density:.1%}")
            decision.reason += f" (disabled entities: low density {complexity.entity_density:.1%})"

    # Rule 4: Force entity extraction for high entity density
    if complexity.entity_density > 0.3 and not decision.enable_entity_extraction:
        decision.enable_entity_extraction = True
        rules_applied.append(f"enable_entities_high_density_{complexity.entity_density:.0%}")
        decision.reason += f" (enabled entities: high density {complexity.entity_density:.0%})"

    # Rule 5: Increase max_synonyms for long complex queries
    if len(query) > 60 and decision.enable_synonym_expansion:
        if decision.max_synonyms < 3:
            decision.max_synonyms = 3
            rules_applied.append("increase_synonyms_long_query")
            decision.reason += " (increased synonyms: long query)"

    # Rule 6: Reduce max_synonyms for short queries
    if len(query) < 20 and decision.max_synonyms > 1:
        decision.max_synonyms = 1
        rules_applied.append("reduce_synonyms_short_query")
        decision.reason += " (reduced synonyms: short query)"

    decision.rules_applied = rules_applied
    return decision


def stage_decision_to_config(decision: StageDecision) -> PreprocessingConfig:
    """Convert StageDecision to PreprocessingConfig"""
    return PreprocessingConfig(
        enableSpellCorrection=decision.enable_spell_correction,
        enableSynonymExpansion=decision.enable_synonym_expansion,
        enableEntityExtraction=decision.enable_entity_extraction,
        maxSynonyms=decision.max_synonyms,
    )


# ─── Domain-Specific Overrides ─────────────────────────────────────────────


def select_stages_with_domain(
    query: str,
    domain: Optional[str] = None,
    complexity: Optional[QueryComplexityScore] = None,
) -> StageDecision:
    """
    Select stages with optional domain-specific overrides

    Domains:
    - "code-search": Disable spell correction and synonyms (exact match needed)
    - "natural-language": Enable all stages (user queries)
    - "log-search": Disable all preprocessing (preserve exact logs)
    """

    # Get base decision
    decision = select_stages(query, complexity)

    if domain == "code-search":
        # Code search: exact matching, no "corrections"
        decision.enable_spell_correction = False
        decision.enable_synonym_expansion = False
        decision.enable_entity_extraction = False
        decision.reason = "Code search domain (exact match only)"
        decision.rules_applied.append("domain_code_search")

    elif domain == "log-search":
        # Log search: preserve exact query
        decision.enable_spell_correction = False
        decision.enable_synonym_expansion = False
        decision.enable_entity_extraction = True  # May want to extract timestamps
        decision.reason = "Log search domain (preserve exact query)"
        decision.rules_applied.append("domain_log_search")

    elif domain == "natural-language":
        # Natural language: enable all helpful preprocessing
        if complexity and complexity.overall > 40:
            decision.enable_spell_correction = True
            decision.enable_synonym_expansion = True
            decision.max_synonyms = 3
            decision.reason = "Natural language domain (full preprocessing)"
            decision.rules_applied.append("domain_natural_language")

    return decision


# ─── Batch Decision for Multiple Queries ───────────────────────────────────


def select_stages_batch(queries: list[str]) -> list[StageDecision]:
    """
    Batch process multiple queries

    This is useful for:
    - Pre-analyzing a query batch
    - Optimizing by grouping queries with same strategy
    """
    decisions = []

    for query in queries:
        complexity = analyze_query_complexity(query)
        decision = select_stages(query, complexity)
        decisions.append(decision)

    return decisions


# ─── Strategy Statistics ───────────────────────────────────────────────────


def get_strategy_stats(decisions: list[StageDecision]) -> dict[str, int]:
    """
    Get statistics about stage decisions

    Useful for:
    - Monitoring adaptive behavior
    - Identifying optimization opportunities
    """
    stats = {
        "total": len(decisions),
        "spell_correction_enabled": 0,
        "synonym_expansion_enabled": 0,
        "entity_extraction_enabled": 0,
        "all_disabled": 0,
        "all_enabled": 0,
    }

    for decision in decisions:
        if decision.enable_spell_correction:
            stats["spell_correction_enabled"] += 1
        if decision.enable_synonym_expansion:
            stats["synonym_expansion_enabled"] += 1
        if decision.enable_entity_extraction:
            stats["entity_extraction_enabled"] += 1

        # Count fully disabled/enabled
        if not any(
            [
                decision.enable_spell_correction,
                decision.enable_synonym_expansion,
                decision.enable_entity_extraction,
            ]
        ):
            stats["all_disabled"] += 1
        elif all(
            [
                decision.enable_spell_correction,
                decision.enable_synonym_expansion,
                decision.enable_entity_extraction,
            ]
        ):
            stats["all_enabled"] += 1

    return stats

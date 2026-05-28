#!/usr/bin/env python3
"""
Generate Synthetic Typo Dataset for Quality Testing

Takes clean queries and injects realistic errors:
- 40% typo queries (keyboard errors, character swaps, deletions)
- 30% informal queries (contractions, slang, incomplete sentences)
- 20% conversational queries (natural language reformulations)
- 10% edge cases (multilingual, code-switching)
"""

import json
import random
import re
from typing import List, Dict, Tuple
from pathlib import Path


# ─── Keyboard Layout for Realistic Typos ────────────────────────────────────

# QWERTY keyboard adjacency map (adjacent keys on US keyboard)
KEYBOARD_ADJACENT = {
    'q': ['w', 'a', '1', '2'],
    'w': ['q', 'e', 's', 'a', '2', '3'],
    'e': ['w', 'r', 'd', 's', '3', '4'],
    'r': ['e', 't', 'f', 'd', '4', '5'],
    't': ['r', 'y', 'g', 'f', '5', '6'],
    'y': ['t', 'u', 'h', 'g', '6', '7'],
    'u': ['y', 'i', 'j', 'h', '7', '8'],
    'i': ['u', 'o', 'k', 'j', '8', '9'],
    'o': ['i', 'p', 'l', 'k', '9', '0'],
    'p': ['o', 'l', '0'],
    'a': ['q', 'w', 's', 'z'],
    's': ['a', 'w', 'e', 'd', 'x', 'z'],
    'd': ['s', 'e', 'r', 'f', 'c', 'x'],
    'f': ['d', 'r', 't', 'g', 'v', 'c'],
    'g': ['f', 't', 'y', 'h', 'b', 'v'],
    'h': ['g', 'y', 'u', 'j', 'n', 'b'],
    'j': ['h', 'u', 'i', 'k', 'm', 'n'],
    'k': ['j', 'i', 'o', 'l', 'm'],
    'l': ['k', 'o', 'p'],
    'z': ['a', 's', 'x'],
    'x': ['z', 's', 'd', 'c'],
    'c': ['x', 'd', 'f', 'v'],
    'v': ['c', 'f', 'g', 'b'],
    'b': ['v', 'g', 'h', 'n'],
    'n': ['b', 'h', 'j', 'm'],
    'm': ['n', 'j', 'k'],
}

# Common typo patterns (word -> typo)
COMMON_TYPOS = {
    "deploy": ["deplyo", "deply", "depoy", "deplo"],
    "deployment": ["deplyoment", "deploymnet", "deployement", "depolyment"],
    "kubernetes": ["kuberntes", "kuberentes", "kubernets", "kubernetis"],
    "configure": ["confgiure", "configrue", "congigure", "confiugre"],
    "configuration": ["confgiuration", "configuraton", "configration", "configuraiton"],
    "production": ["prodction", "producton", "prduction", "proudction"],
    "docker": ["dokcer", "docer", "docekr", "dcoker"],
    "container": ["contaienr", "containre", "contaner", "conatiner"],
    "service": ["servcie", "serivce", "servce", "sevice"],
    "ingress": ["ingres", "ingrss", "ingres", "ingresss"],
    "namespace": ["namesapce", "namepsace", "namspace", "nameespace"],
    "cluster": ["cluter", "clustre", "clsuter", "culster"],
    "application": ["applicaton", "appliation", "applicaiton", "aplication"],
    "image": ["imge", "iamge", "imagee", "imaeg"],
    "network": ["netwrok", "netowrk", "nework", "networ"],
    "volume": ["volme", "voluem", "volumne", "volue"],
    "database": ["databse", "datbase", "databaes", "databas"],
    "replica": ["replcia", "repica", "repliac", "replicaa"],
    "manifest": ["manfiest", "manifset", "manifes", "mainifest"],
    "pod": ["pdo", "ppod", "podd", "opd"],
}


# ─── Typo Generation Functions ──────────────────────────────────────────────


def inject_keyboard_typo(word: str) -> str:
    """Replace random character with adjacent keyboard key"""
    if len(word) <= 2:
        return word

    idx = random.randint(1, len(word) - 2)  # Don't replace first/last
    char = word[idx].lower()

    if char in KEYBOARD_ADJACENT:
        adjacent = KEYBOARD_ADJACENT[char]
        replacement = random.choice(adjacent)
        return word[:idx] + replacement + word[idx + 1:]

    return word


def inject_swap_typo(word: str) -> str:
    """Swap two adjacent characters (common typo)"""
    if len(word) <= 2:
        return word

    idx = random.randint(0, len(word) - 2)
    chars = list(word)
    chars[idx], chars[idx + 1] = chars[idx + 1], chars[idx]
    return ''.join(chars)


def inject_deletion_typo(word: str) -> str:
    """Delete a random character"""
    if len(word) <= 3:
        return word

    idx = random.randint(1, len(word) - 2)
    return word[:idx] + word[idx + 1:]


def inject_insertion_typo(word: str) -> str:
    """Insert a duplicate adjacent character"""
    if len(word) <= 2:
        return word

    idx = random.randint(1, len(word) - 1)
    char = word[idx - 1]
    return word[:idx] + char + word[idx:]


def apply_common_typo(text: str) -> Tuple[str, bool]:
    """Apply common typo patterns from dictionary"""
    text_lower = text.lower()
    for correct, typos in COMMON_TYPOS.items():
        if correct in text_lower:
            typo = random.choice(typos)
            # Preserve case
            if correct.capitalize() in text:
                typo = typo.capitalize()
            text = re.sub(r'\b' + re.escape(correct) + r'\b', typo, text, flags=re.IGNORECASE)
            return text, True
    return text, False


def inject_random_typo(text: str) -> str:
    """Inject a random typo into the text"""
    words = text.split()
    if len(words) == 0:
        return text

    # Pick a random word (prefer longer words)
    long_words = [w for w in words if len(w) > 4]
    if long_words:
        word = random.choice(long_words)
    else:
        word = random.choice(words)

    # Apply random typo type
    typo_func = random.choice([
        inject_keyboard_typo,
        inject_swap_typo,
        inject_deletion_typo,
        inject_insertion_typo,
    ])

    typo_word = typo_func(word)
    return text.replace(word, typo_word, 1)


# ─── Query Transformation Functions ─────────────────────────────────────────


def make_informal(query: str) -> str:
    """Add informal language (contractions, lowercase, incomplete)"""
    informal = query.lower()

    # Remove punctuation
    informal = re.sub(r'[?!]$', '', informal)

    # Add contractions
    contractions = {
        "how do i": "how do i",
        "what is": "whats",
        "how can i": "how can i",
        "do not": "dont",
        "does not": "doesnt",
        "cannot": "cant",
        "will not": "wont",
        "should not": "shouldnt",
    }
    for formal, casual in contractions.items():
        informal = informal.replace(formal, casual)

    # Add filler words
    fillers = ["like", "basically", "just", "really"]
    if random.random() < 0.5:
        words = informal.split()
        if len(words) > 2:
            pos = random.randint(1, len(words) - 1)
            words.insert(pos, random.choice(fillers))
            informal = ' '.join(words)

    return informal


def make_conversational(query: str) -> str:
    """Convert to natural conversational language"""
    # Remove question mark for statements
    conversational = re.sub(r'[?]$', '', query)

    # Add conversational starters
    starters = [
        "I need to ",
        "I want to ",
        "I'm trying to ",
        "How do I ",
        "Can someone help me ",
        "Need help with ",
    ]

    # If it starts with "How", keep it; otherwise add starter
    if not conversational.lower().startswith(('how', 'what', 'why', 'when', 'where')):
        starter = random.choice(starters)
        conversational = starter + conversational.lower()

    # Add trailing context
    endings = [
        " in kubernetes",
        " on my cluster",
        " please",
        " thanks",
    ]
    if random.random() < 0.4:
        conversational += random.choice(endings)

    return conversational


def make_multilingual(query: str) -> str:
    """Add multilingual or code-switching elements"""
    # Spanish words
    spanish_map = {
        "how": "cómo",
        "configure": "configurar",
        "deployment": "despliegue",
        "settings": "ajustes",
        "error": "error",
    }

    # French words
    french_map = {
        "how": "comment",
        "configure": "configurer",
        "settings": "paramètres",
        "error": "erreur",
    }

    # German words
    german_map = {
        "how": "wie",
        "configure": "konfigurieren",
        "settings": "einstellungen",
        "error": "fehler",
    }

    # Pick a language
    lang_map = random.choice([spanish_map, french_map, german_map])

    # Replace 1-2 words
    query_lower = query.lower()
    for eng, foreign in lang_map.items():
        if eng in query_lower:
            query = re.sub(r'\b' + eng + r'\b', foreign, query, count=1, flags=re.IGNORECASE)
            break

    return query


# ─── Dataset Generation ─────────────────────────────────────────────────────


def generate_synthetic_queries(
    base_queries: List[Dict],
    num_queries: int = 100
) -> List[Dict]:
    """
    Generate synthetic queries from base queries

    Distribution:
    - 40% typo queries (keyboard errors, swaps, deletions)
    - 30% informal queries (lowercase, contractions, slang)
    - 20% conversational queries (natural language)
    - 10% edge cases (multilingual, code-switching)
    """
    synthetic_queries = []

    # Calculate distribution
    num_typo = int(num_queries * 0.40)
    num_informal = int(num_queries * 0.30)
    num_conversational = int(num_queries * 0.20)
    num_edge = num_queries - num_typo - num_informal - num_conversational

    query_id = 1

    # 1. Typo queries (40%)
    for i in range(num_typo):
        base = random.choice(base_queries)
        original_query = base["query"]

        # Try common typo first (50% chance)
        if random.random() < 0.5:
            typo_query, applied = apply_common_typo(original_query)
            if not applied:
                # Fallback to random typo
                typo_query = inject_random_typo(original_query)
        else:
            typo_query = inject_random_typo(original_query)

        synthetic_queries.append({
            "id": f"synth_query_{query_id:03d}",
            "query": typo_query,
            "original_query": original_query,
            "category": "typo",
            "relevant_docs": base["relevant_docs"],
            "expected_improvement_with_preprocessing": True,
            "preprocessing_helps_with": ["spell_correction"],
        })
        query_id += 1

    # 2. Informal queries (30%)
    for i in range(num_informal):
        base = random.choice(base_queries)
        original_query = base["query"]
        informal_query = make_informal(original_query)

        synthetic_queries.append({
            "id": f"synth_query_{query_id:03d}",
            "query": informal_query,
            "original_query": original_query,
            "category": "informal",
            "relevant_docs": base["relevant_docs"],
            "expected_improvement_with_preprocessing": True,
            "preprocessing_helps_with": ["synonym_expansion", "query_normalization"],
        })
        query_id += 1

    # 3. Conversational queries (20%)
    for i in range(num_conversational):
        base = random.choice(base_queries)
        original_query = base["query"]
        conversational_query = make_conversational(original_query)

        synthetic_queries.append({
            "id": f"synth_query_{query_id:03d}",
            "query": conversational_query,
            "original_query": original_query,
            "category": "conversational",
            "relevant_docs": base["relevant_docs"],
            "expected_improvement_with_preprocessing": True,
            "preprocessing_helps_with": ["synonym_expansion", "query_reformulation"],
        })
        query_id += 1

    # 4. Edge cases (10%) - multilingual, code-switching
    for i in range(num_edge):
        base = random.choice(base_queries)
        original_query = base["query"]

        # Mix of multilingual + typo
        if random.random() < 0.5:
            edge_query = make_multilingual(original_query)
            helps_with = ["language_detection", "translation"]
        else:
            # Double typo (harder case)
            edge_query = inject_random_typo(inject_random_typo(original_query))
            helps_with = ["spell_correction", "fuzzy_matching"]

        synthetic_queries.append({
            "id": f"synth_query_{query_id:03d}",
            "query": edge_query,
            "original_query": original_query,
            "category": "edge_case",
            "relevant_docs": base["relevant_docs"],
            "expected_improvement_with_preprocessing": True,
            "preprocessing_helps_with": helps_with,
        })
        query_id += 1

    return synthetic_queries


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Generate synthetic typo dataset")
    parser.add_argument(
        "--input",
        type=str,
        default="../tests/fixtures/stackoverflow-ground-truth.json",
        help="Input ground truth dataset (clean queries)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="../tests/fixtures/synthetic-typo-ground-truth.json",
        help="Output synthetic dataset",
    )
    parser.add_argument(
        "--num-queries",
        type=int,
        default=100,
        help="Number of synthetic queries to generate (default: 100)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )

    args = parser.parse_args()

    # Set random seed for reproducibility
    random.seed(args.seed)

    print("=" * 80)
    print("SYNTHETIC TYPO DATASET GENERATION")
    print("=" * 80)
    print()

    # Load base dataset
    print(f"Loading base dataset from {args.input}...")
    with open(args.input, "r") as f:
        base_data = json.load(f)

    base_queries = base_data["queries"]
    documents = base_data["documents"]

    print(f"✓ Loaded {len(base_queries)} base queries")
    print(f"✓ Loaded {len(documents)} documents")
    print()

    # Generate synthetic queries
    print(f"Generating {args.num_queries} synthetic queries...")
    print(f"  - 40% typo queries ({int(args.num_queries * 0.40)})")
    print(f"  - 30% informal queries ({int(args.num_queries * 0.30)})")
    print(f"  - 20% conversational queries ({int(args.num_queries * 0.20)})")
    print(f"  - 10% edge cases ({args.num_queries - int(args.num_queries * 0.90)})")
    print()

    synthetic_queries = generate_synthetic_queries(base_queries, args.num_queries)

    # Create output dataset
    output_data = {
        "metadata": {
            "version": "1.0.0",
            "source": "synthetic_typo",
            "base_dataset": args.input,
            "generated_queries": len(synthetic_queries),
            "base_documents": len(documents),
            "distribution": {
                "typo": len([q for q in synthetic_queries if q["category"] == "typo"]),
                "informal": len([q for q in synthetic_queries if q["category"] == "informal"]),
                "conversational": len([q for q in synthetic_queries if q["category"] == "conversational"]),
                "edge_case": len([q for q in synthetic_queries if q["category"] == "edge_case"]),
            },
            "random_seed": args.seed,
        },
        "documents": documents,
        "queries": synthetic_queries,
    }

    # Save
    with open(args.output, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"✓ Generated {len(synthetic_queries)} synthetic queries")
    print()

    # Show examples
    print("Sample synthetic queries:")
    print("-" * 80)
    for category in ["typo", "informal", "conversational", "edge_case"]:
        examples = [q for q in synthetic_queries if q["category"] == category][:2]
        print(f"\n{category.upper()}:")
        for ex in examples:
            print(f"  Original: {ex['original_query']}")
            print(f"  Synthetic: {ex['query']}")
            print()

    print("=" * 80)
    print(f"✓ Saved to {args.output}")
    print()

    print("Next steps:")
    print("  1. Run quality benchmark:")
    print(f"     cd tests/quality && python3 test_retrieval_quality.py --ground-truth {args.output}")
    print("  2. Compare results: synthetic (with typos) vs stackoverflow (clean)")
    print("  3. Expected: Full preprocessing shows +10-15% NDCG@10 improvement")
    print()
    print("=" * 80)


if __name__ == "__main__":
    main()

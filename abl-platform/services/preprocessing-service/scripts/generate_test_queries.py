#!/usr/bin/env python3
"""
Generate 2000 test queries for adaptive preprocessing benchmark (Phase 3.5-3.7)

Categories:
- Simple keywords (100)
- Structured queries (100)
- SQL queries (100)
- Technical terms (200)
- Queries with typos (200)
- Multilingual queries (200)
- Entity-heavy queries (200)
- Proper nouns (200)
- Complex semantic queries (200)
- Mixed/edge cases (500)
"""

import json
import random
from typing import List, Dict, Any


# ─── Query Templates ────────────────────────────────────────────────────────

SIMPLE_KEYWORDS = [
    "user", "users", "login", "logout", "dashboard", "settings", "profile",
    "admin", "home", "search", "help", "docs", "api", "database", "server",
    "network", "security", "password", "email", "account", "data", "file",
    "folder", "document", "report", "chart", "graph", "table", "list", "view",
]

STRUCTURED_PATTERNS = [
    ("status", ["active", "inactive", "pending", "completed"]),
    ("user_id", ["12345", "67890", "abc123", "xyz789"]),
    ("created_at", ["2024-01-15", "2024-02-20", "2023-12-01"]),
    ("type", ["admin", "user", "guest", "moderator"]),
    ("category", ["devops", "database", "frontend", "backend"]),
    ("priority", ["high", "medium", "low", "critical"]),
    ("environment", ["prod", "staging", "dev", "test"]),
]

SQL_TEMPLATES = [
    "SELECT * FROM {table}",
    "SELECT {fields} FROM {table} WHERE {condition}",
    "INSERT INTO {table} VALUES ({values})",
    "UPDATE {table} SET {field} = {value} WHERE {condition}",
    "DELETE FROM {table} WHERE {condition}",
    "SELECT COUNT(*) FROM {table}",
    "SELECT * FROM {table} ORDER BY {field} DESC LIMIT 10",
]

SQL_TABLES = ["users", "orders", "products", "customers", "invoices", "logs"]
SQL_FIELDS = ["id", "name", "email", "status", "created_at", "amount"]
SQL_CONDITIONS = ["status = 'active'", "id > 100", "created_at >= '2024-01-01'"]

TECHNICAL_TERMS = {
    "devops": ["kubernetes", "docker", "terraform", "ansible", "jenkins", "gitlab", "prometheus", "grafana"],
    "database": ["postgresql", "mongodb", "redis", "elasticsearch", "mysql", "cassandra"],
    "programming": ["python", "javascript", "typescript", "golang", "rust", "java"],
    "cloud": ["aws", "azure", "gcp", "s3", "ec2", "lambda", "cloudformation"],
    "networking": ["vpc", "firewall", "loadbalancer", "dns", "ssl", "tls", "nginx"],
}

TECHNICAL_QUERY_TEMPLATES = [
    "{term1} {term2} configuration",
    "{term1} deployment best practices",
    "{term1} {term2} integration guide",
    "how to configure {term1} with {term2}",
    "{term1} monitoring and logging",
]

# Common typo patterns
TYPO_WORDS = [
    ("document", "docuemnt"), ("kubernetes", "kuberntes"), ("deployment", "deployemnt"),
    ("configuration", "confgiuration"), ("production", "prodction"), ("environment", "enviornment"),
    ("application", "applicaiton"), ("database", "databse"), ("connection", "conection"),
    ("repository", "repostory"), ("authentication", "authetication"), ("authorization", "authorzation"),
]

MULTILINGUAL_QUERIES = {
    "es": [
        "mostrar documentos sobre {topic}",
        "buscar usuarios activos",
        "configuración de {topic}",
        "cómo implementar {topic}",
        "guía de {topic}",
    ],
    "fr": [
        "afficher les documents sur {topic}",
        "rechercher les utilisateurs actifs",
        "configuration de {topic}",
        "comment configurer {topic}",
        "guide de {topic}",
    ],
    "de": [
        "dokumente über {topic} anzeigen",
        "aktive benutzer suchen",
        "konfiguration von {topic}",
        "wie man {topic} konfiguriert",
        "{topic} anleitung",
    ],
}

ENTITY_TEMPLATES = [
    "orders from {date1} to {date2} with amount >= {number}",
    "send invoice to {email} for ${amount}",
    "schedule meeting on {date} at {time}",
    "transfer ${amount} to account {account_number}",
    "call {phone} regarding order #{order_id}",
]

PROPER_NOUNS = {
    "companies": ["Amazon", "Google", "Microsoft", "Apple", "Netflix", "Uber", "Airbnb"],
    "cloud": ["AWS", "Azure", "GCP", "DigitalOcean", "Heroku", "Vercel"],
    "products": ["S3", "EC2", "Lambda", "DynamoDB", "CloudFront", "Kubernetes Engine"],
}

COMPLEX_SEMANTIC_TEMPLATES = [
    "how do I configure {topic} with {feature}",
    "what are the best practices for {topic}",
    "explain the difference between {concept1} and {concept2}",
    "troubleshooting {topic} performance issues",
    "step by step guide to implement {topic}",
]


# ─── Query Generators ───────────────────────────────────────────────────────

def generate_simple_keywords(count: int) -> List[Dict[str, Any]]:
    """Generate simple keyword queries (1-2 words)"""
    queries = []
    for i in range(count):
        if i < len(SIMPLE_KEYWORDS):
            query = SIMPLE_KEYWORDS[i]
        else:
            # Generate combinations
            query = f"{random.choice(SIMPLE_KEYWORDS)} {random.choice(SIMPLE_KEYWORDS)}"

        queries.append({
            "id": f"simple_{i+1:03d}",
            "category": "simple_keywords",
            "query": query,
            "expected_complexity": "low",
            "expected_strategy": "skip",
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": False,
                "needs_entities": False,
                "optimal_config": "skip"
            }
        })
    return queries


def generate_structured_queries(count: int) -> List[Dict[str, Any]]:
    """Generate structured field:value queries"""
    queries = []
    for i in range(count):
        field, values = random.choice(STRUCTURED_PATTERNS)
        value = random.choice(values)
        query = f"{field}:{value}"

        queries.append({
            "id": f"structured_{i+1:03d}",
            "category": "structured_queries",
            "query": query,
            "expected_complexity": "low",
            "expected_strategy": "skip",
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": False,
                "needs_entities": False,
                "optimal_config": "skip"
            }
        })
    return queries


def generate_sql_queries(count: int) -> List[Dict[str, Any]]:
    """Generate SQL-like queries"""
    queries = []
    for i in range(count):
        template = random.choice(SQL_TEMPLATES)
        query = template.format(
            table=random.choice(SQL_TABLES),
            fields=", ".join(random.sample(SQL_FIELDS, 2)),
            field=random.choice(SQL_FIELDS),
            condition=random.choice(SQL_CONDITIONS),
            value="'new_value'",
            values="'value1', 'value2'"
        )

        queries.append({
            "id": f"sql_{i+1:03d}",
            "category": "sql_queries",
            "query": query,
            "expected_complexity": "low",
            "expected_strategy": "skip",
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": False,
                "needs_entities": False,
                "optimal_config": "skip"
            }
        })
    return queries


def generate_technical_queries(count: int) -> List[Dict[str, Any]]:
    """Generate queries with technical terms"""
    queries = []
    for i in range(count):
        category = random.choice(list(TECHNICAL_TERMS.keys()))
        terms = TECHNICAL_TERMS[category]
        template = random.choice(TECHNICAL_QUERY_TEMPLATES)

        query = template.format(
            term1=random.choice(terms),
            term2=random.choice(terms)
        )

        queries.append({
            "id": f"technical_{i+1:03d}",
            "category": "technical_terms",
            "query": query,
            "expected_complexity": "medium",
            "expected_strategy": "minimal",
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": False,
                "needs_entities": False,
                "optimal_config": "minimal",
                "technical_terms": 2
            }
        })
    return queries


def generate_typo_queries(count: int) -> List[Dict[str, Any]]:
    """Generate queries with intentional typos"""
    queries = []

    base_templates = [
        "show me {word1} about {word2}",
        "{word1} {word2} for {word3}",
        "how to configure {word1} in {word2}",
        "{word1} guide for {word2}",
        "troubleshoot {word1} {word2}",
    ]

    for i in range(count):
        template = random.choice(base_templates)

        # Select 2-3 words, introduce typos in 1-2 of them
        typo_pairs = random.sample(TYPO_WORDS, min(3, len(TYPO_WORDS)))
        words = {}
        corrections = []

        for j, (correct, typo) in enumerate(typo_pairs, 1):
            if random.random() < 0.6:  # 60% chance of typo
                words[f"word{j}"] = typo
                corrections.append(f"{typo} -> {correct}")
            else:
                words[f"word{j}"] = correct

        # Fill remaining placeholders
        for j in range(len(words) + 1, 4):
            words[f"word{j}"] = random.choice([w[0] for w in TYPO_WORDS])

        query = template.format(**words)

        queries.append({
            "id": f"typo_{i+1:03d}",
            "category": "queries_with_typos",
            "query": query,
            "expected_complexity": "high",
            "expected_strategy": "thorough",
            "ground_truth": {
                "needs_spell_correction": len(corrections) > 0,
                "needs_synonyms": True,
                "needs_entities": False,
                "optimal_config": "thorough",
                "expected_corrections": corrections if corrections else None
            }
        })
    return queries


def generate_multilingual_queries(count: int) -> List[Dict[str, Any]]:
    """Generate multilingual queries"""
    queries = []
    languages = list(MULTILINGUAL_QUERIES.keys())
    topics = ["kubernetes", "database", "api", "deployment", "monitoring"]

    for i in range(count):
        lang = random.choice(languages)
        template = random.choice(MULTILINGUAL_QUERIES[lang])
        topic = random.choice(topics)
        query = template.format(topic=topic)

        queries.append({
            "id": f"multilingual_{i+1:03d}",
            "category": "multilingual",
            "query": query,
            "expected_complexity": "medium",
            "expected_strategy": "balanced",
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": True,
                "needs_entities": False,
                "optimal_config": "balanced",
                "expected_language": lang
            }
        })
    return queries


def generate_entity_queries(count: int) -> List[Dict[str, Any]]:
    """Generate entity-heavy queries"""
    queries = []

    for i in range(count):
        template = random.choice(ENTITY_TEMPLATES)
        query = template.format(
            date1="2024-01-15",
            date2="2024-02-15",
            date="2024-03-20",
            time="14:30",
            number=random.randint(100, 10000),
            amount=random.randint(100, 5000),
            email=f"user{random.randint(1, 999)}@example.com",
            phone=f"+1-555-{random.randint(1000, 9999)}",
            account_number=f"ACC{random.randint(10000, 99999)}",
            order_id=random.randint(1000, 9999)
        )

        queries.append({
            "id": f"entity_{i+1:03d}",
            "category": "entity_heavy",
            "query": query,
            "expected_complexity": "high",
            "expected_strategy": "thorough",
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": False,
                "needs_entities": True,
                "optimal_config": "thorough"
            }
        })
    return queries


def generate_proper_noun_queries(count: int) -> List[Dict[str, Any]]:
    """Generate queries with proper nouns"""
    queries = []

    for i in range(count):
        company = random.choice(PROPER_NOUNS["companies"])
        cloud = random.choice(PROPER_NOUNS["cloud"])
        product = random.choice(PROPER_NOUNS["products"])

        templates = [
            f"{company} {cloud} {product} configuration",
            f"{company} {product} best practices",
            f"how to use {company} {product}",
            f"{cloud} {product} integration guide",
        ]
        query = random.choice(templates)

        queries.append({
            "id": f"proper_noun_{i+1:03d}",
            "category": "proper_nouns",
            "query": query,
            "expected_complexity": "medium",
            "expected_strategy": "minimal",
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": False,
                "needs_entities": False,
                "optimal_config": "minimal",
                "has_proper_nouns": True
            }
        })
    return queries


def generate_complex_semantic_queries(count: int) -> List[Dict[str, Any]]:
    """Generate complex semantic queries"""
    queries = []

    topics = ["high availability", "microservices", "load balancing", "caching", "authentication"]
    features = ["automatic failover", "distributed tracing", "rate limiting", "circuit breaker"]
    concepts = ["REST", "GraphQL", "gRPC", "WebSocket"]

    for i in range(count):
        template = random.choice(COMPLEX_SEMANTIC_TEMPLATES)
        query = template.format(
            topic=random.choice(topics),
            feature=random.choice(features),
            concept1=random.choice(concepts),
            concept2=random.choice(concepts)
        )

        queries.append({
            "id": f"complex_{i+1:03d}",
            "category": "complex_semantic",
            "query": query,
            "expected_complexity": "high",
            "expected_strategy": "thorough",
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": True,
                "needs_entities": False,
                "optimal_config": "thorough"
            }
        })
    return queries


def generate_mixed_edge_cases(count: int) -> List[Dict[str, Any]]:
    """Generate mixed/edge case queries"""
    queries = []

    edge_cases = [
        ("", "low", "skip"),  # Empty query
        ("a", "low", "skip"),  # Single character
        ("ab", "low", "skip"),  # Two characters
        ("   spaces   ", "low", "skip"),  # Extra spaces
        ("UPPERCASE QUERY", "medium", "balanced"),  # All caps
        ("lowercase query", "medium", "balanced"),  # All lowercase
        ("MiXeD CaSe QuErY", "medium", "balanced"),  # Mixed case
    ]

    # Generate edge cases
    for i, (query, complexity, strategy) in enumerate(edge_cases * (count // len(edge_cases) + 1)):
        if i >= count:
            break

        queries.append({
            "id": f"mixed_{i+1:03d}",
            "category": "mixed_edge_cases",
            "query": query,
            "expected_complexity": complexity,
            "expected_strategy": strategy,
            "ground_truth": {
                "needs_spell_correction": False,
                "needs_synonyms": False,
                "needs_entities": False,
                "optimal_config": strategy
            }
        })

    # Fill remaining with random combinations
    while len(queries) < count:
        i = len(queries)

        # Mix different categories
        if random.random() < 0.3:
            # Technical + typo
            query = f"how to configure kuberntes deployemnt"
            complexity = "high"
            strategy = "thorough"
        elif random.random() < 0.6:
            # Multilingual + entity
            query = "enviar factura a john@example.com el 2024-01-15"
            complexity = "high"
            strategy = "thorough"
        else:
            # Proper noun + technical
            company = random.choice(PROPER_NOUNS["companies"])
            term = random.choice(TECHNICAL_TERMS["devops"])
            query = f"{company} {term} configuration"
            complexity = "medium"
            strategy = "minimal"

        queries.append({
            "id": f"mixed_{i+1:03d}",
            "category": "mixed_edge_cases",
            "query": query,
            "expected_complexity": complexity,
            "expected_strategy": strategy,
            "ground_truth": {
                "needs_spell_correction": "typo" in query or "deployemnt" in query,
                "needs_synonyms": complexity in ["medium", "high"],
                "needs_entities": "@" in query or any(c.isdigit() for c in query),
                "optimal_config": strategy
            }
        })

    return queries[:count]


# ─── Main Generator ─────────────────────────────────────────────────────────

def generate_all_queries() -> Dict[str, Any]:
    """Generate all 2000 test queries"""

    print("Generating test queries...")

    queries = []
    queries.extend(generate_simple_keywords(100))
    print(f"  ✓ Generated {len(queries)} simple keyword queries")

    queries.extend(generate_structured_queries(100))
    print(f"  ✓ Generated {len(queries)} total queries (structured)")

    queries.extend(generate_sql_queries(100))
    print(f"  ✓ Generated {len(queries)} total queries (SQL)")

    queries.extend(generate_technical_queries(200))
    print(f"  ✓ Generated {len(queries)} total queries (technical)")

    queries.extend(generate_typo_queries(200))
    print(f"  ✓ Generated {len(queries)} total queries (typos)")

    queries.extend(generate_multilingual_queries(200))
    print(f"  ✓ Generated {len(queries)} total queries (multilingual)")

    queries.extend(generate_entity_queries(200))
    print(f"  ✓ Generated {len(queries)} total queries (entities)")

    queries.extend(generate_proper_noun_queries(200))
    print(f"  ✓ Generated {len(queries)} total queries (proper nouns)")

    queries.extend(generate_complex_semantic_queries(200))
    print(f"  ✓ Generated {len(queries)} total queries (complex semantic)")

    queries.extend(generate_mixed_edge_cases(500))
    print(f"  ✓ Generated {len(queries)} total queries (mixed/edge cases)")

    # Count by category
    categories = {}
    for q in queries:
        cat = q["category"]
        categories[cat] = categories.get(cat, 0) + 1

    return {
        "metadata": {
            "version": "1.0.0",
            "total_queries": len(queries),
            "categories": categories,
            "purpose": "Benchmark adaptive preprocessing features (Phase 3.5-3.7)",
            "generated_by": "generate_test_queries.py"
        },
        "queries": queries
    }


if __name__ == "__main__":
    dataset = generate_all_queries()

    output_file = "../tests/fixtures/test-queries-full.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(dataset, f, indent=2, ensure_ascii=False)

    print(f"\n✓ Saved {dataset['metadata']['total_queries']} queries to {output_file}")
    print(f"\nCategory breakdown:")
    for cat, count in sorted(dataset['metadata']['categories'].items()):
        print(f"  {cat}: {count}")

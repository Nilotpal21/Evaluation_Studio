"""
Query Complexity Analyzer (Phase 3.6)

Analyzes query characteristics to determine preprocessing needs:
- Length and structure
- Technical term density
- Typo likelihood
- Entity density
- Language complexity
"""

import re
from typing import Dict, List, Tuple, Literal
from dataclasses import dataclass


@dataclass
class QueryComplexityScore:
    """Query complexity analysis result"""

    overall: float  # 0-100 score
    recommendation: Literal["skip", "minimal", "balanced", "thorough"]

    # Factor scores
    length_score: float
    is_structured_query: bool
    technical_term_count: int
    typo_likelihood: float
    has_language_mix: bool
    entity_density: float
    proper_noun_ratio: float

    # Reasoning
    reason: str


# ─── Technical Terms Dictionary ────────────────────────────────────────────

TECHNICAL_TERMS = {
    # Common Abbreviations
    "api",
    "cli",
    "sdk",
    "ide",
    "gui",
    # DevOps & Infrastructure
    "kubernetes",
    "docker",
    "terraform",
    "ansible",
    "jenkins",
    "gitlab",
    "prometheus",
    "grafana",
    "helm",
    "istio",
    # Databases
    "postgresql",
    "mongodb",
    "redis",
    "elasticsearch",
    "mysql",
    "cassandra",
    "dynamodb",
    "mariadb",
    # Programming
    "python",
    "javascript",
    "typescript",
    "golang",
    "rust",
    "java",
    "kotlin",
    "swift",
    # Cloud Providers
    "aws",
    "azure",
    "gcp",
    "digitalocean",
    "heroku",
    "vercel",
    "cloudflare",
    # Cloud Services
    "s3",
    "ec2",
    "lambda",
    "cloudformation",
    "cloudwatch",
    "cloudfront",
    # Networking
    "vpc",
    "firewall",
    "loadbalancer",
    "nginx",
    "haproxy",
    "traefik",
    # Monitoring & Logging
    "datadog",
    "newrelic",
    "splunk",
    "elk",
    "logstash",
    "kibana",
    # Orchestration
    "nomad",
    "consul",
    "etcd",
    "zookeeper",
}

# Common typo patterns
TYPO_PATTERNS = [
    # Repeated characters
    (r"(.)\1{2,}", "repeated_chars"),
    # Common misspellings (endings)
    (r"\b\w*emnt\b", "ement_typo"),  # deployemnt, docuemnt
    (r"\b\w*tion\b", "tion_typo"),  # configuraiton
    (r"\b\w*ntes\b", "netes_typo"),  # kuberntes
    (r"\b\w*yoment\b", "oyment_typo"),  # deplyoment
    (r"\b\w*urtion\b", "uration_typo"),  # configurtion
    # Common word typos
    (r"\brecieve\b", "receive_typo"),
    (r"\bmesage\b", "message_typo"),
    (r"\bthier\b", "their_typo"),
    (r"\boccured\b", "occurred_typo"),
]

# Question patterns
QUESTION_WORDS = [
    "how",
    "what",
    "why",
    "when",
    "where",
    "which",
    "who",
    "can",
    "should",
    "could",
    "would",
]

# Comparison patterns
COMPARISON_PATTERNS = [
    r"\bdifference between\b",
    r"\bcompared to\b",
    r"\bvs\b",
    r"\bversus\b",
    r"\bbetter than\b",
]

# Lorem ipsum detection (meaningless placeholder text)
LOREM_IPSUM_WORDS = {
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing",
    "elit", "sed", "eiusmod", "tempor", "incididunt", "labore", "dolore",
    "magna", "aliqua", "enim", "minim", "veniam", "quis", "nostrud",
    "exercitation", "ullamco", "laboris", "nisi", "aliquip", "commodo",
    "consequat", "duis", "aute", "irure", "reprehenderit", "voluptate",
    "velit", "esse", "cillum", "fugiat", "nulla", "pariatur", "excepteur",
    "sint", "occaecat", "cupidatat", "proident", "sunt", "culpa", "officia",
    "deserunt", "mollit", "anim"
}


# ─── Helper Functions ───────────────────────────────────────────────────────


def is_structured_query(query: str) -> bool:
    """
    Detect structured queries that don't need preprocessing:
    - field:value patterns
    - SQL queries
    - Regex patterns
    """
    # Field:value pattern (e.g., "status:active", "user_id:12345")
    if re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*:[^:]+$", query.strip()):
        return True

    # SQL keywords
    sql_keywords = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP"]
    for keyword in sql_keywords:
        if query.strip().upper().startswith(keyword):
            return True

    # Regex patterns
    if query.startswith("/") and query.endswith("/"):
        return True

    return False


def count_technical_terms(query: str) -> int:
    """Count technical terms in query"""
    query_lower = query.lower()
    words = re.findall(r"\b[a-z0-9]+\b", query_lower)

    count = 0
    for word in words:
        if word in TECHNICAL_TERMS:
            count += 1

    return count


def detect_language(query: str) -> Tuple[str, bool]:
    """
    Detect if query is non-English or mixed language

    Returns:
        (language_hint, is_non_english)

    Simple heuristic:
    - Accented characters (é, ñ, ü) → likely Spanish/French/German
    - Non-Latin scripts (Japanese, Chinese, Arabic) → non-English
    - All ASCII → likely English
    - Mixed language indicators counted
    """
    detected_languages = set()

    # Non-Latin scripts
    if re.search(r'[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]', query):  # Japanese/Chinese
        detected_languages.add("ja/zh")
    if re.search(r'[\u0600-\u06FF]', query):  # Arabic
        detected_languages.add("ar")
    if re.search(r'[\u0400-\u04FF]', query):  # Cyrillic (Russian)
        detected_languages.add("ru")

    # Latin with accents (Spanish, French, German, Portuguese)
    accented_chars = r'[àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝŸÑÇ]'
    if re.search(accented_chars, query):
        detected_languages.add("romance")

    query_lower = query.lower()

    # German-specific patterns
    if re.search(r'\b(ich|der|die|das|und|wie|konfiguriere)\b', query_lower):
        detected_languages.add("de")

    # Spanish-specific patterns
    if re.search(r'\b(cómo|qué|dónde|cuándo|por|para|con|parametros|especificos)\b', query_lower):
        detected_languages.add("es")

    # French-specific patterns
    if re.search(r'\b(le|la|les|un|une|est|sont|avec)\b', query_lower):
        detected_languages.add("fr")

    # English-specific patterns (to detect code-switching)
    # Common English words that wouldn't appear in other languages
    if re.search(r'\b(configure|deployment|settings|configuration|setup|enable|disable|install|update)\b', query_lower):
        # Only add "en" if we also detected another language (code-switching)
        if detected_languages:
            detected_languages.add("en")

    # Clean up: if we have "romance" + a specific Romance language, merge them
    romance_languages = {"es", "fr", "de", "pt"}
    if "romance" in detected_languages:
        specific_romance = detected_languages & romance_languages
        if specific_romance:
            # Remove generic "romance", keep specific language
            detected_languages.remove("romance")

    # If multiple language indicators detected, it's mixed/code-switching
    if len(detected_languages) >= 2:
        return ("mixed", True)

    if len(detected_languages) == 1:
        lang = list(detected_languages)[0]
        return (lang, True)

    if "romance" in detected_languages:
        return ("romance", True)

    return ("en", False)


def detect_question_pattern(query: str) -> bool:
    """
    Detect if query is a question

    Questions typically need thorough preprocessing for synonym expansion
    """
    query_lower = query.lower().strip()

    # Check for question words at start
    for qword in QUESTION_WORDS:
        if query_lower.startswith(qword + " "):
            return True

    # Check for question mark
    if query.strip().endswith("?"):
        return True

    # Check for question patterns mid-sentence
    if re.search(r"\bhow to\b", query_lower):
        return True

    return False


def detect_comparison_pattern(query: str) -> bool:
    """
    Detect if query is comparing concepts

    Comparisons need thorough preprocessing for semantic understanding
    """
    query_lower = query.lower()

    for pattern in COMPARISON_PATTERNS:
        if re.search(pattern, query_lower):
            return True

    return False


def is_lorem_ipsum(query: str) -> bool:
    """
    Detect if query is lorem ipsum (meaningless placeholder text)

    Returns True if 40%+ of words are from lorem ipsum vocabulary
    """
    query_lower = query.lower()
    words = re.findall(r'\b[a-z]+\b', query_lower)

    if len(words) < 5:
        return False

    lorem_count = sum(1 for word in words if word in LOREM_IPSUM_WORDS)
    lorem_ratio = lorem_count / len(words)

    return lorem_ratio >= 0.4


def is_title_case(query: str) -> bool:
    """
    Detect if query is in title case (every word capitalized)

    Title case should not be treated as proper nouns
    """
    words = query.split()
    if len(words) < 2:
        return False

    # Check if all words start with capital
    capitalized = [w[0].isupper() for w in words if w and w[0].isalpha()]

    if len(capitalized) == 0:
        return False

    # Title case if 80%+ words are capitalized
    return sum(capitalized) / len(capitalized) >= 0.8


def detect_typo_likelihood(query: str) -> float:
    """
    Estimate probability of typos (0-1 score)

    Factors:
    - Repeated characters (e.g., "helllo")
    - Common typo patterns (e.g., "docuemnt")
    - Unusual character combinations
    - Transpositions (e.g., "deplyoment")
    """
    score = 0.0
    query_lower = query.lower()

    # Check typo patterns
    for pattern, _ in TYPO_PATTERNS:
        if re.search(pattern, query_lower):
            score += 0.3

    # Check for words not in a basic dictionary (simplified heuristic)
    # In production, use a proper spell checker
    words = re.findall(r"\b[a-z]{4,}\b", query_lower)
    if len(words) > 0:
        # Heuristic: words with uncommon letter combinations
        uncommon_patterns = [
            r"[bcdfghjklmnpqrstvwxyz]{4,}",  # 4+ consonants in a row
            r"[aeiou]{3,}",  # 3+ vowels in a row
        ]

        uncommon_count = 0
        for word in words:
            for pattern in uncommon_patterns:
                if re.search(pattern, word):
                    uncommon_count += 1
                    break

        if uncommon_count > 0:
            score += min(0.4, uncommon_count * 0.2)

    return min(1.0, score)


def detect_proper_nouns(query: str) -> float:
    """
    Estimate ratio of proper nouns (capitalized words)

    Returns: ratio 0-1 of capitalized words

    Excludes title case (all words capitalized)
    """
    # Skip title case
    if is_title_case(query):
        return 0.0

    words = query.split()
    if len(words) == 0:
        return 0.0

    # Count words that start with capital letter (excluding first word)
    capitalized = sum(1 for w in words[1:] if w[0].isupper() and w[0].isalpha())

    return capitalized / max(1, len(words) - 1)


def count_entities(query: str) -> int:
    """
    Count potential entities in query:
    - Dates (YYYY-MM-DD, MM/DD/YYYY)
    - Numbers
    - Emails
    - URLs
    - Phone numbers
    """
    count = 0

    # Dates
    date_patterns = [
        r"\b\d{4}-\d{2}-\d{2}\b",  # YYYY-MM-DD
        r"\b\d{2}/\d{2}/\d{4}\b",  # MM/DD/YYYY
    ]
    for pattern in date_patterns:
        count += len(re.findall(pattern, query))

    # Numbers (including currency)
    count += len(re.findall(r"[\$€£¥]?\d+(?:,\d{3})*(?:\.\d+)?", query))

    # Emails
    count += len(re.findall(r"\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b", query))

    # URLs
    count += len(re.findall(r"https?://[^\s]+", query))

    # Phone numbers
    count += len(re.findall(r"\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}", query))

    return count


# ─── Main Analyzer ──────────────────────────────────────────────────────────


def analyze_query_complexity(query: str) -> QueryComplexityScore:
    """
    Analyze query complexity and recommend preprocessing strategy

    Complexity Levels:
    - skip (0-20): Structured queries, very simple keywords
    - minimal (20-40): Short queries with technical terms
    - balanced (40-70): Medium complexity, some preprocessing needed
    - thorough (70-100): Complex, typos, multilingual, entities

    Returns:
        QueryComplexityScore with overall score and recommendation
    """

    # Strip whitespace
    query = query.strip()

    # Handle empty queries
    if not query:
        return QueryComplexityScore(
            overall=0,
            recommendation="skip",
            length_score=0,
            is_structured_query=False,
            technical_term_count=0,
            typo_likelihood=0,
            has_language_mix=False,
            entity_density=0,
            proper_noun_ratio=0,
            reason="Empty query",
        )

    # Factor 1: Length (0-100 scale)
    length = len(query)
    if length < 10:
        length_score = 10
    elif length < 30:
        length_score = 40
    elif length < 60:
        length_score = 70
    else:
        length_score = 90

    # Factor 2: Structured query detection
    structured = is_structured_query(query)

    # Factor 3: Technical terms
    tech_terms = count_technical_terms(query)

    # Factor 4: Typo likelihood
    typo_score = detect_typo_likelihood(query)

    # Factor 5: Entity density
    words = len(query.split())
    entities = count_entities(query)
    entity_density = entities / max(1, words)

    # Factor 6: Proper nouns (excludes title case)
    proper_noun_ratio = detect_proper_nouns(query)

    # Factor 7: Language detection (NEW)
    language_hint, is_non_english = detect_language(query)

    # Factor 8: Question pattern (NEW)
    is_question = detect_question_pattern(query)

    # Factor 9: Comparison pattern (NEW)
    is_comparison = detect_comparison_pattern(query)

    # Factor 10: Lorem ipsum detection (NEW)
    lorem = is_lorem_ipsum(query)

    # ─── Decision Logic ─────────────────────────────────────────────────────

    # Rule 1: Lorem ipsum (meaningless placeholder text) → skip
    if lorem:
        return QueryComplexityScore(
            overall=0,
            recommendation="skip",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason="Lorem ipsum detected (meaningless placeholder text)",
        )

    # Rule 2: Structured queries → skip
    if structured:
        return QueryComplexityScore(
            overall=0,
            recommendation="skip",
            length_score=length_score,
            is_structured_query=True,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason="Structured query (field:value or SQL)",
        )

    # Rule 3: Very short queries → skip or minimal (technical terms need minimal preprocessing)
    if length < 5:
        if tech_terms > 0:
            # Short technical terms like "api" should get minimal preprocessing
            return QueryComplexityScore(
                overall=25,
                recommendation="minimal",
                length_score=length_score,
                is_structured_query=False,
                technical_term_count=tech_terms,
                typo_likelihood=typo_score,
                has_language_mix=is_non_english,
                entity_density=entity_density,
                proper_noun_ratio=proper_noun_ratio,
                reason=f"Short technical term ({tech_terms} technical terms)",
            )
        else:
            return QueryComplexityScore(
                overall=10,
                recommendation="skip",
                length_score=length_score,
                is_structured_query=False,
                technical_term_count=tech_terms,
                typo_likelihood=typo_score,
                has_language_mix=is_non_english,
                entity_density=entity_density,
                proper_noun_ratio=proper_noun_ratio,
                reason="Very short query (< 5 characters)",
            )

    # Rule 4: Title case queries → balanced
    # Title case (Monday Morning Meeting Notes) likely document titles/headers
    if is_title_case(query):
        return QueryComplexityScore(
            overall=50,
            recommendation="balanced",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=0.0,  # Title case is not proper nouns
            reason="Title case detected (likely document title or header)",
        )

    # Rule 5: Mixed language / code-switching → thorough
    # Queries mixing multiple languages need thorough preprocessing
    if is_non_english and language_hint == "mixed":
        return QueryComplexityScore(
            overall=80,
            recommendation="thorough",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=True,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason="Mixed language/code-switching detected",
        )

    # Rule 6: Non-English query → balanced (minimum)
    # Non-English queries need synonyms for multilingual dictionaries
    if is_non_english:
        return QueryComplexityScore(
            overall=65,
            recommendation="balanced",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=True,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason=f"Non-English query detected ({language_hint})",
        )

    # Rule 8: Question pattern → thorough
    # Questions need synonym expansion for semantic understanding
    if is_question:
        return QueryComplexityScore(
            overall=80,
            recommendation="thorough",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason="Question pattern detected (needs semantic expansion)",
        )

    # Rule 9: Comparison pattern → thorough
    if is_comparison:
        return QueryComplexityScore(
            overall=80,
            recommendation="thorough",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason="Comparison pattern detected (needs semantic understanding)",
        )

    # Rule 10: High typo likelihood → thorough
    if typo_score > 0.3:  # Lowered threshold from 0.5 to 0.3
        return QueryComplexityScore(
            overall=85,
            recommendation="thorough",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason=f"Typo detected (confidence: {typo_score:.1%})",
        )

    # Rule 11: High entity density → thorough
    if entity_density > 0.3:
        return QueryComplexityScore(
            overall=80,
            recommendation="thorough",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason=f"High entity density ({entity_density:.1%})",
        )

    # Rule 12: High technical term density (but no questions/typos) → minimal
    if tech_terms >= 2 and typo_score < 0.3 and not is_question:
        return QueryComplexityScore(
            overall=30,
            recommendation="minimal",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason=f"Technical query ({tech_terms} technical terms)",
        )

    # Rule 13: High proper noun ratio → minimal
    if proper_noun_ratio > 0.4:
        return QueryComplexityScore(
            overall=35,
            recommendation="minimal",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason=f"High proper noun ratio ({proper_noun_ratio:.1%})",
        )

    # Rule 14: Long complex query → thorough
    if length > 60:
        return QueryComplexityScore(
            overall=75,
            recommendation="thorough",
            length_score=length_score,
            is_structured_query=False,
            technical_term_count=tech_terms,
            typo_likelihood=typo_score,
            has_language_mix=is_non_english,
            entity_density=entity_density,
            proper_noun_ratio=proper_noun_ratio,
            reason=f"Long query ({length} characters)",
        )

    # Default: balanced strategy for medium complexity
    overall_score = (
        length_score * 0.3
        + tech_terms * 10
        + typo_score * 30
        + entity_density * 20
        + proper_noun_ratio * 10
    )

    if overall_score < 40:
        recommendation = "minimal"
        reason = "Medium complexity, minimal preprocessing"
    else:
        recommendation = "balanced"
        reason = "Medium complexity, balanced preprocessing"

    return QueryComplexityScore(
        overall=overall_score,
        recommendation=recommendation,
        length_score=length_score,
        is_structured_query=False,
        technical_term_count=tech_terms,
        typo_likelihood=typo_score,
        has_language_mix=is_non_english,
        entity_density=entity_density,
        proper_noun_ratio=proper_noun_ratio,
        reason=reason,
    )

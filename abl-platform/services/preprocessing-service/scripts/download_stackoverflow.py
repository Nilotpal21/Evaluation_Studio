#!/usr/bin/env python3
"""
Download and parse StackOverflow dataset for quality testing

Downloads a subset of StackOverflow posts (DevOps/infrastructure topics)
and converts to IR test format with relevance judgments.
"""

import requests
import json
import re
from typing import List, Dict, Tuple
from collections import defaultdict
from datetime import datetime

# StackExchange API (no auth needed for public data)
API_BASE = "https://api.stackexchange.com/2.3"

# DevOps/Infrastructure tags we care about
TARGET_TAGS = [
    "kubernetes", "docker", "terraform", "ansible", "jenkins",
    "gitlab", "prometheus", "grafana", "helm", "istio",
    "postgresql", "mongodb", "redis", "elasticsearch",
    "aws", "azure", "gcp", "ci-cd", "devops"
]


def search_questions(tags: List[str], max_results: int = 100) -> List[Dict]:
    """
    Search StackOverflow for questions with specific tags

    Uses StackExchange API (rate limit: 300 requests/day without key)
    """
    print(f"Searching for questions with tags: {', '.join(tags[:5])}...")

    questions = []
    page = 1
    page_size = min(100, max_results)  # API max is 100 per page

    while len(questions) < max_results:
        url = f"{API_BASE}/questions"
        params = {
            "page": page,
            "pagesize": page_size,
            "order": "desc",
            "sort": "votes",  # Get highest quality questions
            "tagged": ";".join(tags[:5]),  # API limit: 5 tags max
            "site": "stackoverflow",
            "filter": "withbody"  # Include question body
        }

        response = requests.get(url, params=params)
        if response.status_code != 200:
            print(f"  Error: API returned {response.status_code}")
            break

        data = response.json()

        if "items" not in data or len(data["items"]) == 0:
            break

        questions.extend(data["items"])
        print(f"  Fetched page {page}: {len(data['items'])} questions (total: {len(questions)})")

        # Check quota
        quota_remaining = data.get("quota_remaining", 0)
        print(f"  API quota remaining: {quota_remaining}")

        if not data.get("has_more", False):
            break

        page += 1

        if len(questions) >= max_results:
            questions = questions[:max_results]
            break

    print(f"✓ Fetched {len(questions)} questions")
    return questions


def get_answers(question_ids: List[int]) -> Dict[int, List[Dict]]:
    """Get answers for multiple questions"""
    print(f"Fetching answers for {len(question_ids)} questions...")

    # API allows up to 100 IDs per request
    answers_by_question = defaultdict(list)

    for i in range(0, len(question_ids), 100):
        batch = question_ids[i:i+100]
        ids_str = ";".join(str(qid) for qid in batch)

        url = f"{API_BASE}/questions/{ids_str}/answers"
        params = {
            "order": "desc",
            "sort": "votes",
            "site": "stackoverflow",
            "filter": "withbody"
        }

        response = requests.get(url, params=params)
        if response.status_code != 200:
            print(f"  Error fetching answers: {response.status_code}")
            continue

        data = response.json()

        for answer in data.get("items", []):
            qid = answer["question_id"]
            answers_by_question[qid].append(answer)

        print(f"  Fetched batch {i//100 + 1}: {len(data.get('items', []))} answers")

    print(f"✓ Fetched answers for {len(answers_by_question)} questions")
    return dict(answers_by_question)


def has_typo(text: str) -> bool:
    """Simple heuristic to detect potential typos"""
    # Check for common typo patterns
    typo_patterns = [
        r'\b\w*emnt\b',  # deployemnt
        r'\b\w*tion\b.*\b\w*tion\b',  # repeated -tion
        r'\b\w*ntes\b',  # kuberntes
        r'\w{15,}',  # very long words (likely typos)
    ]

    for pattern in typo_patterns:
        if re.search(pattern, text.lower()):
            return True
    return False


def convert_to_ir_format(questions: List[Dict], answers_by_question: Dict[int, List[Dict]]) -> Tuple[List[Dict], List[Dict]]:
    """
    Convert StackOverflow data to IR test format

    Returns:
        (documents, queries)
    """
    documents = []
    queries = []

    for i, question in enumerate(questions):
        qid = question["question_id"]
        question_text = question["title"]
        question_body = question.get("body", "")

        # Create document for the question
        doc_id = f"doc_{i+1:03d}"
        documents.append({
            "id": doc_id,
            "title": question_text,
            "content": question_body[:500],  # Truncate long content
            "metadata": {
                "category": "stackoverflow",
                "topic": "devops",
                "score": question.get("score", 0),
                "tags": question.get("tags", []),
                "url": question.get("link", "")
            }
        })

        # Get answers for this question
        answers = answers_by_question.get(qid, [])

        # Create query from question title
        query_id = f"query_{i+1:03d}"

        # Determine relevance of answers
        relevant_docs = []

        # The question itself is always relevant (level 1)
        relevant_docs.append({
            "doc_id": doc_id,
            "relevance": 1
        })

        # Accepted answer = highly relevant (level 3)
        # High-voted answers = relevant (level 2)
        for answer in answers[:5]:  # Top 5 answers
            answer_doc_id = f"doc_{len(documents)+1:03d}"

            # Determine relevance
            if answer.get("is_accepted", False):
                relevance = 3  # Highly relevant
            elif answer.get("score", 0) >= 10:
                relevance = 2  # Relevant
            elif answer.get("score", 0) >= 1:
                relevance = 1  # Marginally relevant
            else:
                continue  # Skip low-quality answers

            # Add answer as document
            documents.append({
                "id": answer_doc_id,
                "title": f"Answer to: {question_text}",
                "content": answer.get("body", "")[:500],
                "metadata": {
                    "category": "stackoverflow",
                    "topic": "answer",
                    "score": answer.get("score", 0),
                    "is_accepted": answer.get("is_accepted", False)
                }
            })

            relevant_docs.append({
                "doc_id": answer_doc_id,
                "relevance": relevance
            })

        # Create query
        queries.append({
            "id": query_id,
            "query": question_text,
            "relevant_docs": relevant_docs,
            "expected_improvement_with_preprocessing": has_typo(question_text),
            "preprocessing_helps_with": ["natural_typos"] if has_typo(question_text) else []
        })

    return documents, queries


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Download StackOverflow dataset for IR testing")
    parser.add_argument("--output", type=str, default="../tests/fixtures/stackoverflow-ground-truth.json",
                        help="Output file path")
    parser.add_argument("--limit", type=int, default=100,
                        help="Number of questions to fetch (default: 100)")
    parser.add_argument("--tags", type=str, default="kubernetes,docker,terraform",
                        help="Comma-separated tags to search for")

    args = parser.parse_args()

    print("=" * 80)
    print("STACKOVERFLOW DATASET DOWNLOAD")
    print("=" * 80)
    print()

    # Parse tags
    tags = [tag.strip() for tag in args.tags.split(",")]

    # Step 1: Search for questions
    questions = search_questions(tags, max_results=args.limit)

    if len(questions) == 0:
        print("✗ No questions found")
        return

    # Step 2: Get answers
    question_ids = [q["question_id"] for q in questions]
    answers_by_question = get_answers(question_ids)

    # Step 3: Convert to IR format
    print("\nConverting to IR format...")
    documents, queries = convert_to_ir_format(questions, answers_by_question)

    # Step 4: Save
    output_data = {
        "metadata": {
            "version": "1.0.0",
            "source": "stackoverflow",
            "generated": datetime.now().isoformat(),
            "total_queries": len(queries),
            "total_documents": len(documents),
            "tags": tags
        },
        "documents": documents,
        "queries": queries
    }

    with open(args.output, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"\n✓ Saved {len(queries)} queries and {len(documents)} documents to {args.output}")
    print()
    print("Summary:")
    print(f"  Queries: {len(queries)}")
    print(f"  Documents: {len(documents)}")
    print(f"  Avg docs per query: {len(documents) / len(queries):.1f}")
    print(f"  Queries with typos: {sum(1 for q in queries if q['expected_improvement_with_preprocessing'])}")
    print()
    print("=" * 80)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Test BGE-M3 Device Detection and Batch Processing
Tests both CPU and GPU configurations
"""

import requests
import json
import time
from typing import List, Dict

BASE_URL = "http://localhost:8000"

def print_section(title: str):
    """Print formatted section header"""
    print(f"\n{'='*70}")
    print(f"  {title}")
    print('='*70)

def test_health_check():
    """Test 1: Health check and device detection"""
    print_section("TEST 1: Health Check & Device Detection")

    try:
        response = requests.get(f"{BASE_URL}/health", timeout=10)
        response.raise_for_status()

        data = response.json()
        print(f"✅ Service is healthy")
        print(f"   Model: {data['model']}")
        print(f"   Dimensions: {data['dimension']}")
        print(f"   Device: {data['device'].upper()}")
        print(f"   GPU Available: {data['gpu_available']}")
        if data.get('gpu_name'):
            print(f"   GPU Name: {data['gpu_name']}")
        print(f"   Recommended Batch Size: {data['recommended_batch_size']}")

        return data
    except Exception as e:
        print(f"❌ Health check failed: {e}")
        return None

def test_single_embedding():
    """Test 2: Single text embedding"""
    print_section("TEST 2: Single Text Embedding")

    payload = {
        "input": "What is artificial intelligence?",
        "model": "bge-m3"
    }

    try:
        start = time.time()
        response = requests.post(f"{BASE_URL}/v1/embeddings", json=payload, timeout=30)
        latency = (time.time() - start) * 1000
        response.raise_for_status()

        data = response.json()
        embedding = data['data'][0]['embedding']

        print(f"✅ Single embedding generated")
        print(f"   Latency: {latency:.2f}ms")
        print(f"   Embedding length: {len(embedding)}")
        print(f"   First 5 values: {embedding[:5]}")
        print(f"   Token count: {data['usage']['total_tokens']}")

        return latency
    except Exception as e:
        print(f"❌ Single embedding failed: {e}")
        return None

def test_small_batch():
    """Test 3: Small batch (8 texts - CPU optimal)"""
    print_section("TEST 3: Small Batch (8 texts - CPU optimal)")

    texts = [
        "Machine learning is a subset of AI",
        "Deep learning uses neural networks",
        "Natural language processing",
        "Computer vision applications",
        "Reinforcement learning algorithms",
        "Supervised learning methods",
        "Unsupervised clustering techniques",
        "Transfer learning in AI"
    ]

    payload = {
        "input": texts,
        "model": "bge-m3"
    }

    try:
        start = time.time()
        response = requests.post(f"{BASE_URL}/v1/embeddings", json=payload, timeout=60)
        latency = (time.time() - start) * 1000
        response.raise_for_status()

        data = response.json()
        embeddings = data['data']

        print(f"✅ Small batch processed")
        print(f"   Batch size: {len(texts)}")
        print(f"   Total latency: {latency:.2f}ms")
        print(f"   Latency per text: {latency/len(texts):.2f}ms")
        print(f"   Embeddings returned: {len(embeddings)}")
        print(f"   Total tokens: {data['usage']['total_tokens']}")

        return latency
    except Exception as e:
        print(f"❌ Small batch failed: {e}")
        return None

def test_medium_batch():
    """Test 4: Medium batch (32 texts - GPU optimal)"""
    print_section("TEST 4: Medium Batch (32 texts - GPU optimal)")

    texts = [f"Sample text number {i} for embedding generation" for i in range(32)]

    payload = {
        "input": texts,
        "model": "bge-m3"
    }

    try:
        start = time.time()
        response = requests.post(f"{BASE_URL}/v1/embeddings", json=payload, timeout=90)
        latency = (time.time() - start) * 1000
        response.raise_for_status()

        data = response.json()
        embeddings = data['data']

        print(f"✅ Medium batch processed")
        print(f"   Batch size: {len(texts)}")
        print(f"   Total latency: {latency:.2f}ms")
        print(f"   Latency per text: {latency/len(texts):.2f}ms")
        print(f"   Embeddings returned: {len(embeddings)}")
        print(f"   Total tokens: {data['usage']['total_tokens']}")

        return latency
    except Exception as e:
        print(f"❌ Medium batch failed: {e}")
        return None

def test_large_batch():
    """Test 5: Large batch (100 texts - stress test)"""
    print_section("TEST 5: Large Batch (100 texts - Stress Test)")

    texts = [f"Test embedding for document chunk {i}" for i in range(100)]

    payload = {
        "input": texts,
        "model": "bge-m3"
    }

    try:
        start = time.time()
        response = requests.post(f"{BASE_URL}/v1/embeddings", json=payload, timeout=180)
        latency = (time.time() - start) * 1000
        response.raise_for_status()

        data = response.json()
        embeddings = data['data']

        print(f"✅ Large batch processed")
        print(f"   Batch size: {len(texts)}")
        print(f"   Total latency: {latency:.2f}ms")
        print(f"   Latency per text: {latency/len(texts):.2f}ms")
        print(f"   Embeddings returned: {len(embeddings)}")
        print(f"   Total tokens: {data['usage']['total_tokens']}")

        return latency
    except Exception as e:
        print(f"❌ Large batch failed: {e}")
        return None

def test_legacy_endpoint():
    """Test 6: Legacy /embed endpoint"""
    print_section("TEST 6: Legacy Endpoint (/embed)")

    texts = ["Legacy endpoint test", "Second test text"]

    payload = {
        "texts": texts
    }

    try:
        start = time.time()
        response = requests.post(f"{BASE_URL}/embed", json=payload, timeout=30)
        latency = (time.time() - start) * 1000
        response.raise_for_status()

        data = response.json()

        print(f"✅ Legacy endpoint works")
        print(f"   Latency: {latency:.2f}ms")
        print(f"   Embeddings returned: {len(data['embeddings'])}")
        print(f"   Dimension: {data['dimension']}")
        print(f"   Model: {data['model']}")

        return True
    except Exception as e:
        print(f"❌ Legacy endpoint failed: {e}")
        return False

def run_all_tests():
    """Run all test cases"""
    print("\n" + "🚀 BGE-M3 Device Detection & Batch Processing Tests".center(70, "="))
    print("Starting test suite...\n")

    results = {}

    # Test 1: Health check
    health_data = test_health_check()
    if not health_data:
        print("\n❌ Health check failed. Service may not be running.")
        print(f"   Make sure service is running: docker compose up bge-m3-embeddings")
        return

    results['device'] = health_data['device']
    results['gpu_available'] = health_data['gpu_available']
    results['recommended_batch'] = health_data['recommended_batch_size']

    # Test 2: Single embedding
    results['single_latency'] = test_single_embedding()
    time.sleep(1)

    # Test 3: Small batch (CPU optimal)
    results['small_batch_latency'] = test_small_batch()
    time.sleep(1)

    # Test 4: Medium batch (GPU optimal)
    results['medium_batch_latency'] = test_medium_batch()
    time.sleep(1)

    # Test 5: Large batch (stress test)
    results['large_batch_latency'] = test_large_batch()
    time.sleep(1)

    # Test 6: Legacy endpoint
    results['legacy_works'] = test_legacy_endpoint()

    # Summary
    print_section("TEST SUMMARY")
    print(f"Device: {results['device'].upper()}")
    print(f"GPU Available: {results['gpu_available']}")
    print(f"Recommended Batch Size: {results['recommended_batch']}")
    print()

    if results['single_latency']:
        print(f"✅ Single text: {results['single_latency']:.2f}ms")
    if results['small_batch_latency']:
        print(f"✅ Small batch (8): {results['small_batch_latency']:.2f}ms ({results['small_batch_latency']/8:.2f}ms per text)")
    if results['medium_batch_latency']:
        print(f"✅ Medium batch (32): {results['medium_batch_latency']:.2f}ms ({results['medium_batch_latency']/32:.2f}ms per text)")
    if results['large_batch_latency']:
        print(f"✅ Large batch (100): {results['large_batch_latency']:.2f}ms ({results['large_batch_latency']/100:.2f}ms per text)")
    if results['legacy_works']:
        print(f"✅ Legacy endpoint working")

    print()

    # Performance analysis
    if results['device'] == 'cpu':
        print("💡 Performance Notes (CPU mode):")
        print("   - Single worker recommended (current: check Dockerfile)")
        print("   - For higher throughput, use 4 workers (GUNICORN_WORKERS=4)")
        print("   - Batch size 8 is optimal for CPU")
    else:
        print("💡 Performance Notes (GPU mode):")
        print("   - Single worker mandatory (CUDA not fork-safe)")
        print("   - Batch size 32-64 optimal for GPU")
        print("   - GPU provides 10-35× speedup over CPU")

    print("\n" + "="*70)
    print("All tests completed!".center(70))
    print("="*70 + "\n")

if __name__ == "__main__":
    run_all_tests()

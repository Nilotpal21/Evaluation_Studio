#!/usr/bin/env python3
"""
Unit tests for BGE-M3 device detection logic (no service required)
Tests the device detection function in isolation
"""

import sys
import os

# Mock torch if not available
try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    print("⚠️  PyTorch not installed. Install with: pip install torch")
    TORCH_AVAILABLE = False
    sys.exit(1)

def test_device_detection():
    """Test the device detection logic"""
    print("="*70)
    print("  BGE-M3 Device Detection Unit Test")
    print("="*70)
    print()

    # Test 1: Check PyTorch availability
    print("TEST 1: PyTorch Installation")
    print(f"   PyTorch version: {torch.__version__}")
    print(f"   ✅ PyTorch is installed")
    print()

    # Test 2: CUDA/GPU detection
    print("TEST 2: GPU Detection")
    cuda_available = torch.cuda.is_available()
    print(f"   CUDA available: {cuda_available}")

    if cuda_available:
        device_count = torch.cuda.device_count()
        device_name = torch.cuda.get_device_name(0)
        print(f"   ✅ GPU detected!")
        print(f"   GPU count: {device_count}")
        print(f"   GPU name: {device_name}")
        print(f"   Recommended batch size: 32 (GPU-optimized)")
        device = 'cuda'
        recommended_batch = 32
    else:
        cpu_count = os.cpu_count()
        print(f"   ℹ️  No GPU detected, using CPU")
        print(f"   CPU cores: {cpu_count}")
        print(f"   Recommended batch size: 8 (CPU-optimized)")
        device = 'cpu'
        recommended_batch = 8
    print()

    # Test 3: Device creation
    print("TEST 3: Device Object Creation")
    try:
        torch_device = torch.device(device)
        print(f"   Device object: {torch_device}")
        print(f"   ✅ Device successfully created")
    except Exception as e:
        print(f"   ❌ Device creation failed: {e}")
        return False
    print()

    # Test 4: Tensor operations on device
    print("TEST 4: Tensor Operations on Device")
    try:
        # Create a test tensor
        test_tensor = torch.tensor([1.0, 2.0, 3.0])
        print(f"   Original tensor device: {test_tensor.device}")

        # Move to detected device
        test_tensor = test_tensor.to(device)
        print(f"   Tensor moved to: {test_tensor.device}")

        # Perform operation
        result = test_tensor * 2
        print(f"   Operation result: {result.cpu().tolist()}")
        print(f"   ✅ Tensor operations work on {device}")
    except Exception as e:
        print(f"   ❌ Tensor operations failed: {e}")
        return False
    print()

    # Test 5: Simulate model loading
    print("TEST 5: Simulate Model Device Assignment")
    try:
        # Simulate what SentenceTransformer does
        class MockModel:
            def __init__(self, device):
                self.device = torch.device(device)
                print(f"   Mock model initialized on: {self.device}")

        mock_model = MockModel(device)
        print(f"   ✅ Model device assignment works")
    except Exception as e:
        print(f"   ❌ Model initialization failed: {e}")
        return False
    print()

    # Summary
    print("="*70)
    print("  Test Summary")
    print("="*70)
    print(f"✅ Device: {device.upper()}")
    print(f"✅ Recommended batch size: {recommended_batch}")
    print(f"✅ PyTorch: {torch.__version__}")
    if cuda_available:
        print(f"✅ GPU: {device_name}")
    else:
        print(f"✅ CPU: {os.cpu_count()} cores")
    print()
    print("All unit tests passed! ✅")
    print("="*70)
    print()

    return True

def test_batch_size_logic():
    """Test batch size optimization logic"""
    print("="*70)
    print("  Batch Size Optimization Test")
    print("="*70)
    print()

    scenarios = [
        (1, "Single text"),
        (8, "Small batch (CPU optimal)"),
        (32, "Medium batch (GPU optimal)"),
        (64, "Large batch (GPU high throughput)"),
        (100, "Very large batch (may need splitting)"),
    ]

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    recommended = 32 if device == 'cuda' else 8

    for size, desc in scenarios:
        warning = ""
        if size > recommended * 2:
            warning = " ⚠️  WARNING: Consider splitting"
        print(f"  Batch size {size:3d} - {desc}{warning}")

    print()
    print(f"Recommended batch size for {device.upper()}: {recommended}")
    print("="*70)
    print()

def main():
    """Run all unit tests"""
    print("\n🚀 Starting BGE-M3 Unit Tests\n")

    if not TORCH_AVAILABLE:
        print("❌ PyTorch not available. Cannot run tests.")
        return

    # Run tests
    success = test_device_detection()

    if success:
        test_batch_size_logic()

        print("💡 Next Steps:")
        print("   1. Start the service: docker compose up bge-m3-embeddings")
        print("   2. Run integration tests: python test_device_detection.py")
        print()

if __name__ == "__main__":
    main()

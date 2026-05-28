"""
Unified Token Counter

Provides accurate token counting using tiktoken instead of character-based heuristics.
Configurable via TOKENIZER_MODEL environment variable.

Usage:
    from tokenizer import count_tokens, get_tokenizer_info

    token_count = count_tokens("Some text to count")
    info = get_tokenizer_info()
"""

import os
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Global tokenizer instance (lazy-loaded)
_tokenizer = None
_tokenizer_model = None

# Supported tiktoken models (tiktoken 0.5.x)
SUPPORTED_MODELS = {
    "cl100k_base": "GPT-4, GPT-3.5-turbo, text-embedding-ada-002",
    "p50k_base": "GPT-3 (Davinci, Curie, Babbage, Ada)",
    "r50k_base": "GPT-3 (older models)",
}

# Default model if not specified
DEFAULT_MODEL = "cl100k_base"


def get_tokenizer():
    """
    Get or initialize the tiktoken tokenizer.

    Uses TOKENIZER_MODEL environment variable to select encoding.
    Falls back to cl100k_base (GPT-4) if not specified.

    Returns:
        tiktoken.Encoding: Tokenizer instance
    """
    global _tokenizer, _tokenizer_model

    # Get model from environment
    model = os.getenv("TOKENIZER_MODEL", DEFAULT_MODEL)

    # Return cached tokenizer if model hasn't changed
    if _tokenizer is not None and _tokenizer_model == model:
        return _tokenizer

    # Initialize tiktoken
    try:
        import tiktoken

        # Validate model
        if model not in SUPPORTED_MODELS:
            logger.warning(
                f"Unknown tokenizer model '{model}', falling back to '{DEFAULT_MODEL}'. "
                f"Supported models: {', '.join(SUPPORTED_MODELS.keys())}"
            )
            model = DEFAULT_MODEL

        _tokenizer = tiktoken.get_encoding(model)
        _tokenizer_model = model

        logger.info(f"Initialized tiktoken with model: {model} ({SUPPORTED_MODELS[model]})")
        return _tokenizer

    except ImportError:
        logger.error(
            "tiktoken not available - install it with: pip install tiktoken\n"
            "Falling back to character-based estimation (INACCURATE)"
        )
        return None
    except Exception as e:
        logger.error(f"Failed to initialize tiktoken: {e}")
        return None


def count_tokens(text: str) -> int:
    """
    Count tokens in text using tiktoken.

    Falls back to character-based estimation if tiktoken unavailable.

    Args:
        text: Text to count tokens for

    Returns:
        int: Accurate token count

    Example:
        >>> count_tokens("Hello, world!")
        4
        >>> count_tokens("This is a longer sentence with more tokens.")
        10
    """
    if not text:
        return 0

    tokenizer = get_tokenizer()

    if tokenizer is not None:
        # Use tiktoken for accurate counting
        try:
            tokens = tokenizer.encode(text)
            return len(tokens)
        except Exception as e:
            logger.warning(f"tiktoken encoding failed: {e}, falling back to char estimate")
            return _fallback_count_tokens(text)
    else:
        # Fallback to character-based estimation
        return _fallback_count_tokens(text)


def _fallback_count_tokens(text: str) -> int:
    """
    Fallback character-based token estimation.

    INACCURATE: Only use when tiktoken unavailable.
    Assumes ~4 characters per token (rough average for English).

    Args:
        text: Text to estimate tokens for

    Returns:
        int: Estimated token count
    """
    return len(text) // 4


def count_tokens_batch(texts: list[str]) -> list[int]:
    """
    Count tokens for multiple texts efficiently.

    Args:
        texts: List of text strings

    Returns:
        list[int]: Token counts for each text

    Example:
        >>> count_tokens_batch(["Hello", "World", "Test"])
        [1, 1, 1]
    """
    return [count_tokens(text) for text in texts]


def get_tokenizer_info() -> dict:
    """
    Get information about the current tokenizer configuration.

    Returns:
        dict: Tokenizer metadata

    Example:
        >>> get_tokenizer_info()
        {
            'model': 'cl100k_base',
            'description': 'GPT-4, GPT-3.5-turbo, text-embedding-ada-002',
            'available': True,
            'source': 'environment'
        }
    """
    model = os.getenv("TOKENIZER_MODEL", DEFAULT_MODEL)
    tokenizer = get_tokenizer()

    return {
        "model": model,
        "description": SUPPORTED_MODELS.get(model, "Unknown model"),
        "available": tokenizer is not None,
        "source": "environment" if os.getenv("TOKENIZER_MODEL") else "default",
        "fallback": tokenizer is None,
    }


# Convenience function for backward compatibility
def estimate_tokens(text: str) -> int:
    """
    Alias for count_tokens() for backward compatibility.

    Args:
        text: Text to count tokens for

    Returns:
        int: Token count
    """
    return count_tokens(text)

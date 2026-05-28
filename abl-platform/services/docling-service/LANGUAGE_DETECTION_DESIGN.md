# High-Quality Language Detection Design

## Overview

Document language detection with support for mixed-language content, handling cases where documents contain foreign words (e.g., English technical terms in non-English documents).

## Requirements

### 1. **Accuracy for Mixed Content**

- Detect primary document language even with foreign words
- Example: Chinese document with English technical terms → Primary: Chinese
- Example: English document with French phrases → Primary: English

### 2. **Multi-Language Support**

- Support major languages:
  - **Western**: English, Spanish, French, German, Italian, Portuguese
  - **CJK**: Chinese (Simplified/Traditional), Japanese, Korean
  - **Middle Eastern**: Arabic, Hebrew, Persian
  - **Asian**: Hindi, Bengali, Thai, Vietnamese, Indonesian
  - **European**: Russian, Polish, Dutch, Swedish, Danish, Norwegian, Finnish
- Detect multiple languages in a single document (with confidence scores)

### 3. **Performance**

- Fast detection (< 100ms for typical documents)
- Scalable to large documents (100+ pages)
- Cacheable results (hash-based caching)

### 4. **Integration Points**

- Document extraction pipeline (post-extraction)
- Query preprocessing (detect query language)
- Search filtering (filter by document language)

## Architecture

### Detection Strategy: Hierarchical Multi-Model Approach

```
┌─────────────────────────────────────────────────────────────┐
│                    Document Text Input                       │
└─────────────────────┬───────────────────────────────────────┘
                      │
          ┌───────────▼──────────┐
          │  1. Quick Detection  │
          │  (fasttext/langdetect)│
          │  Confidence threshold │
          └───────────┬───────────┘
                      │
          ┌───────────▼───────────────┐
          │ High confidence (>95%)?   │
          └──────┬──────────┬─────────┘
                 │ YES      │ NO
                 │          │
                 │     ┌────▼────────────────────┐
                 │     │ 2. Multi-Sample Analysis│
                 │     │ Sample chunks throughout│
                 │     │ document, vote on lang  │
                 │     └──────┬──────────────────┘
                 │            │
            ┌────▼────────────▼──────┐
            │ 3. Script Analysis      │
            │ (Unicode char analysis) │
            │ CJK, Arabic, Cyrillic   │
            └───────────┬─────────────┘
                        │
            ┌───────────▼──────────────────┐
            │ 4. Language Profile Matching │
            │ (character n-grams, word freq)│
            └───────────┬──────────────────┘
                        │
           ┌────────────▼────────────────┐
           │  Primary + Secondary langs  │
           │  With confidence scores     │
           └─────────────────────────────┘
```

### Model Selection

#### Primary: **lingua-language-detector** (Python)

- **Pros**: High accuracy (99%+), low dependencies, works offline
- **Cons**: Slower than fasttext
- **Use**: Definitive detection when quick detection is uncertain

#### Secondary: **fasttext** (Meta AI)

- **Pros**: Very fast (<5ms), good accuracy (93%+)
- **Cons**: Requires model file (~1MB)
- **Use**: Quick first-pass detection

#### Tertiary: **Unicode Script Analysis**

- **Pros**: Perfect for script-specific languages (CJK, Arabic)
- **Cons**: Can't distinguish within same script (zh-CN vs zh-TW)
- **Use**: Fallback and validation

### Detection Levels

#### Level 1: Document-Wide Detection

```python
{
  "primary": "en",
  "confidence": 0.97,
  "secondary": [
    {"lang": "fr", "confidence": 0.15},
    {"lang": "es", "confidence": 0.08}
  ],
  "script": "Latin",
  "detectionMethod": "fasttext-confident"
}
```

#### Level 2: Chunk-Level Detection (Optional)

```python
# Per-chunk language for multilingual documents
{
  "chunkId": "chunk-1",
  "language": "en",
  "confidence": 0.98
}
```

## Implementation

### 1. Detection Service

```python
from lingua import Language, LanguageDetectorBuilder
import fasttext
from collections import Counter
import unicodedata

class LanguageDetector:
    """
    High-quality language detection with mixed-content handling.
    """

    def __init__(self):
        # Load models
        self.fasttext_model = fasttext.load_model('lid.176.bin')  # Fast detection

        # Build lingua detector with all languages (high accuracy)
        self.lingua_detector = LanguageDetectorBuilder.from_all_languages().build()

        # Confidence thresholds
        self.CONFIDENT_THRESHOLD = 0.95  # If fasttext is this confident, skip lingua
        self.MIN_TEXT_LENGTH = 50        # Minimum text length for reliable detection

    def detect_document_language(self, text: str, sample_chunks: bool = True) -> dict:
        """
        Detect document language with mixed-content handling.

        Args:
            text: Full document text
            sample_chunks: If True, sample multiple chunks for voting

        Returns:
            {
                "primary": "en",
                "confidence": 0.97,
                "secondary": [{"lang": "fr", "conf": 0.15}],
                "script": "Latin",
                "method": "fasttext-confident" | "lingua-voted" | "script-detected"
            }
        """
        if len(text) < self.MIN_TEXT_LENGTH:
            return self._fallback_detection(text)

        # Step 1: Quick detection with fasttext
        fasttext_result = self._detect_fasttext(text[:1000])  # First 1000 chars

        if fasttext_result['confidence'] > self.CONFIDENT_THRESHOLD:
            # High confidence - use fasttext result
            return {
                "primary": fasttext_result['lang'],
                "confidence": fasttext_result['confidence'],
                "secondary": [],
                "script": self._detect_script(text[:500]),
                "method": "fasttext-confident"
            }

        # Step 2: Multi-sample analysis for mixed content
        if sample_chunks and len(text) > 5000:
            return self._detect_with_sampling(text)
        else:
            return self._detect_with_lingua(text)

    def _detect_fasttext(self, text: str) -> dict:
        """Fast detection using fasttext."""
        text_clean = text.replace('\n', ' ').strip()
        if not text_clean:
            return {"lang": "unknown", "confidence": 0.0}

        predictions = self.fasttext_model.predict(text_clean, k=3)
        labels, confidences = predictions

        # Parse fasttext labels (__label__en -> en)
        primary_lang = labels[0].replace('__label__', '')
        primary_conf = float(confidences[0])

        return {
            "lang": primary_lang,
            "confidence": primary_conf
        }

    def _detect_with_sampling(self, text: str) -> dict:
        """
        Sample multiple chunks and vote on language.
        Handles mixed-language documents (e.g., English terms in Chinese docs).
        """
        # Sample 10 chunks evenly distributed throughout document
        chunk_size = len(text) // 10
        samples = []

        for i in range(10):
            start = i * chunk_size
            end = start + min(chunk_size, 500)  # Max 500 chars per sample
            samples.append(text[start:end])

        # Detect language for each sample
        votes = []
        for sample in samples:
            result = self._detect_fasttext(sample)
            if result['confidence'] > 0.5:  # Only count confident detections
                votes.append((result['lang'], result['confidence']))

        # Vote with confidence weighting
        if not votes:
            return self._detect_with_lingua(text)

        lang_scores = Counter()
        for lang, conf in votes:
            lang_scores[lang] += conf

        # Primary language = most votes
        primary_lang, primary_score = lang_scores.most_common(1)[0]
        total_score = sum(lang_scores.values())
        primary_confidence = primary_score / total_score if total_score > 0 else 0

        # Secondary languages (above 10% threshold)
        secondary = []
        for lang, score in lang_scores.most_common(5):
            if lang != primary_lang:
                conf = score / total_score
                if conf > 0.10:  # At least 10% of content
                    secondary.append({"lang": lang, "confidence": round(conf, 3)})

        return {
            "primary": primary_lang,
            "confidence": round(primary_confidence, 3),
            "secondary": secondary,
            "script": self._detect_script(text[:500]),
            "method": "sampling-voted"
        }

    def _detect_with_lingua(self, text: str) -> dict:
        """
        High-accuracy detection using lingua.
        Slower but more accurate for uncertain cases.
        """
        # Get top 3 language predictions
        confidences = self.lingua_detector.compute_language_confidence_values(text[:5000])

        if not confidences:
            return self._fallback_detection(text)

        # Sort by confidence
        sorted_langs = sorted(confidences, key=lambda x: x.value, reverse=True)

        primary = sorted_langs[0]
        secondary = [
            {"lang": lang.language.iso_code_639_1.name.lower(), "confidence": round(lang.value, 3)}
            for lang in sorted_langs[1:4]
            if lang.value > 0.05
        ]

        return {
            "primary": primary.language.iso_code_639_1.name.lower(),
            "confidence": round(primary.value, 3),
            "secondary": secondary,
            "script": self._detect_script(text[:500]),
            "method": "lingua-definitive"
        }

    def _detect_script(self, text: str) -> str:
        """
        Detect Unicode script (Latin, CJK, Arabic, Cyrillic, etc.).
        Very fast and reliable for script-specific languages.
        """
        script_counts = Counter()

        for char in text:
            if char.isspace() or not char.isalpha():
                continue
            script = unicodedata.name(char, '').split()[0]
            script_counts[script] += 1

        if not script_counts:
            return "Unknown"

        dominant_script = script_counts.most_common(1)[0][0]

        # Map Unicode script names to readable names
        script_map = {
            "CJK": "CJK",
            "ARABIC": "Arabic",
            "CYRILLIC": "Cyrillic",
            "LATIN": "Latin",
            "DEVANAGARI": "Devanagari",
            "HANGUL": "Hangul",
            "HIRAGANA": "Japanese",
            "KATAKANA": "Japanese",
            "THAI": "Thai",
            "HEBREW": "Hebrew"
        }

        for key, value in script_map.items():
            if key in dominant_script:
                return value

        return "Latin"  # Default

    def _fallback_detection(self, text: str) -> dict:
        """Fallback for very short text or detection failures."""
        script = self._detect_script(text)

        # Use script to guess language
        script_to_lang = {
            "Arabic": "ar",
            "Hebrew": "he",
            "Cyrillic": "ru",
            "CJK": "zh",  # Default to Chinese
            "Hangul": "ko",
            "Japanese": "ja",
            "Devanagari": "hi",
            "Thai": "th"
        }

        primary = script_to_lang.get(script, "en")  # Default to English

        return {
            "primary": primary,
            "confidence": 0.6,  # Low confidence
            "secondary": [],
            "script": script,
            "method": "script-fallback"
        }
```

### 2. Integration with Extraction Pipeline

```python
# In services/docling-service/app.py

async def extract_document(
    file: UploadFile,
    options: str = Form("{}")
) -> ExtractionResult:
    """Extract document with language detection."""

    # ... existing extraction logic ...

    # After extraction, detect language
    if pages:
        # Concatenate first few pages for detection (performance)
        sample_text = '\n\n'.join(p.text for p in pages[:5])  # First 5 pages

        language_detector = LanguageDetector()
        language_info = language_detector.detect_document_language(sample_text)

        metadata.language = language_info['primary']
        metadata.languageConfidence = language_info['confidence']
        metadata.languageScript = language_info['script']

        # Store secondary languages if significant
        if language_info['secondary']:
            metadata.secondaryLanguages = language_info['secondary']

    return ExtractionResult(pages=pages, metadata=metadata, structure=structure)
```

### 3. API Enhancement

```python
class ExtractionMetadata(BaseModel):
    """Extraction metadata with language detection"""
    pageCount: int
    hasOCR: bool
    totalTables: int
    totalImages: int
    processingTime: float
    documentType: Optional[str] = None

    # Language detection fields
    language: Optional[str] = None                    # ISO 639-1 code (en, zh, es, etc.)
    languageConfidence: Optional[float] = None        # 0.0 to 1.0
    languageScript: Optional[str] = None              # Latin, CJK, Arabic, etc.
    secondaryLanguages: Optional[List[dict]] = None   # [{"lang": "fr", "confidence": 0.15}]
```

### 4. Document Metadata API Parameter

Allow explicit language override via API:

```python
@app.post("/extract")
async def extract_document(
    file: UploadFile,
    options: str = Form("{}"),
    language: Optional[str] = Form(None),  # Explicit language override
    detectLanguage: bool = Form(True)      # Enable/disable detection
):
    """
    Extract document with optional explicit language.

    Args:
        file: Document file
        options: Extraction options JSON
        language: Optional explicit language code (ISO 639-1)
        detectLanguage: Whether to auto-detect language (default: True)
    """
    opts = ExtractionOptions(**json.loads(options))

    # ... extraction ...

    if language:
        # User provided explicit language - use it
        metadata.language = language
        metadata.languageConfidence = 1.0
        metadata.languageDetectionMethod = "explicit"
    elif detectLanguage:
        # Auto-detect language
        language_detector = LanguageDetector()
        language_info = language_detector.detect_document_language(sample_text)
        metadata.language = language_info['primary']
        metadata.languageConfidence = language_info['confidence']
        metadata.languageDetectionMethod = language_info['method']

    return result
```

## Handling Mixed-Language Content

### Example: Technical Document with English Terms

**Input Document (Chinese with English terms):**

```
这是一个技术文档关于 Machine Learning 和 Deep Learning。
我们使用 Python 和 TensorFlow 来实现模型。
API endpoint 返回 JSON 格式的数据。
```

**Detection Process:**

1. **Quick Detection (fasttext)**:
   - Sample: "这是一个技术文档关于 Machine Learning..."
   - Result: 70% Chinese, 30% English → Low confidence

2. **Multi-Sample Analysis**:
   - Sample 10 chunks throughout document
   - Chunk votes: 8 Chinese, 2 English
   - Weighted by confidence

3. **Result**:

```json
{
  "primary": "zh",
  "confidence": 0.82,
  "secondary": [{ "lang": "en", "confidence": 0.18 }],
  "script": "CJK",
  "method": "sampling-voted"
}
```

### Example: Code Documentation

**Input Document (English with code snippets):**

````
## Installation

To install the package, run:

```bash
pip install my-package
npm install my-package
````

## Usage

Import the module:

```python
from my_package import MyClass
```

````

**Handling**:
- Pre-process: Strip code blocks before detection
- Code fence removal: Remove ` ``` ` delimited sections
- Result: Pure English prose → High confidence

```python
def preprocess_for_detection(text: str) -> str:
    """Remove code blocks and other non-prose content."""
    # Remove code fences
    text = re.sub(r'```[\s\S]*?```', '', text)
    # Remove inline code
    text = re.sub(r'`[^`]+`', '', text)
    # Remove URLs
    text = re.sub(r'https?://\S+', '', text)
    return text
````

## Performance Optimization

### Caching Strategy

```python
import hashlib
from functools import lru_cache

class CachedLanguageDetector(LanguageDetector):
    """Language detector with hash-based caching."""

    @lru_cache(maxsize=1000)
    def detect_document_language_cached(self, text_hash: str, text: str) -> dict:
        """Cached detection based on content hash."""
        return super().detect_document_language(text)

    def detect(self, text: str) -> dict:
        """Detect with caching."""
        # Hash first 5000 chars for cache key
        sample = text[:5000]
        text_hash = hashlib.md5(sample.encode()).hexdigest()
        return self.detect_document_language_cached(text_hash, sample)
```

### Sampling for Large Documents

- For documents > 10 pages: Sample 10 evenly-spaced chunks
- For documents > 100 pages: Sample 20 chunks
- Cache per-document results by content hash

## Metrics & Monitoring

Track detection quality:

```python
# Log language detection metrics
logger.info(
    f"[METRIC] language.detection "
    f"primary={result['primary']} "
    f"confidence={result['confidence']:.3f} "
    f"method={result['method']} "
    f"script={result['script']} "
    f"doc_length={len(text)}"
)
```

## Testing Strategy

### Unit Tests

```python
def test_english_dominant_with_french_terms():
    text = "This is an English document with some café and résumé words."
    result = detector.detect_document_language(text)
    assert result['primary'] == 'en'
    assert result['confidence'] > 0.85

def test_chinese_with_english_technical_terms():
    text = "这是一个技术文档 about Machine Learning and API endpoints 使用 Python 实现"
    result = detector.detect_document_language(text)
    assert result['primary'] == 'zh'
    assert any(lang['lang'] == 'en' for lang in result['secondary'])

def test_mixed_arabic_english():
    text = "هذا مستند عربي with some English technical terms مثل API و Database"
    result = detector.detect_document_language(text)
    assert result['primary'] == 'ar'
    assert result['script'] == 'Arabic'
```

## Summary

**Key Features:**

- ✅ High accuracy for mixed-language content (multi-sample voting)
- ✅ Fast detection (< 100ms with caching)
- ✅ Handles foreign words in primary language
- ✅ Unicode script analysis as fallback
- ✅ Supports 50+ languages
- ✅ Explicit language override via API
- ✅ Secondary language detection
- ✅ Confidence scoring

**Models Used:**

1. **fasttext** - Fast first-pass (93% accuracy)
2. **lingua** - High accuracy definitive (99% accuracy)
3. **Unicode script** - Script-specific fallback (100% for CJK/Arabic)

**Integration:**

- Automatic detection in extraction pipeline
- Stored in document metadata
- Available for search filtering and query preprocessing
- Cacheable by content hash

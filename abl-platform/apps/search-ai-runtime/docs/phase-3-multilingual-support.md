# Phase 3: Multilingual Query Support Analysis

## Current State

**BGE-M3 Embeddings** already support 100+ languages:

```typescript
// From bge-m3-service README:
// Languages: 100+ (multilingual)
// Max sequence length: 8192 tokens
```

This means **vector search already works multilingually** ✅

But **preprocessing stages need language-specific handling**:

---

## Language Support by Component

### 1. Spell Correction

#### English-Only Libraries

**TypeScript:**

- ❌ `symspell` - English dictionary only by default
- ❌ `typo-js` - Hunspell dictionaries (can add languages manually)

**Python:**

- ❌ `symspellpy` - English by default
- ✅ `pyspellchecker` - Supports 20+ languages out of box

#### Multilingual Support

**TypeScript with Hunspell Dictionaries:**

```typescript
import SymSpell from 'symspell';

// Load language-specific dictionary
const language = detectLanguage(query); // 'en', 'es', 'fr', 'de', etc.

const dictPath = `./dictionaries/${language}.txt`;
await symSpell.loadDictionary(dictPath);

// Problem: Need dictionaries for each language
// Size: ~50MB per language * 20 languages = 1GB+ dictionaries
```

**Python with pyspellchecker:**

```python
from spellchecker import SpellChecker

# Auto-detect language and load dictionary
spell = SpellChecker(language='es')  # Spanish
misspelled = spell.unknown(['hola', 'munndo'])  # 'munndo' is misspelled

# Supports: en, es, de, fr, pt, ru, ar, lv, eu, nl, it, tr
# Size: ~10MB per language
```

**Winner: Python** (built-in multilingual support)

---

### 2. Synonym Expansion

#### English-Only

**TypeScript:**

- ❌ `natural` - WordNet is English-only
- ❌ `wink-nlp` - English-only

**Python:**

- ❌ `nltk.wordnet` - English-only
- ✅ `Open Multilingual Wordnet` - 30+ languages

#### Multilingual Support

**Python with OMW (Open Multilingual WordNet):**

```python
from nltk.corpus import wordnet as wn
import nltk
nltk.download('omw-1.4')  # Open Multilingual WordNet

# Get synonyms in Spanish
synsets = wn.synsets('computadora', lang='spa')
synonyms = [lemma.name() for syn in synsets for lemma in syn.lemmas('spa')]
# Result: ['computadora', 'ordenador', 'pc']

# Supported: 30+ languages (spa, fra, deu, jpn, zho, etc.)
```

**TypeScript Alternative:**

```typescript
// No good multilingual synonym library
// Would need to:
// 1. Build custom dictionaries per language
// 2. Use translation API + English WordNet (expensive, slow)
// 3. Skip synonym expansion for non-English (degraded experience)
```

**Winner: Python** (OMW provides 30+ languages)

---

### 3. Entity Extraction

#### Language-Agnostic Patterns

**Dates, Numbers, Emails, URLs** work across languages:

```typescript
// These patterns are language-agnostic:
const dates = /\d{4}-\d{2}-\d{2}/g; // ✅ Works globally
const numbers = /[><]=?\s*\d+/g; // ✅ Works globally
const emails = /\S+@\S+\.\S+/g; // ✅ Works globally
const currencies = /[$€£¥]\d+/g; // ✅ Works globally
```

**BUT text-based dates need language handling:**

```typescript
// English: "last week", "Q1 2024"
// Spanish: "la semana pasada", "T1 2024"
// French: "la semaine dernière", "T1 2024"
// German: "letzte Woche", "Q1 2024"
```

#### Multilingual NLP

**Python spaCy:**

```python
import spacy

# Load language-specific models
nlp_en = spacy.load("en_core_web_sm")   # English
nlp_es = spacy.load("es_core_news_sm")  # Spanish
nlp_de = spacy.load("de_core_news_sm")  # German

# Extract entities (works for any language)
doc = nlp_es("Apple compra startup española por 100 millones")
entities = [(ent.text, ent.label_) for ent in doc.ents]
# Result: [('Apple', 'ORG'), ('española', 'NORP'), ('100 millones', 'MONEY')]

# Supports: 20+ languages with pre-trained models
# Latency: 50-200ms (same issue - too slow)
```

**Winner: Python** (if using spaCy, but still too slow)

---

## Language Detection

### Required for Multilingual Preprocessing

**TypeScript:**

```typescript
import { franc } from 'franc';

const language = franc('This is an English text');
// Result: 'eng' (ISO 639-3 code)

// Supports: 400+ languages
// Accuracy: 95%+ for text > 50 chars
// Latency: < 1ms ✅
```

**Python:**

```python
from langdetect import detect

language = detect("Este es un texto en español")
# Result: 'es' (ISO 639-1 code)

# Supports: 55 languages
# Accuracy: 99%+ for text > 20 chars
# Latency: < 1ms ✅
```

**Winner: Tie** (both excellent)

---

## Multilingual Architecture Options

### Option 1: TypeScript with Basic Multilingual Support

**Approach:**

```typescript
// 1. Language detection (franc)
const language = detectLanguage(query);

// 2. Spell correction (English only, skip others)
if (language === 'eng') {
  processedQuery = await spellCorrect(query);
} else {
  // Skip spell correction for non-English
  processedQuery = query;
}

// 3. Synonym expansion (custom dictionaries)
const domainDict = await getDomainDictionary(tenantId, language);
processedQuery = expandWithCustomSynonyms(processedQuery, domainDict);
// No WordNet for non-English

// 4. Entity extraction (language-agnostic patterns)
const entities = extractEntities(processedQuery);
// Dates (ISO), numbers, emails, URLs work globally
```

**Coverage:**

- ✅ Language detection: All languages
- ⚠️ Spell correction: **English only**
- ⚠️ Synonym expansion: **Custom dictionaries only** (no WordNet)
- ✅ Entity extraction: **Numeric patterns work globally**
- ⚠️ Overall: **Degraded experience for non-English**

**Pros:**

- Simple implementation
- No Python dependency
- Low latency (3-7ms)

**Cons:**

- English-first experience
- Limited non-English support
- Requires custom dictionaries per language

---

### Option 2: Python Microservice with Full Multilingual Support

**Approach:**

```python
from langdetect import detect
from spellchecker import SpellChecker
from nltk.corpus import wordnet as wn
import nltk
nltk.download('omw-1.4')

def preprocess(query: str, tenant_id: str):
    # 1. Language detection
    language = detect(query)
    lang_map = {'en': 'eng', 'es': 'spa', 'fr': 'fra', 'de': 'deu'}

    # 2. Spell correction (20+ languages)
    spell = SpellChecker(language=language)
    corrected = correct_spelling(query, spell)

    # 3. Synonym expansion (30+ languages via OMW)
    if language in lang_map:
        expanded = expand_synonyms(corrected, lang=lang_map[language])
    else:
        expanded = corrected

    # 4. Entity extraction (language-agnostic patterns + custom)
    entities = extract_entities(expanded, language)

    return {
        'processedQuery': expanded,
        'language': language,
        'entities': entities
    }
```

**Coverage:**

- ✅ Language detection: 55 languages
- ✅ Spell correction: **20+ languages**
- ✅ Synonym expansion: **30+ languages** (OMW)
- ✅ Entity extraction: **Patterns work globally**
- ✅ Overall: **Excellent multilingual support**

**Pros:**

- Full multilingual support (20-30 languages)
- Consistent experience across languages
- Can upgrade to spaCy for NER if needed

**Cons:**

- Python microservice complexity
- 3-6ms network overhead
- Need to manage models per language

---

### Option 3: Hybrid - TypeScript + Optional Python for Non-English

**Approach:**

```typescript
async function preprocess(query: string, tenantId: string): Promise<PreprocessedQuery> {
  // 1. Detect language
  const language = detectLanguage(query);

  // 2. Route based on language
  if (language === 'eng') {
    // TypeScript preprocessing (fast, local)
    return await typescriptPreprocessor.preprocess(query);
  } else {
    // Python microservice (multilingual support)
    return await fetch('http://preprocessing-service:8003/v1/preprocess', {
      method: 'POST',
      body: JSON.stringify({ query, language, tenantId }),
    });
  }
}
```

**Coverage:**

- ✅ English: TypeScript (3-7ms)
- ✅ Non-English: Python (4-8ms)
- ✅ Best of both worlds

**Pros:**

- Optimal for English (majority of queries)
- Full multilingual support when needed
- Can measure actual non-English traffic

**Cons:**

- Two implementations to maintain
- Complexity of dual system

---

## Recommendation: Depends on User Base

### If Users are Primarily English ✅

**Use: TypeScript Only (Option 1)**

**Rationale:**

- 80-90% of queries are English (typical for tech)
- Simple implementation
- Low latency (3-7ms)
- Can add custom dictionaries for key non-English terms

**Non-English Strategy:**

```typescript
// 1. Skip spell correction for non-English (acceptable trade-off)
// 2. Use tenant domain dictionaries (all languages)
// 3. Entity extraction works globally (numbers, dates, emails)
// 4. Vector search is multilingual (BGE-M3 handles it)

// Result: 70-80% of preprocessing benefits for non-English
```

---

### If Users are Multilingual 🌍

**Use: Python Microservice (Option 2)**

**Rationale:**

- Need consistent experience across languages
- Spell correction matters for all languages
- Synonym expansion improves recall globally
- Worth the 3-6ms network overhead

**Implementation:**

```
services/preprocessing-service/
├── app.py                   # Flask app
├── requirements.txt
│   ├── langdetect           # Language detection
│   ├── pyspellchecker       # 20+ languages
│   ├── nltk                 # OMW for synonyms
│   └── dateutil             # Date parsing
├── dictionaries/
│   ├── en_US.txt            # English
│   ├── es_ES.txt            # Spanish
│   ├── fr_FR.txt            # French
│   └── de_DE.txt            # German
└── Dockerfile
```

**API:**

```python
@app.route('/v1/preprocess', methods=['POST'])
def preprocess():
    data = request.json
    query = data['query']
    tenant_id = data['tenantId']

    # Auto-detect language
    language = detect(query)

    # Process with language-specific tools
    result = process_multilingual(query, language, tenant_id)

    return jsonify(result)
```

---

### Hybrid Approach (Recommended for Production) 🎯

**Use: TypeScript + Python Fallback (Option 3)**

**Rationale:**

- Optimize for majority case (English)
- Support minority case (non-English) without compromise
- Measure actual non-English traffic before over-investing

**Implementation:**

```typescript
const ENABLE_MULTILINGUAL = env('ENABLE_MULTILINGUAL', 'true') === 'true';

async function preprocess(query: string, config: PreprocessConfig) {
  const language = detectLanguage(query);

  // Fast path for English (80-90% of queries)
  if (language === 'eng') {
    return await typescriptPreprocessor.preprocess(query, config);
  }

  // Multilingual path (10-20% of queries)
  if (ENABLE_MULTILINGUAL) {
    return await pythonPreprocessor.preprocess(query, language, config);
  } else {
    // Fallback: basic preprocessing without spell/synonym
    return await basicPreprocessor.preprocess(query, config);
  }
}
```

---

## Language Support Matrix

| Language     | Spell Correction | Synonym Expansion | Entity Extraction | TypeScript | Python  |
| ------------ | ---------------- | ----------------- | ----------------- | ---------- | ------- |
| **English**  | ✅ Excellent     | ✅ WordNet        | ✅ All patterns   | ✅ Full    | ✅ Full |
| **Spanish**  | ❌ None          | ❌ None           | ✅ Numbers/dates  | ⚠️ Basic   | ✅ Full |
| **French**   | ❌ None          | ❌ None           | ✅ Numbers/dates  | ⚠️ Basic   | ✅ Full |
| **German**   | ❌ None          | ❌ None           | ✅ Numbers/dates  | ⚠️ Basic   | ✅ Full |
| **Chinese**  | ❌ None          | ❌ None           | ✅ Numbers/dates  | ⚠️ Basic   | ✅ Full |
| **Japanese** | ❌ None          | ❌ None           | ✅ Numbers/dates  | ⚠️ Basic   | ✅ Full |

**TypeScript = English-first**
**Python = Truly multilingual**

---

## Domain Dictionaries for Multilingual

**Solution works for both approaches:**

```typescript
interface MultilingualDomainDictionary {
  tenantId: string;

  // Per-language abbreviations
  abbreviations: {
    en: { k8s: 'kubernetes'; ml: 'machine learning' };
    es: { ia: 'inteligencia artificial'; bd: 'base de datos' };
    fr: { ia: 'intelligence artificielle'; bd: 'base de données' };
    de: { ki: 'künstliche intelligenz'; db: 'datenbank' };
  };

  // Per-language synonyms
  synonyms: {
    en: { deploy: ['release', 'rollout'] };
    es: { desplegar: ['publicar', 'lanzar'] };
    fr: { déployer: ['publier', 'lancer'] };
  };

  // Entity patterns (language-agnostic)
  entityPatterns: [{ name: 'sku'; pattern: '[A-Z]{2,4}-\\d{4,8}'; type: 'product_sku' }];
}
```

**Usage:**

```typescript
const language = detectLanguage(query);
const domainDict = await getDomainDictionary(tenantId);

// Use language-specific abbreviations
const abbreviations = domainDict.abbreviations[language] || {};
const synonyms = domainDict.synonyms[language] || {};
```

---

## Final Recommendation

### 🎯 Start: TypeScript with English Focus

**Phase 1 (MVP):**

```typescript
// TypeScript preprocessing
// - Spell correction: English only
// - Synonym expansion: Custom dictionaries (all languages)
// - Entity extraction: Language-agnostic patterns
// - Domain dictionaries: Multilingual support

// Coverage: 100% for English, 60% for others
// Latency: 3-7ms
```

### 🌍 Add: Python for Multilingual (if needed)

**Phase 2 (If non-English usage > 20%):**

```python
# Python microservice
# - Spell correction: 20+ languages
# - Synonym expansion: 30+ languages (OMW)
# - Entity extraction: Language-agnostic + spaCy

# Coverage: 90%+ for all languages
# Latency: 4-8ms (with network)
```

### 📊 Measure First, Optimize Later

**Metrics to track:**

```typescript
// After Phase 1 deployment, measure:
1. Language distribution (% English vs others)
2. Non-English query quality (user feedback)
3. Missed entities/typos in non-English queries

// IF non-English is significant AND quality is poor:
// THEN invest in Python microservice

// OTHERWISE: Stay with TypeScript
```

---

## Summary

| Approach                | English Support | Non-English Support | Latency | Complexity | Recommendation             |
| ----------------------- | --------------- | ------------------- | ------- | ---------- | -------------------------- |
| **TypeScript Only**     | ✅ Excellent    | ⚠️ Basic            | 3-7ms   | Low        | ✅ If English > 80%        |
| **Python Microservice** | ✅ Excellent    | ✅ Excellent        | 4-8ms   | Medium     | ✅ If multilingual         |
| **Hybrid**              | ✅ Excellent    | ✅ Excellent        | 3-8ms   | High       | ✅ For production at scale |

**Start with TypeScript, measure language distribution, add Python if needed.**

**Key Insight:** BGE-M3 embeddings already handle 100+ languages for vector search. Preprocessing is an enhancement, not a requirement. Even basic preprocessing (entity extraction only) provides value for non-English queries.

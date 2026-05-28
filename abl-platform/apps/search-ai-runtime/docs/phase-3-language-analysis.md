# Phase 3: Language & Dependency Analysis

## Language Suitability Analysis

### Current Design (TypeScript/Node.js)

| Component               | TypeScript Libraries | Python Alternative | Go Alternative  | Recommendation    |
| ----------------------- | -------------------- | ------------------ | --------------- | ----------------- |
| **Spell Correction**    | `symspell` (npm)     | `symspellpy`       | `go-symspell`   | ✅ **TypeScript** |
| **Synonym Expansion**   | `wordnet` (npm)      | `nltk.wordnet`     | Limited support | ✅ **TypeScript** |
| **Entity Extraction**   | Regex (built-in)     | Regex/SpaCy        | Regex           | ✅ **TypeScript** |
| **Complexity Analysis** | Pure JS/TS           | Pure Python        | Pure Go         | ✅ **TypeScript** |

### Performance Comparison

#### SymSpell Performance

```
Language    Library          Lookup Time    Memory      Notes
──────────────────────────────────────────────────────────────
TypeScript  symspell         0.1-0.5ms      ~50MB       ✅ Good
Python      symspellpy       0.08-0.4ms     ~50MB       Slightly faster
Go          go-symspell      0.05-0.3ms     ~40MB       Fastest (but marginal)
```

**Verdict:** TypeScript is sufficient. 0.1ms difference doesn't justify polyglot complexity.

#### WordNet Performance

```
Language    Library          Lookup Time    Memory      Notes
──────────────────────────────────────────────────────────────
TypeScript  wordnet          1-2ms          ~30MB       ✅ Adequate
Python      nltk.wordnet     0.5-1.5ms      ~40MB       Faster but needs NLTK
Go          N/A              N/A            N/A         No mature library
```

**Verdict:** TypeScript is fine. Python NLTK is overkill for simple synonym lookup.

---

## When to Use Python?

### ✅ Use Python IF You Need:

1. **Advanced NLP Models**

   ```python
   # SpaCy for sophisticated entity extraction
   import spacy
   nlp = spacy.load("en_core_web_sm")
   doc = nlp("Apple is looking at buying U.K. startup for $1 billion")

   # Extracts: ORG (Apple), GPE (U.K.), MONEY ($1 billion)
   # Accuracy: 90%+ for named entities
   # Latency: 50-200ms per query ❌ TOO SLOW
   ```

2. **Semantic Similarity**

   ```python
   # Sentence transformers for semantic matching
   from sentence_transformers import SentenceTransformer
   model = SentenceTransformer('all-MiniLM-L6-v2')

   similarity = model.encode(["kubernetes", "k8s"]).cosine_similarity()
   # Accuracy: Very high
   # Latency: 20-50ms per comparison ❌ TOO SLOW
   ```

3. **ML-Based Complexity Scoring**

   ```python
   # Train ML model on historical query complexity
   from sklearn.ensemble import RandomForestClassifier
   model.fit(X_train, y_train)
   complexity = model.predict(query_features)

   # Accuracy: 85%+ with training data
   # Latency: 5-10ms ⚠️ Acceptable but adds complexity
   ```

### ❌ Don't Use Python For:

1. **Dictionary Lookups** - TypeScript is equally fast
2. **Regex Patterns** - Available everywhere
3. **Simple Heuristics** - No advantage
4. **High-Frequency Operations** - Node.js event loop is better

---

## When to Use Go?

### ✅ Use Go IF You Need:

1. **CPU-Intensive Operations**

   ```go
   // Parallel spell checking across large corpus
   func checkSpelling(words []string) []Correction {
       results := make(chan Correction, len(words))
       for _, word := range words {
           go func(w string) {
               results <- symspell.Lookup(w)
           }(word)
       }
       // 3-5x faster than single-threaded
   }
   ```

   **Verdict:** Not needed - our queries are small (< 100 words)

2. **Memory-Constrained Environments**

   ```go
   // Go's efficient memory model
   // Memory usage: ~40MB vs ~70MB for Node.js
   ```

   **Verdict:** Not a constraint for us

3. **High-Throughput Microservices**
   ```go
   // Go can handle 50K+ req/s with low latency
   // Node.js: 10K-20K req/s (still sufficient for our scale)
   ```
   **Verdict:** Not needed at current scale

---

## Recommendation: **Stay with TypeScript**

### Why TypeScript is Optimal:

1. **Codebase Consistency** ✅
   - Entire `search-ai-runtime` is TypeScript
   - No polyglot maintenance overhead
   - Easier debugging and deployment

2. **Adequate Performance** ✅
   - SymSpell TypeScript: 0.1-0.5ms (target: < 10ms) ✅
   - WordNet TypeScript: 1-2ms (target: < 15ms) ✅
   - Regex: Near-instant (target: < 20ms) ✅
   - Total: 2-5ms preprocessing overhead ✅

3. **Library Ecosystem** ✅
   - `symspell`: Well-maintained, 100K+ downloads/month
   - `wordnet`: Stable, 20K+ downloads/month
   - Both have TypeScript support

4. **Integration Simplicity** ✅
   - No IPC overhead (Python subprocess or Go gRPC)
   - No serialization/deserialization
   - Direct function calls

5. **Deployment Simplicity** ✅
   - Single Docker image
   - No language runtime dependencies
   - Easier CI/CD

### When to Reconsider:

**Switch to Python IF:**

- Entity extraction accuracy < 80% with regex
- Need semantic similarity for synonym expansion
- ML-based complexity scoring shows 20%+ improvement

**Switch to Go IF:**

- Preprocessing latency consistently > 100ms
- Memory usage becomes critical (> 500MB)
- Need to process 100K+ queries/second

**Current Scale:** ~100-1000 QPS → TypeScript is perfectly adequate

---

## Domain Terms & Shortcuts Management

### Problem Statement

Users have domain-specific abbreviations that need handling:

```
Tech Domain:
  k8s → kubernetes
  ml/ai → machine learning, artificial intelligence
  ci/cd → continuous integration, continuous deployment

E-commerce:
  oos → out of stock
  sku → stock keeping unit
  b2b/b2c → business-to-business, business-to-consumer

Healthcare:
  rx → prescription
  ehr → electronic health record
  icd → international classification of diseases
```

### Solution Architecture

#### 1. **Tenant-Specific Domain Dictionaries**

```typescript
/**
 * Domain dictionary service for managing tenant-specific terms
 */
export class DomainDictionaryService {
  private cache = new Map<string, TenantDictionary>();

  /**
   * Get domain dictionary for a tenant
   */
  async getDictionary(tenantId: string): Promise<TenantDictionary> {
    // Check cache
    if (this.cache.has(tenantId)) {
      return this.cache.get(tenantId)!;
    }

    // Load from database
    const dictionary = await this.loadFromDB(tenantId);
    this.cache.set(tenantId, dictionary);

    return dictionary;
  }

  private async loadFromDB(tenantId: string): Promise<TenantDictionary> {
    const record = await prisma.domainDictionary.findUnique({
      where: { tenantId },
    });

    return {
      tenantId,
      spellingCorrections: new Map(record?.spellingCorrections || []),
      synonyms: new Map(record?.synonyms || []),
      abbreviations: new Map(record?.abbreviations || []),
      entityPatterns: record?.entityPatterns || [],
    };
  }
}

export interface TenantDictionary {
  tenantId: string;

  // Spell correction overrides
  spellingCorrections: Map<string, string>;
  // Example: { "kubes": "kubernetes" }

  // Synonym expansion
  synonyms: Map<string, string[]>;
  // Example: { "k8s": ["kubernetes", "container orchestration"] }

  // Abbreviation expansion (prioritized over general synonyms)
  abbreviations: Map<string, string>;
  // Example: { "ml": "machine learning", "ai": "artificial intelligence" }

  // Custom entity patterns
  entityPatterns: EntityPattern[];
  // Example: Product SKU pattern for e-commerce
}
```

#### 2. **Pre-built Domain Templates**

```typescript
/**
 * Pre-built domain templates for common industries
 */
export const DOMAIN_TEMPLATES: Record<string, DomainTemplate> = {
  'tech-devops': {
    name: 'Technology & DevOps',
    abbreviations: {
      k8s: 'kubernetes',
      'ci/cd': 'continuous integration continuous deployment',
      ml: 'machine learning',
      ai: 'artificial intelligence',
      api: 'application programming interface',
      sdk: 'software development kit',
      ide: 'integrated development environment',
      db: 'database',
      orm: 'object relational mapping',
      cdn: 'content delivery network',
    },
    synonyms: {
      kubernetes: ['k8s', 'container orchestration', 'k8s cluster'],
      docker: ['container', 'containerization'],
      deploy: ['release', 'rollout', 'publish'],
      monitor: ['observe', 'track', 'watch'],
    },
    entityPatterns: [
      {
        name: 'git_sha',
        pattern: /\b[0-9a-f]{7,40}\b/gi,
        type: 'commit_hash',
      },
      {
        name: 'semver',
        pattern: /\bv?\d+\.\d+\.\d+(?:-[a-z0-9]+)?/gi,
        type: 'version',
      },
    ],
  },

  ecommerce: {
    name: 'E-commerce & Retail',
    abbreviations: {
      oos: 'out of stock',
      sku: 'stock keeping unit',
      b2b: 'business to business',
      b2c: 'business to consumer',
      rma: 'return merchandise authorization',
      aov: 'average order value',
      cac: 'customer acquisition cost',
    },
    synonyms: {
      buy: ['purchase', 'order', 'checkout'],
      cheap: ['affordable', 'budget', 'discount', 'sale'],
      expensive: ['premium', 'luxury', 'high-end'],
    },
    entityPatterns: [
      {
        name: 'sku_pattern',
        pattern: /\b[A-Z]{2,4}-\d{4,8}\b/g,
        type: 'product_sku',
      },
      {
        name: 'order_id',
        pattern: /\bORD-\d{6,10}\b/g,
        type: 'order_id',
      },
    ],
  },

  healthcare: {
    name: 'Healthcare & Medical',
    abbreviations: {
      rx: 'prescription',
      dx: 'diagnosis',
      tx: 'treatment',
      ehr: 'electronic health record',
      icd: 'international classification of diseases',
      cpt: 'current procedural terminology',
      hmo: 'health maintenance organization',
    },
    synonyms: {
      doctor: ['physician', 'provider', 'practitioner'],
      patient: ['individual', 'case', 'subject'],
      medicine: ['medication', 'drug', 'pharmaceutical'],
    },
    entityPatterns: [
      {
        name: 'icd_code',
        pattern: /\b[A-Z]\d{2}(?:\.\d{1,3})?\b/g,
        type: 'icd_code',
      },
    ],
  },

  finance: {
    name: 'Finance & Banking',
    abbreviations: {
      apy: 'annual percentage yield',
      apr: 'annual percentage rate',
      roi: 'return on investment',
      etf: 'exchange traded fund',
      ach: 'automated clearing house',
      kyc: 'know your customer',
      aml: 'anti money laundering',
    },
    synonyms: {
      invest: ['allocate', 'deploy capital', 'put money'],
      profit: ['return', 'gain', 'earnings'],
    },
    entityPatterns: [],
  },
};
```

#### 3. **Management API**

```typescript
/**
 * API endpoints for managing domain dictionaries
 */

// POST /api/tenants/:tenantId/domain-dictionary
// Apply a domain template
app.post('/api/tenants/:tenantId/domain-dictionary', async (req, res) => {
  const { tenantId } = req.params;
  const { templateId, customTerms } = req.body;

  // Load template
  const template = DOMAIN_TEMPLATES[templateId];
  if (!template) {
    return res.status(400).json({ error: 'Invalid template' });
  }

  // Merge with custom terms
  const dictionary = {
    ...template,
    ...customTerms,
  };

  // Save to database
  await prisma.domainDictionary.upsert({
    where: { tenantId },
    create: { tenantId, ...dictionary },
    update: dictionary,
  });

  res.json({ success: true });
});

// PATCH /api/tenants/:tenantId/domain-dictionary/abbreviations
// Add custom abbreviation
app.patch('/api/tenants/:tenantId/domain-dictionary/abbreviations', async (req, res) => {
  const { tenantId } = req.params;
  const { abbreviation, expansion } = req.body;

  await prisma.domainDictionary.update({
    where: { tenantId },
    data: {
      abbreviations: {
        [abbreviation]: expansion,
      },
    },
  });

  // Invalidate cache
  domainDictionaryService.invalidateCache(tenantId);

  res.json({ success: true });
});

// GET /api/tenants/:tenantId/domain-dictionary
// Retrieve current dictionary
app.get('/api/tenants/:tenantId/domain-dictionary', async (req, res) => {
  const dictionary = await domainDictionaryService.getDictionary(req.params.tenantId);
  res.json(dictionary);
});
```

#### 4. **Integration with Preprocessing**

```typescript
/**
 * Updated preprocessing stages to use domain dictionaries
 */

// Spell Correction Stage
async process(input: StageInput): Promise<StageOutput> {
  // Load tenant dictionary
  const dictionary = await this.domainDictService.getDictionary(input.tenantId);

  // Check tenant spelling corrections first
  if (dictionary.spellingCorrections.has(token.toLowerCase())) {
    const corrected = dictionary.spellingCorrections.get(token.toLowerCase())!;
    corrections.push({ original: token, corrected, source: 'tenant_dict' });
    continue;
  }

  // Fall back to SymSpell
  // ...
}

// Synonym Expansion Stage
async process(input: StageInput): Promise<StageOutput> {
  const dictionary = await this.domainDictService.getDictionary(input.tenantId);

  // Check abbreviations first (highest priority)
  if (dictionary.abbreviations.has(term.toLowerCase())) {
    const expansion = dictionary.abbreviations.get(term.toLowerCase())!;
    expansions.push({ term, synonyms: [expansion], source: 'abbreviation' });
    continue;
  }

  // Check tenant synonyms
  if (dictionary.synonyms.has(term.toLowerCase())) {
    const synonyms = dictionary.synonyms.get(term.toLowerCase())!;
    expansions.push({ term, synonyms, source: 'tenant_dict' });
    continue;
  }

  // Fall back to WordNet
  // ...
}

// Entity Extraction Stage
async process(input: StageInput): Promise<StageOutput> {
  const dictionary = await this.domainDictService.getDictionary(input.tenantId);

  // Add tenant-specific entity patterns
  const patterns = [...this.builtInPatterns, ...dictionary.entityPatterns];

  // Extract entities using combined patterns
  // ...
}
```

#### 5. **Studio UI for Dictionary Management**

```typescript
// apps/studio/src/pages/settings/domain-dictionary.tsx

export default function DomainDictionarySettings() {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [abbreviations, setAbbreviations] = useState<Map<string, string>>(new Map());

  return (
    <div>
      <h2>Domain Dictionary</h2>

      {/* Template Selection */}
      <section>
        <h3>Apply Domain Template</h3>
        <Select value={selectedTemplate} onChange={setSelectedTemplate}>
          <option value="tech-devops">Technology & DevOps</option>
          <option value="ecommerce">E-commerce & Retail</option>
          <option value="healthcare">Healthcare & Medical</option>
          <option value="finance">Finance & Banking</option>
        </Select>
        <Button onClick={() => applyTemplate(selectedTemplate)}>
          Apply Template
        </Button>
      </section>

      {/* Custom Abbreviations */}
      <section>
        <h3>Custom Abbreviations</h3>
        <Table>
          <thead>
            <tr>
              <th>Abbreviation</th>
              <th>Full Term</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {Array.from(abbreviations).map(([abbr, full]) => (
              <tr key={abbr}>
                <td><code>{abbr}</code></td>
                <td>{full}</td>
                <td>
                  <Button variant="ghost" onClick={() => removeAbbr(abbr)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>

        <AddAbbreviationForm onAdd={(abbr, full) => addAbbreviation(abbr, full)} />
      </section>

      {/* Custom Synonyms */}
      <section>
        <h3>Custom Synonyms</h3>
        {/* Similar UI for synonyms */}
      </section>

      {/* Custom Entity Patterns */}
      <section>
        <h3>Custom Entity Patterns</h3>
        <p>Add regex patterns for domain-specific entities (e.g., product SKUs)</p>
        {/* Pattern editor UI */}
      </section>
    </div>
  );
}
```

#### 6. **Database Schema**

```prisma
model DomainDictionary {
  id        String   @id @default(cuid())
  tenantId  String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Domain template applied (if any)
  templateId String?

  // Custom spelling corrections
  spellingCorrections Json @default("{}")
  // Format: { "kubes": "kubernetes" }

  // Custom synonyms
  synonyms Json @default("{}")
  // Format: { "k8s": ["kubernetes", "container orchestration"] }

  // Abbreviation expansions
  abbreviations Json @default("{}")
  // Format: { "ml": "machine learning" }

  // Custom entity patterns
  entityPatterns Json @default("[]")
  // Format: [{ name: "sku", pattern: "...", type: "product_sku" }]

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
}
```

---

## Performance Optimization: Caching Strategy

```typescript
/**
 * Multi-layer caching for domain dictionaries
 */
export class DomainDictionaryService {
  // Layer 1: In-memory cache (per-runtime instance)
  private memoryCache = new Map<string, TenantDictionary>();

  // Layer 2: Redis cache (shared across instances)
  private redis: Redis;

  async getDictionary(tenantId: string): Promise<TenantDictionary> {
    // Check memory cache (fastest)
    if (this.memoryCache.has(tenantId)) {
      return this.memoryCache.get(tenantId)!;
    }

    // Check Redis cache (fast)
    const cached = await this.redis.get(`domain_dict:${tenantId}`);
    if (cached) {
      const dictionary = JSON.parse(cached);
      this.memoryCache.set(tenantId, dictionary);
      return dictionary;
    }

    // Load from database (slowest)
    const dictionary = await this.loadFromDB(tenantId);

    // Populate caches
    await this.redis.setex(
      `domain_dict:${tenantId}`,
      3600, // 1 hour TTL
      JSON.stringify(dictionary),
    );
    this.memoryCache.set(tenantId, dictionary);

    return dictionary;
  }

  invalidateCache(tenantId: string): void {
    this.memoryCache.delete(tenantId);
    this.redis.del(`domain_dict:${tenantId}`);
  }
}
```

**Lookup Performance:**

- Memory cache hit: ~0.01ms
- Redis cache hit: ~1-2ms
- Database load: ~10-20ms (cold start only)
- **Average: < 0.1ms** (99% memory cache hit rate)

---

## Summary & Recommendations

### ✅ Stay with TypeScript

- Adequate performance for all components
- No polyglot complexity
- Easier maintenance and deployment

### ✅ Domain Dictionary System

- **Tenant-specific customization** (abbreviations, synonyms, entity patterns)
- **Pre-built templates** (tech, e-commerce, healthcare, finance)
- **Management API + Studio UI** for easy configuration
- **Multi-layer caching** for < 0.1ms lookup

### 🎯 Implementation Priority

1. **Phase 3.1-3.4:** Implement preprocessing with TypeScript
2. **Phase 3.5:** Add domain dictionary service
3. **Phase 3.6-3.7:** Implement adaptive pipeline
4. **Phase 3.8-3.9:** Test and deploy

### 🔄 Future Optimization Path

**IF** TypeScript performance becomes insufficient:

1. Profile to identify bottleneck (likely entity extraction if anything)
2. Consider Python microservice for **ONLY** that component
3. Communicate via gRPC with < 5ms overhead
4. But **don't prematurely optimize** - TypeScript should be fine

---

**Recommendation: Proceed with TypeScript implementation + domain dictionary system.**

# Design: Domain-Aware Knowledge Graph with Product Disambiguation

> **Status**: Design Phase — Stage-by-Stage Implementation
> **Date**: 2026-02-24
> **Authors**: Bharath (Product), Claude Opus 4.6 (Design)
> **Related Tasks**: Task #52 (Enhance Knowledge Graph with API Endpoints)

---

## Executive Summary

### The Core Problem

When building knowledge graphs from customer documents, **similar but distinct products get incorrectly linked**, causing false relationships that harm query accuracy.

**Real-World Example (Banking)**:

- User asks: "What is the interest rate on my **debit card**?"
- **Wrong Answer** (current system): Shows credit card APR (15-30%)
- **Right Answer**: "Debit cards don't have interest rates. They withdraw directly from your account."

**Why This Happens**:

- Both "credit card" and "debit card" contain the word "card"
- Both appear in banking documents together
- Generic entity extraction treats them as related
- Co-occurrence analysis links them incorrectly

**Impact**: Customers get wrong information, trust erodes, support tickets increase.

---

### The Solution

**Domain-Aware Knowledge Graph Extraction** using:

1. **Default Domain Definitions** — Pre-built vocabularies for 6 common industries (banking, manufacturing, pharma, CPG, software, financial services)
2. **Customer Organization Profile** — Customer-provided MD file describing their specific products, hierarchies, and disambiguation rules
3. **LLM-Based Contextual Extraction** — Send domain definitions + customer profile + document text directly to LLM (no pre-parsing)
4. **Product Scope Detection** — Classify documents by product scope before extraction
5. **Scoped Relationship Building** — Only build relationships within product scope boundaries

---

## Problem Statement (Detailed)

### User's Question (Critical Context)

> "How do we identify various departments? like credit card and debit cards both are credit card only but fraud report for credit card is different and debit card is different, also the interest rates and offers. similarly housing loan and personal loan are different the process to apply varies and bank store locators could be different. but both have common terms like cards and loans **how do we avoid these not required relation to answer interest rate of a credit card when asking for debit card** or to show offers and process similarly help user find best deal on credit cards with less interest rate etc."

**Translation**:

- **Credit Card** ≠ **Debit Card** (despite both containing "card")
- **Housing Loan** ≠ **Personal Loan** (despite both being "loans")
- Interest rates apply to credit cards and loans, but NOT to debit cards
- Application processes differ between housing loans and personal loans
- We must **prevent false relationships** that cross product boundaries

---

### Why Generic Knowledge Graphs Fail

**Generic Entity Extraction** (current implementation):

1. Extract entities: `credit_card`, `debit_card`, `interest_rate`, `fraud`
2. Co-occurrence analysis: `credit_card` and `debit_card` appear together frequently
3. Build relationship: `CREDIT_CARD --CO_OCCURS_WITH--> DEBIT_CARD`
4. Query time: "debit card interest rate" → returns credit card APR (wrong!)

**Root Causes**:

- No product taxonomy → treats all "cards" as equivalent
- No attribute scoping → doesn't know "interest_rate" only applies to credit cards
- No department boundaries → links products across unrelated divisions
- No context-aware extraction → doesn't tag entities with product scope

---

## Solution Architecture

### Design Principles

1. **Hierarchical Product Taxonomy** — Products organized in categories, departments, sub-departments
2. **Attribute Specificity Rules** — Define which attributes apply to which products
3. **Department Boundaries** — Explicit rules preventing cross-department relationships
4. **LLM-First Approach** — Send domain definitions + customer profile directly to LLM (no pre-parsing)
5. **Product Scope Classification** — Detect document product scope BEFORE entity extraction
6. **Scoped Entity Extraction** — Tag extracted entities with product context
7. **Constrained Relationship Building** — Only build relationships within scope boundaries

---

### Implementation Stages

## Stage 1: Domain Definition Input

### Stage 1A: Default Domain Definitions (System-Provided)

**Location**: `apps/search-ai/docs/knowledge-graph/domain-definitions/`

**Created Files**:

1. `banking.md` — Credit cards, debit cards, loans, accounts, investment products
2. `manufacturing.md` — Cables, wires, equipment, transformers, conduit
3. `pharma-lifesciences.md` — Prescription drugs, OTC, biologics, crop protection, animal health
4. `cpg-consumer-goods.md` — Food, pet food, personal care, household products
5. `software-b2b-saas.md` — Billing platforms, analytics, APIs, integrations
6. `financial-services.md` — Mutual funds, ETFs, retirement plans, advisory services

**Structure** (per domain definition):

```markdown
## Product Hierarchy

### 1. Category (Department)

#### 1.1 Product (Sub-department)

- Description
- Key Attributes (credit_limit, interest_rate, etc.)
- Identifier Patterns (CC-#######, DC-#######)
- Disambiguation Keywords (credit, debit, revolving, withdrawal)
- Standards Compliance

## Attribute Specificity Rules

### Attribute: interest_rate

- Applies to: credit_card, housing_loan, personal_loan
- Does NOT apply to: debit_card, checking_account
- Contextual Meanings: (per product)

## Department Boundaries

### Credit Card Division

- Excludes: debit_card, loans
- Reasoning: Credit vs direct withdrawal

## Common Entity Types

- CREDIT_CARD_ID: Pattern CC-#######
- DEBIT_CARD_ID: Pattern DC-#######

## Use Case Examples

### Use Case 1: Credit Card Interest Rate Inquiry

- Expected Behavior
- Avoid False Positives
```

**Usage**:

- **Tenant-specific overrides**: `config/knowledge-graph/domain-definitions/{tenantId}/banking.md` overrides default
- **Index-specific overrides**: `config/knowledge-graph/domain-definitions/{tenantId}/{indexId}/banking.md` overrides tenant default
- **Fallback chain**: Index-specific → Tenant-specific → System default

---

### Stage 1B: Customer Organization Profile (Customer-Provided)

**Template**: `apps/search-ai/docs/knowledge-graph/customer-organization-template.md`

**Customer Fills Out**:

1. **Company Overview** — Industry, markets, business model
2. **Product & Service Portfolio** — Categories, example products
3. **Product Disambiguation** — Critical! Explains how similar products differ
4. **Domain-Specific Terminology** — Acronyms, internal codes, industry terms
5. **Business Processes & Workflows** — Application processes, document types
6. **Regulatory & Compliance Context** — Regulatory bodies, standards
7. **Additional Context** — Unique attributes, common mistakes to avoid

**Example (Banking)**:

```markdown
### Product Disambiguation (Critical!)

#### Credit Card vs Debit Card

- **Credit Card**: Revolving credit, interest charges (APR), credit limit, rewards programs, affects credit score
- **Debit Card**: Direct withdrawal from account, no credit, daily ATM limits, no interest, no rewards
- **Key Distinction**: "credit", "APR", "rewards", "credit score" → Credit Card ONLY. "debit", "withdrawal", "checking account" → Debit Card ONLY.
- **DO NOT RELATE**: Credit card interest rates have NOTHING to do with debit card withdrawal limits.

#### Housing Loan vs Personal Loan

- **Housing Loan**: Long-term (15-30 years), secured by property, down payment required, lower interest rate (6-10%)
- **Personal Loan**: Short-term (1-5 years), unsecured, no collateral, higher interest rate (10-20%)
- **Key Distinction**: "mortgage", "property", "down payment", "LTV" → Housing Loan ONLY. "unsecured", "no collateral" → Personal Loan ONLY.
- **DO NOT RELATE**: Housing loan application process has NOTHING to do with personal loan application.
```

**Format**: Markdown (.md file)

- Customers write in **natural language** (human-readable descriptions)
- **No structured data required** — LLM parses the markdown directly
- **No parsing by traditional NLP** — send entire MD file to LLM as context

---

### Stage 1C: Configuration Model

```typescript
interface KnowledgeGraphConfig {
  // Default domain definition (system-provided)
  defaultDomain:
    | 'banking'
    | 'manufacturing'
    | 'pharma'
    | 'cpg'
    | 'software'
    | 'financial-services'
    | null;

  // Tenant-specific domain override (path to MD file)
  tenantDomainDefinition?: string; // e.g., "s3://config/kg/tenant123/banking.md"

  // Index-specific domain override (path to MD file)
  indexDomainDefinition?: string; // e.g., "s3://config/kg/tenant123/index456/banking.md"

  // Customer organization profile (uploaded by customer)
  customerOrgProfile: string; // e.g., "s3://config/kg/tenant123/nbb-bank-profile.md"

  // Resolution order (for multi-domain cases)
  domainResolutionOrder: string[]; // e.g., ["banking", "financial-services"]

  // Features
  enableProductScopeDetection: boolean; // Default: true
  enableAttributeScoping: boolean; // Default: true
  enableDepartmentBoundaries: boolean; // Default: true
  enableCoOccurrence: boolean; // Default: true (but scoped)
  minIdfThreshold: number; // Default: 0.3
}
```

---

## Stage 2: LLM-Based Domain Context Loading

### Design Decision: LLM-First, Not Parsing

**User Feedback**:

> "I believe we should not parse the MD file instead directly send to LLM only parse it if needed for traditional ML operations."

**Approach**:

1. **Load MD files** (default domain definition + customer org profile)
2. **Send entire MD content to LLM** as context (no pre-parsing)
3. **LLM extracts structured taxonomy** from natural language descriptions
4. **Cache LLM output** (parsed taxonomy) per tenant/index
5. **Only parse if needed** for traditional ML (regex entity extraction, IDF calculations)

---

### LLM Prompt for Domain Context Extraction

```typescript
interface DomainContextExtractionPrompt {
  systemPrompt: string;
  domainDefinitionMD: string; // Default domain MD (banking.md)
  customerOrgProfileMD: string; // Customer-provided profile
  task: 'extract_taxonomy' | 'detect_product_scope' | 'extract_entities' | 'build_relationships';
}

// Example prompt for taxonomy extraction
const TAXONOMY_EXTRACTION_PROMPT = `
You are a domain expert extracting product taxonomy from organizational documentation.

**Task**: Parse the domain definition and customer organization profile (both in markdown format) and extract a structured product taxonomy.

**Input**:
1. Default Domain Definition (markdown):
${domainDefinitionMD}

2. Customer Organization Profile (markdown):
${customerOrgProfileMD}

**Output Format** (JSON):
{
  "company": {
    "name": "National Bank of Bahrain",
    "industry": "Banking",
    "markets": ["Bahrain", "Saudi Arabia", "UAE"]
  },
  "productHierarchy": [
    {
      "category": "Cards",
      "department": "Card Services",
      "products": [
        {
          "name": "Credit Card",
          "subDepartment": "Credit Card Division",
          "description": "Revolving credit line with interest charges",
          "attributes": [
            {"name": "credit_limit", "applicableTo": ["credit_card"], "notApplicableTo": ["debit_card"]},
            {"name": "interest_rate", "applicableTo": ["credit_card"], "notApplicableTo": ["debit_card"]}
          ],
          "identifierPattern": {"pattern": "CC-#######", "regex": "CC-\\\\d{7}"},
          "disambiguationKeywords": ["credit", "revolving", "APR", "rewards", "credit score"]
        },
        {
          "name": "Debit Card",
          "subDepartment": "Debit Card Division",
          "description": "Direct withdrawal from checking/savings account",
          "attributes": [
            {"name": "daily_withdrawal_limit", "applicableTo": ["debit_card"], "notApplicableTo": ["credit_card"]}
          ],
          "identifierPattern": {"pattern": "DC-#######", "regex": "DC-\\\\d{7}"},
          "disambiguationKeywords": ["debit", "direct withdrawal", "ATM", "checking account"]
        }
      ]
    }
  ],
  "attributeRules": [
    {
      "attributeName": "interest_rate",
      "applicableTo": ["credit_card", "housing_loan", "personal_loan"],
      "notApplicableTo": ["debit_card", "checking_account", "savings_account"],
      "contextualMeaning": [
        {"productType": "credit_card", "meaning": "APR on revolving balance (15-30%)"},
        {"productType": "housing_loan", "meaning": "Mortgage rate (6-10%)"}
      ]
    }
  ],
  "departmentBoundaries": [
    {
      "department": "Credit Card Division",
      "excludes": ["debit_card", "housing_loan", "personal_loan"],
      "canRelate": ["rewards_programs", "credit_bureaus"],
      "reasoning": "Credit cards are revolving credit; debit cards are direct withdrawal; loans are structured repayment"
    }
  ]
}

**Instructions**:
- Extract ALL products mentioned in both documents
- Identify disambiguation keywords for similar products
- Define attribute applicability rules
- Map department boundaries
- If customer profile contradicts default definition, USE CUSTOMER PROFILE (it's more specific)
`;
```

---

### Caching Strategy

```typescript
interface DomainTaxonomyCache {
  key: string; // `{tenantId}:{indexId}:domain-taxonomy`
  value: DomainTaxonomy; // LLM-extracted taxonomy
  ttl: number; // 24 hours (taxonomy changes infrequently)
  invalidateOn: 'customer_profile_update' | 'domain_definition_update';
}

// Cache lookup
async function loadDomainTaxonomy(
  tenantId: string,
  indexId: string,
  config: KnowledgeGraphConfig,
): Promise<DomainTaxonomy> {
  const cacheKey = `${tenantId}:${indexId}:domain-taxonomy`;

  // Check cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Load MD files
  const defaultDomainMD = await loadDefaultDomainDefinition(config.defaultDomain);
  const customerOrgProfileMD = await loadFile(config.customerOrgProfile);

  // LLM extraction
  const taxonomy = await extractTaxonomyWithLLM({
    systemPrompt: TAXONOMY_EXTRACTION_PROMPT,
    domainDefinitionMD: defaultDomainMD,
    customerOrgProfileMD,
  });

  // Cache result (24 hours)
  await redis.set(cacheKey, JSON.stringify(taxonomy), 'EX', 86400);

  return taxonomy;
}
```

---

## Stage 3: Product Scope Detection (Document Classification)

### Purpose

**Before extracting entities**, classify the document by product scope to provide context for entity extraction.

### Approach

```typescript
interface ProductScopeDetectionResult {
  primaryProduct: string; // "credit_card", "debit_card", "housing_loan", etc.
  confidence: number; // 0.0 to 1.0
  secondaryProducts: string[]; // Other products mentioned (lower confidence)
  department: string; // "Card Services", "Lending Services", etc.
  subDepartment: string; // "Credit Card Division", "Mortgage Division", etc.
}

async function detectProductScope(
  chunkText: string,
  documentContext: { title?: string; type?: string; metadata?: any },
  taxonomy: DomainTaxonomy,
): Promise<ProductScopeDetectionResult> {
  const prompt = `
You are analyzing a document to determine which product or service it primarily discusses.

**Product Taxonomy** (from domain definition):
${JSON.stringify(taxonomy.productHierarchy, null, 2)}

**Document Context**:
- Title: ${documentContext.title || 'N/A'}
- Type: ${documentContext.type || 'N/A'}
- Metadata: ${JSON.stringify(documentContext.metadata || {})}

**Document Text** (chunk):
${chunkText}

**Task**: Determine the PRIMARY product this document discusses.

**Output Format** (JSON):
{
  "primaryProduct": "credit_card",
  "confidence": 0.95,
  "secondaryProducts": ["rewards_program"],
  "department": "Card Services",
  "subDepartment": "Credit Card Division",
  "reasoning": "Document discusses APR, credit limits, and revolving balance — all specific to credit cards, not debit cards."
}

**Instructions**:
- Use disambiguation keywords from taxonomy
- If document mentions "credit", "APR", "revolving", "rewards" → credit_card
- If document mentions "debit", "withdrawal", "checking account" → debit_card
- If ambiguous, set lower confidence and include secondaryProducts
- Return null if no clear product match
`;

  const response = await llm.complete({
    systemPrompt: 'You are a domain expert in product classification.',
    userPrompt: prompt,
    responseFormat: 'json',
    model: 'claude-3-5-haiku', // Fast model for classification
  });

  return JSON.parse(response.content);
}
```

---

### Document-Level Product Scope Storage

```typescript
// Store product scope on SearchDocument metadata
interface SearchDocument {
  _id: ObjectId;
  tenantId: string;
  indexId: string;
  metadata: {
    productScope?: {
      primaryProduct: string; // "credit_card"
      confidence: number; // 0.95
      secondaryProducts: string[]; // ["rewards_program"]
      department: string; // "Card Services"
      subDepartment: string; // "Credit Card Division"
      detectedAt: Date;
    };
    // ... other metadata
  };
}
```

---

## Stage 4: Context-Aware Entity Extraction

### Purpose

Extract entities from chunks **with product context**, tagging each entity with:

- Product type (credit_card, debit_card, etc.)
- In-scope match (does entity match document's product scope?)
- Confidence

### Approach

```typescript
interface ContextualEntity {
  text: string; // "15% APR"
  type: string; // "interest_rate"
  start: number; // Character offset
  end: number;
  productType: string; // "credit_card"
  context: {
    documentScope: string; // "credit_card" (from Stage 3)
    inScopeMatch: boolean; // true (entity matches document scope)
    confidence: number; // 0.95
  };
  extractionMethod: 'regex' | 'compromise' | 'llm';
}

async function extractEntitiesWithContext(
  chunkText: string,
  documentScope: ProductScopeDetectionResult,
  taxonomy: DomainTaxonomy,
): Promise<ContextualEntity[]> {
  const entities: ContextualEntity[] = [];

  // Step 1: Extract product-specific identifiers (regex)
  for (const product of taxonomy.productHierarchy.flatMap((cat) => cat.products)) {
    if (product.identifierPattern) {
      const pattern = new RegExp(product.identifierPattern.regex, 'g');
      let match;
      while ((match = pattern.exec(chunkText)) !== null) {
        entities.push({
          text: match[0],
          type: 'product_identifier',
          start: match.index,
          end: match.index + match[0].length,
          productType: product.name, // "credit_card"
          context: {
            documentScope: documentScope.primaryProduct,
            inScopeMatch: documentScope.primaryProduct === product.name,
            confidence: documentScope.confidence,
          },
          extractionMethod: 'regex',
        });
      }
    }
  }

  // Step 2: Extract attributes with scoping (LLM)
  const scopedAttributes = taxonomy.attributeRules.filter((rule) =>
    rule.applicableTo.includes(documentScope.primaryProduct),
  );

  const llmPrompt = `
You are extracting entities from a document about ${documentScope.primaryProduct}.

**Applicable Attributes** (for this product):
${scopedAttributes.map((attr) => `- ${attr.attributeName}: ${attr.contextualMeaning.find((cm) => cm.productType === documentScope.primaryProduct)?.meaning}`).join('\n')}

**NOT Applicable Attributes** (ignore these):
${taxonomy.attributeRules
  .filter((rule) => rule.notApplicableTo.includes(documentScope.primaryProduct))
  .map((r) => `- ${r.attributeName}`)
  .join('\n')}

**Document Text**:
${chunkText}

**Task**: Extract ONLY attributes applicable to ${documentScope.primaryProduct}. Ignore attributes for other products.

**Output Format** (JSON array):
[
  {"text": "15% APR", "type": "interest_rate", "start": 45, "end": 52},
  {"text": "$5,000 credit limit", "type": "credit_limit", "start": 78, "end": 97}
]
`;

  const llmEntities = await llm.complete({
    systemPrompt: 'You are an entity extraction expert.',
    userPrompt: llmPrompt,
    responseFormat: 'json',
    model: 'claude-3-5-haiku',
  });

  // Tag LLM entities with context
  for (const entity of JSON.parse(llmEntities.content)) {
    entities.push({
      ...entity,
      productType: documentScope.primaryProduct,
      context: {
        documentScope: documentScope.primaryProduct,
        inScopeMatch: true, // LLM extracted based on scope
        confidence: documentScope.confidence,
      },
      extractionMethod: 'llm',
    });
  }

  return entities;
}
```

---

### Chunk-Level Entity Storage

```typescript
// Store contextual entities on SearchChunk metadata
interface SearchChunk {
  _id: ObjectId;
  documentId: ObjectId;
  tenantId: string;
  indexId: string;
  content: string;
  metadata: {
    entities?: ContextualEntity[]; // With product context
    references?: ContextualReference[];
    entityIds?: string[]; // Neo4j entity IDs (if stored in graph)
    productScope?: string; // "credit_card" (inherited from document)
    // ... other metadata
  };
}
```

---

## Stage 5: Scoped Relationship Building

### Purpose

Build relationships ONLY between entities/documents that share product scope or have explicit department boundary permissions.

### Approach

```typescript
interface ScopedRelationship {
  fromDocument: ObjectId;
  toDocument: ObjectId;
  relationshipType: 'CO_OCCURS' | 'REFERENCES' | 'RELATED_PRODUCT';
  productScope: string; // "credit_card"
  scopeEnforced: boolean; // true (relationship was scope-checked)
  weight: number; // IDF weight or similarity score
  reasoning?: string; // Why relationship was allowed
}

async function buildScopedRelationships(
  documents: SearchDocument[],
  chunks: SearchChunk[],
  taxonomy: DomainTaxonomy,
  config: KnowledgeGraphConfig,
): Promise<ScopedRelationship[]> {
  const relationships: ScopedRelationship[] = [];

  // Group documents by product scope
  const docsByScope = documents.reduce(
    (acc, doc) => {
      const scope = doc.metadata?.productScope?.primaryProduct;
      if (scope) {
        acc[scope] = acc[scope] || [];
        acc[scope].push(doc);
      }
      return acc;
    },
    {} as Record<string, SearchDocument[]>,
  );

  // Build relationships WITHIN each product scope
  for (const [scope, scopeDocs] of Object.entries(docsByScope)) {
    // Co-occurrence analysis (scoped)
    for (let i = 0; i < scopeDocs.length; i++) {
      for (let j = i + 1; j < scopeDocs.length; j++) {
        const docA = scopeDocs[i];
        const docB = scopeDocs[j];

        // Extract in-scope entities only
        const entitiesA = await getInScopeEntities(docA, scope);
        const entitiesB = await getInScopeEntities(docB, scope);

        // Calculate similarity based on in-scope entities only
        const similarity = calculateEntitySimilarity(entitiesA, entitiesB, config);

        if (similarity.score > config.minIdfThreshold) {
          relationships.push({
            fromDocument: docA._id,
            toDocument: docB._id,
            relationshipType: 'CO_OCCURS',
            productScope: scope,
            scopeEnforced: true,
            weight: similarity.score,
            reasoning: `Documents share ${similarity.commonEntities.length} in-scope entities`,
          });
        }
      }
    }
  }

  // Cross-scope relationships (ONLY if department boundaries allow)
  if (config.enableDepartmentBoundaries) {
    for (const scopeA of Object.keys(docsByScope)) {
      for (const scopeB of Object.keys(docsByScope)) {
        if (scopeA === scopeB) continue; // Same scope, already handled above

        // Check department boundary
        const boundaryCheck = await checkDepartmentBoundary(scopeA, scopeB, taxonomy);

        if (!boundaryCheck.allowed) {
          console.log(
            `[KG] Skipping cross-scope relationship: ${scopeA} → ${scopeB} (${boundaryCheck.reason})`,
          );
          continue; // Skip false relationship
        }

        // Build cross-scope relationships (if allowed)
        for (const docA of docsByScope[scopeA]) {
          for (const docB of docsByScope[scopeB]) {
            const similarity = await calculateCrossScopeSimilarity(docA, docB, taxonomy);

            if (similarity.score > config.minIdfThreshold) {
              relationships.push({
                fromDocument: docA._id,
                toDocument: docB._id,
                relationshipType: 'RELATED_PRODUCT',
                productScope: `${scopeA}+${scopeB}`, // Cross-scope
                scopeEnforced: true,
                weight: similarity.score,
                reasoning:
                  boundaryCheck.reason || 'Cross-scope relationship allowed by department boundary',
              });
            }
          }
        }
      }
    }
  }

  return relationships;
}

// Department boundary check
async function checkDepartmentBoundary(
  productA: string,
  productB: string,
  taxonomy: DomainTaxonomy,
): Promise<{ allowed: boolean; reason: string }> {
  // Find product A's department boundaries
  const boundaryA = taxonomy.departmentBoundaries.find(
    (b) => b.department === getProductDepartment(productA, taxonomy),
  );

  if (!boundaryA) {
    return { allowed: true, reason: 'No boundary defined' };
  }

  // Check if productB is excluded
  if (boundaryA.excludes.includes(productB)) {
    return {
      allowed: false,
      reason: `${productA} department excludes ${productB}: ${boundaryA.reasoning}`,
    };
  }

  // Check if productB is explicitly allowed
  if (boundaryA.canRelate && boundaryA.canRelate.includes(productB)) {
    return {
      allowed: true,
      reason: `${productA} department allows ${productB}: ${boundaryA.reasoning}`,
    };
  }

  // Default: allow (no explicit exclusion)
  return { allowed: true, reason: 'No exclusion rule' };
}
```

---

### Neo4j Storage (Scoped)

```cypher
// Create document node with product scope
CREATE (d:Document {
  id: $documentId,
  tenantId: $tenantId,
  indexId: $indexId,
  productScope: $productScope, // "credit_card"
  department: $department, // "Card Services"
  subDepartment: $subDepartment // "Credit Card Division"
})

// Create entity node with product context
CREATE (e:Entity {
  id: $entityId,
  text: $entityText,
  type: $entityType, // "interest_rate"
  productType: $productType, // "credit_card"
  inScopeMatch: $inScopeMatch // true
})

// Create scoped relationship
MATCH (d1:Document {id: $docAId, productScope: $scope})
MATCH (d2:Document {id: $docBId, productScope: $scope})
CREATE (d1)-[r:CO_OCCURS {
  weight: $weight,
  productScope: $scope,
  scopeEnforced: true
}]->(d2)
```

---

## Stage 6: Query-Time Disambiguation

### Product Scope Detection in Queries

```typescript
async function detectQueryProductScope(
  query: string,
  taxonomy: DomainTaxonomy,
): Promise<ProductScopeDetectionResult | null> {
  const prompt = `
You are analyzing a user query to determine which product it asks about.

**Product Taxonomy**:
${JSON.stringify(taxonomy.productHierarchy, null, 2)}

**User Query**: "${query}"

**Task**: Determine which product the user is asking about.

**Output Format** (JSON):
{
  "primaryProduct": "credit_card",
  "confidence": 0.95,
  "reasoning": "Query mentions 'interest rate' which applies to credit cards (APR), not debit cards."
}

**Disambiguation Rules**:
- If query contains "interest rate" + "card" → Check for "credit" (credit card) vs "debit" (debit card, no interest)
- If query contains "interest rate" + "loan" → Check for "housing" (mortgage) vs "personal" (unsecured)
- If query contains "limit" + "card" → Check for "credit" (credit limit) vs "debit" (withdrawal limit)
- If query contains "application" + "loan" → Check for "housing" (property, down payment) vs "personal" (no collateral)

**Examples**:
- "What is the interest rate on my debit card?" → {"primaryProduct": "debit_card", "confidence": 0.9, "reasoning": "Trick question: debit cards don't have interest rates. User may be confused."}
- "What is the APR on credit cards?" → {"primaryProduct": "credit_card", "confidence": 0.95}
- "How do I apply for a housing loan?" → {"primaryProduct": "housing_loan", "confidence": 0.95}
`;

  const response = await llm.complete({
    systemPrompt: 'You are a query intent expert.',
    userPrompt: prompt,
    responseFormat: 'json',
    model: 'claude-3-5-haiku',
  });

  return JSON.parse(response.content);
}
```

---

### Scoped Retrieval Filter

```typescript
async function retrieveWithProductScopeFilter(
  query: string,
  tenantId: string,
  indexId: string,
  taxonomy: DomainTaxonomy,
  config: KnowledgeGraphConfig,
): Promise<SearchResult[]> {
  // Step 1: Detect query product scope
  const queryScope = await detectQueryProductScope(query, taxonomy);

  if (!queryScope) {
    // No clear product scope, use generic semantic search
    return await semanticSearch(query, tenantId, indexId);
  }

  // Step 2: Filter documents by product scope
  const scopeFilter = {
    'metadata.productScope.primaryProduct': queryScope.primaryProduct,
    // OR secondary products if confidence is lower
    ...(queryScope.confidence < 0.8 && {
      $or: [
        { 'metadata.productScope.primaryProduct': queryScope.primaryProduct },
        { 'metadata.productScope.secondaryProducts': { $in: [queryScope.primaryProduct] } },
      ],
    }),
  };

  // Step 3: Semantic search with scope filter
  const results = await semanticSearch(query, tenantId, indexId, {
    filter: scopeFilter,
    // Boost in-scope matches
    boostFunction: (doc: SearchDocument) => {
      if (doc.metadata?.productScope?.primaryProduct === queryScope.primaryProduct) {
        return 1.5; // 50% boost for exact product match
      }
      return 1.0;
    },
  });

  // Step 4: Filter out cross-scope relationships in graph traversal
  if (config.enableDepartmentBoundaries) {
    for (const result of results) {
      // Check if result's scope matches query scope
      const resultScope = result.document.metadata?.productScope?.primaryProduct;

      if (resultScope && resultScope !== queryScope.primaryProduct) {
        // Check department boundary
        const boundaryCheck = await checkDepartmentBoundary(
          queryScope.primaryProduct,
          resultScope,
          taxonomy,
        );

        if (!boundaryCheck.allowed) {
          // Remove result (false cross-scope match)
          result.relevanceScore *= 0.1; // Penalize heavily instead of removing
          result.metadata = result.metadata || {};
          result.metadata.scopeMismatch = true;
          result.metadata.scopeMismatchReason = boundaryCheck.reason;
        }
      }
    }
  }

  return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
}
```

---

### Error Handling & User Education

```typescript
// If query asks for attribute that doesn't apply to detected product
async function handleAttributeMismatch(
  query: string,
  queryScope: ProductScopeDetectionResult,
  taxonomy: DomainTaxonomy,
): Promise<string | null> {
  // Example: "What is the interest rate on my debit card?"
  // queryScope.primaryProduct = "debit_card"
  // query contains "interest rate"

  // Check if "interest_rate" applies to "debit_card"
  const attributeRule = taxonomy.attributeRules.find((r) => r.attributeName === 'interest_rate');

  if (attributeRule && attributeRule.notApplicableTo.includes(queryScope.primaryProduct)) {
    // Attribute doesn't apply!
    return `Debit cards don't have interest rates because they withdraw directly from your checking or savings account. Interest rates apply to credit cards (revolving credit) and loans. Did you mean to ask about credit cards?`;
  }

  return null; // No mismatch
}

// Example usage in query handler
const errorMessage = await handleAttributeMismatch(query, queryScope, taxonomy);
if (errorMessage) {
  return {
    success: false,
    error: {
      code: 'ATTRIBUTE_MISMATCH',
      message: errorMessage,
      suggestions: ['credit_card', 'housing_loan', 'personal_loan'], // Products where interest_rate applies
    },
  };
}
```

---

## Configuration & Deployment

### Index-Level Configuration

```typescript
// Per-index knowledge graph configuration
interface IndexKnowledgeGraphConfig {
  indexId: string;
  tenantId: string;

  // Domain selection
  defaultDomain: 'banking' | 'manufacturing' | 'pharma' | 'cpg' | 'software' | 'financial-services';

  // Customer organization profile (uploaded)
  customerOrgProfileUrl: string; // S3 URL or file path

  // Tenant-specific overrides (optional)
  tenantDomainDefinitionUrl?: string;
  indexDomainDefinitionUrl?: string;

  // Features
  features: {
    enableProductScopeDetection: boolean; // Default: true
    enableAttributeScoping: boolean; // Default: true
    enableDepartmentBoundaries: boolean; // Default: true
    enableCoOccurrence: boolean; // Default: true
    enableQueryDisambiguation: boolean; // Default: true
  };

  // Tuning
  minIdfThreshold: number; // Default: 0.3
  productScopeConfidenceThreshold: number; // Default: 0.7
}
```

---

### API Endpoints (Task #52)

```typescript
// POST /api/v1/knowledge-graph/configure
// Configure domain-aware knowledge graph for an index
interface ConfigureKGRequest {
  indexId: string;
  defaultDomain: string; // "banking"
  customerOrgProfile: File; // Uploaded MD file
  features?: Partial<KnowledgeGraphConfig['features']>;
}

// GET /api/v1/knowledge-graph/taxonomy/{indexId}
// Retrieve parsed domain taxonomy for an index
interface GetTaxonomyResponse {
  indexId: string;
  taxonomy: DomainTaxonomy;
  source: {
    defaultDomain: string;
    customerOrgProfile: string; // Filename
    lastParsedAt: Date;
  };
}

// POST /api/v1/knowledge-graph/query
// Query with product scope disambiguation
interface QueryWithDisambiguationRequest {
  indexId: string;
  query: string;
  enableDisambiguation?: boolean; // Default: true
}

interface QueryWithDisambiguationResponse {
  query: string;
  detectedScope?: {
    primaryProduct: string;
    confidence: number;
    reasoning: string;
  };
  results: SearchResult[];
  scopeMismatches?: {
    documentId: string;
    documentScope: string;
    reason: string;
  }[];
  attributeMismatch?: {
    message: string;
    suggestions: string[];
  };
}

// GET /api/v1/knowledge-graph/stats/{indexId}
// Knowledge graph statistics for an index
interface KGStatsResponse {
  indexId: string;
  totalDocuments: number;
  documentsWithProductScope: number;
  productScopeDistribution: Record<string, number>; // "credit_card": 150, "debit_card": 75
  totalEntities: number;
  entitiesWithContext: number;
  totalRelationships: number;
  scopedRelationships: number;
  crossScopeRelationshipsAllowed: number;
  crossScopeRelationshipsBlocked: number;
}
```

---

## Implementation Plan

### Phase 1: Foundation (Week 1-2)

- [x] Create default domain definitions (6 industries)
- [x] Create customer organization template
- [ ] Implement domain context loading (LLM-based parsing)
- [ ] Implement domain taxonomy caching (Redis)
- [ ] Unit tests for taxonomy extraction

### Phase 2: Product Scope Detection (Week 3)

- [ ] Implement document-level product scope detection
- [ ] Update SearchDocument schema (add productScope metadata)
- [ ] Implement query-level product scope detection
- [ ] Integration tests for scope detection

### Phase 3: Context-Aware Entity Extraction (Week 4)

- [ ] Implement contextual entity extraction (with LLM)
- [ ] Update SearchChunk schema (add contextual entities)
- [ ] Implement attribute scoping (only extract applicable attributes)
- [ ] Integration tests for scoped extraction

### Phase 4: Scoped Relationship Building (Week 5)

- [ ] Implement department boundary checking
- [ ] Implement scoped co-occurrence analysis
- [ ] Update Neo4j schema (add product scope to relationships)
- [ ] Integration tests for relationship building

### Phase 5: Query-Time Disambiguation (Week 6)

- [ ] Implement query scope detection
- [ ] Implement scoped retrieval filtering
- [ ] Implement attribute mismatch detection & user education
- [ ] End-to-end tests with real banking data

### Phase 6: API & UI (Week 7-8)

- [ ] Implement configuration API endpoints
- [ ] Build admin UI for uploading customer org profile
- [ ] Build visualization for product scope distribution
- [ ] Build debugging UI for scope mismatch detection

---

## Testing Strategy

### Unit Tests

- Domain taxonomy extraction (LLM output validation)
- Product scope detection (classification accuracy)
- Department boundary checking (rule evaluation)
- Attribute scoping (applicability validation)

### Integration Tests

- End-to-end: Upload customer profile → ingest documents → extract entities → build relationships → query
- Cross-scope scenarios: Verify false relationships are NOT built
- Attribute mismatch scenarios: Verify user education messages

### Real-World Validation

- **Banking**: Test with NBB Bank documents (credit cards vs debit cards vs loans)
- **Manufacturing**: Test with Southwire documents (building wire vs power cable)
- **Pharma**: Test with Bayer documents (prescription drugs vs crop protection)

---

## Success Metrics

### Extraction Quality

- **Product scope detection accuracy**: >90% (measured on labeled test set)
- **False cross-scope relationships**: <5% (compared to generic extraction)
- **Attribute applicability accuracy**: >95% (e.g., interest_rate only extracted for credit cards, not debit cards)

### Query Quality

- **Query scope detection accuracy**: >85%
- **Attribute mismatch detection rate**: 100% (catch all impossible queries like "debit card interest rate")
- **User education trigger rate**: Track how often users ask impossible questions

### Performance

- **Domain taxonomy caching hit rate**: >95% (taxonomy changes infrequently)
- **Product scope detection latency**: <500ms per document
- **Query disambiguation latency**: <200ms per query

---

## Open Questions & Next Steps

### Questions for User

1. **Default domain selection**: Should we auto-detect industry from customer org profile, or require explicit selection?
2. **Taxonomy updates**: How should customers update their org profile? API upload? UI form?
3. **Multi-domain support**: What if a customer has products across multiple industries (e.g., bank + insurance)?
4. **Neo4j vs MongoDB**: Should we store relationships in Neo4j (graph queries) or MongoDB (simpler deployment)?

### Next Steps (After Design Approval)

1. **Create tasks** for Phase 1-6 implementation (GitHub issues or Jira tickets)
2. **Set up test data**: Collect real documents from NBB Bank, Southwire, Bayer
3. **Build LLM prompt library**: Finalize prompts for taxonomy extraction, scope detection, entity extraction
4. **Architecture review**: Review with engineering team (LLM costs, caching strategy, Neo4j schema)

---

**End of Design Document**

**Related Files**:

- `apps/search-ai/docs/knowledge-graph/domain-definitions/` — Default domain definitions (6 files)
- `apps/search-ai/docs/knowledge-graph/customer-organization-template.md` — Template for customer org profiles
- `apps/search-ai/docs/knowledge-graph/15-knowledge-graph-extraction.md` — Current KG implementation docs
- `apps/search-ai/src/services/knowledge-graph/` — Current KG service code

**Date**: 2026-02-24
**Status**: Ready for Review

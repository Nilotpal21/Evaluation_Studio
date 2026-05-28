# Knowledge Graph Design Discussion - Updated with Decisions

> **Date**: 2026-02-24
> **Status**: Design Review - Decisions Made
> **Previous Version**: DESIGN-domain-aware-knowledge-graph.md
> **This Document**: Captures all design decisions and pending items

---

## Design Decisions Summary

### ✅ Confirmed Decisions

| #   | Topic                      | Decision                                                                | Rationale                                                    |
| --- | -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Multiple domains per index | **YES** - Support multiple domains (e.g., banking + financial-services) | Banks offer both retail banking and wealth management        |
| 2   | Merge strategy             | **UNION** - Merge all domain definitions                                | Maximize coverage, handle conflicts explicitly               |
| 3   | Confidence threshold       | **CONFIGURABLE** - Default 0.7, adjustable per index                    | Different use cases need different strictness                |
| 4   | Classification timing      | **INDEX TIME** - Classify at chunk level during ingestion               | Store as separate field on chunk, enables fast filtering     |
| 5   | Multi-scope documents      | **YES** - Support graph relationships across scopes                     | Documents can mention multiple products (graph structure)    |
| 6   | Relationship storage       | **Neo4j** - Start and test with Neo4j                                   | Graph queries needed for taxonomy traversal                  |
| 7   | Domain auto-detection      | **YES** - Detect from document content                                  | LLM analyzes document to determine relevant domains          |
| 8   | Taxonomy update workflow   | **API first** - Build UI later                                          | API for MVP, UI in Phase 2                                   |
| 9   | Taxonomy as graph nodes    | **YES** - Create catalog nodes during document upload                   | Taxonomy structure (categories, departments) stored as nodes |
| 10  | Caching strategy           | **ONE-TIME SETUP** - Cache until customer updates profile               | No repeated LLM calls per document ingestion                 |

---

## Critical Design Updates

### Update 1: Domain Definition vs. Organization Profile (CLARIFIED)

**User Feedback**:

> "Customer can come up with customer-specific Domain Definition (banking.md) but we should also have organization profile detailing about the company details, their structure, how they are performing."

**Clarification**: TWO separate files per customer:

#### File 1: Custom Domain Definition (Optional)

**Path**: `config/knowledge-graph/domain-definitions/{tenantId}/banking.md`
**Purpose**: Customer-specific TAXONOMY (products, attributes, boundaries)
**When to use**: When customer's products differ significantly from default domain

**Example**: NBB Bank creates `nbb-banking.md` to add Islamic finance products:

```markdown
# Domain Definition: NBB Banking (extends default banking.md)

## Additional Products

### Islamic Finance Products (Department: Islamic Banking)

#### Islamic Housing Finance (Ijara)

- **Description**: Sharia-compliant property financing using lease structure
- **Key Attributes**:
  - `profit_rate`: NOT interest_rate (Sharia-compliant equivalent)
  - `lease_term`: Lease duration (NOT loan tenure)
  - `ownership_transfer`: Transfer of ownership at end of lease
- **Disambiguation Keywords**: Ijara, Sharia-compliant, profit rate, lease, riba-free
- **DO NOT CONFUSE WITH**: Conventional housing loans (interest-based)

## Attribute Specificity Rules (NBB-Specific)

### Attribute: `profit_rate`

- **Applies to**: Islamic finance products ONLY
- **Does NOT apply to**: Conventional loans, credit cards
- **Contextual Meaning**: Sharia-compliant equivalent to interest rate, structured as lease payment

### Attribute: `interest_rate`

- **Applies to**: Conventional products ONLY
- **Does NOT apply to**: Islamic finance products (use profit_rate instead)
```

#### File 2: Organization Profile (Required)

**Path**: `config/knowledge-graph/{tenantId}/organization-profile.md`
**Purpose**: Company details, structure, operations, business context
**When to use**: ALWAYS (every customer must provide this)

**Example**: NBB Bank `organization-profile.md`:

```markdown
# Organization Profile: National Bank of Bahrain (NBB)

## Company Overview

### Company Structure

- **Headquarters**: Manama, Bahrain
- **Branches**: 28 branches (15 in Bahrain, 8 in Saudi Arabia, 5 in UAE)
- **Employees**: 1,200+ employees
- **Founded**: 1957
- **Stock Exchange**: Bahrain Bourse (ticker: NBB)

### Business Lines

1. **Retail Banking** (60% of revenue)
   - Credit cards, debit cards, personal loans, housing loans
   - Primary customer segment: Individual consumers

2. **Corporate Banking** (30% of revenue)
   - Business loans, trade finance, cash management
   - Primary customer segment: SMEs and large corporations

3. **Islamic Banking** (10% of revenue)
   - Sharia-compliant products (Ijara, Murabaha, Tawarruq)
   - Primary customer segment: Sharia-conscious customers

### Organizational Departments

- **Card Services Division**: Credit cards, debit cards, prepaid cards
- **Lending Division**: Housing loans, personal loans, auto loans, business loans
- **Islamic Banking Division**: All Sharia-compliant products
- **Wealth Management Division**: Mutual funds, investment advisory, retirement planning
- **Operations**: Back-office, compliance, risk management

### Geographic Operations

- **Bahrain**: Full banking license, all products available
- **Saudi Arabia**: Commercial banking license, limited retail presence
- **UAE**: Representative office, corporate banking only (no retail)

### Regulatory Environment

- **Primary Regulator**: Central Bank of Bahrain (CBB)
- **International Regulators**: SAMA (Saudi), CBUAE (UAE)
- **Compliance Standards**: Basel III, PCI-DSS, FATCA, CRS
- **Sharia Governance**: NBB Sharia Board (for Islamic products only)

### Performance & Scale

- **Total Assets**: $35 billion (as of 2025)
- **Customer Base**: 500,000+ retail customers, 5,000+ corporate clients
- **Market Position**: #2 bank in Bahrain by assets, #5 in GCC by Islamic banking assets
- **Growth Areas**: Digital banking, Islamic finance, wealth management

### Technology & Digital Channels

- **Mobile App**: NBB Mobile (iOS/Android), 200,000+ active users
- **Online Banking**: NBB Online, 300,000+ active users
- **ATM Network**: 150+ ATMs (100 in Bahrain, 50 in Saudi/UAE)
- **Digital Strategy**: "Digital First" by 2027 — 80% of transactions via digital channels

### Customer Service

- **Call Center**: 24/7 support (Arabic/English)
- **Branch Hours**: Sun-Thu 8am-2pm (Bahrain), Sat-Wed 9am-4pm (Saudi)
- **Complaint Resolution**: 48-hour resolution SLA, escalation to CBB if unresolved

### Internal Terminology (NBB-Specific)

- **"Platinum Tier"**: High-net-worth customers (>$500k deposits)
- **"Gold Tier"**: Premium customers ($100k-$500k deposits)
- **"Silver Tier"**: Standard customers (<$100k deposits)
- **"VRU"**: Voice Response Unit (IVR system for call center)
- **"T24"**: Core banking system (Temenos T24)
- **"CIF"**: Customer Information File (unique customer ID)

### Pain Points & Challenges (Context for Support)

- **Most common customer complaint**: Credit card APR confusion (customers confuse debit card fees with credit card interest)
- **Cross-selling challenge**: Customers don't understand difference between conventional and Islamic products
- **Regional complexity**: Product availability varies by country (UAE = corporate only, Bahrain = full retail)

**End of Organization Profile**
```

**Key Distinction**:

| Aspect          | Custom Domain Definition (nbb-banking.md)                     | Organization Profile (organization-profile.md)           |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| **Focus**       | WHAT products/services (taxonomy)                             | WHO the company is (identity, structure)                 |
| **Content**     | Product hierarchy, attributes, disambiguation rules           | Company structure, operations, performance, culture      |
| **Usage in KG** | Used for entity extraction, relationship building             | Used for context understanding, query disambiguation     |
| **Example**     | "Islamic Housing Finance uses profit_rate, not interest_rate" | "NBB has 28 branches across 3 countries, 500K customers" |

---

### Update 2: Classification at Chunk Level (INDEX TIME)

**User Feedback**:

> "Link is established in job but domain/product/department classification happens as a catalog for every chunk as a separate field in design time."

**Implementation**:

#### Chunk Schema Update

```typescript
interface SearchChunk {
  _id: ObjectId;
  documentId: ObjectId;
  tenantId: string;
  indexId: string;
  content: string;

  // NEW: Classification metadata (added during ingestion)
  classification: {
    // Product scope (detected by LLM)
    productScope: {
      primaryProduct: string; // "credit_card"
      confidence: number; // 0.85
      secondaryProducts: string[]; // ["rewards_program"]
    };

    // Department/category (from taxonomy)
    department: string; // "Card Services"
    subDepartment: string; // "Credit Card Division"
    category: string; // "Cards"

    // Detected at index time
    classifiedAt: Date;
    classificationMethod: 'llm' | 'rule-based' | 'hybrid';
  };

  // Existing fields
  metadata: {
    entities?: ContextualEntity[];
    references?: ContextualReference[];
    // ...
  };
  embedding: number[];
  createdAt: Date;
}
```

#### Classification Job (During Ingestion)

```typescript
// Worker: page-processing-worker.ts (UPDATED)
async function processPageWithClassification(
  chunk: SearchChunk,
  taxonomy: DomainTaxonomy,
  config: KnowledgeGraphConfig,
): Promise<SearchChunk> {
  // Step 1: Classify chunk by product scope (LLM call)
  const classification = await classifyChunk({
    chunkText: chunk.content,
    documentContext: { title: chunk.metadata.title, type: chunk.metadata.type },
    taxonomy,
    confidenceThreshold: config.confidenceThreshold || 0.7, // CONFIGURABLE
  });

  // Step 2: Store classification on chunk
  chunk.classification = {
    productScope: classification.productScope,
    department: classification.department,
    subDepartment: classification.subDepartment,
    category: classification.category,
    classifiedAt: new Date(),
    classificationMethod: 'llm',
  };

  // Step 3: Extract entities with classification context (Stage 4)
  chunk.metadata.entities = await extractEntitiesWithContext(
    chunk.content,
    classification.productScope,
    taxonomy,
  );

  // Step 4: Save chunk with classification
  await SearchChunk.updateOne({ _id: chunk._id }, { $set: chunk });

  return chunk;
}
```

#### Confidence Threshold Configuration

**Per-Index Configuration**:

```typescript
interface IndexKnowledgeGraphConfig {
  indexId: string;
  tenantId: string;

  // Classification settings
  classification: {
    confidenceThreshold: number; // Default: 0.7
    fallbackBehavior: 'allow_all' | 'reject' | 'flag_for_review'; // Default: 'flag_for_review'
    enableMultiScope: boolean; // Default: true
  };

  // ... other config
}
```

**Example Configurations**:

| Use Case                      | Threshold | Fallback        | Reasoning                                                    |
| ----------------------------- | --------- | --------------- | ------------------------------------------------------------ |
| **Banking (strict)**          | 0.8       | reject          | Avoid cross-product contamination (credit card ≠ debit card) |
| **General docs**              | 0.6       | allow_all       | More lenient, fewer false negatives                          |
| **Manufacturing (technical)** | 0.75      | flag_for_review | Technical terms need accuracy, but allow manual review       |

**API to Configure**:

```bash
POST /api/v1/knowledge-graph/config/{indexId}
{
  "classification": {
    "confidenceThreshold": 0.8,
    "fallbackBehavior": "reject",
    "enableMultiScope": true
  }
}
```

---

### Update 3: Taxonomy as Graph Nodes (Catalog Structure)

**User Feedback**:

> "Based on the taxonomy should create graph nodes (the catalog, the various verticals or sections) as part of the document upload itself?"

**YES** - Create taxonomy structure as Neo4j nodes during index setup (not per document upload).

#### Taxonomy Graph Schema

```cypher
// 1. Create Domain node
CREATE (d:Domain {
  id: "banking",
  name: "Banking & Financial Institutions",
  version: "1.0"
})

// 2. Create Category nodes
CREATE (cat_cards:Category {
  id: "cards",
  name: "Cards",
  department: "Card Services",
  domain: "banking"
})

CREATE (cat_loans:Category {
  id: "loans",
  name: "Loans",
  department: "Lending Services",
  domain: "banking"
})

// 3. Create Product nodes
CREATE (prod_cc:Product {
  id: "credit_card",
  name: "Credit Card",
  subDepartment: "Credit Card Division",
  description: "Revolving credit line with interest charges",
  disambiguationKeywords: ["credit", "revolving", "APR", "rewards"]
})

CREATE (prod_dc:Product {
  id: "debit_card",
  name: "Debit Card",
  subDepartment: "Debit Card Division",
  description: "Direct withdrawal from checking/savings account",
  disambiguationKeywords: ["debit", "direct withdrawal", "ATM"]
})

// 4. Create Attribute nodes
CREATE (attr_interest:Attribute {
  id: "interest_rate",
  name: "Interest Rate",
  applicableTo: ["credit_card", "housing_loan", "personal_loan"],
  notApplicableTo: ["debit_card", "checking_account"]
})

CREATE (attr_credit_limit:Attribute {
  id: "credit_limit",
  name: "Credit Limit",
  applicableTo: ["credit_card"],
  notApplicableTo: ["debit_card", "loans"]
})

// 5. Create relationships (Taxonomy structure)
CREATE (d)-[:HAS_CATEGORY]->(cat_cards)
CREATE (d)-[:HAS_CATEGORY]->(cat_loans)
CREATE (cat_cards)-[:HAS_PRODUCT]->(prod_cc)
CREATE (cat_cards)-[:HAS_PRODUCT]->(prod_dc)
CREATE (prod_cc)-[:HAS_ATTRIBUTE]->(attr_interest)
CREATE (prod_cc)-[:HAS_ATTRIBUTE]->(attr_credit_limit)
CREATE (prod_dc)-[:EXCLUDES]->(prod_cc) // Department boundary
```

#### When to Create Taxonomy Nodes

**Trigger**: Index configuration API call (one-time setup)

```typescript
// POST /api/v1/knowledge-graph/config/{indexId}
async function setupTaxonomyGraph(
  indexId: string,
  tenantId: string,
  config: IndexKnowledgeGraphConfig,
) {
  // Step 1: Load domain definitions
  const taxonomy = await loadDomainTaxonomy(tenantId, indexId, config);

  // Step 2: Create taxonomy nodes in Neo4j (ONE-TIME)
  await neo4jService.createTaxonomyNodes(taxonomy, { tenantId, indexId });

  console.log(`[KG] Taxonomy graph created for ${tenantId}/${indexId}`);
}
```

#### Document Nodes Link to Taxonomy Nodes

**During document ingestion**:

```cypher
// 1. Create Document node
CREATE (doc:Document {
  id: $documentId,
  tenantId: $tenantId,
  indexId: $indexId,
  title: $title,
  uploadedAt: $uploadedAt
})

// 2. Link document to product node (based on classification)
MATCH (prod:Product {id: $productScope}) // "credit_card"
MATCH (doc:Document {id: $documentId})
CREATE (doc)-[:CLASSIFIED_AS {
  confidence: $confidence, // 0.85
  classifiedAt: $classifiedAt
}]->(prod)

// 3. Link document to category/department
MATCH (cat:Category {id: $category}) // "cards"
MATCH (doc:Document {id: $documentId})
CREATE (doc)-[:BELONGS_TO_CATEGORY]->(cat)
```

**Query Example**: Find all documents about credit cards

```cypher
MATCH (prod:Product {id: "credit_card"})
MATCH (doc:Document)-[:CLASSIFIED_AS]->(prod)
WHERE doc.tenantId = $tenantId AND doc.indexId = $indexId
RETURN doc
```

**Query Example**: Find all products in "Card Services" department

```cypher
MATCH (cat:Category {department: "Card Services"})
MATCH (cat)-[:HAS_PRODUCT]->(prod:Product)
RETURN prod.name, prod.disambiguationKeywords
```

---

### Update 4: Caching Strategy (ONE-TIME SETUP)

**User Feedback**:

> "Why every time we send the customer details? This is one-time setup per index. Customer won't do this repeatedly as this requires re-ingesting."

**YOU'RE ABSOLUTELY RIGHT** - Caching strategy was over-engineered.

#### Revised Approach: Setup-Time Taxonomy Loading (NOT Runtime)

**When taxonomy is loaded**:

1. **Index creation/configuration** (one-time) → Load MD files → LLM parse → Store taxonomy in MongoDB/Neo4j
2. **Document ingestion** → Use pre-loaded taxonomy (no LLM calls, no MD file reads)
3. **Taxonomy update** → Customer uploads new profile → Trigger re-load → Flag all documents for re-classification

**Implementation**:

```typescript
// 1. Index Configuration API (ONE-TIME SETUP)
async function configureKnowledgeGraph(
  indexId: string,
  tenantId: string,
  config: IndexKnowledgeGraphConfig,
) {
  // Step 1: Load MD files (domain definitions + org profile)
  const domainMDs = await loadDomainDefinitions(config.domains); // ["banking", "financial-services"]
  const customDomainMDs = await loadCustomDomainDefinitions(tenantId, config.domains); // optional
  const orgProfileMD = await loadOrganizationProfile(config.customerOrgProfile);

  // Step 2: Send to LLM for parsing (ONE-TIME, NOT CACHED)
  const taxonomy = await extractTaxonomyWithLLM({
    domainDefinitions: domainMDs,
    customDomainDefinitions: customDomainMDs,
    organizationProfile: orgProfileMD,
  });

  // Step 3: Store taxonomy in MongoDB (for fast access during ingestion)
  await KnowledgeGraphTaxonomy.create({
    tenantId,
    indexId,
    taxonomy, // Structured JSON
    version: '1.0',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Step 4: Create taxonomy graph in Neo4j (for graph queries)
  await neo4jService.createTaxonomyNodes(taxonomy, { tenantId, indexId });

  console.log(`[KG] Taxonomy setup complete for ${tenantId}/${indexId}`);
}

// 2. Document Ingestion (RUNTIME - NO LLM CALLS FOR TAXONOMY)
async function classifyChunk(chunk: SearchChunk, tenantId: string, indexId: string) {
  // Step 1: Load pre-stored taxonomy (fast MongoDB read, NO LLM)
  const taxonomyDoc = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId });
  if (!taxonomyDoc) {
    throw new Error('Taxonomy not configured for this index. Run setup first.');
  }

  // Step 2: Classify chunk using taxonomy (LLM call for classification, NOT taxonomy loading)
  const classification = await classifyChunkWithTaxonomy(chunk.content, taxonomyDoc.taxonomy);

  return classification;
}

// 3. Taxonomy Update (TRIGGER RE-CLASSIFICATION)
async function updateTaxonomy(tenantId: string, indexId: string, newOrgProfile: string) {
  // Step 1: Re-load taxonomy with new org profile
  const taxonomy = await reloadTaxonomy(tenantId, indexId, newOrgProfile);

  // Step 2: Update stored taxonomy
  await KnowledgeGraphTaxonomy.updateOne(
    { tenantId, indexId },
    { $set: { taxonomy, updatedAt: new Date(), version: '1.1' } },
  );

  // Step 3: Flag all documents for re-classification (background job)
  await SearchDocument.updateMany(
    { tenantId, indexId },
    { $set: { 'metadata.taxonomyVersion': '1.0', 'metadata.needsReclassification': true } },
  );

  console.log(
    `[KG] Taxonomy updated. ${await SearchDocument.countDocuments({ tenantId, indexId })} documents flagged for re-classification.`,
  );
}
```

**Schema: Taxonomy Storage**

```typescript
// MongoDB collection: knowledge_graph_taxonomy
interface KnowledgeGraphTaxonomy {
  _id: ObjectId;
  tenantId: string;
  indexId: string;

  // Parsed taxonomy (from LLM)
  taxonomy: DomainTaxonomy;

  // Metadata
  version: string; // "1.0", "1.1", etc.
  domains: string[]; // ["banking", "financial-services"]
  customDomainFiles: string[]; // ["s3://config/kg/tenant123/nbb-banking.md"]
  organizationProfileFile: string; // "s3://config/kg/tenant123/organization-profile.md"

  createdAt: Date;
  updatedAt: Date;
}
```

**Cost Analysis (REVISED)**:

| Event                               | Frequency              | LLM Calls                                     | Cost            |
| ----------------------------------- | ---------------------- | --------------------------------------------- | --------------- |
| **Index setup** (one-time)          | Once per index         | 1 (taxonomy parsing)                          | $0.75           |
| **Document ingestion** (1,000 docs) | Repeated               | 1,000 (classification only, ~500 tokens each) | $10 (NOT $750!) |
| **Taxonomy update**                 | Rare (maybe quarterly) | 1 (re-parse) + 1,000 (re-classify)            | $10.75          |

**Key Insight**: No caching needed because taxonomy is loaded ONCE during index setup, not per document.

---

## Stage 4: Context-Aware Entity Extraction (DETAILED DISCUSSION)

**User Feedback**: "Ensure we discuss this."

### Purpose

Extract entities from chunks with full product context to enable accurate disambiguation.

### The Problem (Without Context)

**Scenario**: Extract entities from this chunk about credit cards:

> "The Platinum Rewards card offers 2% cashback with no annual fee for the first year. Interest rate is 18% APR."

**Generic extraction** (current implementation):

```json
{
  "entities": [
    { "text": "Platinum Rewards card", "type": "product_name" },
    { "text": "2% cashback", "type": "reward" },
    { "text": "annual fee", "type": "fee" },
    { "text": "18% APR", "type": "percentage" },
    { "text": "Interest rate", "type": "attribute" }
  ]
}
```

**Problem**: No context! If this exact text appeared in a document about debit cards (incorrectly), we'd extract the same entities.

### The Solution (With Context)

**Context-aware extraction**:

```json
{
  "entities": [
    {
      "text": "Platinum Rewards card",
      "type": "product_name",
      "productType": "credit_card", // <-- CONTEXT
      "context": {
        "documentScope": "credit_card",
        "chunkScope": "credit_card",
        "inScopeMatch": true, // <-- Chunk is about credit cards, entity is about credit cards
        "confidence": 0.95
      }
    },
    {
      "text": "18% APR",
      "type": "interest_rate",
      "productType": "credit_card",
      "context": {
        "documentScope": "credit_card",
        "chunkScope": "credit_card",
        "inScopeMatch": true,
        "confidence": 0.92,
        "attributeApplicable": true // <-- interest_rate APPLIES to credit cards
      }
    },
    {
      "text": "2% cashback",
      "type": "reward_rate",
      "productType": "credit_card",
      "context": {
        "documentScope": "credit_card",
        "chunkScope": "credit_card",
        "inScopeMatch": true,
        "confidence": 0.88,
        "attributeApplicable": true // <-- rewards APPLY to credit cards
      }
    }
  ]
}
```

### Extraction Process (Step-by-Step)

#### Step 1: Chunk Classification (Already Done in Stage 3)

```typescript
const chunkClassification = {
  productScope: {
    primaryProduct: 'credit_card',
    confidence: 0.85,
    secondaryProducts: [],
  },
  department: 'Card Services',
  subDepartment: 'Credit Card Division',
};
```

#### Step 2: Load Applicable Attributes (From Taxonomy)

```typescript
// Get attributes that APPLY to credit_card
const applicableAttributes = taxonomy.attributeRules.filter((rule) =>
  rule.applicableTo.includes('credit_card'),
);

// Result:
// - interest_rate: APPLIES to credit_card
// - credit_limit: APPLIES to credit_card
// - rewards_program: APPLIES to credit_card
// - annual_fee: APPLIES to credit_card

// Get attributes that DO NOT APPLY to credit_card
const notApplicableAttributes = taxonomy.attributeRules.filter((rule) =>
  rule.notApplicableTo.includes('credit_card'),
);

// Result:
// - daily_withdrawal_limit: DOES NOT APPLY (debit card attribute)
// - linked_account: DOES NOT APPLY (debit card attribute)
```

#### Step 3: Extract Product Identifiers (Regex - Fast)

```typescript
// Extract credit card IDs using pattern from taxonomy
const ccPattern = new RegExp(
  taxonomy.products.find((p) => p.name === 'credit_card').identifierPattern.regex,
);
// Pattern: CC-\d{7} or NBB-CC-\d{7}

const matches = chunkText.matchAll(ccPattern);
for (const match of matches) {
  entities.push({
    text: match[0], // "NBB-CC-1234567"
    type: 'product_identifier',
    productType: 'credit_card',
    context: {
      documentScope: chunkClassification.productScope.primaryProduct,
      chunkScope: chunkClassification.productScope.primaryProduct,
      inScopeMatch: true,
      confidence: 1.0, // Regex match = high confidence
    },
    extractionMethod: 'regex',
  });
}
```

#### Step 4: Extract Attributes (LLM - Context-Aware)

**LLM Prompt**:

```typescript
const prompt = `
You are extracting entities from a document chunk about ${chunkClassification.productScope.primaryProduct}.

**Document Context**:
- Product: ${chunkClassification.productScope.primaryProduct}
- Department: ${chunkClassification.department}
- Sub-department: ${chunkClassification.subDepartment}

**Applicable Attributes** (for ${chunkClassification.productScope.primaryProduct}):
${applicableAttributes
  .map((attr) => {
    const meaning = attr.contextualMeaning.find(
      (cm) => cm.productType === chunkClassification.productScope.primaryProduct,
    );
    return `- ${attr.attributeName}: ${meaning?.meaning || 'N/A'}`;
  })
  .join('\n')}

**NOT Applicable Attributes** (DO NOT extract these - they don't apply to ${chunkClassification.productScope.primaryProduct}):
${notApplicableAttributes.map((attr) => `- ${attr.attributeName}`).join('\n')}

**Chunk Text**:
${chunkText}

**Task**: Extract ONLY attributes applicable to ${chunkClassification.productScope.primaryProduct}. Ignore attributes that don't apply.

**Output Format** (JSON array):
[
  {
    "text": "18% APR",
    "type": "interest_rate",
    "start": 45,
    "end": 52,
    "confidence": 0.92
  }
]

**Rules**:
1. ONLY extract attributes from "Applicable Attributes" list
2. If you see an attribute from "NOT Applicable Attributes" list, SKIP it
3. Include start/end character offsets
4. Estimate confidence (0.0 to 1.0)
`;

const llmResponse = await llm.complete({
  systemPrompt: 'You are an entity extraction expert. Follow instructions precisely.',
  userPrompt: prompt,
  responseFormat: 'json',
  model: 'claude-3-5-haiku', // Fast model for extraction
});

const llmEntities = JSON.parse(llmResponse.content);
```

**Example LLM Response**:

```json
[
  {
    "text": "18% APR",
    "type": "interest_rate",
    "start": 120,
    "end": 127,
    "confidence": 0.92
  },
  {
    "text": "Platinum Rewards card",
    "type": "product_name",
    "start": 4,
    "end": 25,
    "confidence": 0.95
  },
  {
    "text": "2% cashback",
    "type": "reward_rate",
    "start": 35,
    "end": 46,
    "confidence": 0.88
  },
  {
    "text": "annual fee",
    "type": "fee",
    "start": 58,
    "end": 68,
    "confidence": 0.9
  }
]
```

**What LLM SHOULD NOT extract** (because chunk is about credit_card, not debit_card):

- "daily_withdrawal_limit" (debit card attribute)
- "linked_account" (debit card attribute)
- "overdraft_protection" (checking account attribute)

#### Step 5: Tag Entities with Context

```typescript
for (const llmEntity of llmEntities) {
  entities.push({
    ...llmEntity,
    productType: chunkClassification.productScope.primaryProduct, // "credit_card"
    context: {
      documentScope: chunkClassification.productScope.primaryProduct,
      chunkScope: chunkClassification.productScope.primaryProduct,
      inScopeMatch: true, // Entity matches chunk's product scope
      confidence: llmEntity.confidence,
      attributeApplicable: true, // Verified during extraction
    },
    extractionMethod: 'llm',
  });
}
```

### Handling Out-of-Scope Mentions

**Scenario**: Chunk is about credit_card, but mentions debit_card in comparison:

> "Unlike debit cards which withdraw directly from your account, our Platinum Rewards credit card offers revolving credit with 18% APR."

**Extraction Result**:

```json
{
  "entities": [
    {
      "text": "debit cards",
      "type": "product_mention",
      "productType": "debit_card", // <-- Different from chunk scope
      "context": {
        "documentScope": "credit_card",
        "chunkScope": "credit_card",
        "inScopeMatch": false, // <-- OUT OF SCOPE (mentioned for comparison)
        "confidence": 0.85,
        "role": "comparison" // <-- Why it's mentioned
      }
    },
    {
      "text": "Platinum Rewards credit card",
      "type": "product_name",
      "productType": "credit_card",
      "context": {
        "documentScope": "credit_card",
        "chunkScope": "credit_card",
        "inScopeMatch": true, // <-- IN SCOPE
        "confidence": 0.95
      }
    },
    {
      "text": "18% APR",
      "type": "interest_rate",
      "productType": "credit_card",
      "context": {
        "documentScope": "credit_card",
        "chunkScope": "credit_card",
        "inScopeMatch": true,
        "confidence": 0.92,
        "attributeApplicable": true
      }
    }
  ]
}
```

**Key Insight**: `inScopeMatch: false` flags "debit cards" as a comparison mention, NOT the main topic. Relationships will NOT be built between credit_card and debit_card based on this mention.

### Storage: Contextual Entities on Chunk

```typescript
interface SearchChunk {
  // ... existing fields

  metadata: {
    // Contextual entities (replaces simple entity list)
    entities: ContextualEntity[];

    // Example:
    // [
    //   {
    //     text: "18% APR",
    //     type: "interest_rate",
    //     productType: "credit_card",
    //     context: {
    //       documentScope: "credit_card",
    //       inScopeMatch: true,
    //       confidence: 0.92,
    //       attributeApplicable: true
    //     },
    //     extractionMethod: "llm"
    //   }
    // ]
  };
}
```

### Query-Time Usage

**User Query**: "What is the interest rate on credit cards?"

**Retrieval**:

1. Classify query → `credit_card`
2. Filter chunks: `classification.productScope.primaryProduct = "credit_card"`
3. Filter entities: `metadata.entities[].context.inScopeMatch = true AND metadata.entities[].type = "interest_rate"`
4. Return: "18% APR" (from credit card chunks ONLY, not debit card chunks)

**User Query**: "What is the interest rate on debit cards?" (IMPOSSIBLE QUERY)

**Detection**:

1. Classify query → `debit_card`
2. Check attribute applicability: `taxonomy.attributeRules["interest_rate"].notApplicableTo.includes("debit_card")` → TRUE
3. Return error: "Debit cards don't have interest rates. They withdraw directly from your checking account. Did you mean credit cards?"

---

## Pending Items & Next Steps

### Pending Design Decisions

| #   | Question                                                                         | Status  | Next Action                                                |
| --- | -------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------- |
| 1   | Neo4j schema optimization (indexes, constraints)                                 | PENDING | Design Neo4j schema with performance in mind (Task #56)    |
| 2   | LLM model selection (Haiku vs Sonnet for classification)                         | PENDING | Benchmark Haiku vs Sonnet (accuracy vs cost)               |
| 3   | Multi-scope document ranking (how to rank docs with multiple scopes)             | PENDING | Define ranking algorithm for cross-scope relevance         |
| 4   | Taxonomy version migration (when taxonomy changes, how to migrate old documents) | PENDING | Design migration strategy (re-classify all vs incremental) |
| 5   | API authentication for taxonomy upload                                           | PENDING | Define auth model (admin-only vs tenant-admin)             |

### Pending Implementation Tasks

**Created Tasks** (from previous session):

- Task #53: Implement domain context loading (LLM-based parsing)
- Task #54: Implement product scope detection (document + query classification)
- Task #55: Implement context-aware entity extraction (with attribute scoping)
- Task #56: Implement scoped relationship building (department boundaries)
- Task #57: Implement query-time disambiguation (user education)
- Task #58: Build API endpoints and admin UI
- Task #59: Create real-world test datasets

**Additional Tasks Needed** (based on this discussion):

- **Task #60**: Implement taxonomy graph creation (Neo4j nodes for catalog structure)
- **Task #61**: Update chunk schema with classification field
- **Task #62**: Implement configurable confidence threshold per index
- **Task #63**: Build organization profile template and API
- **Task #64**: Implement one-time taxonomy setup (no runtime caching)
- **Task #65**: Build taxonomy update workflow (trigger re-classification)

### Implementation Order (Recommended)

**Phase 1: Foundation** (Weeks 1-2)

1. Task #60: Create taxonomy graph (Neo4j nodes)
2. Task #61: Update chunk schema (add classification field)
3. Task #53: Domain context loading (one-time setup)
4. Task #63: Organization profile template

**Phase 2: Classification** (Week 3) 5. Task #54: Product scope detection (chunk-level classification) 6. Task #62: Configurable confidence threshold

**Phase 3: Entity Extraction** (Week 4) 7. Task #55: Context-aware entity extraction (Stage 4)

**Phase 4: Relationships** (Week 5) 8. Task #56: Scoped relationship building (department boundaries)

**Phase 5: Query-Time** (Week 6) 9. Task #57: Query-time disambiguation (impossible query detection)

**Phase 6: API & Testing** (Weeks 7-8) 10. Task #58: Build API endpoints 11. Task #59: Real-world test datasets 12. Task #64: One-time taxonomy setup workflow 13. Task #65: Taxonomy update workflow

---

## Design Clarifications Summary

### 1. Multiple Domains per Index

✅ **CONFIRMED**: Support `domains: ["banking", "financial-services"]` per index, merge taxonomies using UNION strategy.

### 2. Domain Definition vs. Organization Profile

✅ **CLARIFIED**: TWO separate files:

- **Custom Domain Definition** (optional): `{tenantId}/banking.md` - Product taxonomy
- **Organization Profile** (required): `{tenantId}/organization-profile.md` - Company structure, operations

### 3. Classification Timing

✅ **CONFIRMED**: Classify at chunk level during INDEX TIME, store as `classification` field on chunk. Configurable confidence threshold.

### 4. Taxonomy as Graph Nodes

✅ **CONFIRMED**: Create taxonomy nodes (Domain → Category → Product → Attribute) in Neo4j during index setup. Documents link to taxonomy nodes.

### 5. Caching Strategy

✅ **REVISED**: No runtime caching needed. Taxonomy loaded ONCE during index setup, stored in MongoDB. Documents use pre-loaded taxonomy.

### 6. Context-Aware Entity Extraction (Stage 4)

✅ **DETAILED**: Extract entities with full product context:

- Tag entities with `productType`, `inScopeMatch`, `confidence`
- Apply attribute scoping (only extract applicable attributes)
- LLM prompted with applicable/not-applicable attribute lists
- Handle out-of-scope mentions (comparisons)

---

## Open Questions for Next Discussion

1. **Neo4j schema design**: What indexes/constraints do we need for performance?
2. **LLM model selection**: Haiku (cheap, fast) vs Sonnet (accurate, expensive) for classification?
3. **Multi-scope ranking**: How to rank documents with `primaryProduct: credit_card` vs `secondaryProducts: [credit_card]` for query about credit cards?
4. **Taxonomy versioning**: When taxonomy changes, how to handle old documents? Re-classify all (expensive) or incremental (complex)?
5. **API authentication**: Who can upload taxonomy? Admin only? Tenant admins? Project admins?

---

**End of Design Discussion Document**

**Next Action**: Review this document, confirm design decisions, answer open questions, then proceed to Phase 1 implementation (Task #60, #61, #53, #63).

# Knowledge Graph Implementation Plan

> **Document Purpose**: Detailed phase-by-phase implementation plan for domain-aware knowledge graph with product disambiguation
> **Status**: Ready for Phase 1 implementation
> **Last Updated**: 2026-02-24
> **Related Documents**:
>
> - DESIGN-DISCUSSION-updated.md (design decisions and clarifications)
> - OPEN-QUESTIONS-DISCUSSION.md (5 open questions resolved with recommendations)
> - DESIGN-domain-aware-knowledge-graph.md (comprehensive 6-stage design)

---

## Executive Summary

### Problem Statement

Current knowledge graph lacks domain awareness, causing false relationships between similar products:

- **Credit cards vs debit cards**: Both share terms like "cards," "interest," "fees," but interest_rate applies ONLY to credit cards, NOT debit cards
- **Housing loans vs personal loans**: Both are "loans," but application processes, collateral requirements, and documentation differ significantly
- **Internal employee docs**: "Priority P1" means different things in Sales (must-have feature) vs Support (major customer impact) vs Engineering (story points)

### Solution Overview

**Domain-Aware Knowledge Graph with 6 Stages**:

1. **Stage 1**: Domain Context Loading (one-time taxonomy setup per index)
2. **Stage 2**: Product Scope Detection (chunk-level classification during ingestion)
3. **Stage 3**: Context-Aware Entity Extraction (extract entities with product scope tags)
4. **Stage 4**: Scoped Relationship Building (prevent false relationships using department boundaries)
5. **Stage 5**: Query-Time Disambiguation (detect impossible queries, scope retrieval)
6. **Stage 6**: Configuration APIs & Admin UI (tenant self-service taxonomy management)

### Key Design Decisions (All Approved)

| Decision                  | Approach                                         | Rationale                                      |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| **Neo4j Indexing**        | Standard indexing (unique `id`, index `name`)    | 5-10ms query lookups, production-proven        |
| **LLM Model**             | Hybrid (Sonnet for taxonomy, Haiku + escalation) | $1.15 per 1K docs, 91% accuracy                |
| **Multi-Scope Ranking**   | Primary + secondary weighting (1.0 vs 0.7)       | Balanced precision/recall, configurable        |
| **Taxonomy Migration**    | Incremental on-demand re-classification          | Cost spread over time, prioritizes hot docs    |
| **API Authentication**    | Tenant admin (self-service)                      | Good security, no support bottleneck           |
| **Classification Timing** | INDEX TIME (chunk level)                         | Fast query filtering, no runtime overhead      |
| **Taxonomy Storage**      | ONE-TIME SETUP in MongoDB                        | $0.75 one-time + $10 per 1K docs (not $750!)   |
| **Confidence Threshold**  | CONFIGURABLE per index (default 0.7)             | Different industries need different strictness |
| **Multiple Domains**      | YES (union merge strategy)                       | Banks offer both retail + wealth management    |
| **Taxonomy as Graph**     | YES (Neo4j nodes for catalog)                    | Fast taxonomy traversal, explicit boundaries   |

### Success Metrics

**Accuracy Metrics**:

- Product scope classification accuracy: **91%** (target)
- Entity extraction precision: **85%+** (with product context)
- False relationship prevention: **95%+** (compared to 60% baseline)

**Performance Metrics**:

- Neo4j taxonomy lookup: **5-10ms** per query
- Chunk classification: **500ms** (Haiku) or **1-2s** (Sonnet escalation)
- Query-time disambiguation: **< 50ms** overhead

**Cost Metrics**:

- Taxonomy setup: **$0.75** one-time per index
- Document ingestion: **$1.15** per 1,000 docs (hybrid LLM approach)
- Taxonomy update: **$10.75** (re-parse + re-classify)

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2) — **PRIORITY**

**Objective**: Set up taxonomy infrastructure and chunk classification schema

**Tasks**:

1. **Task #60**: Implement taxonomy graph creation in Neo4j
2. **Task #61**: Update SearchChunk schema with classification field
3. **Task #53**: Implement domain context loading with LLM-based parsing
4. **Task #63**: Build organization profile template and API

**Dependencies**: None (can start immediately)

**Deliverables**:

- Neo4j schema with standard indexing (constraints + indexes)
- MongoDB schema with `classification` field on SearchChunk
- Taxonomy loading service (Sonnet-based parsing)
- Organization profile API (tenant admin authentication)

---

### Phase 2: Classification (Week 3)

**Objective**: Implement chunk-level product scope classification during ingestion

**Tasks**: 5. **Task #54**: Implement product scope detection for documents and queries 6. **Task #62**: Implement configurable confidence threshold per index

**Dependencies**: Phase 1 (requires taxonomy loading and chunk schema)

**Deliverables**:

- Hybrid LLM classification service (Haiku primary, Sonnet escalation)
- Chunk classification during document ingestion
- Configurable confidence threshold per index (default 0.7)

---

### Phase 3: Entity Extraction (Week 4)

**Objective**: Extract entities with product context and attribute scoping

**Tasks**: 7. **Task #55**: Implement context-aware entity extraction with attribute scoping

**Dependencies**: Phase 2 (requires chunk classification)

**Deliverables**:

- Context-aware entity extraction (tags entities with productType, confidence, attributeApplicable)
- Attribute scoping logic (interest_rate applies to credit_card, NOT debit_card)
- Entity storage with full context metadata

---

### Phase 4: Relationships (Week 5)

**Objective**: Build scoped relationships with department boundaries

**Tasks**: 8. **Task #56**: Implement scoped relationship building with department boundaries

**Dependencies**: Phase 3 (requires context-aware entities)

**Deliverables**:

- Scoped relationship builder (prevents false relationships)
- Department boundary enforcement (credit_card EXCLUDES debit_card)
- Neo4j relationship creation with scope metadata

---

### Phase 5: Query-Time (Week 6)

**Objective**: Implement query-time disambiguation and scoped retrieval

**Tasks**: 9. **Task #57**: Implement query-time disambiguation and scoped retrieval

**Dependencies**: Phase 4 (requires scoped relationships)

**Deliverables**:

- Query scope classification (classify query by product)
- Impossible query detection ("What is the interest rate on debit cards?" → ERROR)
- Scoped retrieval (filter chunks by product scope)
- Multi-scope document ranking (primary 1.0, secondary 0.7)

---

### Phase 6: API & Testing (Weeks 7-8)

**Objective**: Build configuration APIs, admin UI, and comprehensive testing

**Tasks**: 10. **Task #58**: Build knowledge graph configuration API and admin UI 11. **Task #59**: Create real-world test datasets for KG disambiguation validation 12. **Task #64**: Implement one-time taxonomy setup workflow 13. **Task #65**: Build taxonomy update workflow with re-classification

**Dependencies**: Phase 5 (full system operational)

**Deliverables**:

- Taxonomy upload API (tenant admin authentication)
- Taxonomy update API with incremental re-classification
- Admin UI for taxonomy management
- Real-world test datasets (banking, manufacturing, pharma, internal ops)
- End-to-end testing with actual customer scenarios

---

## Detailed Task Breakdown

### Phase 1: Foundation

---

#### Task #60: Implement Taxonomy Graph Creation in Neo4j

**Priority**: P0 (blocking all other work)

**Description**: Create Neo4j nodes for taxonomy catalog structure (Domain → Category → Department → Product → Attribute) with standard indexing.

**Acceptance Criteria**:

- [ ] Neo4j schema created with standard indexing:
  - Unique constraints on all `.id` fields (Product, Attribute, Domain, Category, Department)
  - Indexes on `.name` fields (Product, Attribute)
  - Existence constraints on required fields (Product.name, Attribute.name)
- [ ] Taxonomy graph builder service:
  - `createTaxonomyGraph(taxonomy: DomainTaxonomy): Promise<void>`
  - Creates nodes: Domain, Category, Department, Product, Attribute
  - Creates relationships: HAS_CATEGORY, HAS_PRODUCT, HAS_ATTRIBUTE, EXCLUDES, APPLIES_TO
- [ ] Query performance validated:
  - Product lookup by name: < 10ms
  - Attribute applicability check: < 10ms
  - Department boundary traversal: < 20ms
- [ ] Integration tests:
  - Create taxonomy from banking domain definition
  - Query product by name
  - Traverse relationships (credit_card → interest_rate attribute)
  - Verify EXCLUDES relationship (credit_card EXCLUDES debit_card)

**Implementation Details**:

**Neo4j Schema** (Cypher):

```cypher
// 1. Create unique constraints (auto-creates indexes)
CREATE CONSTRAINT product_id_unique FOR (p:Product) REQUIRE p.id IS UNIQUE;
CREATE CONSTRAINT attribute_id_unique FOR (a:Attribute) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT domain_id_unique FOR (d:Domain) REQUIRE d.id IS UNIQUE;
CREATE CONSTRAINT category_id_unique FOR (c:Category) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT department_id_unique FOR (dept:Department) REQUIRE dept.id IS UNIQUE;

// 2. Create indexes on name fields
CREATE INDEX product_name_index FOR (p:Product) ON (p.name);
CREATE INDEX attribute_name_index FOR (a:Attribute) ON (a.name);

// 3. Create existence constraints
CREATE CONSTRAINT product_name_exists FOR (p:Product) REQUIRE p.name IS NOT NULL;
CREATE CONSTRAINT attribute_name_exists FOR (a:Attribute) REQUIRE a.name IS NOT NULL;
```

**Node Structure**:

```typescript
interface DomainNode {
  id: string; // "banking"
  name: string; // "Banking & Financial Institutions"
  description: string;
}

interface CategoryNode {
  id: string; // "cards"
  name: string; // "Cards"
  department: string; // "Card Services"
}

interface ProductNode {
  id: string; // "credit_card"
  name: string; // "Credit Card"
  description: string;
  disambiguationKeywords: string[]; // ["credit", "APR", "revolving", "balance"]
}

interface AttributeNode {
  id: string; // "interest_rate"
  name: string; // "Interest Rate"
  applicableTo: string[]; // ["credit_card", "housing_loan", "personal_loan"]
  notApplicableTo: string[]; // ["debit_card", "checking_account"]
}
```

**Service Implementation**:

```typescript
// packages/search-ai/src/services/taxonomy-graph-builder.ts

import { Driver, Session } from 'neo4j-driver';
import { DomainTaxonomy } from '../types/domain-taxonomy';

export class TaxonomyGraphBuilder {
  constructor(private neo4jDriver: Driver) {}

  async createTaxonomyGraph(taxonomy: DomainTaxonomy): Promise<void> {
    const session: Session = this.neo4jDriver.session();

    try {
      // Step 1: Create Domain node
      await session.run(
        `CREATE (d:Domain {
          id: $id,
          name: $name,
          description: $description
        })`,
        {
          id: taxonomy.domain.id,
          name: taxonomy.domain.name,
          description: taxonomy.domain.description,
        },
      );

      // Step 2: Create Category nodes
      for (const category of taxonomy.categories) {
        await session.run(
          `MATCH (d:Domain {id: $domainId})
           CREATE (c:Category {
             id: $id,
             name: $name,
             department: $department
           })
           CREATE (d)-[:HAS_CATEGORY]->(c)`,
          {
            domainId: taxonomy.domain.id,
            id: category.id,
            name: category.name,
            department: category.department,
          },
        );
      }

      // Step 3: Create Product nodes
      for (const product of taxonomy.products) {
        await session.run(
          `MATCH (c:Category {id: $categoryId})
           CREATE (p:Product {
             id: $id,
             name: $name,
             description: $description,
             disambiguationKeywords: $keywords
           })
           CREATE (c)-[:HAS_PRODUCT]->(p)`,
          {
            categoryId: product.categoryId,
            id: product.id,
            name: product.name,
            description: product.description,
            keywords: product.disambiguationKeywords,
          },
        );
      }

      // Step 4: Create Attribute nodes and relationships
      for (const attribute of taxonomy.attributes) {
        await session.run(
          `CREATE (a:Attribute {
             id: $id,
             name: $name,
             applicableTo: $applicableTo,
             notApplicableTo: $notApplicableTo
           })`,
          {
            id: attribute.id,
            name: attribute.name,
            applicableTo: attribute.applicableTo,
            notApplicableTo: attribute.notApplicableTo || [],
          },
        );

        // Create APPLIES_TO relationships
        for (const productId of attribute.applicableTo) {
          await session.run(
            `MATCH (p:Product {id: $productId})
             MATCH (a:Attribute {id: $attributeId})
             CREATE (p)-[:HAS_ATTRIBUTE]->(a)`,
            { productId, attributeId: attribute.id },
          );
        }
      }

      // Step 5: Create EXCLUDES relationships (department boundaries)
      for (const boundary of taxonomy.departmentBoundaries) {
        await session.run(
          `MATCH (p1:Product {id: $product1})
           MATCH (p2:Product {id: $product2})
           CREATE (p1)-[:EXCLUDES]->(p2)`,
          { product1: boundary.product1, product2: boundary.product2 },
        );
      }

      console.log(
        `[TaxonomyGraphBuilder] Taxonomy graph created for domain: ${taxonomy.domain.id}`,
      );
    } finally {
      await session.close();
    }
  }

  async deleteTaxonomyGraph(domainId: string): Promise<void> {
    const session: Session = this.neo4jDriver.session();
    try {
      // Delete all nodes and relationships for this domain
      await session.run(
        `MATCH (d:Domain {id: $domainId})
         OPTIONAL MATCH (d)-[*]->(n)
         DETACH DELETE d, n`,
        { domainId },
      );
      console.log(`[TaxonomyGraphBuilder] Taxonomy graph deleted for domain: ${domainId}`);
    } finally {
      await session.close();
    }
  }
}
```

**Estimated Effort**: 2 days

**Dependencies**: None

**Blocked By**: None

**Blocks**: Task #53 (domain context loading needs graph), Task #54 (classification needs taxonomy lookup)

---

#### Task #61: Update SearchChunk Schema with Classification Field

**Priority**: P0 (blocking all other work)

**Description**: Add `classification` field to SearchChunk schema for storing product scope at chunk level during index time.

**Acceptance Criteria**:

- [ ] MongoDB schema updated with `classification` field:
  - `classification.productScope.primaryProduct` (string)
  - `classification.productScope.confidence` (number, 0-1)
  - `classification.productScope.secondaryProducts` (string[])
  - `classification.department` (string)
  - `classification.category` (string)
  - `classification.classifiedAt` (Date)
  - `classification.classificationMethod` ('llm' | 'rule-based' | 'hybrid')
- [ ] TypeScript interfaces updated
- [ ] Database migration script created (add field with default null)
- [ ] Indexes created on `classification.productScope.primaryProduct` for fast filtering
- [ ] Backward compatibility: Existing chunks without classification handled gracefully

**Implementation Details**:

**MongoDB Schema Update**:

```typescript
// packages/search-ai/src/models/search-chunk.model.ts

import { Schema, model, Document } from 'mongoose';

interface ChunkClassification {
  productScope: {
    primaryProduct: string; // "credit_card"
    confidence: number; // 0.85
    secondaryProducts: string[]; // ["rewards_program"]
  };
  department: string; // "Card Services"
  subDepartment?: string; // "Credit Card Division"
  category: string; // "Cards"
  classifiedAt: Date;
  classificationMethod: 'llm' | 'rule-based' | 'hybrid';
}

interface SearchChunk extends Document {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  tenantId: string;
  indexId: string;
  content: string;

  // NEW: Classification metadata (added during ingestion)
  classification?: ChunkClassification;

  metadata: {
    entities?: ContextualEntity[];
    // ... other metadata
  };

  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}

const ChunkClassificationSchema = new Schema<ChunkClassification>({
  productScope: {
    primaryProduct: { type: String, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    secondaryProducts: { type: [String], default: [] },
  },
  department: { type: String, required: true },
  subDepartment: { type: String },
  category: { type: String, required: true },
  classifiedAt: { type: Date, required: true, default: Date.now },
  classificationMethod: {
    type: String,
    enum: ['llm', 'rule-based', 'hybrid'],
    required: true,
  },
});

const SearchChunkSchema = new Schema<SearchChunk>({
  documentId: { type: Schema.Types.ObjectId, ref: 'SearchDocument', required: true, index: true },
  tenantId: { type: String, required: true, index: true },
  indexId: { type: String, required: true, index: true },
  content: { type: String, required: true },

  // NEW: Classification field
  classification: { type: ChunkClassificationSchema },

  metadata: { type: Schema.Types.Mixed, default: {} },
  embedding: { type: [Number], required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Create index on primaryProduct for fast filtering
SearchChunkSchema.index({ 'classification.productScope.primaryProduct': 1 });

export const SearchChunkModel = model<SearchChunk>('SearchChunk', SearchChunkSchema);
```

**Database Migration**:

```typescript
// packages/search-ai/src/migrations/20260224-add-classification-field.ts

import { SearchChunkModel } from '../models/search-chunk.model';

export async function up(): Promise<void> {
  console.log('[Migration] Adding classification field to SearchChunk...');

  // Step 1: Add classification field (optional, defaults to undefined)
  await SearchChunkModel.updateMany(
    { classification: { $exists: false } },
    { $set: { classification: null } },
  );

  // Step 2: Create index on primaryProduct
  await SearchChunkModel.collection.createIndex({
    'classification.productScope.primaryProduct': 1,
  });

  console.log('[Migration] Classification field added successfully.');
}

export async function down(): Promise<void> {
  console.log('[Migration] Removing classification field from SearchChunk...');

  // Remove index
  await SearchChunkModel.collection.dropIndex({ 'classification.productScope.primaryProduct': 1 });

  // Remove field
  await SearchChunkModel.updateMany({}, { $unset: { classification: 1 } });

  console.log('[Migration] Classification field removed.');
}
```

**Estimated Effort**: 1 day

**Dependencies**: None

**Blocked By**: None

**Blocks**: Task #54 (classification needs schema to store results)

---

#### Task #53: Implement Domain Context Loading with LLM-Based Parsing

**Priority**: P0 (blocking all other work)

**Description**: Implement one-time taxonomy loading service that parses domain definitions + organization profile with LLM (Sonnet) and stores structured taxonomy in MongoDB.

**Acceptance Criteria**:

- [ ] Taxonomy loading service implemented:
  - `loadTaxonomy(indexId: string): Promise<DomainTaxonomy>`
  - Reads default domain definitions from filesystem (banking.md, etc.)
  - Reads custom domain definitions from S3 (if provided)
  - Reads organization profile from S3 (required)
  - Calls LLM (Sonnet) to parse and merge taxonomies
  - Stores parsed taxonomy in MongoDB (knowledge_graph_taxonomy collection)
- [ ] MongoDB schema for taxonomy storage:
  - `KnowledgeGraphTaxonomy` collection with fields: tenantId, indexId, taxonomy, version, domains, customDomainFiles, organizationProfileFile
- [ ] LLM prompt for taxonomy parsing:
  - Accepts markdown files as input
  - Returns structured JSON (DomainTaxonomy)
  - Handles multiple domain merge (union strategy)
- [ ] One-time setup workflow:
  - Taxonomy loaded once during index configuration
  - Cached in MongoDB for subsequent use
  - No repeated LLM calls during document ingestion
- [ ] Integration tests:
  - Load banking domain definition
  - Parse with LLM (Sonnet)
  - Verify structured taxonomy output
  - Store in MongoDB
  - Retrieve and verify

**Implementation Details**:

**MongoDB Schema**:

```typescript
// packages/search-ai/src/models/knowledge-graph-taxonomy.model.ts

import { Schema, model, Document, Types } from 'mongoose';

interface DomainTaxonomy {
  domain: {
    id: string; // "banking"
    name: string; // "Banking & Financial Institutions"
    description: string;
  };
  categories: Array<{
    id: string;
    name: string;
    department: string;
  }>;
  products: Array<{
    id: string;
    name: string;
    description: string;
    categoryId: string;
    disambiguationKeywords: string[];
  }>;
  attributes: Array<{
    id: string;
    name: string;
    applicableTo: string[];
    notApplicableTo: string[];
  }>;
  departmentBoundaries: Array<{
    product1: string;
    product2: string;
    reasoning: string;
  }>;
}

interface KnowledgeGraphTaxonomy extends Document {
  _id: Types.ObjectId;
  tenantId: string;
  indexId: string;

  // Parsed taxonomy (from LLM)
  taxonomy: DomainTaxonomy;

  // Metadata
  version: string; // "1.0", "1.1", etc.
  domains: string[]; // ["banking", "financial-services"]
  customDomainFiles: string[]; // S3 URLs
  organizationProfileFile: string; // S3 URL

  createdAt: Date;
  updatedAt: Date;
}

const KnowledgeGraphTaxonomySchema = new Schema<KnowledgeGraphTaxonomy>({
  tenantId: { type: String, required: true, index: true },
  indexId: { type: String, required: true, index: true },
  taxonomy: { type: Schema.Types.Mixed, required: true },
  version: { type: String, required: true, default: '1.0' },
  domains: { type: [String], required: true },
  customDomainFiles: { type: [String], default: [] },
  organizationProfileFile: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Compound index for fast lookup
KnowledgeGraphTaxonomySchema.index({ tenantId: 1, indexId: 1 }, { unique: true });

export const KnowledgeGraphTaxonomyModel = model<KnowledgeGraphTaxonomy>(
  'KnowledgeGraphTaxonomy',
  KnowledgeGraphTaxonomySchema,
);
```

**Taxonomy Loading Service**:

```typescript
// packages/search-ai/src/services/taxonomy-loader.ts

import Anthropic from '@anthropic-ai/sdk';
import { KnowledgeGraphTaxonomyModel } from '../models/knowledge-graph-taxonomy.model';
import { DomainTaxonomy } from '../types/domain-taxonomy';
import fs from 'fs/promises';
import path from 'path';

export class TaxonomyLoader {
  constructor(
    private anthropic: Anthropic,
    private s3Client: S3Client,
  ) {}

  async loadTaxonomy(
    tenantId: string,
    indexId: string,
    domains: string[],
    organizationProfileUrl: string,
    customDomainUrls: string[] = [],
  ): Promise<DomainTaxonomy> {
    console.log(
      `[TaxonomyLoader] Loading taxonomy for index: ${indexId}, domains: ${domains.join(', ')}`,
    );

    // Step 1: Load default domain definitions from filesystem
    const defaultDomainContents: string[] = [];
    for (const domainId of domains) {
      const domainPath = path.join(
        __dirname,
        `../../docs/knowledge-graph/domain-definitions/${domainId}.md`,
      );
      const content = await fs.readFile(domainPath, 'utf-8');
      defaultDomainContents.push(content);
    }

    // Step 2: Load custom domain definitions from S3 (if provided)
    const customDomainContents: string[] = [];
    for (const url of customDomainUrls) {
      const content = await this.s3Client.getObject(url);
      customDomainContents.push(content);
    }

    // Step 3: Load organization profile from S3
    const orgProfileContent = await this.s3Client.getObject(organizationProfileUrl);

    // Step 4: Parse with LLM (Sonnet)
    const taxonomy = await this.parseTaxonomyWithLLM(
      defaultDomainContents,
      customDomainContents,
      orgProfileContent,
    );

    // Step 5: Store in MongoDB
    await KnowledgeGraphTaxonomyModel.findOneAndUpdate(
      { tenantId, indexId },
      {
        $set: {
          taxonomy,
          version: '1.0',
          domains,
          customDomainFiles: customDomainUrls,
          organizationProfileFile: organizationProfileUrl,
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );

    console.log(`[TaxonomyLoader] Taxonomy loaded and stored for index: ${indexId}`);
    return taxonomy;
  }

  private async parseTaxonomyWithLLM(
    defaultDomains: string[],
    customDomains: string[],
    orgProfile: string,
  ): Promise<DomainTaxonomy> {
    const prompt = `You are a taxonomy parser for a knowledge graph system. Parse the provided domain definitions and organization profile into a structured taxonomy.

**Domain Definitions** (default):
${defaultDomains.map((content, i) => `\n### Domain ${i + 1}\n${content}`).join('\n')}

**Custom Domain Definitions** (overrides):
${customDomains.length > 0 ? customDomains.map((content, i) => `\n### Custom Domain ${i + 1}\n${content}`).join('\n') : 'None'}

**Organization Profile**:
${orgProfile}

**Output Format** (JSON):
{
  "domain": {
    "id": "banking",
    "name": "Banking & Financial Institutions",
    "description": "..."
  },
  "categories": [
    { "id": "cards", "name": "Cards", "department": "Card Services" }
  ],
  "products": [
    {
      "id": "credit_card",
      "name": "Credit Card",
      "description": "...",
      "categoryId": "cards",
      "disambiguationKeywords": ["credit", "APR", "revolving"]
    }
  ],
  "attributes": [
    {
      "id": "interest_rate",
      "name": "Interest Rate",
      "applicableTo": ["credit_card", "housing_loan"],
      "notApplicableTo": ["debit_card", "checking_account"]
    }
  ],
  "departmentBoundaries": [
    {
      "product1": "credit_card",
      "product2": "debit_card",
      "reasoning": "Different voltage classes..."
    }
  ]
}

**Merge Strategy**: If multiple domains provided, use UNION merge (combine all products, categories, attributes). If conflicts, prefer custom over default.

Parse now:`;

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    });

    const taxonomyJson = response.content[0].type === 'text' ? response.content[0].text : '';
    const taxonomy: DomainTaxonomy = JSON.parse(taxonomyJson);

    return taxonomy;
  }

  async getTaxonomy(tenantId: string, indexId: string): Promise<DomainTaxonomy | null> {
    const doc = await KnowledgeGraphTaxonomyModel.findOne({ tenantId, indexId });
    return doc ? doc.taxonomy : null;
  }
}
```

**Estimated Effort**: 2 days

**Dependencies**: Task #60 (taxonomy graph builder)

**Blocked By**: None

**Blocks**: Task #54 (classification needs taxonomy), Task #62 (confidence threshold needs taxonomy)

---

#### Task #63: Build Organization Profile Template and API

**Priority**: P0 (blocking taxonomy setup)

**Description**: Create organization profile template (markdown) and API endpoints for tenant admins to upload/manage organization profiles.

**Acceptance Criteria**:

- [ ] Organization profile template exists:
  - `apps/search-ai/docs/knowledge-graph/customer-organization-template.md` (already created)
  - Sections: Company Overview, Product Disambiguation (CRITICAL), Domain Terminology, Business Processes, Regulatory Context
- [ ] API endpoints implemented:
  - `POST /api/knowledge-graph/:indexId/organization-profile` - Upload org profile
  - `GET /api/knowledge-graph/:indexId/organization-profile` - Retrieve org profile
  - `PUT /api/knowledge-graph/:indexId/organization-profile` - Update org profile (triggers re-classification)
  - `DELETE /api/knowledge-graph/:indexId/organization-profile` - Delete org profile
- [ ] Authentication: Tenant admin role required (`requireTenantAdmin` middleware)
- [ ] Storage: S3 for markdown content, MongoDB for metadata
- [ ] Validation: Markdown file size limit (10MB), required sections check
- [ ] Audit logging: Track tenantId, userId, action, timestamp
- [ ] Integration tests:
  - Upload org profile as tenant admin
  - Retrieve org profile
  - Update triggers taxonomy re-load
  - Non-admin user rejected (403)

**Implementation Details**:

**API Endpoints**:

```typescript
// packages/search-ai/src/routes/knowledge-graph.routes.ts

import { Router } from 'express';
import { requireAuth, requireTenantAdmin } from '@agent-platform/shared/middleware/auth';
import { TaxonomyLoader } from '../services/taxonomy-loader';
import { S3Client } from '../services/s3-client';
import { AuditLog } from '../models/audit-log.model';

const router = Router();

// Upload organization profile
router.post(
  '/api/knowledge-graph/:indexId/organization-profile',
  requireAuth,
  requireTenantAdmin,
  async (req, res) => {
    const { indexId } = req.params;
    const { tenantId } = req.user;
    const { organizationProfile } = req.body; // Markdown content

    // Step 1: Verify index belongs to tenant
    const index = await SearchIndex.findOne({ _id: indexId, tenantId });
    if (!index) {
      return res.status(404).json({ error: 'Index not found' });
    }

    // Step 2: Validate file size (10MB limit)
    if (organizationProfile.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Organization profile exceeds 10MB limit' });
    }

    // Step 3: Upload to S3
    const s3Client = new S3Client();
    const orgProfileUrl = await s3Client.uploadFile(
      `knowledge-graph/${tenantId}/${indexId}/organization-profile.md`,
      organizationProfile,
    );

    // Step 4: Load taxonomy (triggers LLM parsing)
    const taxonomyLoader = new TaxonomyLoader(anthropic, s3Client);
    const taxonomy = await taxonomyLoader.loadTaxonomy(
      tenantId,
      indexId,
      index.knowledgeGraph.domains,
      orgProfileUrl,
      index.knowledgeGraph.customDomainFiles || [],
    );

    // Step 5: Create taxonomy graph in Neo4j
    const graphBuilder = new TaxonomyGraphBuilder(neo4jDriver);
    await graphBuilder.createTaxonomyGraph(taxonomy);

    // Step 6: Audit log
    await AuditLog.create({
      tenantId,
      userId: req.user.id,
      action: 'ORGANIZATION_PROFILE_UPLOAD',
      resource: 'knowledge-graph-taxonomy',
      resourceId: indexId,
      metadata: {
        orgProfileSize: organizationProfile.length,
        domains: index.knowledgeGraph.domains,
      },
      timestamp: new Date(),
    });

    res.json({ success: true, organizationProfileUrl: orgProfileUrl });
  },
);

// Retrieve organization profile
router.get(
  '/api/knowledge-graph/:indexId/organization-profile',
  requireAuth,
  requireTenantAdmin,
  async (req, res) => {
    const { indexId } = req.params;
    const { tenantId } = req.user;

    const taxonomy = await KnowledgeGraphTaxonomyModel.findOne({ tenantId, indexId });
    if (!taxonomy) {
      return res.status(404).json({ error: 'Organization profile not found' });
    }

    // Download from S3
    const s3Client = new S3Client();
    const content = await s3Client.getObject(taxonomy.organizationProfileFile);

    res.json({ organizationProfile: content, url: taxonomy.organizationProfileFile });
  },
);

// Update organization profile
router.put(
  '/api/knowledge-graph/:indexId/organization-profile',
  requireAuth,
  requireTenantAdmin,
  async (req, res) => {
    const { indexId } = req.params;
    const { tenantId } = req.user;
    const { organizationProfile } = req.body;

    // Upload new version to S3
    const s3Client = new S3Client();
    const orgProfileUrl = await s3Client.uploadFile(
      `knowledge-graph/${tenantId}/${indexId}/organization-profile.md`,
      organizationProfile,
    );

    // Re-load taxonomy
    const taxonomyLoader = new TaxonomyLoader(anthropic, s3Client);
    const index = await SearchIndex.findOne({ _id: indexId, tenantId });
    const taxonomy = await taxonomyLoader.loadTaxonomy(
      tenantId,
      indexId,
      index.knowledgeGraph.domains,
      orgProfileUrl,
      index.knowledgeGraph.customDomainFiles || [],
    );

    // Update taxonomy graph
    const graphBuilder = new TaxonomyGraphBuilder(neo4jDriver);
    await graphBuilder.deleteTaxonomyGraph(taxonomy.domain.id);
    await graphBuilder.createTaxonomyGraph(taxonomy);

    // Flag all chunks for re-classification
    await SearchChunk.updateMany(
      { tenantId, indexId },
      { $set: { 'metadata.needsReclassification': true, 'metadata.taxonomyVersion': '1.0' } },
    );

    // Audit log
    await AuditLog.create({
      tenantId,
      userId: req.user.id,
      action: 'ORGANIZATION_PROFILE_UPDATE',
      resource: 'knowledge-graph-taxonomy',
      resourceId: indexId,
      timestamp: new Date(),
    });

    res.json({ success: true, organizationProfileUrl: orgProfileUrl });
  },
);

export default router;
```

**Estimated Effort**: 2 days

**Dependencies**: Task #53 (taxonomy loader)

**Blocked By**: None

**Blocks**: None (enables tenant self-service)

---

### Phase 2: Classification

---

#### Task #54: Implement Product Scope Detection for Documents and Queries

**Priority**: P0 (blocking entity extraction)

**Description**: Implement hybrid LLM classification service (Haiku primary, Sonnet escalation) for chunk-level product scope classification during document ingestion.

**Acceptance Criteria**:

- [ ] Classification service implemented:
  - `classifyChunk(content: string, taxonomy: DomainTaxonomy): Promise<ChunkClassification>`
  - Hybrid approach: Haiku primary, Sonnet escalation if confidence < 0.8
  - Returns: primaryProduct, confidence, secondaryProducts, department, category
- [ ] Integration with document ingestion pipeline:
  - Classify each chunk during ingestion
  - Store classification in `classification` field on SearchChunk
- [ ] Query classification:
  - `classifyQuery(query: string, taxonomy: DomainTaxonomy): Promise<string>`
  - Returns product scope for query (e.g., "credit_card")
- [ ] Monitoring:
  - Track escalation rate (target: 20% or less)
  - Log classification duration (Haiku ~500ms, Sonnet ~1-2s)
- [ ] Integration tests:
  - Classify chunk about credit cards → primaryProduct="credit_card"
  - Classify comparison doc → primaryProduct="credit_card", secondaryProducts=["debit_card"]
  - Classify ambiguous chunk (confidence < 0.8) → Escalate to Sonnet

**Implementation Details**:

**Classification Service**:

```typescript
// packages/search-ai/src/services/chunk-classifier.ts

import Anthropic from '@anthropic-ai/sdk';
import { DomainTaxonomy, ChunkClassification } from '../types/domain-taxonomy';

export class ChunkClassifier {
  constructor(private anthropic: Anthropic) {}

  async classifyChunk(content: string, taxonomy: DomainTaxonomy): Promise<ChunkClassification> {
    // Step 1: Try Haiku first
    const haikuResult = await this.classifyWithHaiku(content, taxonomy);

    // Step 2: Check confidence
    if (haikuResult.productScope.confidence >= 0.8) {
      // High confidence → Accept Haiku classification
      return {
        ...haikuResult,
        classificationMethod: 'llm',
      };
    }

    // Step 3: Low confidence → Escalate to Sonnet
    console.log(
      `[ChunkClassifier] Low confidence (${haikuResult.productScope.confidence}), escalating to Sonnet`,
    );
    const sonnetResult = await this.classifyWithSonnet(content, taxonomy);
    return {
      ...sonnetResult,
      classificationMethod: 'llm',
    };
  }

  private async classifyWithHaiku(
    content: string,
    taxonomy: DomainTaxonomy,
  ): Promise<ChunkClassification> {
    const prompt = this.buildClassificationPrompt(content, taxonomy);

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const resultText = response.content[0].type === 'text' ? response.content[0].text : '';
    const result = JSON.parse(resultText);

    return {
      productScope: {
        primaryProduct: result.primaryProduct,
        confidence: result.confidence,
        secondaryProducts: result.secondaryProducts || [],
      },
      department: result.department,
      subDepartment: result.subDepartment,
      category: result.category,
      classifiedAt: new Date(),
      classificationMethod: 'llm',
    };
  }

  private async classifyWithSonnet(
    content: string,
    taxonomy: DomainTaxonomy,
  ): Promise<ChunkClassification> {
    const prompt = this.buildClassificationPrompt(content, taxonomy);

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const resultText = response.content[0].type === 'text' ? response.content[0].text : '';
    const result = JSON.parse(resultText);

    return {
      productScope: {
        primaryProduct: result.primaryProduct,
        confidence: result.confidence,
        secondaryProducts: result.secondaryProducts || [],
      },
      department: result.department,
      subDepartment: result.subDepartment,
      category: result.category,
      classifiedAt: new Date(),
      classificationMethod: 'llm',
    };
  }

  private buildClassificationPrompt(content: string, taxonomy: DomainTaxonomy): string {
    const productList = taxonomy.products
      .map((p) => `- ${p.id}: ${p.name} (keywords: ${p.disambiguationKeywords.join(', ')})`)
      .join('\n');

    return `You are a document classifier for a knowledge graph system. Classify the following text chunk by product scope.

**Available Products**:
${productList}

**Text Chunk**:
${content}

**Task**: Determine which product this text is primarily about. If it mentions multiple products, identify the primary product and list secondary products.

**Output Format** (JSON):
{
  "primaryProduct": "credit_card",
  "confidence": 0.85,
  "secondaryProducts": ["rewards_program"],
  "department": "Card Services",
  "subDepartment": "Credit Card Division",
  "category": "Cards"
}

**Confidence Guidelines**:
- 0.9-1.0: Unambiguous (clear keywords, single product focus)
- 0.7-0.89: Likely (multiple keywords match, some ambiguity)
- 0.5-0.69: Uncertain (weak keyword matches, high ambiguity)
- Below 0.5: Cannot classify confidently

Classify now:`;
  }

  async classifyQuery(query: string, taxonomy: DomainTaxonomy): Promise<string> {
    // For queries, use Haiku only (fast, cost-effective)
    const result = await this.classifyWithHaiku(query, taxonomy);
    return result.productScope.primaryProduct;
  }
}
```

**Integration with Ingestion Pipeline**:

```typescript
// packages/search-ai/src/services/document-ingestion.service.ts

import { ChunkClassifier } from './chunk-classifier';
import { TaxonomyLoader } from './taxonomy-loader';

export class DocumentIngestionService {
  async ingestDocument(documentId: string, tenantId: string, indexId: string): Promise<void> {
    // Step 1: Load document
    const document = await SearchDocument.findById(documentId);

    // Step 2: Load taxonomy (cached in MongoDB)
    const taxonomyLoader = new TaxonomyLoader(anthropic, s3Client);
    const taxonomy = await taxonomyLoader.getTaxonomy(tenantId, indexId);

    if (!taxonomy) {
      console.log(`[Ingestion] No taxonomy found for index ${indexId}, skipping classification`);
      // Continue with ingestion without classification (backward compatibility)
    }

    // Step 3: Chunk document
    const chunks = await this.chunkDocument(document);

    // Step 4: Classify each chunk
    const classifier = new ChunkClassifier(anthropic);
    for (const chunk of chunks) {
      if (taxonomy) {
        const classification = await classifier.classifyChunk(chunk.content, taxonomy);
        chunk.classification = classification;
      }

      // Step 5: Generate embedding
      chunk.embedding = await this.generateEmbedding(chunk.content);

      // Step 6: Save chunk
      await SearchChunk.create(chunk);
    }
  }
}
```

**Estimated Effort**: 3 days

**Dependencies**: Task #53 (taxonomy loader), Task #61 (chunk schema)

**Blocked By**: None

**Blocks**: Task #55 (entity extraction needs classification), Task #57 (query disambiguation needs classification)

---

#### Task #62: Implement Configurable Confidence Threshold per Index

**Priority**: P1 (nice-to-have for MVP)

**Description**: Add configurable confidence threshold setting to index configuration for product classification filtering.

**Acceptance Criteria**:

- [ ] SearchIndex schema updated:
  - `knowledgeGraph.classificationThreshold` field (default: 0.7)
- [ ] Threshold validation: Must be between 0.0 and 1.0
- [ ] Filtering logic: Chunks with confidence < threshold marked as "unknown" product scope
- [ ] API endpoint: `PUT /api/search-indexes/:indexId/knowledge-graph/threshold` (tenant admin)
- [ ] Integration tests:
  - Set threshold to 0.8 (strict)
  - Classify chunk with confidence 0.75 → Marked as "unknown"
  - Set threshold to 0.6 (lenient)
  - Same chunk now classified as primary product

**Implementation Details**:

**Schema Update**:

```typescript
// packages/search-ai/src/models/search-index.model.ts

interface SearchIndex extends Document {
  // ...existing fields
  knowledgeGraph: {
    enabled: boolean;
    domains: string[]; // ["banking", "financial-services"]
    classificationThreshold: number; // 0.7 (default)
    taxonomyVersion: string; // "1.0"
  };
}

const SearchIndexSchema = new Schema<SearchIndex>({
  // ...existing fields
  knowledgeGraph: {
    enabled: { type: Boolean, default: false },
    domains: { type: [String], default: [] },
    classificationThreshold: { type: Number, default: 0.7, min: 0.0, max: 1.0 },
    taxonomyVersion: { type: String, default: '1.0' },
  },
});
```

**Filtering Logic**:

```typescript
// packages/search-ai/src/services/chunk-classifier.ts

async classifyChunk(
  content: string,
  taxonomy: DomainTaxonomy,
  threshold: number = 0.7
): Promise<ChunkClassification> {
  const classification = await this.classifyWithHaiku(content, taxonomy);

  // Apply threshold
  if (classification.productScope.confidence < threshold) {
    console.log(`[ChunkClassifier] Confidence ${classification.productScope.confidence} below threshold ${threshold}, marking as unknown`);
    return {
      ...classification,
      productScope: {
        primaryProduct: 'unknown',
        confidence: classification.productScope.confidence,
        secondaryProducts: [],
      },
    };
  }

  return classification;
}
```

**API Endpoint**:

```typescript
router.put(
  '/api/search-indexes/:indexId/knowledge-graph/threshold',
  requireAuth,
  requireTenantAdmin,
  async (req, res) => {
    const { indexId } = req.params;
    const { tenantId } = req.user;
    const { threshold } = req.body;

    // Validate threshold
    if (threshold < 0.0 || threshold > 1.0) {
      return res.status(400).json({ error: 'Threshold must be between 0.0 and 1.0' });
    }

    // Update index
    await SearchIndex.findOneAndUpdate(
      { _id: indexId, tenantId },
      { $set: { 'knowledgeGraph.classificationThreshold': threshold } },
    );

    res.json({ success: true, threshold });
  },
);
```

**Estimated Effort**: 1 day

**Dependencies**: Task #54 (classification service)

**Blocked By**: None

**Blocks**: None

---

### Phase 3: Entity Extraction

---

#### Task #55: Implement Context-Aware Entity Extraction with Attribute Scoping

**Priority**: P0 (blocking relationships)

**Description**: Extract entities from chunks with product context and attribute scoping (interest_rate applies to credit_card, NOT debit_card).

**Acceptance Criteria**:

- [ ] Context-aware entity extraction service:
  - `extractEntities(chunk: SearchChunk, taxonomy: DomainTaxonomy): Promise<ContextualEntity[]>`
  - Uses chunk classification (primaryProduct) to scope attribute extraction
  - Loads applicable attributes from taxonomy
  - Extracts product identifiers (regex)
  - Extracts attributes (LLM with context-aware prompt)
  - Tags entities with: productType, inScopeMatch, confidence, attributeApplicable
- [ ] ContextualEntity interface:
  - `text` (entity text), `type` (entity type), `start/end` (position)
  - `productType` (chunk's primaryProduct)
  - `context.inScopeMatch` (entity matches chunk scope)
  - `context.attributeApplicable` (attribute applies to product per taxonomy)
- [ ] Integration with ingestion pipeline:
  - Extract entities after chunk classification
  - Store entities in `metadata.entities` on SearchChunk
- [ ] Integration tests:
  - Extract "18% APR" from credit card chunk → attributeApplicable=true
  - Extract "18% APR" from debit card chunk → attributeApplicable=false (should NOT extract)
  - Extract product comparison ("credit card vs debit card") → Both marked with inScopeMatch flags

**Implementation Details**:

**ContextualEntity Interface**:

```typescript
// packages/search-ai/src/types/contextual-entity.ts

export interface ContextualEntity {
  text: string; // "18% APR"
  type: string; // "interest_rate"
  start: number;
  end: number;
  productType: string; // "credit_card" (from chunk classification)
  context: {
    documentScope: string; // "credit_card"
    chunkScope: string; // "credit_card"
    inScopeMatch: boolean; // true (entity matches chunk scope)
    confidence: number; // 0.92
    attributeApplicable: boolean; // true (interest_rate applies to credit_card)
  };
  extractionMethod: 'regex' | 'compromise' | 'llm';
}
```

**Context-Aware Entity Extraction Service**:

```typescript
// packages/search-ai/src/services/contextual-entity-extractor.ts

import Anthropic from '@anthropic-ai/sdk';
import { DomainTaxonomy, ContextualEntity } from '../types/domain-taxonomy';
import { SearchChunk } from '../models/search-chunk.model';

export class ContextualEntityExtractor {
  constructor(private anthropic: Anthropic) {}

  async extractEntities(chunk: SearchChunk, taxonomy: DomainTaxonomy): Promise<ContextualEntity[]> {
    if (!chunk.classification) {
      console.log('[ContextualEntityExtractor] Chunk not classified, skipping entity extraction');
      return [];
    }

    const primaryProduct = chunk.classification.productScope.primaryProduct;

    // Step 1: Load applicable attributes for this product
    const applicableAttributes = taxonomy.attributes.filter((attr) =>
      attr.applicableTo.includes(primaryProduct),
    );

    const notApplicableAttributes = taxonomy.attributes.filter((attr) =>
      attr.notApplicableTo.includes(primaryProduct),
    );

    // Step 2: Extract product identifiers (regex)
    const productIdentifiers = this.extractProductIdentifiers(chunk.content, taxonomy);

    // Step 3: Extract attributes (LLM with context-aware prompt)
    const attributeEntities = await this.extractAttributesWithLLM(
      chunk.content,
      primaryProduct,
      applicableAttributes,
      notApplicableAttributes,
    );

    // Step 4: Tag entities with product context
    const taggedEntities = [...productIdentifiers, ...attributeEntities].map((entity) => ({
      ...entity,
      productType: primaryProduct,
      context: {
        documentScope: primaryProduct,
        chunkScope: primaryProduct,
        inScopeMatch: entity.productType === primaryProduct,
        confidence: chunk.classification.productScope.confidence,
        attributeApplicable: applicableAttributes.some((attr) => attr.id === entity.type),
      },
    }));

    return taggedEntities;
  }

  private extractProductIdentifiers(
    content: string,
    taxonomy: DomainTaxonomy,
  ): Partial<ContextualEntity>[] {
    const entities: Partial<ContextualEntity>[] = [];

    for (const product of taxonomy.products) {
      for (const keyword of product.disambiguationKeywords) {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        let match;
        while ((match = regex.exec(content)) !== null) {
          entities.push({
            text: match[0],
            type: product.id,
            start: match.index,
            end: match.index + match[0].length,
            extractionMethod: 'regex',
          });
        }
      }
    }

    return entities;
  }

  private async extractAttributesWithLLM(
    content: string,
    primaryProduct: string,
    applicableAttributes: Array<{ id: string; name: string }>,
    notApplicableAttributes: Array<{ id: string; name: string }>,
  ): Promise<Partial<ContextualEntity>[]> {
    const applicableList = applicableAttributes.map((a) => `- ${a.id}: ${a.name}`).join('\n');
    const notApplicableList = notApplicableAttributes.map((a) => `- ${a.id}: ${a.name}`).join('\n');

    const prompt = `You are an entity extractor for a knowledge graph system. Extract attributes from the following text chunk.

**Product Scope**: ${primaryProduct}

**Applicable Attributes** (EXTRACT these):
${applicableList}

**NOT Applicable Attributes** (DO NOT EXTRACT these - they don't apply to ${primaryProduct}):
${notApplicableList}

**Text Chunk**:
${content}

**Task**: Extract ONLY applicable attributes. For each attribute found, provide:
- text: The exact text (e.g., "18% APR")
- type: The attribute ID (e.g., "interest_rate")
- start/end: Character positions

**Output Format** (JSON array):
[
  { "text": "18% APR", "type": "interest_rate", "start": 45, "end": 52 }
]

**IMPORTANT**: Do NOT extract attributes from the "NOT Applicable" list. For example, if the product is debit_card, do NOT extract interest_rate even if mentioned (it doesn't apply to debit cards).

Extract now:`;

    const response = await this.anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const resultText = response.content[0].type === 'text' ? response.content[0].text : '[]';
    const entities: Partial<ContextualEntity>[] = JSON.parse(resultText);

    return entities.map((e) => ({
      ...e,
      extractionMethod: 'llm' as const,
    }));
  }
}
```

**Integration with Ingestion**:

```typescript
// packages/search-ai/src/services/document-ingestion.service.ts

export class DocumentIngestionService {
  async ingestDocument(documentId: string, tenantId: string, indexId: string): Promise<void> {
    // ... chunk and classify ...

    const entityExtractor = new ContextualEntityExtractor(anthropic);
    for (const chunk of chunks) {
      if (taxonomy && chunk.classification) {
        // Extract entities with product context
        const entities = await entityExtractor.extractEntities(chunk, taxonomy);
        chunk.metadata.entities = entities;
      }

      await SearchChunk.create(chunk);
    }
  }
}
```

**Estimated Effort**: 3 days

**Dependencies**: Task #54 (classification)

**Blocked By**: None

**Blocks**: Task #56 (relationship building needs entities)

---

### Phase 4: Relationships (Week 5)

#### Task #56: Implement Scoped Relationship Building with Department Boundaries

**Priority**: P1

**Description**: Build scoped relationships in Neo4j with department boundary enforcement to prevent false relationships.

**Acceptance Criteria**:

- [ ] Relationship builder service implemented
- [ ] Department boundary enforcement (EXCLUDES relationships)
- [ ] Relationship types: MENTIONS, APPLIES_TO, RELATED_TO (scoped)
- [ ] Integration tests with boundary violations

**Estimated Effort**: 3 days

**Dependencies**: Task #55 (entities)

---

### Phase 5: Query-Time (Week 6)

#### Task #57: Implement Query-Time Disambiguation and Scoped Retrieval

**Priority**: P0

**Description**: Implement query scope classification, impossible query detection, and scoped retrieval with multi-scope document ranking.

**Acceptance Criteria**:

- [ ] Query classification service
- [ ] Impossible query detection
- [ ] Scoped retrieval with filtering
- [ ] Multi-scope ranking (1.0 primary, 0.7 secondary)

**Estimated Effort**: 3 days

**Dependencies**: Task #56 (relationships)

---

### Phase 6: API & Testing (Weeks 7-8)

#### Task #58: Build Knowledge Graph Configuration API and Admin UI

**Priority**: P1

**Estimated Effort**: 4 days

---

#### Task #59: Create Real-World Test Datasets for KG Disambiguation Validation

**Priority**: P1

**Estimated Effort**: 3 days

---

#### Task #64: Implement One-Time Taxonomy Setup Workflow

**Priority**: P0

**Estimated Effort**: 2 days

---

#### Task #65: Build Taxonomy Update Workflow with Re-Classification

**Priority**: P1

**Estimated Effort**: 3 days

---

## Dependencies Graph

```
Phase 1: Foundation
├── Task #60 (Neo4j) ──────────┐
├── Task #61 (Schema) ─────┐   │
├── Task #53 (Taxonomy) ───┤   │
└── Task #63 (API) ────────┘   │
                               │
Phase 2: Classification        │
├── Task #54 (Classification) <┴─ Depends on #53, #61
└── Task #62 (Threshold) <──── Depends on #54
                               │
Phase 3: Entity Extraction     │
└── Task #55 (Entities) <──────┴─ Depends on #54
                               │
Phase 4: Relationships         │
└── Task #56 (Relations) <─────┴─ Depends on #55
                               │
Phase 5: Query-Time            │
└── Task #57 (Query) <─────────┴─ Depends on #56
                               │
Phase 6: API & Testing         │
├── Task #58 (API) <───────────┤
├── Task #59 (Tests) <─────────┤
├── Task #64 (Setup) <─────────┤
└── Task #65 (Update) <────────┴─ Depends on #57
```

---

## Risk Mitigation

### Risk 1: LLM Cost Overruns

**Mitigation**:

- Start with Haiku-only for MVP (cheapest: $0.275 per 1K docs)
- Monitor escalation rate (target: < 20%)
- Implement cost alerts ($100/day threshold)
- Provide tenant-level cost dashboards

### Risk 2: Classification Accuracy Below Target (91%)

**Mitigation**:

- Comprehensive testing with real-world datasets (Task #59)
- Iterate on LLM prompts based on failure analysis
- Provide manual override UI for misclassified chunks
- Implement feedback loop (user corrections → training data)

### Risk 3: Neo4j Performance Degradation

**Mitigation**:

- Start with standard indexing (proven approach)
- Monitor query times (alert if > 50ms)
- Implement query caching (5-minute TTL)
- Add full-text indexes if keyword matching becomes bottleneck

### Risk 4: Taxonomy Migration Delays

**Mitigation**:

- Use incremental re-classification (Phase 4 recommendation)
- Prioritize high-traffic documents (20% accessed in week 1)
- Provide admin UI to trigger batch re-classification if needed
- Implement progress tracking and ETA estimates

---

## Success Criteria

### Phase 1 Complete When:

- [ ] Neo4j schema created with standard indexing
- [ ] Chunk schema has `classification` field
- [ ] Taxonomy loading service operational (Sonnet-based parsing)
- [ ] Organization profile API accepts uploads from tenant admins

### Phase 2 Complete When:

- [ ] Hybrid LLM classification (Haiku + Sonnet escalation) working
- [ ] Chunks classified during ingestion with 91% accuracy
- [ ] Configurable confidence threshold per index

### Phase 3 Complete When:

- [ ] Entities extracted with product context and attribute scoping
- [ ] "18% APR" extracted from credit card chunks, NOT debit card chunks
- [ ] Entity storage includes full context metadata

### Phase 4 Complete When:

- [ ] Scoped relationships created in Neo4j
- [ ] Department boundaries enforced (credit_card EXCLUDES debit_card)
- [ ] False relationship prevention rate > 95%

### Phase 5 Complete When:

- [ ] Queries classified by product scope
- [ ] Impossible queries detected ("What is the interest rate on debit cards?" → ERROR)
- [ ] Scoped retrieval filters chunks by product scope
- [ ] Multi-scope ranking returns comparison docs ranked lower

### Phase 6 Complete When:

- [ ] Taxonomy upload API operational (tenant admin auth)
- [ ] Taxonomy update triggers incremental re-classification
- [ ] Admin UI allows taxonomy management
- [ ] Real-world test datasets validate 91% accuracy

### MVP Launch Criteria:

- [ ] All Phase 1-5 tasks complete
- [ ] 91% classification accuracy on test datasets
- [ ] 95% false relationship prevention rate
- [ ] Query-time performance < 50ms overhead
- [ ] Cost per 1,000 docs < $2 (target: $1.15)
- [ ] Documentation complete (user guide, API reference)

---

## Monitoring & Observability

### Metrics to Track:

**Classification Metrics**:

- Classification accuracy (target: 91%)
- Escalation rate (target: < 20%)
- Average confidence score (target: > 0.8)
- Classification duration (Haiku: ~500ms, Sonnet: ~1-2s)

**Cost Metrics**:

- Cost per 1,000 docs (target: $1.15)
- Monthly LLM spend by tenant
- Escalation cost vs baseline cost

**Performance Metrics**:

- Neo4j query time (target: < 10ms)
- Chunk classification time (target: < 2s)
- Query-time disambiguation overhead (target: < 50ms)
- End-to-end retrieval time (target: < 500ms)

**Quality Metrics**:

- False relationship rate (target: < 5%)
- Entity extraction precision (target: > 85%)
- Impossible query detection rate (target: > 90%)
- User satisfaction score (target: > 4/5)

### Dashboards:

**Admin Dashboard** (per tenant):

- Total documents ingested
- Classification accuracy breakdown by product
- Cost breakdown (taxonomy parsing, classification, escalation)
- Taxonomy version and last update date

**Engineering Dashboard** (platform-wide):

- Escalation rate trend
- Classification duration histogram
- Neo4j query performance
- Error rate by task

---

## Rollout Plan

### Week 1-2 (Phase 1):

- **Internal testing**: Load banking domain, classify test documents
- **Stakeholders**: Engineering team only

### Week 3 (Phase 2):

- **Alpha testing**: 1 pilot customer (banking industry)
- **Stakeholders**: Engineering + pilot customer

### Week 4 (Phase 3):

- **Expand alpha**: 2 more pilot customers (manufacturing, pharma)
- **Stakeholders**: Engineering + 3 pilot customers

### Week 5 (Phase 4):

- **Beta testing**: 10 customers across multiple industries
- **Stakeholders**: Engineering + beta customers

### Week 6 (Phase 5):

- **Beta expansion**: 50 customers
- **Stakeholders**: Engineering + Product + beta customers

### Week 7-8 (Phase 6):

- **General Availability**: All customers
- **Stakeholders**: All

---

## Post-MVP Enhancements (Future Phases)

### Phase 7: Advanced Features (Weeks 9-12)

**Task #66**: Implement comparison intent detection (Option 3C from Q3)

- Detect comparison queries ("credit card vs debit card")
- Boost comparison docs when user wants comparison
- Penalize comparison docs when user wants specific product

**Task #67**: Implement hot/cold document split (Option 4C from Q4)

- Identify hot documents (top 20% by query frequency)
- Immediately re-classify hot documents on taxonomy update
- Lazy re-classify cold documents

**Task #68**: Implement project-level permissions (Option 5C from Q5)

- Project admin role can upload taxonomy for their project
- Granular control for multi-project tenants

**Task #69**: Add full-text search indexes (Neo4j optimization)

- Full-text index on `Product.disambiguationKeywords`
- Composite indexes for multi-field queries
- Performance improvement: Sub-5ms queries

**Task #70**: Build taxonomy validation service

- Validate taxonomy structure before upload
- Detect conflicts (attribute applicable AND not-applicable)
- Suggest fixes for common errors

---

**End of Implementation Plan**

# RFC-001: Simplify Taxonomy Setup for Knowledge Graph

> **Status**: Draft (Revised after Architecture Review)
> **Date**: 2026-03-03 (Updated: 2026-03-03)
> **Authors**: Bharath (Product), Claude Opus 4.6 (Design)
> **Reviewers**: search-ai-architect (Architecture Review Complete)
> **Related Documents**:
>
> - DESIGN-domain-aware-knowledge-graph.md (6-stage architecture)
> - FINAL-DESIGN.md (approved implementation design)
> - DESIGN-DISCUSSION-updated.md (10 confirmed design decisions)
> - customer-organization-template.md (7-section customer template)
>
> **Architecture Review**: 3 CRITICAL, 4 HIGH, 4 MEDIUM findings addressed in this revision

---

## 1. Problem Statement

### 1.1 The Taxonomy Setup Burden

The domain-aware knowledge graph requires taxonomy to be configured **before** enrichment runs. This is a correct architectural decision — the taxonomy constrains entity extraction, prevents false cross-product relationships, and bounds the Neo4j graph. Without upfront taxonomy, a credit card query returns debit card interest rates, and the graph explodes with millions of irrelevant nodes.

However, the current setup flow imposes an unreasonable knowledge burden on the person configuring it:

**What the admin must provide today:**

| Requirement                                      | Scale (Real-World)                                                                 | Who Knows This                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------- |
| Organization name + industry                     | 1 field                                                                            | Anyone                        |
| Which products they offer (from domain list)     | Select from 11 generic products                                                    | Product manager               |
| Organization-specific product names and aliases  | 30-50+ per org (e.g., "Platinum Rewards Card", "Cashback Plus", "Student Starter") | Marketing + each product team |
| Attribute context (typical ranges per product)   | Per product per attribute (e.g., "Platinum APR: 16-24%, Student APR: 22-29%")      | Each product team             |
| Disambiguation rules between confusable products | Per pair (credit card vs personal loan, HELOC vs mortgage, CD vs savings)          | Domain expert                 |
| Internal acronyms and terminology                | 50-200 per org (HELOC, CD, AUM, APY, ARM, PMI, LTV, DTI...)                        | Varies by department          |
| Business processes and document types            | Per product line                                                                   | Operations                    |

**No single person in an organization has all this knowledge.** The product manager knows the product catalog but not the internal acronyms. Marketing knows the aliases but not the attribute ranges. The IT admin running the platform knows none of it.

### 1.2 Domain Coverage Gap

Only 5 pre-built domain JSON files exist:

- `financial-services.json` (11 products, 10 attributes)
- `healthcare.json`
- `technology.json`
- `manufacturing.json`
- `retail.json`

Industries without a built-in domain (telecom, government, education, legal, energy, insurance, real estate, logistics, media, agriculture) have no starting point. They'd need to create a custom domain definition from scratch — a task the design docs originally envisioned as a customer-provided markdown file parsed by LLM, but which the implementation simplified to JSON with a specific schema.

### 1.3 Product Granularity Mismatch

The built-in `financial-services.json` has 11 generic products: `checking-account`, `savings-account`, `credit-card`, `mortgage`, `personal-loan`, `auto-loan`, `investment-account`, `retirement-account`, `life-insurance`, `home-insurance`, `auto-insurance`.

A real bank offers 30+ products the domain doesn't cover:

- HELOC (Home Equity Line of Credit)
- Certificate of Deposit (CD)
- Money Market Account
- Business Checking / Business Savings
- Wire Transfer / ACH
- Trade Finance / Letter of Credit
- Treasury Management / Cash Management
- Merchant Services
- Student Loans
- Commercial Real Estate Loans
- SBA Loans
- Prepaid Cards

The admin must either shoehorn these into the 11 generic products (losing disambiguation) or manually create custom products — which the current UI doesn't support.

### 1.4 No Iterative Refinement

Today: set up taxonomy, run enrichment, see results. If classification accuracy is poor because the taxonomy missed products or aliases, the admin deletes the taxonomy and starts over. There is no feedback loop from enrichment results back to taxonomy quality.

---

## 2. Design Constraint: Taxonomy Must Remain Upfront

This RFC does **NOT** propose discovering taxonomy from documents. The design documents are explicit about why taxonomy must exist before enrichment:

1. **Node explosion prevention** — Entity extraction is scoped by `attribute.applicableTo`. Without taxonomy, every entity in every document gets extracted. A 10M-document corpus would create millions of irrelevant Neo4j nodes.

2. **False relationship prevention** — `departmentBoundaries` and `EXCLUDES` relationships prevent linking "credit card interest rate" to "debit card". This requires knowing the product taxonomy upfront.

3. **Classification requires targets** — Document-level product scope detection classifies documents into known products. You can't classify into a taxonomy that doesn't exist yet.

4. **Cost control** — Scoped entity extraction (only extract attributes applicable to the classified product) reduces LLM costs ~10x vs unscoped extraction.

**The simplification opportunity is in how the taxonomy gets populated, not whether it exists.**

---

## 3. Security & Data Integrity Requirements

Before implementing any LLM-based generation features, these security requirements MUST be satisfied:

### 3.1 SSRF Protection for URL Fetching (CRITICAL)

**Risk**: Phase 3.1 allows URL-based seed input. Without validation, attackers can:

- Scan internal network (Redis:6380, MongoDB:27017, Neo4j:7687)
- Access cloud metadata endpoints (169.254.169.254)
- Exfiltrate data via DNS tunneling

**Mitigation**:

```typescript
// Add to org-profile-generator.service.ts
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16', // Private IP ranges
  'metadata.google.internal', // GCP metadata
  'fd00::/8', // IPv6 private
];

const BLOCKED_SCHEMES = ['file:', 'ftp:', 'gopher:', 'data:', 'javascript:'];

async function validateAndFetchURL(url: string): Promise<string> {
  // 1. Parse URL
  const parsed = new URL(url);

  // 2. Block dangerous schemes
  if (BLOCKED_SCHEMES.includes(parsed.protocol)) {
    throw new ValidationError('Unsupported URL scheme');
  }

  // 3. Block internal hosts by hostname
  if (BLOCKED_HOSTS.some((h) => parsed.hostname.includes(h))) {
    throw new ValidationError('Access to internal hosts forbidden');
  }

  // 4. Resolve DNS and check IP (prevent DNS rebinding)
  const resolved = await dns.promises.resolve4(parsed.hostname);
  for (const ip of resolved) {
    if (isPrivateIP(ip)) {
      throw new ValidationError('Resolved to private IP address');
    }
  }

  // 5. Fetch with timeout and size limit
  const response = await fetch(url, {
    timeout: 10_000, // 10 seconds
    redirect: 'manual', // Don't follow redirects automatically
    headers: { 'User-Agent': 'ABL-Platform-Taxonomy-Generator/1.0' },
  });

  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 1_000_000) {
    // 1MB limit
    throw new ValidationError('URL content too large');
  }

  return await response.text();
}
```

**Reference**: OWASP SSRF Prevention Cheat Sheet

### 3.2 LLM Response Validation (CRITICAL)

**Risk**: Current regex-based JSON extraction is too permissive. LLM can return invalid product IDs, malformed regex patterns, or circular references.

**Mitigation**: Use Zod schema validation:

```typescript
import { z } from 'zod';

const ProductIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    'Product ID must be lowercase, start with letter, contain only letters/numbers/hyphens',
  );

const OrgProfileSchema = z.object({
  organizationName: z.string().min(1).max(200),
  products: z
    .array(
      z.object({
        productId: ProductIdSchema,
        organizationSpecificNames: z.array(z.string().min(1)).min(1).max(50),
        attributeContext: z
          .record(
            z.object({
              typicalRange: z.string().max(200).optional(),
              aliases: z.array(z.string().max(100)).max(20).optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1)
    .max(100),
});

const DomainDefinitionSchema = z.object({
  id: ProductIdSchema,
  name: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  categories: z
    .array(
      z.object({
        id: ProductIdSchema,
        name: z.string().min(1),
        department: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
  products: z
    .array(
      z.object({
        id: ProductIdSchema,
        name: z.string().min(1),
        categoryId: ProductIdSchema,
        disambiguationKeywords: z.array(z.string()).max(50).optional(),
        subProducts: z
          .array(
            z.object({
              // Support sub-products
              id: ProductIdSchema,
              name: z.string().min(1),
              disambiguationKeywords: z.array(z.string()).max(20).optional(),
            }),
          )
          .max(10)
          .optional(),
      }),
    )
    .min(1)
    .max(100),
  attributes: z.array(
    z.object({
      id: ProductIdSchema,
      name: z.string().min(1),
      dataType: z.enum([
        'percentage',
        'currency',
        'date',
        'duration',
        'identifier',
        'string',
        'number',
      ]),
      applicableTo: z.array(ProductIdSchema).min(1),
      notApplicableTo: z.array(ProductIdSchema).optional(),
      extraction: z.object({
        method: z.enum(['regex', 'llm', 'hybrid']),
        patterns: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
      }),
    }),
  ),
  departmentBoundaries: z
    .array(
      z.object({
        product1: ProductIdSchema,
        product2: ProductIdSchema,
        reasoning: z.string().min(10).max(500),
      }),
    )
    .optional(),
});

// Usage in parseOrganizationProfileWithLLM()
const jsonMatch = response.match(/\{[\s\S]*\}/);
if (!jsonMatch) {
  throw new ValidationError('LLM response contains no JSON');
}

try {
  const rawParsed = JSON.parse(jsonMatch[0]);
  const validated = OrgProfileSchema.parse(rawParsed); // Throws ZodError if invalid

  // Additional cross-field validation
  const productIds = new Set(validated.products.map((p) => p.productId));
  if (productIds.size !== validated.products.length) {
    throw new ValidationError('Duplicate product IDs detected');
  }

  return validated;
} catch (error) {
  if (error instanceof z.ZodError) {
    throw new ValidationError('Invalid LLM response structure', {
      llm: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
    });
  }
  throw error;
}
```

### 3.3 Custom Domain Audit Logging (HIGH)

**Risk**: Custom domains contain competitive intelligence (product catalog, internal terminology, department structure). If MongoDB is compromised, attacker gains organizational reconnaissance data.

**Mitigation**: Add audit logging for all custom domain operations:

```typescript
import { auditLog } from '@agent-platform/audit'; // Assume exists

// In domain-generator.service.ts
await auditLog({
  action: 'kg_domain_created',
  tenantId,
  userId: req.user.id,
  resourceType: 'custom_domain',
  resourceId: domainId,
  metadata: {
    generatedBy: 'llm',
    industryName: input.industryName,
    productCount: domain.products.length,
  },
});

await auditLog({
  action: 'kg_domain_accessed',
  tenantId,
  userId: req.user.id,
  resourceType: 'custom_domain',
  resourceId: domainId,
});

await auditLog({
  action: 'kg_domain_deleted',
  tenantId,
  userId: req.user.id,
  resourceType: 'custom_domain',
  resourceId: domainId,
  metadata: { reason: req.body.reason },
});
```

**Alternative (if audit log doesn't exist)**: Add `accessLog` field to `CustomDomainDefinition` schema tracking last 100 accesses with timestamps and user IDs.

### 3.4 BullMQ Job Deduplication (CRITICAL)

**Risk**: Refinement actions (Phase 3.4) can trigger duplicate re-classification jobs if admin clicks rapidly or network retries occur. Causes race conditions and duplicate LLM costs.

**Mitigation**: Use BullMQ `jobId` for idempotency:

```typescript
// In kg-taxonomy refinement API endpoint
const queue = createQueue('kg-reclassify');
try {
  const jobId = `kg-reclassify:${tenantId}:${indexId}:${action}:${Date.now()}`;
  await queue.add(
    'kg-reclassify',
    {
      tenantId,
      indexId,
      refinementAction: action,
      affectedDocumentIds: documentIds,
    },
    {
      jobId, // BullMQ deduplicates by jobId
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  );
} finally {
  await queue.close();
}
```

**Reference**: `docs/searchai/DATABASE-SCHEMA.md` - all workers must use jobId for idempotency

### 3.5 Tenant Isolation for Custom Domains

**Enforcement**: All custom domain queries MUST include `{ tenantId }` filter:

```typescript
// WRONG (violates tenant isolation):
const domain = await CustomDomain.findById(domainId);

// RIGHT:
const domain = await CustomDomain.findOne({ _id: domainId, tenantId });

// Also applies to updates and deletes:
await CustomDomain.findOneAndUpdate(
  { _id: domainId, tenantId }, // Filter must include tenantId
  { $set: updates },
);
```

---

## 4. Proposed Changes

### 4.1 LLM-Assisted Organization Profile from a Seed Input

**Problem**: The organization profile requires deep cross-departmental knowledge that no single person has.

**Solution**: Let the admin provide a minimal seed, and use an LLM to generate a draft organization profile from public knowledge about the organization.

#### Seed Input Options (any one)

| Seed Type               | Example                                                                                                                               | LLM Can Derive                                                       | Security                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| Company website URL     | `https://www.nbb.com.bh`                                                                                                              | Products, departments, terminology, market context                   | SSRF-protected fetch (see Section 3.1) |
| Company name + industry | "National Bank of Bahrain, retail and Islamic banking"                                                                                | Product catalog, Islamic finance terms, Bahraini banking terminology | No external calls, safe                |
| Short paragraph         | "Mid-size bank in Bahrain with retail banking, Islamic finance (Ijara, Murabaha), and wealth management across Bahrain, KSA, and UAE" | Full product hierarchy, disambiguation, regulatory context           | No external calls, safe                |

#### Flow

```
CURRENT FLOW:
  1. Select domain  ──>  2. Fill org profile (200+ lines)  ──>  3. Wait

PROPOSED FLOW:
  1. Select domain  ──>  2. Provide seed input  ──>  3. Review generated profile  ──>  4. Edit/confirm  ──>  5. Wait
```

#### How Generation Works

1. Admin provides seed input (URL, name+industry, or paragraph)
2. **If URL**: Validate and fetch using SSRF-protected `validateAndFetchURL()` (Section 3.1)
3. System calls LLM (Sonnet) with:
   - The selected domain definition (as context)
   - The seed input (or fetched webpage content)
   - The organization profile template structure
   - Instruction: "Generate an organization profile for this company. Include likely product-specific names, aliases, acronyms, and disambiguation rules based on the industry and region."
4. LLM generates a draft org profile in JSON format
5. **Validate response** using `OrgProfileSchema` (Section 3.2) - reject if invalid
6. Admin reviews in the UI:
   - Products shown as editable tree (reuses `KGTaxonomyTree` with edit mode)
   - Aliases shown as editable chips per product
   - Disambiguation rules shown as editable pairs
   - Acronyms shown as editable key-value list
   - Validation errors shown inline if admin makes invalid edits
7. Admin edits, removes incorrect items, adds missing items
8. **Revalidate on save** before persisting to MongoDB
9. Admin confirms and taxonomy setup proceeds as today

#### Cost

- One Sonnet call with ~5K tokens input (domain def + seed) and ~3K tokens output
- ~$0.03 per setup (one-time, not per document)
- Same order of magnitude as current taxonomy parsing cost ($0.01)

#### Key Principle

The LLM uses **general knowledge about the industry and company** — not the customer's documents. There is no catch-22. A bank named "National Bank of Bahrain" operating in Islamic finance will predictably have products like Ijara, Murabaha, and Tawarruq. The LLM knows this from training data, not from the customer's ingested documents.

#### Accuracy Expectation

The generated profile will be **70-80% correct** for well-known industries and companies. The admin's job shifts from "create from scratch" (100% effort) to "review and correct" (20-30% effort). For obscure companies or niche industries, accuracy will be lower, but it's still a better starting point than a blank template.

#### Fallback on Generation Failure

If LLM generation fails (timeout, invalid JSON, schema validation failure):

1. Log error with full context for debugging
2. Show user-friendly error message
3. Fall back to manual org profile entry (current flow)
4. Optionally: Store failed seed input for analysis

**Expected Accuracy**: 70-80% for well-known companies, lower for niche industries. Success rate will be monitored via telemetry.

---

### 4.2 Domain Auto-Generation for Uncovered Industries

**Problem**: Only 5 built-in domains. Organizations in telecom, government, education, legal, energy, etc. have no starting point.

**Solution**: When the admin's industry doesn't match a built-in domain, offer to generate a domain definition via LLM.

#### Flow

```
1. Admin selects "Other / Custom Industry"
2. Admin provides:
   - Industry name (e.g., "Telecommunications")
   - Short description: "Mobile and fixed-line carrier with consumer plans, enterprise services, and network infrastructure"
   - (Optional) 3-5 example product categories
3. System generates domain definition JSON via LLM (Sonnet):
   - Product hierarchy with categories, products, sub-departments
   - Attributes with applicability rules and extraction patterns (regex + keywords)
   - Department boundaries for confusable products
   - Disambiguation keywords per product
4. Admin reviews generated domain in the tree view
5. Admin edits (add/remove products, adjust attributes, fix boundaries)
6. Domain saved as tenant-specific custom domain (stored in MongoDB, not as a file)
7. Taxonomy setup proceeds as normal
```

#### LLM Prompt Structure

```
System: You are a domain taxonomy architect. Generate a product taxonomy
for the given industry following this exact JSON schema: {schema}.

The taxonomy must include:
- 3-8 categories (departments/divisions)
- 5-20 products per category
- Attributes with applicableTo/notApplicableTo rules
- Department boundaries between confusable products
- Disambiguation keywords per product
- Regex extraction patterns for common attributes

Industry: {industry_name}
Description: {industry_description}
Example categories: {optional_categories}

Reference this existing domain for structural guidance: {banking.json}
```

#### Storage

Generated domains stored in the `knowledge_graph_domains` collection (new) with:

```typescript
interface CustomDomainDefinition {
  _id: string;
  tenantId: string; // REQUIRED for tenant isolation
  name: string; // "Telecommunications"
  version: string;
  generatedBy: 'llm' | 'manual';
  categories: DomainCategory[];
  products: DomainProduct[];
  attributes: DomainAttribute[];
  departmentBoundaries: DepartmentBoundary[];
  createdAt: Date;
  updatedAt: Date;
  createdBy: string; // User ID for audit
  lastAccessedAt: Date; // For audit logging
  lastAccessedBy: string; // User ID for audit
}
```

**Tenant Isolation**: All queries MUST include `{ tenantId }` filter (see Section 3.5).

**Audit Logging**: All create/access/delete operations logged (see Section 3.3).

**Validation**: All domains validated with `DomainDefinitionSchema` (Section 3.2) before saving.

Custom domains appear alongside built-in domains in the domain selection step. The admin can edit them at any time.

#### Cost

- One Sonnet call, ~2K input + ~5K output tokens
- ~$0.05 per domain generation (one-time per tenant)

---

### 4.3 Expanded Product Hierarchy with Sub-Products

**Problem**: `financial-services.json` has 11 flat products. A real bank needs 30+.

**Solution**: Expand built-in domain definitions with a two-level product hierarchy. Products have optional sub-products representing common variants.

#### Schema Migration (CRITICAL - Must Complete BEFORE Phase 1)

**Current schema** (`packages/database/src/models/knowledge-graph-taxonomy.model.ts:104-112`):

```typescript
export interface IKGProduct {
  id: string;
  name: string;
  categoryId: string;
  department: string;
  subDepartment: string;
  disambiguationKeywords: string[];
  organizationSpecificNames: string[];
  // ❌ No subProducts field
}
```

**Required schema** (add before implementing Phase 1):

```typescript
export interface IKGProduct {
  id: string;
  name: string;
  categoryId: string;
  department: string;
  subDepartment: string;
  disambiguationKeywords: string[];
  organizationSpecificNames: string[];
  subProducts?: Array<{
    // ✅ NEW
    id: string;
    name: string;
    disambiguationKeywords: string[];
  }>;
}
```

**Also update**:

1. Mongoose schema at `knowledge-graph-taxonomy.model.ts:104`
2. `DomainDefinition` interface at `taxonomy-loader.service.ts:53`
3. `buildSystemPrompt()` in `document-classifier.service.ts:144` to include sub-products
4. Domain JSON files validation schema

**Backward Compatibility**: Sub-products field is optional. Existing taxonomies without sub-products continue working unchanged.

#### Example: Financial Services (expanded)

```json
{
  "id": "credit-card",
  "name": "Credit Card",
  "categoryId": "lending",
  "subProducts": [
    {
      "id": "rewards-credit-card",
      "name": "Rewards Credit Card",
      "disambiguationKeywords": ["rewards", "points", "miles", "cashback"]
    },
    {
      "id": "secured-credit-card",
      "name": "Secured Credit Card",
      "disambiguationKeywords": ["secured", "deposit", "build credit"]
    },
    {
      "id": "business-credit-card",
      "name": "Business Credit Card",
      "disambiguationKeywords": ["business", "corporate", "expense management"]
    },
    {
      "id": "student-credit-card",
      "name": "Student Credit Card",
      "disambiguationKeywords": ["student", "campus", "first card"]
    }
  ]
}
```

#### New Products to Add to Financial Services Domain

| Category         | Products to Add                                                         |
| ---------------- | ----------------------------------------------------------------------- |
| Consumer Banking | Money Market Account, Certificate of Deposit (CD)                       |
| Lending          | HELOC, Student Loan, SBA Loan, Commercial Real Estate Loan              |
| Cards            | Prepaid Card, Business Debit Card                                       |
| Business Banking | Business Checking, Business Savings, Merchant Services, Cash Management |
| Trade Finance    | Letter of Credit, Trade Finance, Wire Transfer                          |

This brings the domain from 11 to ~30 products — covering the common taxonomy without requiring custom domain creation for most banks.

#### UI Impact

The guided chip selector groups sub-products under their parent:

```
[v] Credit Card
    [ ] Rewards Credit Card
    [ ] Secured Credit Card
    [ ] Business Credit Card
    [ ] Student Credit Card
[v] Mortgage
    [ ] Fixed-Rate Mortgage
    [ ] Adjustable-Rate Mortgage (ARM)
    [ ] FHA Loan
    [ ] VA Loan
```

Selecting the parent selects a generic product. Selecting sub-products provides finer disambiguation.

#### Backward Compatibility

Sub-products inherit all attributes and boundaries from their parent. The classifier can classify at either level — a document about "our Platinum Rewards Card benefits" classifies as `rewards-credit-card` (child of `credit-card`). Existing indexes using the parent `credit-card` product continue working unchanged.

#### A/B Testing Requirement (HIGH PRIORITY)

**Risk**: Adding sub-products doubles classifier prompt size (11 → 30 products). May degrade Haiku accuracy and increase Sonnet escalation rate from 15% to 25% (+67% cost increase).

**Mitigation**: A/B test before full rollout:

| Group         | Configuration                          | Metrics to Compare                                                    |
| ------------- | -------------------------------------- | --------------------------------------------------------------------- |
| A (Control)   | 11 flat products                       | Classification accuracy, avg confidence, escalation rate, p95 latency |
| B (Treatment) | 30 products with sub-product hierarchy | Same metrics                                                          |

**Success Criteria**: Proceed with Phase 1 only if Group B accuracy >= Group A - 2% AND escalation rate increase < 10%.

**Test Sample**: 1,000 documents across 5 industries with ground truth labels.

---

### 4.4 Post-Enrichment Taxonomy Refinement Loop

**Problem**: No feedback from enrichment results to taxonomy quality. Poor classification → delete taxonomy → start over.

**Solution**: After enrichment runs, surface quality signals and allow iterative taxonomy refinement without full re-setup.

#### Quality Signals (with Caching)

After enrichment completes, compute and display:

**Storage & Caching Strategy** (HIGH PRIORITY):

```typescript
interface TaxonomyHealthCache {
  _id: string;
  tenantId: string;
  indexId: string;
  signals: QualitySignals;
  computedAt: Date;
  ttl: number; // 1 hour = 3600 seconds
}

// Quality signals computation is expensive on large indexes:
// - Scan all documents with confidence < 0.7 (potentially thousands)
// - Aggregate unknown terms across all chunks (millions)
// - Compute boundary violations (cross-product analysis)
//
// Cache strategy:
// 1. Compute signals at enrichment completion
// 2. Store in MongoDB with 1-hour TTL
// 3. Recompute after refinement actions complete
// 4. Serve from cache for dashboard loads
//
// Cost: 5-10 seconds to compute on 100K documents
// Without cache: Every dashboard load = 5-10s wait = poor UX
```

**Quality Signals Computed**:

| Signal                           | Meaning                                                                      | Action                                                          |
| -------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Low-confidence documents**     | Documents classified with confidence < 0.7                                   | Likely missing products or insufficient disambiguation keywords |
| **Unclassified documents**       | Documents that couldn't be classified at all                                 | Product not in taxonomy, or document is out of domain scope     |
| **Frequent unknown terms**       | Terms appearing in 10+ documents that match no taxonomy product or attribute | Candidate acronyms or product aliases to add                    |
| **Boundary violations**          | Documents that score high for two products in different departments          | Department boundary rules may need refinement                   |
| **Single-product concentration** | >80% of documents classified to one product                                  | Taxonomy may be too coarse — sub-products needed                |

#### UI: Taxonomy Health Dashboard

Add a "Taxonomy Health" section to the KG tab (alongside Graph View and Statistics):

```
Taxonomy Health                                          Overall: 78% coverage
-----------------------------------------------------------------------
[!] 23 documents unclassified (3.2%)                    [View Documents]
    Top clusters:
    - 8 docs mention "HELOC" / "home equity"            [Add as Product]
    - 6 docs mention "wire transfer" / "ACH"            [Add as Product]
    - 5 docs mention "CD" / "certificate of deposit"    [Add as Product]
    - 4 docs: mixed/unclear                             [Review]

[!] 47 documents with confidence < 0.7 (6.5%)          [View Documents]
    Most common ambiguity:
    - 18 docs: credit-card vs personal-loan (0.55 avg)  [Add Boundary Rule]
    - 12 docs: mortgage vs home-insurance (0.62 avg)     [Add Boundary Rule]

[i] 3 unknown terms found frequently                    [Review Terms]
    - "HELOC" (42 occurrences, 15 documents)            [Add as Acronym]
    - "DTI" (28 occurrences, 11 documents)              [Add as Acronym]
    - "LTV" (35 occurrences, 14 documents)              [Already in taxonomy]

[v] 89% of documents classified with confidence > 0.8   Good
[v] No boundary violations detected                     Good
```

#### Refinement Actions

Each signal has an inline action:

1. **"Add as Product"** — Creates a new product in the taxonomy (name, parent category, keywords). Triggers re-classification of unclassified documents only (not the full corpus).

2. **"Add Boundary Rule"** — Creates a `departmentBoundary` between two confusable products. Triggers re-classification of low-confidence documents for those two products only.

3. **"Add as Acronym"** — Adds the term to the taxonomy's terminology list and to relevant product `disambiguationKeywords`.

4. **"Review"** — Opens a panel showing the document titles and summaries for manual inspection.

#### Re-classification Scope

Refinement triggers **incremental** re-classification, not full re-enrichment:

| Action            | Scope                                                                | Haiku Cost | Vector Upsert Cost | Total  | Breakeven |
| ----------------- | -------------------------------------------------------------------- | ---------- | ------------------ | ------ | --------- |
| Add product       | Unclassified docs only (~23 docs)                                    | ~$0.0046   | ~$0.023            | $0.028 | < 5%      |
| Add boundary rule | Low-confidence docs for that pair (~18 docs)                         | ~$0.0036   | ~$0.018            | $0.022 | < 5%      |
| Add acronym       | No re-classification needed (keyword only affects future enrichment) | $0         | $0                 | $0     | Always    |

**Cost formula**:

```
Incremental cost = (N_affected_docs * $0.0002_haiku) + (N_affected_docs * $0.001_vector_upsert)
Full re-enrichment = (N_all_docs * $0.0002_haiku) + (N_all_docs * $0.001_vector_upsert)

Breakeven: Incremental is cheaper if N_affected_docs < 0.05 * N_all_docs (5% of corpus)
```

For a 1,000-doc index:

- Full re-enrichment: $1.20
- Typical refinement: $0.028 (23 docs)
- **Savings: 98%**

#### BullMQ Job Deduplication (CRITICAL)

Refinement actions must use idempotent job IDs to prevent duplicate processing:

```typescript
// In POST /indexes/:indexId/kg-taxonomy/refine endpoint
const queue = createQueue('kg-reclassify');
try {
  const jobId = `kg-reclassify:${tenantId}:${indexId}:${action}:${productId}:${timestamp}`;

  await queue.add(
    'kg-reclassify',
    {
      tenantId,
      indexId,
      refinementAction: action,
      affectedDocumentIds: documentIds,
      taxonomyVersion: updatedTaxonomy.version, // Track which taxonomy version
    },
    {
      jobId, // BullMQ deduplicates by jobId - prevents duplicate processing
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  );

  return { jobId, estimatedCost: documentIds.length * 0.0012 };
} finally {
  await queue.close(); // Always close in finally block
}
```

**Reference**: Section 3.4 (Security Requirements)

#### Rollback Mechanism (HIGH PRIORITY)

**Problem**: If refinement makes classification worse (e.g., new product too broad, causes misclassifications), admin has no way to undo. Must manually remove product and trigger full re-enrichment ($$$, hours of wait).

**Solution**: Version taxonomy on each refinement, allow rollback to previous version:

```typescript
interface IKnowledgeGraphTaxonomy {
  // ... existing fields
  version: string; // Already exists! Format: YYYY-MM-DDTHH-MM-SS
  previousVersions: Array<{
    version: string;
    taxonomy: TaxonomyData;
    createdAt: Date;
    refinementAction?: string; // "Added product: HELOC", "Added boundary: credit-card <-> personal-loan"
    rollbackReason?: string; // If this version was rolled back, why?
  }>;
  maxPreviousVersions: 10; // Keep last 10 versions only
}

// On refinement:
async function refineTaxonomy(refinementAction) {
  const current = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId });

  // Save current version to history before modifying
  const newVersion = generateVersion();
  await KnowledgeGraphTaxonomy.findOneAndUpdate(
    { tenantId, indexId },
    {
      $set: {
        taxonomy: applyRefinement(current.taxonomy, refinementAction),
        version: newVersion,
        updatedAt: new Date(),
      },
      $push: {
        previousVersions: {
          $each: [
            {
              version: current.version,
              taxonomy: current.taxonomy,
              createdAt: current.updatedAt,
              refinementAction: refinementAction.description,
            },
          ],
          $position: 0, // Add to front
          $slice: 10, // Keep only last 10
        },
      },
    },
  );

  // Trigger incremental re-classification
  await enqueueReclassification(refinementAction);
}

// Rollback API: POST /indexes/:indexId/kg-taxonomy/rollback
async function rollbackToVersion(targetVersion, rollbackReason) {
  const current = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId });
  const targetTaxonomy = current.previousVersions.find((v) => v.version === targetVersion);

  if (!targetTaxonomy) {
    throw new ValidationError('Version not found');
  }

  // Mark current version's rollback reason
  await KnowledgeGraphTaxonomy.findOneAndUpdate(
    { tenantId, indexId, 'previousVersions.version': current.version },
    {
      $set: {
        'previousVersions.$.rollbackReason': rollbackReason,
      },
    },
  );

  // Restore target version
  await KnowledgeGraphTaxonomy.findOneAndUpdate(
    { tenantId, indexId },
    {
      $set: {
        taxonomy: targetTaxonomy.taxonomy,
        version: generateVersion(), // New version for the rollback
        updatedAt: new Date(),
      },
    },
  );

  // Trigger full re-classification (no shortcuts - different taxonomy structure)
  await enqueueFullReclassification();
}
```

**UI**: Show version history in Taxonomy Health tab with:

- Version timestamp
- Action that created the version ("Added HELOC product", "Added boundary rule")
- Rollback button with confirmation modal
- Warning: "Rollback triggers full re-classification (~$1.20, 30 min)"

#### Architecture

The refinement loop does NOT change the taxonomy-first principle:

```
        Taxonomy Setup (upfront, required)
               |
               v
        Enrichment Run
               |
               v
        Quality Signals (computed from enrichment results)
               |
               v
        Admin Reviews Signals
               |
               v
     Taxonomy Refinement (incremental edits)
               |
               v
     Targeted Re-Classification (subset of docs)
               |
               v
        Updated Quality Signals
               |
               (iterate until satisfied)
```

The taxonomy always exists before enrichment. Refinement edits the existing taxonomy based on observed enrichment quality, then re-classifies only the affected documents.

---

### 4.5 Expand Built-In Domain Library

**Problem**: 5 domains cover only a fraction of potential customers.

**Solution**: Add 7 more built-in domain definitions to cover the most common industries.

**Prioritization** (based on Architecture Review feedback): Expand based on actual customer demand, not assumptions.

| Domain                  | Products (Est.) | Why Needed                                                   |
| ----------------------- | --------------- | ------------------------------------------------------------ |
| `telecom.json`          | 15-20           | Mobile plans, broadband, enterprise MPLS, IoT, 5G            |
| `government.json`       | 12-15           | Permits, licenses, public records, benefits, taxation        |
| `education.json`        | 10-15           | Admissions, financial aid, courses, transcripts, housing     |
| `legal.json`            | 10-12           | Litigation, contracts, IP, compliance, corporate governance  |
| `energy-utilities.json` | 12-15           | Electricity, gas, water, solar, EV charging, grid management |
| `insurance.json`        | 15-20           | Auto, home, health, life, disability, liability, commercial  |
| `real-estate.json`      | 10-12           | Residential sales, commercial leasing, property management   |

Each domain follows the same structure as existing ones: categories, products with disambiguation keywords, attributes with applicability rules, department boundaries, and extraction patterns.

#### Priority (Data-Driven Approach)

**Instead of guessing**, determine priority using:

1. Analyze existing customer signups (which industries?)
2. Survey waitlist/trial users (which domain would you need?)
3. Review support requests (how many mention specific industries?)

**Recommended initial expansion** (Phase 1):

- Insurance (high financial services adjacency)
- Telecommunications (distinct from current 5)
- Energy/Utilities (regulatory/compliance use case)
- Government (public sector demand exists)

**Deferred** (Phase 2 based on data):

- Education, Legal, Real Estate (expand if demand data supports)

Generate these using the same LLM-based approach from 4.2 (domain auto-generation), then manually review and curate. This validates the auto-generation approach while expanding coverage.

---

## 5. Testing & Validation Strategy

Before implementing any LLM-based generation feature, establish testing baselines:

### 5.1 LLM Generation Quality Benchmarks

**Problem**: RFC claims "70-80% accuracy" for LLM-generated profiles but provides no measurement methodology.

**Solution**: Create ground truth dataset and evaluation metrics:

#### Benchmark Dataset (Create Before Phase 2)

| Industry      | Companies                   | Ground Truth Includes                                 |
| ------------- | --------------------------- | ----------------------------------------------------- |
| Banking       | 3 banks (large, mid, small) | Product list, aliases, acronyms, disambiguation rules |
| Insurance     | 3 carriers                  | Same                                                  |
| Healthcare    | 2 hospital systems          | Same                                                  |
| Manufacturing | 2 manufacturers             | Same                                                  |
| Retail        | 2 retailers                 | Same                                                  |

**Total**: 12 ground truth org profiles (manually created by domain experts)

#### Evaluation Metrics

```typescript
interface GenerationQualityMetrics {
  productExtractionRecall: number; // % of ground truth products found
  productExtractionPrecision: number; // % of generated products that are valid
  aliasOverlap: number; // Jaccard similarity of alias sets
  falseProductRate: number; // % of products that don't exist at company
  schemaValidationRate: number; // % of generations that pass schema validation
}

// Success criteria for Phase 2 launch:
// - Recall >= 70%
// - Precision >= 75%
// - Schema validation rate >= 95%
// - False product rate < 10%
```

#### Fallback Strategy

If quality metrics < success criteria:

- **Option A**: Escalate from Haiku to Sonnet for all generation (higher cost, better quality)
- **Option B**: Use Claude 4.5 Opus for generation (highest quality, $0.10 per org profile)
- **Option C**: Defer feature until model quality improves

### 5.2 Sub-Product A/B Test Plan

**Test Duration**: 2 weeks
**Sample Size**: 1,000 documents from 5 different industries
**Ground Truth**: Manual labeling by domain experts

| Metric                     | Group A (11 products) | Group B (30 products) | Acceptance Criteria      |
| -------------------------- | --------------------- | --------------------- | ------------------------ |
| Classification Accuracy    | Baseline              | Measure               | B >= A - 2%              |
| Avg Confidence Score       | Baseline              | Measure               | B >= A - 0.05            |
| Haiku -> Sonnet Escalation | 15% baseline          | Measure               | B < 25% (< 10% increase) |
| p95 Latency                | Baseline              | Measure               | B < 2x A                 |

**Decision**: Proceed with Phase 1 sub-products only if all acceptance criteria met.

### 5.3 Integration Tests

```typescript
// apps/search-ai/src/__tests__/kg-refinement-integration.test.ts

describe('KG Refinement Loop', () => {
  it('prevents duplicate re-classification jobs via BullMQ jobId', async () => {
    const action = { type: 'add_product', productId: 'heloc' };

    // Rapidly enqueue same refinement twice
    const job1 = await refineAPI.addProduct(action);
    const job2 = await refineAPI.addProduct(action);

    // Should return same jobId (deduplication worked)
    expect(job1.jobId).toBe(job2.jobId);

    // Only one job should exist in queue
    const jobs = await queue.getJobs(['waiting', 'active']);
    expect(jobs.length).toBe(1);
  });

  it('allows rollback to previous taxonomy version', async () => {
    const original = await getTaxonomy();

    // Refine: add product
    await refineAPI.addProduct({ productId: 'heloc', name: 'HELOC' });
    const refined = await getTaxonomy();
    expect(refined.taxonomy.products).toHaveLength(original.taxonomy.products.length + 1);

    // Rollback
    await rollbackAPI.rollback(original.version, 'Testing rollback');
    const rolledBack = await getTaxonomy();
    expect(rolledBack.taxonomy).toEqual(original.taxonomy);
    expect(rolledBack.previousVersions[0].rollbackReason).toBe('Testing rollback');
  });

  it('validates LLM responses with Zod schema', async () => {
    const invalidJSON = '{ "products": "not an array" }';

    await expect(parseOrganizationProfileWithLLM(invalidJSON)).rejects.toThrow(ValidationError);
  });

  it('blocks SSRF attacks via URL validation', async () => {
    await expect(validateAndFetchURL('http://localhost/internal')).rejects.toThrow(
      'Access to internal hosts forbidden',
    );

    await expect(validateAndFetchURL('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      'Access to internal hosts forbidden',
    );
  });
});
```

---

## 6. Implementation Plan (Revised Order)

### Phase 0: Schema Migration & Security Hardening (CRITICAL - BLOCKING)

**Effort**: 1-2 days
**Dependencies**: None
**Must Complete Before Any Other Phase**

| Task                                  | Description                                           | Reference   |
| ------------------------------------- | ----------------------------------------------------- | ----------- |
| Add `subProducts` to IKGProduct       | Update schema in knowledge-graph-taxonomy.model.ts    | Section 4.3 |
| Add `subProducts` to DomainDefinition | Update taxonomy-loader.service.ts interface           | Section 4.3 |
| Update Mongoose schema                | Add subProducts field to KnowledgeGraphTaxonomySchema | Section 4.3 |
| Implement SSRF protection             | Add validateAndFetchURL() with blocked hosts/schemes  | Section 3.1 |
| Implement Zod validation              | Add OrgProfileSchema and DomainDefinitionSchema       | Section 3.2 |
| Add BullMQ jobId pattern              | Update refinement endpoint with deduplication         | Section 3.4 |
| Add audit logging hooks               | Log custom domain create/access/delete                | Section 3.3 |
| Add tenant isolation enforcement      | Review all custom domain queries for { tenantId }     | Section 3.5 |
| Write integration tests               | SSRF, Zod validation, BullMQ dedup, rollback          | Section 5.3 |

### Phase 1: Expanded Domain Library + Sub-Products (Low Risk, High Impact)

**Effort**: 4-6 days
**Dependencies**: Phase 0 (schema migration)
**Impact**: Most customers can find a useful starting domain

| Task                             | Description                                                                   | Validation  |
| -------------------------------- | ----------------------------------------------------------------------------- | ----------- |
| Create benchmark dataset         | 12 ground truth org profiles across 5 industries                              | Section 5.1 |
| A/B test sub-products            | Compare 11 vs 30 products on accuracy, cost, latency                          | Section 5.2 |
| Expand `financial-services.json` | Add ~20 missing products with sub-product hierarchy (only if A/B test passes) | Section 4.3 |
| Expand other 4 domains           | Add sub-products to healthcare, technology, manufacturing, retail             | Section 4.3 |
| Add 4 new domains                | insurance, telecom, energy-utilities, government (data-driven priority)       | Section 4.5 |
| Update chip selector UI          | Support two-level product selection (parent + sub-products)                   | Section 4.3 |
| Update taxonomy setup worker     | Handle sub-product merging into taxonomy                                      | Section 4.3 |
| Update classifier prompt         | Include sub-products in buildSystemPrompt()                                   | Section 4.3 |

### Phase 2: LLM-Assisted Org Profile (Medium Risk, High Impact)

**Effort**: 6-8 days
**Dependencies**: Phase 0 (security), Phase 1 (richer domains make generation more accurate)
**Impact**: Reduces setup time from hours to minutes

| Task                           | Description                                                                    | Security/Validation                 |
| ------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------- |
| Test LLM generation quality    | Run benchmark dataset through generation, measure recall/precision             | Section 5.1                         |
| New API endpoint               | `POST /indexes/:indexId/kg-taxonomy/generate-profile`                          | Requires SSRF protection            |
| LLM profile generation service | `org-profile-generator.service.ts` — takes seed input, generates draft profile | Uses validateAndFetchURL() for URLs |
| Prompt engineering             | Craft and test prompts for URL-based, name-based, and paragraph-based seeds    | Test against benchmark dataset      |
| Response validation            | Parse and validate with OrgProfileSchema (Zod)                                 | Section 3.2                         |
| UI: seed input step            | Add step between domain selection and configuration in `KGTaxonomySetupCard`   | Show validation errors inline       |
| UI: review/edit mode           | Editable tree view showing generated profile for admin review                  | Revalidate on save                  |
| Fallback                       | If generation fails or quality < 50%, fall back to manual flow                 | Section 4.1                         |
| Telemetry                      | Track generation success rate, validation failures, manual edit rate           | For quality monitoring              |

### Phase 3: Domain Auto-Generation (Medium Risk, Medium Impact)

**Effort**: 4-6 days
**Dependencies**: Phase 0 (security), Phase 2 (reuses LLM infrastructure)
**Impact**: Unlocks customers in industries without built-in domains

| Task                          | Description                                                                         | Security/Validation                    |
| ----------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| MongoDB schema                | `knowledge_graph_domains` collection with tenantId, audit fields                    | Section 4.2                            |
| New API endpoint              | `POST /indexes/kg-taxonomy/generate-domain`                                         | Requires audit logging                 |
| LLM domain generation service | `domain-generator.service.ts` — takes industry + description, generates domain JSON | Uses DomainDefinitionSchema validation |
| Response validation           | Validate with DomainDefinitionSchema, check for circular refs, duplicate IDs        | Section 3.2                            |
| Tenant isolation              | All queries include { tenantId } filter                                             | Section 3.5                            |
| Audit logging                 | Log domain create/access/delete with user ID                                        | Section 3.3                            |
| UI: "Custom Industry" option  | Add to domain selection grid in `KGTaxonomySetupCard`                               | Show validation errors                 |
| UI: domain review/edit        | Full domain editor (products, attributes, boundaries)                               | Revalidate on save                     |
| Integration tests             | Test tenant isolation, validation, audit logging                                    | Section 5.3                            |

### Phase 4: Post-Enrichment Refinement Loop (Medium Risk, High Impact)

**Effort**: 8-12 days
**Dependencies**: Phase 0 (security), enrichment pipeline (already implemented)
**Impact**: Iterative improvement without full re-setup

| Task                                 | Description                                                                                                                                                                             | Reference                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Quality signal schema                | MongoDB collection with TTL index for 1-hour cache                                                                                                                                      | Section 4.4                        |
| Quality signal computation           | Service computing low-confidence docs, unclassified docs, unknown terms, boundary violations                                                                                            | Section 4.4                        |
| Quality signal caching               | Store in MongoDB, serve from cache for dashboard loads                                                                                                                                  | Section 4.4                        |
| Taxonomy versioning                  | Add previousVersions array to IKnowledgeGraphTaxonomy schema                                                                                                                            | Section 4.4                        |
| Rollback mechanism                   | Store previous versions, allow rollback with full re-classification                                                                                                                     | Section 4.4                        |
| New API endpoints                    | `GET /indexes/:indexId/kg-taxonomy/health` (quality signals), `POST /indexes/:indexId/kg-taxonomy/refine` (incremental edits), `POST /indexes/:indexId/kg-taxonomy/rollback` (rollback) | All require BullMQ jobId dedup     |
| BullMQ job deduplication             | Use idempotent jobIds for re-classification jobs                                                                                                                                        | Section 3.4                        |
| Incremental re-classification worker | Re-classify only affected document subset                                                                                                                                               | Uses existing kg-enrichment-worker |
| Cost calculation                     | Real-time cost estimate for refinement actions                                                                                                                                          | Section 4.4                        |
| UI: Taxonomy Health section          | Inline quality signals (not separate tab) - show badges on tree nodes                                                                                                                   | Architecture review recommendation |
| UI: inline refinement actions        | "Add Product", "Add Boundary Rule", "Add Acronym" modals with cost preview                                                                                                              | Show estimated cost + time         |
| UI: version history                  | Show previous versions with rollback button                                                                                                                                             | With confirmation modal            |
| Integration tests                    | Test BullMQ dedup, rollback, caching, versioning                                                                                                                                        | Section 5.3                        |
| Performance testing                  | Verify quality signal computation on 100K doc index < 10s                                                                                                                               | Section 4.4                        |

---

## 7. Priority Recommendation (Revised Based on Architecture Review)

```
Phase 0 (Schema + Security)       ██░░░░░░░░░░░░░░  Week 1 (BLOCKING)
Phase 1 (Expand Domains)          ░░████████░░░░░░  Week 1-3
Phase 2 (LLM Org Profile)         ░░░░░░████████░░  Week 2-4
Phase 4 (Refinement Loop)         ░░░░░░░░░░██████  Week 4-6
Phase 3 (Domain Auto-Generation)  ░░░░░░░░░░░░░░██  Week 6-7
```

**Rationale for revised ordering:**

1. **Phase 0 FIRST (CRITICAL)** — Must complete schema migration and security hardening before any other work. Addresses 3 CRITICAL findings from architecture review. **All other phases are blocked on this.**

2. **Phase 1 + Phase 2 in parallel** — Architecture review recommends implementing these together rather than sequentially. Richer domains (Phase 1) make LLM generation (Phase 2) more accurate. Customers get both expanded coverage AND easy setup at same launch.

3. **Phase 4 third** — Refinement loop enables iterative improvement. Once this exists, a "good enough" initial taxonomy (from Phase 2) becomes viable because admin can refine based on results. This is the long-term value play.

4. **Phase 3 last** — Custom domain generation only needed for industries not covered by Phase 1. With data-driven expansion to 8-10 domains, this becomes a long-tail feature.

**Critical Path Dependencies:**

- Phase 1, 2, 3, 4 all depend on Phase 0
- Phase 2 generates more accurate profiles if Phase 1 domains are richer
- Phase 4 is most valuable when combined with Phase 2 (80% LLM-generated + refinement = 95%+ accuracy)

**Architecture Review Resolution:**

- ✅ CRITICAL findings: Addressed in Phase 0 (SSRF, schema migration, BullMQ dedup)
- ✅ HIGH findings: Addressed in Phase 0 (audit logging, validation) and Phase 4 (caching, rollback)
- ✅ MEDIUM findings: Addressed via A/B testing (Phase 1), benchmark dataset (Phase 2), inline UI (Phase 4)
- ✅ LOW findings: Addressed via data-driven prioritization (Phase 1), cost formulas (Phase 4)

---

## 8. What Does NOT Change

- **Taxonomy-first architecture** — Taxonomy is always set up before enrichment runs
- **Neo4j graph structure** — Domain, Category, Product, Attribute, EntityInstance nodes
- **Document classification pipeline** — Haiku primary, Sonnet escalation
- **Entity extraction pipeline** — Scoped by product, regex + LLM hybrid
- **MongoDB taxonomy model** — `IKnowledgeGraphTaxonomy` schema
- **API authentication** — Tenant admin required
- **Enrichment worker** — `kg-enrichment-worker.ts` unchanged
- **Graph/statistics visualization** — `KGTaxonomyTree`, statistics view unchanged

---

## 9. Success Metrics (Expanded)

### 9.1 User Experience Metrics

| Metric                            | Current                               | Target                        | How Measured                                    |
| --------------------------------- | ------------------------------------- | ----------------------------- | ----------------------------------------------- |
| Time to complete taxonomy setup   | 2-4 hours (manual)                    | 15-30 minutes (review + edit) | Time from KG enable to first enrichment trigger |
| Setup abandonment rate            | Unknown (likely high)                 | < 20%                         | Users who enable KG but never complete taxonomy |
| Taxonomy iterations needed        | 1 (no refinement, delete and restart) | 2-3 refinement cycles         | Count of refinement actions per index           |
| LLM generation success rate       | N/A                                   | > 80%                         | % of generations that pass schema validation    |
| Manual edit rate after generation | N/A                                   | 20-30%                        | % of generated fields admin modifies            |

### 9.2 Quality Metrics

| Metric                                        | Current  | Target                 | How Measured                         |
| --------------------------------------------- | -------- | ---------------------- | ------------------------------------ |
| Classification accuracy                       | Baseline | > 90% confidence > 0.7 | Quality signals from Phase 4         |
| Classification accuracy after 1 refinement    | N/A      | > 95% confidence > 0.7 | Quality signals after refinement     |
| Product extraction recall (LLM generation)    | N/A      | > 70%                  | Ground truth benchmark (Section 5.1) |
| Product extraction precision (LLM generation) | N/A      | > 75%                  | Ground truth benchmark (Section 5.1) |
| False product rate (LLM generation)           | N/A      | < 10%                  | Ground truth benchmark (Section 5.1) |
| Schema validation rate (LLM generation)       | N/A      | > 95%                  | % passing Zod validation             |

### 9.3 Coverage Metrics

| Metric                      | Current              | Target                         | How Measured                                |
| --------------------------- | -------------------- | ------------------------------ | ------------------------------------------- |
| Industry coverage           | 5 domains            | 8-10 domains (data-driven)     | Count of built-in domain files              |
| Product coverage per domain | ~11 generic products | ~30 products with sub-products | Count in domain JSON (if A/B test passes)   |
| Custom domains created      | 0                    | Track adoption                 | Count in knowledge_graph_domains collection |

### 9.4 Cost & Performance Metrics

| Metric                                        | Current  | Target          | How Measured                                       |
| --------------------------------------------- | -------- | --------------- | -------------------------------------------------- |
| LLM cost per org profile generation           | N/A      | ~$0.03 (Sonnet) | Actual API costs                                   |
| Classification cost increase (sub-products)   | Baseline | < 10% increase  | Compare escalation rates with/without sub-products |
| Refinement cost savings vs full re-enrichment | N/A      | > 95% savings   | Cost formula validation                            |
| Quality signal computation time (100K docs)   | N/A      | < 10 seconds    | Performance benchmark                              |
| Quality signal cache hit rate                 | N/A      | > 80%           | Redis/MongoDB cache metrics                        |

### 9.5 Security Metrics

| Metric                              | Current | Target     | How Measured                                      |
| ----------------------------------- | ------- | ---------- | ------------------------------------------------- |
| SSRF attack attempts blocked        | N/A     | 100%       | Monitor validateAndFetchURL() rejections          |
| Schema validation failures caught   | N/A     | Track rate | Monitor Zod validation errors                     |
| BullMQ duplicate job prevention     | N/A     | 100%       | Monitor jobId deduplication                       |
| Audit log coverage (custom domains) | N/A     | 100%       | Verify all create/access/delete logged            |
| Tenant isolation violations         | N/A     | 0          | Integration test coverage + production monitoring |

---

## 10. Open Questions (Resolved)

### Question 1: Seed input: URL scraping vs. name-only?

**Answer**: Support all three (URL, name+industry, paragraph), URL optional.

**Rationale**:

- URL scraping gives richer context but requires SSRF protection (Section 3.1)
- Name-only is safe but may have stale training data for small companies
- Short paragraph gives best balance of safety and richness
- Make URL optional with clear security warning in UI

**Decision**: Implement all three in Phase 2, default to paragraph input.

### Question 2: Sub-product depth limit?

**Answer**: Two levels only (product → sub-product), enforced by schema validation.

**Rationale**:

- Deeper nesting adds UI complexity (chip selector becomes nested accordion)
- Classifier prompt size grows linearly with depth → higher costs
- Architecture review showed 11 → 30 products already risks 67% cost increase
- Three-level hierarchy would make prompt too large for Haiku

**Decision**: Hard limit of 2 levels, enforced by `DomainDefinitionSchema` (Section 3.2).

### Question 3: Custom domain sharing?

**Answer**: Not in initial implementation. Revisit after 6 months of adoption data.

**Rationale**:

- Tenant-created domains may contain competitive intelligence
- Sharing requires privacy review and opt-in mechanism
- Unclear if customers want to share (need adoption data first)
- Audit logging (Section 3.3) enables tracking for future sharing feature

**Decision**: Defer until Q3 2026, collect telemetry on custom domain creation rate.

### Question 4: Refinement loop: automatic vs. manual trigger?

**Answer**: Automatic quality signal computation with 1-hour TTL cache. Refinement actions always require manual approval.

**Rationale**:

- Automatic computation ensures signals are fresh when admin opens dashboard
- 1-hour cache prevents expensive recomputation on every page load (Section 4.4)
- Manual refinement approval prevents taxonomy degradation from automated changes
- Rollback mechanism (Section 4.4) provides safety net if admin makes bad decision

**Decision**: Implement automatic computation in Phase 4, trigger after enrichment + refinement completion.

### Question 5: What if LLM generation quality < 70%? (New)

**Answer**: Escalation path defined in Phase 2.

| Condition              | Action                                                      |
| ---------------------- | ----------------------------------------------------------- |
| Validation rate < 50%  | Escalate Haiku → Sonnet for all generation                  |
| Validation rate < 30%  | Escalate Sonnet → Opus, accept higher cost (~$0.10/profile) |
| Recall/Precision < 50% | Defer feature launch, wait for better models                |

**Decision**: Measure on benchmark dataset (Section 5.1) before Phase 2 launch.

### Question 6: What if A/B test shows sub-products degrade accuracy? (New)

**Answer**: Do NOT implement Phase 1 sub-products. Keep 11 flat products.

**Rationale**:

- Architecture review highlighted accuracy regression risk
- 67% cost increase not acceptable if accuracy drops > 2%
- Alternative: Recommend customers use custom products for fine-grained disambiguation

**Decision**: A/B test is blocking requirement for Phase 1 (Section 5.2).

---

## 11. Architecture Review Resolution Summary

All findings from architecture review have been addressed in this revision:

### CRITICAL (3 findings - ALL RESOLVED)

| Finding                                          | Status      | Resolution                                                    |
| ------------------------------------------------ | ----------- | ------------------------------------------------------------- |
| [ABLP-KG-001] SSRF in URL fetching               | ✅ RESOLVED | Section 3.1: validateAndFetchURL() with blocked hosts/schemes |
| [ABLP-KG-002] Schema mismatch: subProducts field | ✅ RESOLVED | Section 4.3: Schema migration required before Phase 1         |
| [ABLP-KG-003] No BullMQ job deduplication        | ✅ RESOLVED | Section 3.4: jobId pattern for all refinement jobs            |

### HIGH (4 findings - ALL RESOLVED)

| Finding                                  | Status      | Resolution                                                |
| ---------------------------------------- | ----------- | --------------------------------------------------------- |
| [ABLP-KG-004] Custom domains unencrypted | ✅ RESOLVED | Section 3.3: Audit logging for create/access/delete       |
| [ABLP-KG-005] Quality signals not cached | ✅ RESOLVED | Section 4.4: MongoDB cache with 1-hour TTL                |
| [ABLP-KG-006] No rollback mechanism      | ✅ RESOLVED | Section 4.4: Version taxonomy, store previous 10 versions |
| [ABLP-KG-007] Weak LLM validation        | ✅ RESOLVED | Section 3.2: Zod schema validation with strict rules      |

### MEDIUM (4 findings - ALL RESOLVED)

| Finding                                         | Status      | Resolution                                                 |
| ----------------------------------------------- | ----------- | ---------------------------------------------------------- |
| [ABLP-KG-008] Sub-products increase prompt size | ✅ RESOLVED | Section 4.3: A/B test required before Phase 1              |
| [ABLP-KG-009] No domain prioritization data     | ✅ RESOLVED | Section 4.5: Data-driven expansion, not assumptions        |
| [ABLP-KG-010] No testing strategy               | ✅ RESOLVED | Section 5: Benchmark dataset, A/B tests, integration tests |
| [ABLP-KG-011] Tab competition in UI             | ✅ RESOLVED | Section 4.4: Inline health signals, not separate tab       |

### LOW (2 findings - ALL RESOLVED)

| Finding                              | Status      | Resolution                                                   |
| ------------------------------------ | ----------- | ------------------------------------------------------------ |
| [ABLP-KG-012] Phase order suboptimal | ✅ RESOLVED | Section 7: Phase 0 first, Phase 1+2 parallel, Phase 4 then 3 |
| [ABLP-KG-013] Missing cost analysis  | ✅ RESOLVED | Section 4.4: Full cost formulas with breakeven calculations  |

---

**Recommendation**: Approved for implementation after Phase 0 (security + schema migration) completion.

**Next Steps**:

1. Create Phase 0 implementation ticket
2. Create benchmark dataset (12 ground truth org profiles)
3. Design A/B test infrastructure for sub-product validation
4. Schedule architecture review checkpoint after Phase 0 completion

**End of RFC**

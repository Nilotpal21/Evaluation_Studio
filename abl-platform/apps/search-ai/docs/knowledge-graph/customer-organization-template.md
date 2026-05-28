# Customer Organization Profile Template

> **Purpose**: This template defines the organization-specific information that customers should provide to enable accurate, domain-aware knowledge graph extraction.
> **Usage**: Customers fill out this template (markdown format) and upload it during index configuration. The LLM uses this context to understand the customer's domain vocabulary, product structure, and business context.
> **Format**: Markdown (.md file) — customers provide human-readable descriptions, not structured data.

---

## Instructions for Customers

Please provide detailed information about your organization in the sections below. This information will be used to:

1. **Understand your domain vocabulary** — industry-specific terms, product names, acronyms
2. **Disambiguate similar concepts** — how your products/services differ from each other
3. **Extract relevant entities** — customer IDs, product codes, document types specific to your business
4. **Build accurate relationships** — avoid linking unrelated products or services

**Important**: Write in natural language. You don't need to format data precisely — our system will parse your descriptions using AI.

---

## Section 1: Company Overview

### 1.1 Company Name & Industry

- **Company Name**: [Your company legal name]
- **Industry**: [Primary industry — e.g., Banking, Manufacturing, Pharmaceuticals, Consumer Goods, Software, Financial Services, etc.]
- **Sub-Industry**: [More specific — e.g., Retail Banking, Electrical Equipment, Crop Science, Pet Food, B2B SaaS, Wealth Management]

**Example**:

```
Company Name: National Bank of Bahrain (NBB)
Industry: Banking & Financial Services
Sub-Industry: Retail banking, corporate banking, investment banking
```

---

### 1.2 Geographic Markets

- **Countries/Regions Served**: [List countries, regions, or markets where you operate]
- **Regulatory Jurisdictions**: [Key regulatory bodies or compliance requirements — e.g., "SAMA (Saudi Arabia), CBB (Bahrain), SEC (USA)", or "FDA, EPA, EMA"]

**Example**:

```
Countries/Regions Served: Bahrain, Saudi Arabia, United Arab Emirates
Regulatory Jurisdictions: Central Bank of Bahrain (CBB), Saudi Central Bank (SAMA), Central Bank of UAE
```

---

### 1.3 Business Model

- **B2B, B2C, or Both**: [Who are your customers?]
- **Revenue Model**: [How do you make money? — e.g., subscription, transaction fees, product sales, advisory fees]

**Example**:

```
B2B, B2C, or Both: Both (retail customers and corporate clients)
Revenue Model: Interest income (loans), fees (account maintenance, transaction fees), advisory fees (wealth management)
```

---

## Section 2: Product & Service Portfolio

### 2.1 Product Categories

**List your major product/service categories.** For each category, provide:

- **Category Name**: What do you call this group of products?
- **Description**: What does this category include?
- **Example Products**: List 3-5 example products/services in this category

**Example** (Banking):

```markdown
### Category: Credit Cards

- **Description**: Revolving credit lines with rewards, interest charges, and credit limits. Distinct from debit cards (no credit, direct withdrawal from account).
- **Example Products**:
  - Platinum Rewards Credit Card
  - Cashback Credit Card
  - Travel Miles Credit Card
  - Business Credit Card

### Category: Debit Cards

- **Description**: Direct withdrawal from checking/savings accounts. No credit involved. Daily withdrawal limits apply.
- **Example Products**:
  - Standard Debit Card
  - Premium Debit Card (higher limits)
  - Student Debit Card

### Category: Housing Loans

- **Description**: Long-term secured loans for purchasing property. Requires down payment, property valuation, and collateral.
- **Example Products**:
  - Fixed-rate Mortgage (15-year, 30-year)
  - Variable-rate Mortgage
  - Islamic Housing Finance (Sharia-compliant)

### Category: Personal Loans

- **Description**: Unsecured short-term loans for personal expenses. No collateral required. Higher interest rates than secured loans.
- **Example Products**:
  - Quick Personal Loan (24-hour disbursal)
  - Education Loan
  - Medical Emergency Loan
```

---

### 2.2 Product Disambiguation (Critical!)

**This is the most important section.** Describe products that are similar but must NOT be confused or cross-linked.

For each pair or group of similar products, explain:

- **What makes them different?**
- **What keywords distinguish them?**
- **What attributes apply to one but NOT the other?**

**Example** (Banking):

```markdown
### Credit Card vs Debit Card

- **Credit Card**: Revolving credit, interest charges (APR), credit limit, rewards programs, affects credit score
- **Debit Card**: Direct withdrawal from account, no credit, daily ATM limits, no interest, no rewards
- **Key Distinction**: "credit", "APR", "rewards", "credit score" → Credit Card ONLY. "debit", "withdrawal", "checking account", "savings account" → Debit Card ONLY.
- **DO NOT RELATE**: Credit card interest rates have NOTHING to do with debit card withdrawal limits.

### Housing Loan vs Personal Loan

- **Housing Loan**: Long-term (15-30 years), secured by property, down payment required, lower interest rate (6-10%), property valuation
- **Personal Loan**: Short-term (1-5 years), unsecured, no collateral, higher interest rate (10-20%), quick disbursal
- **Key Distinction**: "mortgage", "property", "down payment", "LTV" → Housing Loan ONLY. "unsecured", "no collateral", "quick loan" → Personal Loan ONLY.
- **DO NOT RELATE**: Housing loan application process has NOTHING to do with personal loan application.
```

**Example** (Manufacturing):

```markdown
### Building Wire vs Power Cable

- **Building Wire**: Low-voltage (600V, 1000V), residential/commercial wiring, AWG sizing (14 AWG, 12 AWG), THHN/THWN insulation, NEC Article 310
- **Power Cable**: Medium/high-voltage (15kV, 25kV, 35kV), utility transmission/distribution, kcmil sizing (250 kcmil, 500 kcmil), XLPE insulation, IEEE 1202
- **Key Distinction**: "branch circuit", "receptacle", "THHN", "AWG" → Building Wire ONLY. "substation", "transmission", "XLPE", "kcmil" → Power Cable ONLY.
- **DO NOT RELATE**: Building wire voltage ratings (600V) have NOTHING to do with power cable voltage ratings (15kV).
```

---

### 2.3 Product Hierarchies

**If your products have parent-child or hierarchical relationships**, describe them here.

**Example** (CPG):

```markdown
### Brand Hierarchy

- **Parent Brand**: MARS Petcare
  - **Sub-Brand**: Pedigree (Dog Food)
    - **Products**: Pedigree Adult Dry Food, Pedigree Puppy Food, Pedigree Wet Food
  - **Sub-Brand**: Whiskas (Cat Food)
    - **Products**: Whiskas Adult Dry Food, Whiskas Kitten Food, Whiskas Wet Food
  - **Sub-Brand**: Iams (Premium Pet Food)
    - **Products**: Iams ProActive Health, Iams Healthy Naturals

- **Parent Brand**: MARS Chocolate
  - **Sub-Brand**: M&M's
    - **Products**: M&M's Peanut, M&M's Plain, M&M's Almond
  - **Sub-Brand**: Snickers
    - **Products**: Snickers Original, Snickers Almond, Snickers Ice Cream

**Key Point**: Pedigree (dog food) and M&M's (chocolate) are under the same parent company (MARS) but are COMPLETELY DIFFERENT product lines. Do NOT relate dog food to chocolate.
```

---

## Section 3: Domain-Specific Terminology

### 3.1 Acronyms & Abbreviations

**List acronyms commonly used in your domain.** For each acronym, provide:

- **Acronym**: The abbreviation
- **Full Form**: What it stands for
- **Context**: When/where it's used

**Example** (Banking):

```markdown
- **APR**: Annual Percentage Rate — interest rate on credit cards and loans
- **EMI**: Equated Monthly Installment — fixed monthly payment on loans
- **LTV**: Loan-to-Value ratio — loan amount as percentage of property value (housing loans)
- **NPA**: Non-Performing Asset — loan in default
- **KYC**: Know Your Customer — identity verification process
- **AML**: Anti-Money Laundering — regulatory compliance for financial crimes
```

**Example** (Pharma):

```markdown
- **API**: Active Pharmaceutical Ingredient — the drug compound
- **NDA**: New Drug Application — FDA approval for new drugs
- **BLA**: Biologics License Application — FDA approval for biologics
- **IND**: Investigational New Drug — application to start clinical trials
- **GMP**: Good Manufacturing Practice — quality standards for pharma manufacturing
- **CAPA**: Corrective Action Preventive Action — quality management process
```

---

### 3.2 Industry-Specific Terms

**List terms that are unique to your industry or have special meanings in your context.**

**Example** (Manufacturing):

```markdown
- **Ampacity**: Current-carrying capacity of a wire (measured in amps)
- **AWG**: American Wire Gauge — wire size standard (smaller number = thicker wire)
- **kcmil**: Thousand circular mils — large conductor size measurement
- **XLPE**: Cross-linked polyethylene — insulation material for power cables
- **NEC**: National Electrical Code — safety standard for electrical installations
- **FRAC**: Fungicide Resistance Action Committee — classification for fungicides
```

---

### 3.3 Internal Codes & Identifiers

**Describe your internal product codes, customer IDs, or document identifiers.**

**Example** (Banking):

```markdown
- **Customer ID**: Format `CUST-#######` (7 digits) — unique identifier for each customer
- **Credit Card ID**: Format `CC-#######` — credit card account number
- **Debit Card ID**: Format `DC-#######` — debit card account number
- **Housing Loan ID**: Format `HL-#######` or `MTG-#######`
- **Account Number**: Format `CA-#######` (checking) or `SA-#######` (savings)
```

**Example** (Manufacturing):

```markdown
- **SKU Format**: `BW-#####` (Building Wire), `PC-#####` (Power Cable), `TRF-#####` (Transformer)
- **Lot Code**: Format `LOT-YYYYMMDD-###` — production batch identifier
- **Part Number**: Format `####-###-##` — manufacturer part number
```

---

## Section 4: Business Processes & Workflows

### 4.1 Key Processes

**Describe important processes or workflows in your business.** This helps the system understand document types and their relationships.

**Example** (Banking):

```markdown
### Credit Card Application Process

1. Customer submits application (online or in-branch)
2. Credit score check (via credit bureau)
3. Income verification (salary certificate, tax returns)
4. Employment verification (employer contact)
5. Credit history review (existing loans, payment history)
6. Approval decision (automated or manual underwriting)
7. Card issuance (physical card mailed to customer)

**Related Documents**: Application form, credit report, income proof, approval letter, terms & conditions, card agreement

### Housing Loan Application Process

1. Property selection (by customer)
2. Property valuation (by bank-approved appraiser)
3. Income verification (salary certificate, bank statements)
4. Credit score check
5. Down payment verification (proof of funds)
6. Legal documentation (title search, property deed)
7. Loan approval (credit committee)
8. Disbursement (funds transferred to seller)

**Related Documents**: Application form, property valuation report, income proof, bank statements, property deed, loan agreement, disbursement letter
```

---

### 4.2 Document Types

**List the types of documents your organization creates or manages.** For each type, briefly describe its purpose.

**Example** (Banking):

```markdown
- **Loan Agreement**: Legal contract between bank and borrower detailing loan terms
- **Account Statement**: Monthly summary of account transactions and balances
- **Credit Card Statement**: Monthly billing statement with transactions, balance, minimum payment
- **Approval Letter**: Notification of loan/credit card approval
- **Terms & Conditions**: Legal document outlining product rules and policies
- **Disclosure Form**: Regulatory disclosures (interest rates, fees, risks)
- **KYC Document**: Customer identity verification documents (ID, address proof)
```

**Example** (Pharma):

```markdown
- **Clinical Study Report (CSR)**: Summary of clinical trial results
- **Investigator Brochure (IB)**: Drug information for clinical investigators
- **Informed Consent Form (ICF)**: Patient consent for trial participation
- **Regulatory Submission**: NDA, BLA, IND applications to FDA/EMA
- **Product Label**: FDA-approved prescribing information
- **Manufacturing SOP**: Standard operating procedure for drug production
- **Batch Record**: Documentation of manufacturing batch
```

---

## Section 5: Customer Segments & Use Cases

### 5.1 Customer Segments

**Who are your customers?** Describe different customer types or segments.

**Example** (Banking):

```markdown
- **Retail Customers**: Individual consumers with checking/savings accounts, debit cards, personal loans
- **Premium Customers**: High-net-worth individuals with wealth management, premium credit cards, private banking
- **Small Business**: SMEs with business accounts, business loans, payroll services
- **Corporate Clients**: Large enterprises with corporate accounts, trade finance, cash management
```

**Example** (B2B SaaS):

```markdown
- **Small Business** (1-50 employees): Simple billing needs, basic features, self-service setup
- **Mid-Market** (50-500 employees): Multi-entity billing, integrations, dedicated support
- **Enterprise** (500+ employees): Complex hierarchies, custom workflows, dedicated CSM, SLA guarantees
```

---

### 5.2 Common Use Cases

**What are typical questions or tasks your customers perform?** This helps the system understand query intent.

**Example** (Banking):

```markdown
1. "What is the interest rate on credit cards?" → Need APR information for credit cards (NOT debit cards or loans)
2. "How do I apply for a housing loan?" → Need housing loan application process (NOT personal loan process)
3. "What is the daily withdrawal limit on my debit card?" → Need debit card ATM limits (NOT credit card limits)
4. "Can I get a loan without collateral?" → Need personal loan information (unsecured, NOT housing loan)
5. "What documents do I need to open a savings account?" → Need KYC requirements for account opening
```

**Example** (Manufacturing):

```markdown
1. "What wire size do I need for a 20A circuit?" → Need building wire recommendations (NOT power cable)
2. "What cable do I use for a 15kV substation?" → Need power cable specifications (NOT building wire)
3. "Is this product NEC-compliant?" → Need National Electrical Code compliance information
4. "What's the ampacity of 12 AWG THHN?" → Need building wire current rating
```

---

## Section 6: Regulatory & Compliance Context

### 6.1 Regulatory Bodies

**List key regulatory agencies or standards that govern your business.**

**Example** (Banking):

```markdown
- **Central Bank of Bahrain (CBB)**: Banking regulations, capital requirements
- **Saudi Central Bank (SAMA)**: Banking license and operations in KSA
- **Basel III**: International banking standards for capital adequacy
- **PCI-DSS**: Payment card data security standards (for card payments)
- **FATCA**: Foreign Account Tax Compliance Act (for US customers)
```

**Example** (Pharma):

```markdown
- **FDA (USA)**: Drug approvals (NDA, BLA), manufacturing inspections (GMP)
- **EMA (Europe)**: European drug approvals (MAA)
- **ICH**: International Council for Harmonisation (clinical trial standards)
- **WHO**: World Health Organization (prequalification for generics)
```

---

### 6.2 Compliance Requirements

**Describe key compliance obligations or standards your organization must meet.**

**Example** (Banking):

```markdown
- **KYC (Know Your Customer)**: Identity verification required for all account openings
- **AML (Anti-Money Laundering)**: Transaction monitoring, suspicious activity reporting
- **Data Protection**: GDPR (for EU customers), local data privacy laws
- **Fair Lending**: Non-discriminatory lending practices
```

---

## Section 7: Additional Context (Optional)

### 7.1 Unique Attributes

**Is there anything unique about your organization or products that we should know?**

**Example** (Banking in Middle East):

```
We offer both conventional banking products (with interest) and Islamic banking products (Sharia-compliant, no interest/riba). These are COMPLETELY SEPARATE product lines:
- **Conventional**: Credit cards, personal loans, housing loans (with interest rates)
- **Islamic**: Islamic credit cards (Tawarruq), Islamic personal finance (Murabaha), Islamic home finance (Ijara)

Key Distinction: "interest", "APR", "interest rate" → Conventional ONLY. "profit rate", "Tawarruq", "Murabaha", "Sharia-compliant" → Islamic ONLY. Do NOT mix these concepts.
```

---

### 7.2 Common Mistakes to Avoid

**What are common errors or confusion points in your domain?**

**Example** (Manufacturing):

```
- **Mistake**: Confusing AWG wire sizes (smaller number = thicker wire, higher ampacity) with kcmil sizes (larger number = thicker conductor).
  - **Correct**: 10 AWG is THICKER than 14 AWG. 500 kcmil is THICKER than 250 kcmil.

- **Mistake**: Recommending building wire (600V) for medium-voltage (15kV) applications.
  - **Correct**: Building wire is for branch circuits; power cable is for transmission/distribution.
```

---

## Section 8: Contact Information (Optional)

### 8.1 Subject Matter Experts

**If we have questions about your domain vocabulary, who should we contact?**

- **Name**: [SME name]
- **Role**: [Job title]
- **Email**: [Contact email]
- **Area of Expertise**: [What they know — e.g., "Product catalog", "Regulatory compliance", "Technical specifications"]

---

## Submission Instructions

1. **Save this file as**: `{your_company_name}-organization-profile.md`
2. **Upload during index configuration** in the Search-AI platform
3. **Review and update** as your product portfolio or terminology changes

**Questions?** Contact your Customer Success Manager or email support@agent-platform.com.

---

**End of Customer Organization Profile Template**

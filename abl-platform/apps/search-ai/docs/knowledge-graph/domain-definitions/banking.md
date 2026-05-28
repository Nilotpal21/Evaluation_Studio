# Domain Definition: Banking & Financial Institutions

> **Version**: 1.0
> **Industry**: Banking, Financial Services
> **Last Updated**: 2026-02-24
> **Applicable To**: Retail banking, corporate banking, investment banking

This is a default domain definition that can be customized per tenant/index. It provides foundational vocabulary, product taxonomy, and disambiguation rules for banking institutions.

---

## Product Hierarchy

### 1. Cards (Department: Card Services)

#### 1.1 Credit Card (Sub-department: Credit Card Division)

- **Description**: Revolving credit line with interest charges, rewards programs, and credit limits
- **Key Attributes**:
  - `credit_limit`: Maximum borrowing amount
  - `interest_rate`: APR (Annual Percentage Rate)
  - `annual_fee`: Yearly card maintenance fee
  - `rewards_program`: Points/cashback structure
  - `grace_period`: Interest-free period for new purchases
  - `minimum_payment`: Required monthly payment
- **Identifier Patterns**:
  - `CC-#######` (Credit Card ID)
  - `4[0-9]{15}` (Visa credit card number pattern)
  - `5[1-5][0-9]{14}` (Mastercard pattern)
- **Disambiguation Keywords**: credit, revolving, APR, credit limit, rewards, cashback, credit score, borrowing
- **Application Process**:
  1. Credit score check
  2. Income verification
  3. Employment verification
  4. Credit history review
  5. Approval decision
- **Required Documents**: Government ID, proof of income, address proof, employment letter

#### 1.2 Debit Card (Sub-department: Debit Card Division)

- **Description**: Direct withdrawal from linked checking/savings account, no credit involved
- **Key Attributes**:
  - `daily_withdrawal_limit`: ATM cash limit per day
  - `transaction_fees`: Per-transaction charges
  - `linked_account`: Associated checking/savings account
  - `overdraft_protection`: Optional overdraft coverage
  - `international_usage_fees`: Charges for foreign transactions
- **Identifier Patterns**:
  - `DC-#######` (Debit Card ID)
  - Same 16-digit pattern as credit cards but distinguished by BIN range
- **Disambiguation Keywords**: debit, direct withdrawal, checking account, savings account, PIN, ATM, no credit
- **Application Process**:
  1. Open checking/savings account
  2. Request debit card
  3. Set PIN
  4. Card issuance
- **Required Documents**: Government ID, account opening documents, address proof

#### 1.3 Prepaid Card (Sub-department: Card Services)

- **Description**: Pre-loaded card with fixed balance, no credit or bank account required
- **Key Attributes**:
  - `card_balance`: Current loaded amount
  - `reload_options`: Methods to add funds
  - `expiry_date`: Card validity period
  - `reload_fees`: Charges for adding funds
- **Identifier Patterns**: `PC-#######`
- **Disambiguation Keywords**: prepaid, reload, gift card, travel card, no bank account
- **Application Process**:
  1. Purchase card
  2. Load funds
  3. Activate card
- **Required Documents**: Minimal (government ID for high-value cards)

---

### 2. Loans (Department: Lending Services)

#### 2.1 Housing Loan / Mortgage (Sub-department: Mortgage Division)

- **Description**: Long-term loan for purchasing residential or commercial property
- **Key Attributes**:
  - `loan_amount`: Principal borrowed
  - `interest_rate`: Fixed or variable rate
  - `loan_tenure`: Repayment period (typically 15-30 years)
  - `down_payment`: Upfront payment percentage
  - `emi`: Equated Monthly Installment
  - `property_valuation`: Assessed property value
  - `ltv_ratio`: Loan-to-Value ratio
- **Identifier Patterns**: `HL-#######` or `MTG-#######`
- **Disambiguation Keywords**: mortgage, home loan, property, real estate, down payment, LTV, EMI, foreclosure, refinance
- **Application Process**:
  1. Property selection
  2. Property valuation
  3. Income verification
  4. Credit score check
  5. Down payment verification
  6. Legal documentation
  7. Loan approval
  8. Disbursement
- **Required Documents**: Property documents, income proof, employment letter, bank statements (6 months), tax returns, government ID

#### 2.2 Personal Loan (Sub-department: Personal Lending Division)

- **Description**: Unsecured loan for personal expenses (medical, travel, education, etc.)
- **Key Attributes**:
  - `loan_amount`: Principal borrowed
  - `interest_rate`: Fixed rate (typically higher than secured loans)
  - `loan_tenure`: Repayment period (typically 1-5 years)
  - `processing_fee`: Upfront loan processing charge
  - `emi`: Equated Monthly Installment
  - `collateral`: None (unsecured)
- **Identifier Patterns**: `PL-#######`
- **Disambiguation Keywords**: personal loan, unsecured, no collateral, quick disbursal, flexible use, medical expenses, education
- **Application Process**:
  1. Loan application
  2. Income verification
  3. Credit score check
  4. Employment verification
  5. Approval decision
  6. Disbursement (24-48 hours)
- **Required Documents**: Government ID, income proof, employment letter, bank statements (3-6 months)

#### 2.3 Auto Loan / Vehicle Loan (Sub-department: Auto Finance Division)

- **Description**: Secured loan for purchasing new or used vehicles
- **Key Attributes**:
  - `loan_amount`: Principal borrowed
  - `interest_rate`: Fixed or variable rate
  - `loan_tenure`: Repayment period (typically 3-7 years)
  - `down_payment`: Upfront payment percentage
  - `vehicle_value`: Assessed vehicle value
  - `emi`: Equated Monthly Installment
- **Identifier Patterns**: `AL-#######` or `VL-#######`
- **Disambiguation Keywords**: auto loan, car loan, vehicle finance, down payment, vehicle registration, insurance
- **Application Process**:
  1. Vehicle selection
  2. Vehicle valuation
  3. Income verification
  4. Credit score check
  5. Down payment verification
  6. Loan approval
  7. Vehicle registration
  8. Disbursement
- **Required Documents**: Vehicle documents, income proof, employment letter, government ID, insurance documents

#### 2.4 Business Loan (Sub-department: Commercial Lending Division)

- **Description**: Loan for business operations, expansion, or equipment purchase
- **Key Attributes**:
  - `loan_amount`: Principal borrowed
  - `interest_rate`: Fixed or variable rate
  - `loan_tenure`: Repayment period (varies)
  - `collateral`: Business assets or personal guarantee
  - `business_turnover`: Annual revenue
  - `purpose`: Working capital, expansion, equipment, etc.
- **Identifier Patterns**: `BL-#######`
- **Disambiguation Keywords**: business loan, commercial loan, SME loan, working capital, business expansion, equipment finance
- **Application Process**:
  1. Business plan submission
  2. Financial statements review (2-3 years)
  3. Collateral assessment
  4. Credit history check
  5. Business viability analysis
  6. Loan approval
  7. Disbursement
- **Required Documents**: Business registration, financial statements, tax returns, business plan, collateral documents, director IDs

---

### 3. Accounts (Department: Deposit Services)

#### 3.1 Checking Account / Current Account (Sub-department: Transaction Banking)

- **Description**: Transactional account for daily banking with unlimited transactions
- **Key Attributes**:
  - `account_number`: Unique account identifier
  - `minimum_balance`: Required minimum balance to avoid fees
  - `transaction_limit`: Daily transaction limits
  - `overdraft_facility`: Optional credit facility
  - `monthly_fee`: Account maintenance charge
- **Identifier Patterns**: `CA-#######` or `CHK-#######`
- **Disambiguation Keywords**: checking, current account, transactions, overdraft, monthly fee, debit card, checkbook
- **Application Process**:
  1. Account opening form
  2. KYC verification
  3. Initial deposit
  4. Account activation
- **Required Documents**: Government ID, address proof, initial deposit

#### 3.2 Savings Account (Sub-department: Deposit Services)

- **Description**: Interest-bearing account for savings with transaction limits
- **Key Attributes**:
  - `account_number`: Unique account identifier
  - `minimum_balance`: Required minimum balance
  - `interest_rate`: Annual interest on balance
  - `transaction_limit`: Monthly withdrawal limits
  - `passbook`: Physical/digital passbook
- **Identifier Patterns**: `SA-#######` or `SAV-#######`
- **Disambiguation Keywords**: savings, interest, passbook, minimum balance, deposits, withdrawals
- **Application Process**:
  1. Account opening form
  2. KYC verification
  3. Initial deposit
  4. Account activation
- **Required Documents**: Government ID, address proof, initial deposit

#### 3.3 Fixed Deposit / Certificate of Deposit (Sub-department: Term Deposits)

- **Description**: Time-bound deposit with fixed interest rate and maturity date
- **Key Attributes**:
  - `deposit_amount`: Principal amount
  - `interest_rate`: Fixed annual interest
  - `tenure`: Lock-in period (months/years)
  - `maturity_date`: Date of deposit maturity
  - `premature_withdrawal_penalty`: Charge for early withdrawal
- **Identifier Patterns**: `FD-#######` or `CD-#######`
- **Disambiguation Keywords**: fixed deposit, term deposit, certificate of deposit, maturity, lock-in, guaranteed returns
- **Application Process**:
  1. Deposit amount selection
  2. Tenure selection
  3. Nominee details
  4. FD creation
- **Required Documents**: Government ID, source of funds (for large amounts)

---

### 4. Investment Products (Department: Wealth Management)

#### 4.1 Mutual Funds (Sub-department: Investment Advisory)

- **Description**: Pooled investment vehicle managed by professional fund managers
- **Key Attributes**:
  - `fund_name`: Name of mutual fund
  - `nav`: Net Asset Value
  - `risk_category`: Low/Medium/High
  - `fund_type`: Equity/Debt/Hybrid
  - `expense_ratio`: Annual fund management fee
  - `minimum_investment`: Minimum SIP/lumpsum amount
- **Identifier Patterns**: `MF-#######`
- **Disambiguation Keywords**: mutual fund, NAV, SIP, lumpsum, equity, debt, portfolio, fund manager
- **Application Process**:
  1. Risk profiling
  2. Fund selection
  3. KYC verification
  4. Investment
- **Required Documents**: Government ID, PAN card, bank account details

---

## Attribute Specificity Rules

### Attribute: `interest_rate`

- **Applies to**: credit_card, housing_loan, personal_loan, auto_loan, business_loan, savings_account, fixed_deposit
- **Does NOT apply to**: debit_card, checking_account, prepaid_card
- **Contextual Meanings**:
  - **credit_card**: APR on revolving balance (typically 15-30%)
  - **housing_loan**: Mortgage rate (typically 6-10%)
  - **personal_loan**: Unsecured loan rate (typically 10-20%)
  - **savings_account**: Interest earned on balance (typically 2-4%)
  - **fixed_deposit**: Guaranteed return on locked-in deposit (typically 5-8%)

### Attribute: `credit_limit`

- **Applies to**: credit_card, overdraft_facility
- **Does NOT apply to**: debit_card, savings_account, fixed_deposit, loans
- **Contextual Meanings**:
  - **credit_card**: Maximum borrowing limit on card
  - **overdraft_facility**: Maximum negative balance allowed on checking account

### Attribute: `emi` (Equated Monthly Installment)

- **Applies to**: housing_loan, personal_loan, auto_loan, business_loan
- **Does NOT apply to**: credit_card, accounts, investment_products
- **Contextual Meanings**:
  - All loans: Fixed monthly payment (principal + interest)

### Attribute: `withdrawal_limit`

- **Applies to**: debit_card, savings_account, checking_account
- **Does NOT apply to**: credit_card, loans, fixed_deposit
- **Contextual Meanings**:
  - **debit_card**: Daily ATM withdrawal limit
  - **savings_account**: Monthly withdrawal transaction limit

---

## Department Boundaries

### Credit Card Division

- **Excludes**: debit_card, prepaid_card, all_loans, all_accounts, investment_products
- **Reasoning**: Credit card operations (credit limits, APR, rewards) are fundamentally different from debit/prepaid (direct withdrawal) and loans (structured repayment)

### Debit Card Division

- **Excludes**: credit_card, all_loans, investment_products
- **Can relate to**: checking_account, savings_account (linked accounts)
- **Reasoning**: Debit cards are transaction instruments for existing deposits, not credit or lending products

### Mortgage Division

- **Excludes**: credit_card, debit_card, personal_loan, auto_loan (different lending criteria and collateral)
- **Can relate to**: property_insurance, home_insurance
- **Reasoning**: Mortgages have unique underwriting (property valuation, LTV ratios, long tenure)

### Personal Lending Division

- **Excludes**: housing_loan, auto_loan, business_loan (different collateral and purpose)
- **Can relate to**: credit_card (both unsecured)
- **Reasoning**: Personal loans are unsecured short-term lending, different from secured/long-term loans

### Transaction Banking

- **Excludes**: credit_card, all_loans, investment_products
- **Can relate to**: debit_card, overdraft_facility
- **Reasoning**: Checking accounts are transactional, not credit/investment products

---

## Common Entity Types

### Customer Entities

- **PERSON**: Customer names
- **CUSTOMER_ID**: Unique customer identifier (pattern: `CUST-#######`)
- **EMAIL**: Customer email addresses
- **PHONE**: Customer phone numbers
- **ADDRESS**: Customer residential/business addresses

### Product Entities

- **CREDIT_CARD_ID**: Credit card identifiers (pattern: `CC-#######`)
- **DEBIT_CARD_ID**: Debit card identifiers (pattern: `DC-#######`)
- **LOAN_ID**: Loan account identifiers (pattern: `HL-#######`, `PL-#######`, etc.)
- **ACCOUNT_NUMBER**: Bank account numbers (pattern: `CA-#######`, `SA-#######`)

### Financial Entities

- **MONEY**: Currency amounts (pattern: `$###,###.##`, `AED ###,###`, `SAR ###,###`)
- **DATE**: Application dates, maturity dates, payment due dates
- **PERCENTAGE**: Interest rates, fees, down payment percentages

### Document Entities

- **APPLICATION_ID**: Application reference numbers
- **CONTRACT_ID**: Loan/credit agreements
- **STATEMENT_ID**: Account statement identifiers
- **INVOICE_ID**: Billing/fee invoices

---

## Common Relationship Types

### Product-to-Customer

- `CUSTOMER_HAS_ACCOUNT`: Customer owns checking/savings account
- `CUSTOMER_HAS_CARD`: Customer owns credit/debit/prepaid card
- `CUSTOMER_HAS_LOAN`: Customer has active loan

### Product-to-Product

- `CARD_LINKED_TO_ACCOUNT`: Debit card linked to checking/savings account
- `LOAN_SECURED_BY_PROPERTY`: Housing loan secured by real estate
- `LOAN_SECURED_BY_VEHICLE`: Auto loan secured by vehicle
- `OVERDRAFT_ON_ACCOUNT`: Overdraft facility on checking account

### Document-to-Product

- `APPLICATION_FOR_PRODUCT`: Application references product
- `STATEMENT_FOR_ACCOUNT`: Statement belongs to account
- `INVOICE_FOR_CARD`: Billing statement for credit card

### Co-occurrence Relationships (IDF-weighted)

- `CO_OCCURS_WITH`: Two entities frequently appear together (e.g., "credit_card" and "rewards_program")

---

## Use Case Examples

### Use Case 1: Credit Card Interest Rate Inquiry

**User Query**: "What is the interest rate on credit cards?"

**Expected Behavior**:

1. Detect product scope: `credit_card`
2. Extract entities: `interest_rate`, `credit_card`
3. Filter relationships to credit card division only (exclude debit_card, loans)
4. Return: APR information specific to credit cards

**Avoid False Positives**: Do NOT return debit card information or loan interest rates

---

### Use Case 2: Housing Loan Application Process

**User Query**: "How do I apply for a housing loan?"

**Expected Behavior**:

1. Detect product scope: `housing_loan`
2. Extract entities: `housing_loan`, `application_process`
3. Filter relationships to mortgage division only (exclude personal_loan, auto_loan)
4. Return: Housing loan application steps, required documents

**Avoid False Positives**: Do NOT return personal loan or business loan application processes

---

### Use Case 3: Debit Card Daily Withdrawal Limit

**User Query**: "What is the daily limit on my debit card?"

**Expected Behavior**:

1. Detect product scope: `debit_card`
2. Extract entities: `debit_card`, `withdrawal_limit`
3. Filter relationships to debit card division only (exclude credit_card)
4. Return: Daily ATM withdrawal limit information

**Avoid False Positives**: Do NOT return credit card credit limits or spending limits

---

## Regulatory Compliance Context

### KYC (Know Your Customer)

- Required for: All accounts, cards, loans, investment products
- Documents: Government ID, address proof, PAN/tax ID
- Verification: Physical/video/digital verification

### AML (Anti-Money Laundering)

- Transaction monitoring for suspicious activity
- Large transaction reporting (>$10,000 or local equivalent)
- Source of funds verification for large deposits

### PCI-DSS (Payment Card Industry Data Security Standard)

- Applicable to: All card products
- Requirements: Tokenization, encryption, secure card storage

### Basel III / Capital Adequacy

- Applicable to: Lending operations
- Requirements: Risk-weighted asset calculations, capital buffers

---

## Disambiguation Examples

### Example 1: "interest rate"

- **Context**: Credit card document
- **Correct Interpretation**: APR on revolving balance
- **Incorrect Interpretation**: Savings account interest or loan interest

### Example 2: "limit"

- **Context**: Credit card document
- **Correct Interpretation**: Credit limit (maximum borrowing)
- **Context**: Debit card document
- **Correct Interpretation**: Daily withdrawal limit
- **Incorrect Cross-context Match**: Do NOT relate credit card limit to debit card limit

### Example 3: "application process"

- **Context**: Housing loan document
- **Correct Interpretation**: Mortgage application steps (property valuation, LTV, etc.)
- **Context**: Personal loan document
- **Correct Interpretation**: Personal loan application steps (no collateral, quick disbursal)
- **Incorrect Cross-context Match**: Do NOT show housing loan process when user asks about personal loan

---

## Configuration Recommendations

### Enable Knowledge Graph For:

- Multi-product banking platforms (to distinguish between similar products)
- Regulatory compliance tracking (link customers to products to documents)
- Cross-sell opportunities (identify related products customer doesn't have)
- Document relationship mapping (applications → approvals → disbursements)

### Disable Knowledge Graph For:

- Single-product systems (e.g., only credit cards)
- Simple FAQ/chatbot scenarios (semantic search is sufficient)
- Low-volume document collections (<100 documents)

---

## Tenant-Specific Customization Notes

This default definition should be customized per tenant by:

1. **Adding tenant-specific products** (e.g., "Platinum Rewards Card", "Green Home Loan")
2. **Updating identifier patterns** to match internal product codes
3. **Adding regional terminology** (e.g., "current account" vs "checking account")
4. **Defining custom attributes** specific to tenant's offerings
5. **Adding compliance requirements** specific to tenant's jurisdictions

**Customization Path**: `config/knowledge-graph/domain-definitions/{tenantId}/banking.md` (overrides this default)

---

**End of Default Banking Domain Definition**

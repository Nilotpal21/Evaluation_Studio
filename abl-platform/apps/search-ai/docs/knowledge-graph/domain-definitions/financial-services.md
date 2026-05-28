# Domain Definition: Financial Services & Advisory

> **Version**: 2.0
> **Industry**: Financial Advisory, Wealth Management, Investment Services
> **Last Updated**: 2026-03-04
> **Applicable To**: Financial advisors, wealth management, investment planning, retirement planning
> **Product Count**: 30 (12 parent products + 18 sub-products)
> **RFC**: RFC-001 Phase 1 Expansion

This is a default domain definition that can be customized per tenant/index. It provides foundational vocabulary, product taxonomy, and disambiguation rules for financial services and advisory organizations.

**Version 2.0 Changes** (RFC-001 Phase 1):

- Expanded from 12 to 30 products by adding hierarchical sub-products
- Added sub-products for: Mutual Funds (3), ETFs (2), Individual Stocks (3), Bonds (2), 401(k) Plans (2), IRA (2), Annuities (2), Life Insurance (2)
- Each sub-product includes specific disambiguation keywords for improved classification accuracy
- Enables more precise product categorization (e.g., "Index Fund" vs "Actively Managed Fund" within Mutual Funds)

---

## Product Hierarchy

### 1. Investment Products (Department: Wealth Management)

#### 1.1 Mutual Funds (Sub-department: Managed Funds)

- **Description**: Professionally managed investment portfolios pooling investor capital
- **Sub-Products**:
  - **1.1.1 Index Funds**: Passively managed funds tracking market indexes (S&P 500, Total Market)
    - **Disambiguation Keywords**: index fund, passive, tracking, benchmark, low-cost
  - **1.1.2 Actively Managed Funds**: Funds with active manager selection of securities
    - **Disambiguation Keywords**: active management, fund manager, stock picking, outperform
  - **1.1.3 Target-Date Funds**: Age-based asset allocation funds (e.g., "Target 2050")
    - **Disambiguation Keywords**: target-date, retirement date, glide path, lifecycle fund
- **Key Attributes**:
  - `fund_name`: Commercial fund name
  - `ticker_symbol`: Stock ticker symbol
  - `asset_class`: Equity, fixed income, balanced, alternative
  - `investment_objective`: Growth, income, capital preservation
  - `expense_ratio`: Annual fund management fee (as percentage)
  - `minimum_investment`: Minimum initial investment amount
  - `morningstar_rating`: Star rating (1-5 stars)
  - `fund_manager`: Portfolio manager name
  - `inception_date`: Fund launch date
  - `aum`: Assets Under Management
- **Identifier Patterns**:
  - `MF-#####` (Mutual Fund ID)
  - Ticker symbol (5-letter pattern: `VFIAX`, `FXAIX`)
  - CUSIP (9-character alphanumeric)
- **Disambiguation Keywords**: mutual fund, fund, portfolio, expense ratio, NAV, prospectus, asset allocation
- **Regulatory Compliance**: SEC-registered, prospectus disclosure, FINRA rules

#### 1.2 Exchange-Traded Funds (ETFs) (Sub-department: Exchange-Traded Products)

- **Description**: Index funds traded on stock exchanges like individual stocks
- **Sub-Products**:
  - **1.2.1 Equity ETFs**: Stock-based ETFs (broad market, sector, international)
    - **Disambiguation Keywords**: equity ETF, stock ETF, market exposure, sector ETF
  - **1.2.2 Bond ETFs**: Fixed-income ETFs (treasury, corporate, municipal)
    - **Disambiguation Keywords**: bond ETF, fixed-income ETF, AGG, BND
- **Key Attributes**:
  - `fund_name`: Commercial fund name
  - `ticker_symbol`: Stock ticker symbol
  - `underlying_index`: Index tracked (S&P 500, NASDAQ 100, etc.)
  - `asset_class`: Equity, fixed income, commodity, currency
  - `expense_ratio`: Annual management fee (typically lower than mutual funds)
  - `liquidity`: Trading volume
  - `tracking_error`: How closely fund tracks index
- **Identifier Patterns**:
  - `ETF-#####` (ETF ID)
  - Ticker symbol (3-4 letter pattern: `SPY`, `QQQ`, `AGG`)
- **Disambiguation Keywords**: ETF, exchange-traded fund, index fund, ticker, trading, liquidity, tracking error
- **Regulatory Compliance**: SEC-registered, prospectus disclosure

#### 1.3 Individual Stocks (Sub-department: Equity Securities)

- **Description**: Shares of publicly traded companies
- **Sub-Products**:
  - **1.3.1 Growth Stocks**: High-growth potential companies (tech, emerging sectors)
    - **Disambiguation Keywords**: growth stock, high growth, technology, innovation
  - **1.3.2 Value Stocks**: Undervalued companies trading below intrinsic value
    - **Disambiguation Keywords**: value stock, undervalued, P/E ratio, dividend
  - **1.3.3 Dividend Stocks**: Established companies paying regular dividends
    - **Disambiguation Keywords**: dividend stock, income stock, dividend yield, payout
- **Key Attributes**:
  - `company_name`: Issuer company name
  - `ticker_symbol`: Stock ticker symbol
  - `exchange`: NYSE, NASDAQ, etc.
  - `sector`: Technology, healthcare, financials, etc.
  - `market_cap`: Large-cap, mid-cap, small-cap
  - `dividend_yield`: Annual dividend as percentage of stock price
  - `pe_ratio`: Price-to-earnings ratio
- **Identifier Patterns**:
  - Ticker symbol (1-5 letters: `AAPL`, `MSFT`, `GOOGL`)
  - CUSIP (9-character alphanumeric)
- **Disambiguation Keywords**: stock, equity, shares, ticker, dividend, earnings, market cap
- **Regulatory Compliance**: SEC-registered, public company disclosures

#### 1.4 Bonds (Sub-department: Fixed Income Securities)

- **Description**: Debt securities issued by governments or corporations
- **Sub-Products**:
  - **1.4.1 Treasury Bonds**: U.S. government-issued debt securities
    - **Disambiguation Keywords**: treasury, T-bond, government bond, risk-free, sovereign
  - **1.4.2 Municipal Bonds**: State and local government bonds (tax-exempt)
    - **Disambiguation Keywords**: muni bond, municipal, tax-exempt, tax-free
- **Key Attributes**:
  - `issuer`: Government (Treasury, municipal) or corporate
  - `coupon_rate`: Interest rate paid to bondholder
  - `maturity_date`: Date bond principal is repaid
  - `credit_rating`: Moody's/S&P rating (AAA, AA, A, BBB, etc.)
  - `yield_to_maturity`: Expected return if held to maturity
  - `bond_type`: Treasury, municipal, corporate, high-yield
- **Identifier Patterns**:
  - `BOND-#####` (Bond ID)
  - CUSIP (9-character alphanumeric)
- **Disambiguation Keywords**: bond, fixed income, coupon, maturity, yield, credit rating, treasury, municipal, corporate
- **Regulatory Compliance**: SEC-registered (corporate), MSRB rules (municipal)

---

### 2. Retirement Plans (Department: Retirement Services)

#### 2.1 401(k) Plans (Sub-department: Defined Contribution Plans)

- **Description**: Employer-sponsored retirement savings plans with tax advantages
- **Sub-Products**:
  - **2.1.1 Traditional 401(k)**: Pre-tax contributions, taxed upon withdrawal
    - **Disambiguation Keywords**: traditional 401k, pre-tax, tax-deferred
  - **2.1.2 Roth 401(k)**: After-tax contributions, tax-free withdrawals
    - **Disambiguation Keywords**: Roth 401k, after-tax, tax-free growth
- **Key Attributes**:
  - `plan_type`: Traditional 401(k), Roth 401(k), Safe Harbor
  - `contribution_limit`: Annual IRS contribution limit ($22,500 in 2023)
  - `employer_match`: Employer matching contribution (e.g., "50% up to 6%")
  - `vesting_schedule`: Employee ownership timeline (immediate, graded, cliff)
  - `investment_options`: Available funds/investments
  - `loan_provisions`: Plan loan availability and terms
- **Identifier Patterns**: `401K-#####`
- **Disambiguation Keywords**: 401(k), retirement plan, contribution limit, employer match, vesting, rollover
- **Regulatory Compliance**: ERISA, IRS rules, plan document requirements

#### 2.2 IRA (Individual Retirement Account) (Sub-department: Individual Retirement Plans)

- **Description**: Personal retirement savings accounts with tax advantages
- **Sub-Products**:
  - **2.2.1 Traditional IRA**: Pre-tax contributions, tax-deductible, taxed upon withdrawal
    - **Disambiguation Keywords**: traditional IRA, tax-deductible, pre-tax IRA
  - **2.2.2 Roth IRA**: After-tax contributions, tax-free growth and withdrawals
    - **Disambiguation Keywords**: Roth IRA, tax-free, after-tax IRA, income limits
- **Key Attributes**:
  - `ira_type`: Traditional IRA, Roth IRA, SEP IRA, SIMPLE IRA
  - `contribution_limit`: Annual IRS limit ($6,500 in 2023, $7,500 if 50+)
  - `tax_treatment`: Pre-tax (Traditional) or after-tax (Roth)
  - `withdrawal_rules`: Age 59½ penalty-free, RMDs at 73
  - `income_limits`: Roth IRA income eligibility limits
- **Identifier Patterns**: `IRA-#####`
- **Disambiguation Keywords**: IRA, traditional IRA, Roth IRA, contribution, withdrawal, RMD, rollover
- **Regulatory Compliance**: IRS rules, contribution limits, RMD requirements

#### 2.3 Annuities (Sub-department: Insurance Products)

- **Description**: Insurance contracts providing guaranteed income streams
- **Sub-Products**:
  - **2.3.1 Fixed Annuities**: Guaranteed fixed interest rate and income payments
    - **Disambiguation Keywords**: fixed annuity, guaranteed rate, fixed income
  - **2.3.2 Variable Annuities**: Investment-based annuities with market exposure
    - **Disambiguation Keywords**: variable annuity, investment options, market-based
- **Key Attributes**:
  - `annuity_type`: Fixed, variable, indexed, immediate, deferred
  - `payout_option`: Lifetime income, period certain, joint and survivor
  - `surrender_period`: Early withdrawal penalty period
  - `death_benefit`: Beneficiary payment guarantee
  - `fees`: M&E fees, admin fees, rider fees
- **Identifier Patterns**: `ANN-#####`
- **Disambiguation Keywords**: annuity, guaranteed income, payout, surrender period, variable annuity, fixed annuity
- **Regulatory Compliance**: State insurance regulation, SEC registration (variable annuities), FINRA rules

---

### 3. Advisory Services (Department: Financial Planning)

#### 3.1 Wealth Management (Sub-department: Comprehensive Planning)

- **Description**: Holistic financial planning for high-net-worth individuals
- **Key Attributes**:
  - `service_type`: Investment management, tax planning, estate planning, risk management
  - `fee_structure`: AUM-based (e.g., "1% of assets"), flat fee, hourly
  - `minimum_assets`: Minimum portfolio size for service (e.g., "$500,000")
  - `planning_areas`: Retirement, education, estate, tax, insurance
- **Identifier Patterns**: `WM-SVC-####`
- **Disambiguation Keywords**: wealth management, financial planning, AUM, fiduciary, comprehensive planning
- **Regulatory Compliance**: SEC RIA registration, Form ADV disclosure, fiduciary duty

#### 3.2 Retirement Planning (Sub-department: Retirement Advisory)

- **Description**: Specialized planning for retirement income and savings
- **Key Attributes**:
  - `service_type`: Retirement income planning, Social Security optimization, pension analysis
  - `target_client`: Pre-retiree, retiree
  - `planning_horizon`: Years to retirement or in retirement
  - `income_sources`: Social Security, pension, 401(k), IRA, annuities
- **Identifier Patterns**: `RP-SVC-####`
- **Disambiguation Keywords**: retirement planning, Social Security, pension, retirement income, withdrawal strategy
- **Regulatory Compliance**: SEC RIA registration, FINRA rules (if broker-dealer)

#### 3.3 Tax Planning (Sub-department: Tax Advisory)

- **Description**: Tax-efficient investment and income strategies
- **Key Attributes**:
  - `service_type`: Tax-loss harvesting, Roth conversions, charitable giving, estate tax planning
  - `tax_strategies`: Tax-deferred growth, tax-free income, capital gains management
- **Identifier Patterns**: `TAX-SVC-####`
- **Disambiguation Keywords**: tax planning, tax-loss harvesting, Roth conversion, capital gains, tax-efficient
- **Regulatory Compliance**: IRS rules, state tax laws, CPA coordination

---

### 4. Insurance Products (Department: Risk Management)

#### 4.1 Life Insurance (Sub-department: Life Products)

- **Description**: Death benefit protection for beneficiaries
- **Sub-Products**:
  - **4.1.1 Term Life Insurance**: Temporary coverage for specific term (10, 20, 30 years)
    - **Disambiguation Keywords**: term life, temporary coverage, level term, decreasing term
  - **4.1.2 Permanent Life Insurance**: Lifetime coverage with cash value (whole, universal, variable)
    - **Disambiguation Keywords**: permanent life, whole life, universal life, cash value
- **Key Attributes**:
  - `policy_type`: Term life, whole life, universal life, variable life
  - `death_benefit`: Face amount of policy
  - `premium`: Monthly/annual cost
  - `cash_value`: Accumulation in permanent policies
  - `term_length`: 10-year, 20-year, 30-year (term policies)
- **Identifier Patterns**: `LIFE-#####`
- **Disambiguation Keywords**: life insurance, term life, whole life, death benefit, premium, cash value
- **Regulatory Compliance**: State insurance regulation, underwriting, beneficiary designation

#### 4.2 Long-Term Care Insurance (Sub-department: LTC Products)

- **Description**: Coverage for nursing home, assisted living, or in-home care costs
- **Key Attributes**:
  - `policy_type`: Traditional LTC, hybrid (life + LTC), partnership policy
  - `daily_benefit`: Daily coverage amount (e.g., "$200/day")
  - `benefit_period`: Coverage duration (e.g., "3 years", "5 years", "unlimited")
  - `elimination_period`: Waiting period before benefits start (e.g., "90 days")
  - `inflation_protection`: Benefit increase option
- **Identifier Patterns**: `LTC-#####`
- **Disambiguation Keywords**: long-term care, LTC, nursing home, assisted living, daily benefit, elimination period
- **Regulatory Compliance**: State insurance regulation, partnership programs, underwriting

---

## Attribute Specificity Rules

### Attribute: `expense_ratio`

- **Applies to**: mutual_funds, ETFs
- **Does NOT apply to**: individual_stocks, bonds (no management fees for individual securities)
- **Contextual Meanings**:
  - **mutual_funds**: Annual fund management fee (typically 0.5%-2%)
  - **ETFs**: Annual management fee (typically 0.03%-0.5%, lower than mutual funds)

### Attribute: `ticker_symbol`

- **Applies to**: mutual_funds, ETFs, individual_stocks
- **Does NOT apply to**: bonds (use CUSIP), retirement_plans, advisory_services, insurance_products
- **Contextual Meanings**:
  - **mutual_funds**: 5-letter ticker (e.g., `VFIAX`)
  - **ETFs**: 3-4 letter ticker (e.g., `SPY`, `QQQ`)
  - **stocks**: 1-5 letter ticker (e.g., `AAPL`, `MSFT`)

### Attribute: `contribution_limit`

- **Applies to**: 401k_plans, IRAs
- **Does NOT apply to**: investment_products, advisory_services, insurance_products
- **Contextual Meanings**:
  - **401(k)**: $22,500 annual limit (2023), plus $7,500 catch-up if 50+
  - **IRA**: $6,500 annual limit (2023), plus $1,000 catch-up if 50+

### Attribute: `death_benefit`

- **Applies to**: life_insurance, annuities (with death benefit riders)
- **Does NOT apply to**: investment_products, retirement_plans, advisory_services
- **Contextual Meanings**:
  - **life_insurance**: Face amount paid to beneficiary upon death
  - **annuities**: Return of premium or account value to beneficiary

### Attribute: `fee_structure`

- **Applies to**: advisory_services (wealth management, retirement planning)
- **Does NOT apply to**: investment_products (use expense_ratio), insurance_products (use premium)
- **Contextual Meanings**:
  - **advisory_services**: AUM-based (1% of assets), flat fee, hourly, or commission-based

### Attribute: `credit_rating`

- **Applies to**: bonds (corporate and municipal)
- **Does NOT apply to**: stocks, mutual_funds, ETFs, retirement_plans
- **Contextual Meanings**:
  - **bonds**: Moody's/S&P rating (AAA, AA, A, BBB, BB, B, CCC, etc.)

---

## Department Boundaries

### Wealth Management Department

- **Includes**: mutual_funds, ETFs, individual_stocks, bonds (investment products)
- **Excludes**: retirement_plans (separate department), insurance_products (separate department)
- **Reasoning**: Investment products are securities; retirement plans and insurance are distinct regulatory categories

### Mutual Funds Sub-department

- **Excludes**: ETFs (different trading mechanism), individual_stocks, bonds
- **Can relate to**: advisory_services (funds recommended by advisors)
- **Reasoning**: Mutual funds are actively managed and trade at NAV; ETFs trade intraday like stocks

### Retirement Services Department

- **Includes**: 401k_plans, IRAs, annuities
- **Excludes**: investment_products (though they're held within retirement accounts), advisory_services
- **Reasoning**: Retirement plans are tax-advantaged account wrappers; underlying investments are separate

### 401(k) Plans Sub-department

- **Excludes**: IRAs, annuities
- **Can relate to**: mutual_funds (investment options within 401(k))
- **Reasoning**: 401(k) is employer-sponsored; IRA is individual; different rules and contribution limits

### Financial Planning Department

- **Includes**: wealth_management, retirement_planning, tax_planning
- **Excludes**: investment_products, retirement_plans, insurance_products (advisory services, not products)
- **Reasoning**: Advisory services provide guidance; products are what clients invest in or purchase

### Risk Management Department

- **Includes**: life_insurance, ltc_insurance, disability_insurance
- **Excludes**: investment_products, retirement_plans, advisory_services
- **Reasoning**: Insurance products provide protection; investment products provide growth; different regulatory frameworks

---

## Common Entity Types

### Security Identifiers

- **TICKER_SYMBOL**: Stock/fund ticker (pattern: `AAPL`, `VFIAX`, `SPY`)
- **CUSIP**: 9-character security identifier
- **ISIN**: International securities identifier
- **FUND_NAME**: Mutual fund/ETF name

### Financial Metrics

- **EXPENSE_RATIO**: Fund management fee percentage
- **YIELD**: Bond yield, dividend yield, or fund yield
- **PE_RATIO**: Price-to-earnings ratio (stocks)
- **CREDIT_RATING**: Moody's/S&P bond rating
- **NAV**: Net Asset Value (mutual funds)

### Regulatory Identifiers

- **SEC_FILE_NUMBER**: SEC registration number
- **CRD_NUMBER**: Central Registration Depository number (advisors/brokers)
- \*\*STATE_LICENSE`: Insurance license number

### Client Entities

- **CLIENT_ID**: Client account identifier
- **ACCOUNT_NUMBER**: Investment/retirement account number
- **POLICY_NUMBER**: Insurance policy identifier

---

## Common Relationship Types

### Product-to-Client

- `CLIENT_HOLDS_INVESTMENT`: Client owns mutual fund/stock/bond
- `CLIENT_ENROLLED_IN_PLAN`: Client participates in 401(k)/IRA
- `CLIENT_HAS_POLICY`: Client owns life insurance/LTC policy

### Product-to-Product

- `FUND_HOLDS_STOCK`: Mutual fund/ETF holds individual stock
- `401K_OFFERS_FUND`: 401(k) plan offers specific mutual fund as investment option
- `REPLACES_PRODUCT`: New product supersedes old product (fund mergers)

### Advisory-to-Product

- `RECOMMENDS_INVESTMENT`: Advisor recommends specific fund/stock/bond
- `ALLOCATES_TO_ASSET_CLASS`: Portfolio allocation to equity/fixed income/alternative
- `IMPLEMENTS_STRATEGY`: Tax-loss harvesting strategy implemented

### Regulatory Relationships

- `REGULATED_BY`: Product regulated by SEC, FINRA, state insurance department
- `DISCLOSED_IN`: Product details disclosed in prospectus, Form ADV, policy contract
- `COMPLIES_WITH`: Strategy complies with IRS rules, ERISA, fiduciary duty

---

## Use Case Examples

### Use Case 1: Mutual Fund Expense Ratio

**User Query**: "What is the expense ratio of VFIAX?"

**Expected Behavior**:

1. Detect product scope: `mutual_funds`
2. Extract entities: `VFIAX` (ticker), `expense_ratio`
3. Filter to mutual funds sub-department (exclude ETFs, stocks, bonds)
4. Return: "VFIAX (Vanguard 500 Index Fund Admiral Shares) has an expense ratio of 0.04%."

**Avoid False Positives**: Do NOT return ETF expense ratios or individual stock information

---

### Use Case 2: 401(k) Contribution Limit

**User Query**: "How much can I contribute to my 401(k) this year?"

**Expected Behavior**:

1. Detect product scope: `401k_plans`
2. Extract entities: `401(k)`, `contribution_limit`
3. Filter to 401(k) sub-department (exclude IRAs, annuities)
4. Return: "The 2023 401(k) contribution limit is $22,500. If you're 50 or older, you can contribute an additional $7,500 catch-up contribution."

**Avoid False Positives**: Do NOT return IRA contribution limits or annuity premium information

---

### Use Case 3: Roth IRA Income Limits

**User Query**: "What are the Roth IRA income limits?"

**Expected Behavior**:

1. Detect product scope: `IRAs`
2. Extract entities: `Roth IRA`, `income_limits`
3. Filter to IRA sub-department (exclude 401(k), annuities)
4. Return: "For 2023, Roth IRA contributions are phased out for single filers with MAGI between $138,000-$153,000."

**Avoid False Positives**: Do NOT return Traditional IRA deduction limits or 401(k) income limits

---

### Use Case 4: Term Life Insurance vs Whole Life

**User Query**: "What's the difference between term life and whole life insurance?"

**Expected Behavior**:

1. Detect product scope: `life_insurance`
2. Extract entities: `term life`, `whole life`
3. Filter to life insurance sub-department (exclude LTC, disability insurance)
4. Return: "Term life provides temporary coverage (e.g., 20 years) with no cash value. Whole life provides permanent coverage with cash value accumulation."

**Avoid False Positives**: Do NOT return annuity information or long-term care insurance

---

## Disambiguation Examples

### Example 1: "contribution"

- **Context**: 401(k) plan document
- **Correct Interpretation**: Employee salary deferral or employer match contribution
- **Context**: Mutual fund document
- **Correct Interpretation**: NOT APPLICABLE (mutual funds don't have "contributions", they have "investments" or "purchases")

### Example 2: "expense ratio"

- **Context**: Mutual fund document
- **Correct Interpretation**: Annual fund management fee (typically 0.5%-2%)
- **Context**: ETF document
- **Correct Interpretation**: Annual management fee (typically 0.03%-0.5%, lower than mutual funds)
- **Incorrect Cross-context Match**: Do NOT confuse mutual fund expense ratios with ETF expense ratios (different magnitudes)

### Example 3: "death benefit"

- **Context**: Life insurance document
- **Correct Interpretation**: Face amount paid to beneficiary upon death
- **Context**: Annuity document
- **Correct Interpretation**: Return of premium or account value to beneficiary (if death benefit rider)
- **Incorrect Cross-context Match**: Life insurance death benefit (primary purpose) vs annuity death benefit (optional rider)

---

## Configuration Recommendations

### Enable Knowledge Graph For:

- Multi-product financial platforms (investments + retirement + insurance + advisory)
- Regulatory compliance tracking (linking products to disclosures to regulations)
- Client portfolio management (linking clients to products to advisors)
- Financial planning knowledge bases (linking strategies to products to tax rules)
- Advisor training materials (linking product features to use cases to compliance)

### Disable Knowledge Graph For:

- Single-product documentation (e.g., one mutual fund prospectus)
- Marketing brochures (no technical/financial content)
- Simple FAQs

---

## Tenant-Specific Customization Notes

This default definition should be customized per tenant by:

1. **Adding proprietary funds** (firm-specific mutual funds, ETFs, SMAs)
2. **Defining planning methodologies** (retirement income strategies, tax planning approaches)
3. **Adding regional regulations** (state-specific insurance rules, ERISA variations)
4. **Defining advisor credentials** (CFP, CFA, CPA, ChFC, etc.)
5. **Adding client segments** (mass affluent, high-net-worth, ultra-high-net-worth)

**Customization Path**: `config/knowledge-graph/domain-definitions/{tenantId}/financial-services.md` (overrides this default)

---

**End of Default Financial Services & Advisory Domain Definition**

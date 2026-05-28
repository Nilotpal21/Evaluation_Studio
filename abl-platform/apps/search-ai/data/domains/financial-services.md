# Domain: financial-services

- name: Financial Services
- version: 1.0.0

## Categories

- id: consumer-banking, name: Consumer Banking, department: Consumer Banking
- id: lending, name: Lending, department: Lending
- id: investments, name: Investments, department: Wealth Management
- id: insurance, name: Insurance, department: Insurance

## Products

### checking-account

- name: Checking Account
- categoryId: consumer-banking
- department: Consumer Banking
- subDepartment: Deposit Products
- disambiguationKeywords: checking, debit card, transactions, ATM, overdraft

### savings-account

- name: Savings Account
- categoryId: consumer-banking
- department: Consumer Banking
- subDepartment: Deposit Products
- disambiguationKeywords: savings, interest rate, APY, deposit, balance

### credit-card

- name: Credit Card
- categoryId: lending
- department: Lending
- subDepartment: Consumer Credit
- disambiguationKeywords: credit card, APR, credit limit, rewards, cashback, minimum payment

### mortgage

- name: Mortgage
- categoryId: lending
- department: Lending
- subDepartment: Real Estate Lending
- disambiguationKeywords: mortgage, home loan, down payment, fixed rate, adjustable rate, ARM, closing costs, property, appraisal

### personal-loan

- name: Personal Loan
- categoryId: lending
- department: Lending
- subDepartment: Consumer Credit
- disambiguationKeywords: personal loan, unsecured loan, fixed payment, term loan, debt consolidation

### auto-loan

- name: Auto Loan
- categoryId: lending
- department: Lending
- subDepartment: Vehicle Financing
- disambiguationKeywords: auto loan, car loan, vehicle financing, refinance, trade-in

### investment-account

- name: Investment Account
- categoryId: investments
- department: Wealth Management
- subDepartment: Investments
- disambiguationKeywords: investment, portfolio, stocks, bonds, mutual funds, ETF, brokerage

### retirement-account

- name: Retirement Account
- categoryId: investments
- department: Wealth Management
- subDepartment: Retirement Planning
- disambiguationKeywords: retirement, 401k, IRA, Roth IRA, pension, contribution, rollover

### life-insurance

- name: Life Insurance
- categoryId: insurance
- department: Insurance
- subDepartment: Life Insurance
- disambiguationKeywords: life insurance, term life, whole life, beneficiary, death benefit, premium

### home-insurance

- name: Home Insurance
- categoryId: insurance
- department: Insurance
- subDepartment: Property Insurance
- disambiguationKeywords: home insurance, homeowners, property insurance, dwelling coverage, liability, deductible

### auto-insurance

- name: Auto Insurance
- categoryId: insurance
- department: Insurance
- subDepartment: Vehicle Insurance
- disambiguationKeywords: auto insurance, car insurance, collision, comprehensive, liability coverage

## Attributes

### interest_rate

- name: Interest Rate
- dataType: percentage
- applicableTo: savings-account, credit-card, mortgage, personal-loan, auto-loan
- method: regex
- patterns: \d+\.\d+%, \d+% APR, \d+\.\d+% APY
- keywords: interest rate, APR, APY, annual percentage rate

### credit_limit

- name: Credit Limit
- dataType: currency
- applicableTo: credit-card
- method: regex
- patterns: \$[\d,]+, credit limit of \$[\d,]+
- keywords: credit limit, credit line, limit

### loan_amount

- name: Loan Amount
- dataType: currency
- applicableTo: mortgage, personal-loan, auto-loan
- method: regex
- patterns: \$[\d,]+, loan amount of \$[\d,]+
- keywords: loan amount, principal, borrowed

### loan_term

- name: Loan Term
- dataType: duration
- applicableTo: mortgage, personal-loan, auto-loan
- method: regex
- patterns: \d+ years?, \d+ months?, \d+-year, \d+-month
- keywords: loan term, term, duration, repayment period

### down_payment

- name: Down Payment
- dataType: currency
- applicableTo: mortgage, auto-loan
- method: regex
- patterns: \$[\d,]+, \d+% down
- keywords: down payment, deposit, upfront

### maturity_date

- name: Maturity Date
- dataType: date
- applicableTo: savings-account, investment-account, retirement-account
- method: llm
- keywords: maturity date, expires, matures on

### premium

- name: Premium
- dataType: currency
- applicableTo: life-insurance, home-insurance, auto-insurance
- method: regex
- patterns: \$[\d,]+ per month, \$[\d,]+ monthly premium, \$[\d,]+ annually
- keywords: premium, monthly payment, annual premium

### coverage_amount

- name: Coverage Amount
- dataType: currency
- applicableTo: life-insurance, home-insurance, auto-insurance
- method: regex
- patterns: \$[\d,]+ coverage, up to \$[\d,]+
- keywords: coverage, coverage amount, insured amount, death benefit

### deductible

- name: Deductible
- dataType: currency
- applicableTo: home-insurance, auto-insurance
- method: regex
- patterns: \$[\d,]+ deductible
- keywords: deductible, out-of-pocket

### account_number

- name: Account Number
- dataType: identifier
- applicableTo: checking-account, savings-account, credit-card, investment-account, retirement-account
- method: regex
- patterns: [A-Z]{2}\d{8,12}, \d{10,16}
- keywords: account number, account #, acct

## Department Boundaries

- product1: credit-card, product2: personal-loan, reasoning: Both are unsecured consumer credit products in Lending department, but credit cards are revolving credit while personal loans are term loans with fixed payments.
- product1: mortgage, product2: home-insurance, reasoning: Mortgage is lending product (Lending department), home insurance is insurance product (Insurance department). Often mentioned together in home-buying context.
- product1: auto-loan, product2: auto-insurance, reasoning: Auto loan is lending product (Lending department), auto insurance is insurance product (Insurance department). Often bundled in vehicle financing.
- product1: investment-account, product2: retirement-account, reasoning: Both are investment products in Wealth Management, but retirement accounts have specific tax treatment and withdrawal rules.

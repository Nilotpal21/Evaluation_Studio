# Domain Definition: Software & B2B SaaS

> **Version**: 1.0
> **Industry**: Software, B2B SaaS, Technology Services
> **Last Updated**: 2026-02-24
> **Applicable To**: Enterprise software, SaaS platforms, API products, technical documentation

This is a default domain definition that can be customized per tenant/index. It provides foundational vocabulary, product taxonomy, and disambiguation rules for software and B2B SaaS organizations.

---

## Product Hierarchy

### 1. Core Platform Products (Department: Platform Engineering)

#### 1.1 Billing & Revenue Management (Sub-department: Billing Platform)

- **Description**: Subscription billing, usage-based billing, revenue recognition
- **Key Attributes**:
  - `product_module`: Subscription management, usage rating, invoicing, payments, revenue recognition
  - `billing_model`: Subscription, usage-based, hybrid, prepaid, postpaid
  - `rating_engine`: Real-time rating, batch rating, tiered pricing, volume discounts
  - `payment_gateway`: Stripe, Adyen, Braintree, custom
  - `revenue_recognition`: ASC 606, IFRS 15 compliance
  - `integration`: CRM (Salesforce), ERP (NetSuite), payment processors
- **Identifier Patterns**:
  - `BILL-MOD-####` (Billing Module ID)
  - `API-BILL-####` (Billing API endpoint identifier)
- **Disambiguation Keywords**: billing, subscription, invoice, payment, revenue recognition, usage rating, metering
- **Technical Standards**: REST API, GraphQL, Webhooks, OAuth 2.0, PCI-DSS compliance

#### 1.2 Customer Management (Sub-department: Customer Platform)

- **Description**: Customer data management, account hierarchy, customer lifecycle
- **Key Attributes**:
  - `product_module`: Customer accounts, account hierarchy, customer lifecycle, segmentation
  - `data_model`: B2B (account-based), B2C (individual), hybrid
  - `account_hierarchy`: Parent-child, multi-tenant, single-tenant
  - `lifecycle_stages`: Prospect, customer, at-risk, churned
  - `integration`: CRM, CDP, data warehouse
- **Identifier Patterns**: `CUST-MOD-####`
- **Disambiguation Keywords**: customer management, account hierarchy, lifecycle, segmentation, CRM integration
- **Technical Standards**: REST API, GDPR compliance, data encryption

#### 1.3 Order Management (Sub-department: Order Platform)

- **Description**: Order capture, order orchestration, fulfillment, provisioning
- **Key Attributes**:
  - `product_module`: Order capture, order decomposition, fulfillment, provisioning
  - `order_type`: New, change, upgrade, downgrade, cancellation
  - `fulfillment_method`: Automated, manual, hybrid
  - `provisioning`: Service activation, resource allocation, account setup
  - `integration`: Fulfillment systems, inventory, provisioning tools
- **Identifier Patterns**: `ORD-MOD-####`
- **Disambiguation Keywords**: order management, fulfillment, provisioning, service activation, order orchestration
- **Technical Standards**: REST API, event-driven architecture, state machines

---

### 2. Analytics & Reporting (Department: Analytics Platform)

#### 2.1 Revenue Analytics (Sub-department: Financial Analytics)

- **Description**: Revenue reporting, churn analysis, MRR/ARR tracking
- **Key Attributes**:
  - `analytics_type`: Revenue dashboards, churn analysis, cohort analysis, forecasting
  - `metrics`: MRR, ARR, churn rate, CLTV, CAC, net retention
  - `reporting_frequency`: Real-time, daily, weekly, monthly, quarterly
  - `data_source`: Billing platform, CRM, data warehouse
  - `export_format`: CSV, Excel, PDF, API
- **Identifier Patterns**: `ANA-REV-####`
- **Disambiguation Keywords**: revenue analytics, MRR, ARR, churn, cohort, forecasting, financial reporting
- **Technical Standards**: BI tools (Tableau, Looker), SQL, data warehouse integration

#### 2.2 Usage Analytics (Sub-department: Product Analytics)

- **Description**: Product usage tracking, feature adoption, user behavior
- **Key Attributes**:
  - `analytics_type`: Usage dashboards, feature adoption, user behavior, product analytics
  - `metrics`: DAU, MAU, feature usage, session duration, engagement score
  - `tracking_method`: Event tracking, session recording, heatmaps
  - `data_source`: Product telemetry, usage metering
- **Identifier Patterns**: `ANA-USG-####`
- **Disambiguation Keywords**: usage analytics, product analytics, feature adoption, engagement, telemetry
- **Technical Standards**: Event streaming (Kafka), time-series databases, data pipelines

---

### 3. API Products (Department: API Platform)

#### 3.1 REST APIs (Sub-department: API Gateway)

- **Description**: RESTful API endpoints for platform integration
- **Key Attributes**:
  - `api_category`: Billing, customer, order, usage, reporting
  - `http_method`: GET, POST, PUT, PATCH, DELETE
  - `authentication`: OAuth 2.0, API keys, JWT
  - `rate_limiting`: Requests per minute/hour/day
  - `versioning`: v1, v2, etc.
  - `documentation`: OpenAPI/Swagger spec
- **Identifier Patterns**:
  - `/api/v1/billing/invoices` (API endpoint pattern)
  - `API-BILL-INV-001` (API resource identifier)
- **Disambiguation Keywords**: REST API, endpoint, HTTP, authentication, rate limiting, API key, OAuth
- **Technical Standards**: OpenAPI 3.0, REST, JSON, OAuth 2.0, TLS 1.2+

#### 3.2 Webhooks (Sub-department: Event Platform)

- **Description**: Event-driven webhooks for real-time notifications
- **Key Attributes**:
  - `event_type`: Invoice created, payment received, subscription changed, order completed
  - `payload_format`: JSON, XML
  - `delivery_method`: HTTP POST to customer endpoint
  - `retry_logic`: Exponential backoff, max retries
  - `security`: HMAC signature verification
- **Identifier Patterns**: `WEBHOOK-####`
- **Disambiguation Keywords**: webhook, event, notification, callback, real-time, event-driven
- **Technical Standards**: HTTP callbacks, HMAC, idempotency, retry logic

---

### 4. Integration Products (Department: Integration Services)

#### 4.1 CRM Integrations (Sub-department: CRM Connectors)

- **Description**: Pre-built integrations with CRM systems (Salesforce, HubSpot, etc.)
- **Key Attributes**:
  - `crm_platform`: Salesforce, HubSpot, Microsoft Dynamics, Zoho
  - `sync_direction`: One-way, two-way
  - `sync_frequency`: Real-time, hourly, daily
  - `data_objects`: Accounts, contacts, opportunities, invoices
  - `mapping`: Field mapping configuration
- **Identifier Patterns**: `INT-CRM-SFDC-####` (Salesforce integration), `INT-CRM-HUBS-####` (HubSpot)
- **Disambiguation Keywords**: CRM integration, Salesforce, HubSpot, sync, connector, data sync
- **Technical Standards**: REST API, OAuth 2.0, field mapping, data transformation

#### 4.2 ERP Integrations (Sub-department: ERP Connectors)

- **Description**: Pre-built integrations with ERP systems (NetSuite, SAP, etc.)
- **Key Attributes**:
  - `erp_platform`: NetSuite, SAP, Oracle, Microsoft Dynamics
  - `sync_direction`: One-way, two-way
  - `sync_frequency`: Real-time, batch (daily, weekly)
  - `data_objects`: Invoices, payments, revenue recognition, GL entries
  - `mapping`: Chart of accounts mapping
- **Identifier Patterns**: `INT-ERP-NS-####` (NetSuite integration)
- **Disambiguation Keywords**: ERP integration, NetSuite, SAP, financial sync, GL posting, revenue recognition
- **Technical Standards**: SOAP/REST API, batch file transfer, data transformation

---

## Attribute Specificity Rules

### Attribute: `billing_model`

- **Applies to**: billing_platform products
- **Does NOT apply to**: customer_management, order_management, analytics, API products
- **Contextual Meanings**:
  - **billing_platform**: Subscription, usage-based, hybrid, prepaid, postpaid

### Attribute: `http_method`

- **Applies to**: REST_APIs
- **Does NOT apply to**: billing_platform, customer_management, analytics, webhooks
- **Contextual Meanings**:
  - **REST_APIs**: GET, POST, PUT, PATCH, DELETE

### Attribute: `event_type`

- **Applies to**: webhooks
- **Does NOT apply to**: REST_APIs, billing_platform, customer_management
- **Contextual Meanings**:
  - **webhooks**: Invoice created, payment received, subscription changed, etc.

### Attribute: `sync_direction`

- **Applies to**: CRM_integrations, ERP_integrations
- **Does NOT apply to**: billing_platform, analytics, REST_APIs
- **Contextual Meanings**:
  - **integrations**: One-way (push or pull), two-way (bidirectional sync)

### Attribute: `metrics`

- **Applies to**: revenue_analytics, usage_analytics
- **Does NOT apply to**: billing_platform, order_management, API products
- **Contextual Meanings**:
  - **revenue_analytics**: MRR, ARR, churn rate, CLTV, CAC
  - **usage_analytics**: DAU, MAU, feature usage, session duration

### Attribute: `authentication`

- **Applies to**: REST_APIs, webhooks (HMAC signatures)
- **Does NOT apply to**: billing_platform (internal modules), analytics (internal dashboards)
- **Contextual Meanings**:
  - **REST_APIs**: OAuth 2.0, API keys, JWT
  - **webhooks**: HMAC signature verification

---

## Department Boundaries

### Platform Engineering Department

- **Includes**: billing_platform, customer_management, order_management
- **Excludes**: analytics, API products (separate departments)
- **Reasoning**: Core platform modules that operate together; analytics and APIs are consumer-facing layers on top

### Billing Platform Sub-department

- **Excludes**: customer_management, order_management (though they interact via APIs)
- **Can relate to**: revenue_analytics (billing data feeds analytics), REST_APIs (billing endpoints)
- **Reasoning**: Billing handles invoicing/payments; customer management handles account data; order management handles order lifecycle

### Customer Management Sub-department

- **Excludes**: billing_platform, order_management
- **Can relate to**: CRM_integrations (customer data sync), REST_APIs (customer endpoints)
- **Reasoning**: Customer data is distinct from billing/order data, though they reference each other via IDs

### Analytics Platform Department

- **Includes**: revenue_analytics, usage_analytics, operational_analytics
- **Excludes**: billing_platform, API products
- **Can relate to**: All data sources (billing, customer, order, usage)
- **Reasoning**: Analytics consumes data from all systems but doesn't modify source data

### Revenue Analytics Sub-department

- **Excludes**: usage_analytics (different metrics and data sources)
- **Can relate to**: billing_platform (primary data source)
- **Reasoning**: Revenue analytics focuses on financial metrics; usage analytics focuses on product engagement

### API Platform Department

- **Includes**: REST_APIs, webhooks, GraphQL_APIs
- **Excludes**: internal platform modules (billing, customer, order)
- **Can relate to**: All platform modules (APIs expose platform functionality)
- **Reasoning**: APIs are external-facing interfaces; platform modules are internal implementation

---

## Common Entity Types

### Product Entities

- **MODULE_ID**: Product module identifier (pattern: `BILL-MOD-####`, `CUST-MOD-####`)
- **API_ENDPOINT**: API resource path (pattern: `/api/v1/billing/invoices`)
- **WEBHOOK_EVENT**: Webhook event type (pattern: `invoice.created`, `payment.received`)
- **FEATURE_FLAG**: Feature toggle identifier
- **INTEGRATION_ID**: Integration connector identifier (pattern: `INT-CRM-SFDC-####`)

### Technical Entities

- **HTTP_STATUS_CODE**: API response codes (200, 201, 400, 401, 404, 500, etc.)
- \*\*API_KEY`: Authentication key
- **OAUTH_SCOPE**: Permission scope (e.g., `billing:read`, `billing:write`)
- **RATE_LIMIT**: API rate limit (e.g., `100 requests/minute`)
- **API_VERSION**: API version (e.g., `v1`, `v2`)

### Data Entities

- **CUSTOMER_ID**: Unique customer identifier
- **ACCOUNT_ID**: Account identifier (in account hierarchy)
- **INVOICE_ID**: Invoice identifier
- \*\*PAYMENT_ID`: Payment transaction identifier
- **ORDER_ID**: Order identifier
- **SUBSCRIPTION_ID**: Subscription identifier

### Integration Entities

- \*\*CRM_OBJECT`: Salesforce/HubSpot object (Account, Contact, Opportunity)
- **ERP_OBJECT**: NetSuite/SAP object (Invoice, Payment, GL Entry)
- **FIELD_MAPPING**: Source field → target field mapping
- **SYNC_JOB_ID**: Integration sync job identifier

---

## Common Relationship Types

### Module-to-Module

- `INTEGRATES_WITH`: Billing module integrates with payment gateway
- `DEPENDS_ON`: Order module depends on customer module (for account lookup)
- `PUBLISHES_TO`: Billing module publishes events to webhook platform

### API-to-Module

- `EXPOSES_RESOURCE`: REST API exposes billing invoice resource
- `TRIGGERS_ACTION`: API call triggers order creation
- `QUERIES_DATA`: API endpoint queries customer data

### Analytics-to-Source

- `CONSUMES_DATA_FROM`: Revenue analytics consumes data from billing platform
- `AGGREGATES_METRIC`: Analytics dashboard aggregates MRR metric

### Integration-to-System

- `SYNCS_WITH`: CRM integration syncs with Salesforce
- `MAPS_OBJECT`: Integration maps invoice object to NetSuite invoice
- `AUTHENTICATES_VIA`: Integration authenticates via OAuth 2.0

---

## Use Case Examples

### Use Case 1: Billing API Documentation

**User Query**: "How do I create an invoice via API?"

**Expected Behavior**:

1. Detect product scope: `REST_APIs` + `billing_platform`
2. Extract entities: `invoice`, `API`, `create`
3. Filter to REST APIs + billing sub-department
4. Return: `POST /api/v1/billing/invoices` endpoint documentation with request/response examples

**Avoid False Positives**: Do NOT return customer API endpoints or analytics dashboards

---

### Use Case 2: Revenue Metrics Definition

**User Query**: "What is MRR and how is it calculated?"

**Expected Behavior**:

1. Detect product scope: `revenue_analytics`
2. Extract entities: `MRR` (Monthly Recurring Revenue)
3. Filter to revenue analytics sub-department (exclude usage analytics, billing platform)
4. Return: "MRR is Monthly Recurring Revenue, calculated as sum of all active subscription recurring charges normalized to monthly amounts."

**Avoid False Positives**: Do NOT return usage metrics (DAU, MAU) or billing configuration

---

### Use Case 3: Salesforce Integration Setup

**User Query**: "How do I set up the Salesforce integration?"

**Expected Behavior**:

1. Detect product scope: `CRM_integrations`
2. Extract entities: `Salesforce`, `integration`, `setup`
3. Filter to CRM integrations sub-department (exclude ERP integrations, API products)
4. Return: Salesforce OAuth setup, field mapping configuration, sync frequency options

**Avoid False Positives**: Do NOT return NetSuite (ERP) integration docs or HubSpot (different CRM) integration

---

### Use Case 4: Webhook Event Types

**User Query**: "What webhook events are available for invoices?"

**Expected Behavior**:

1. Detect product scope: `webhooks` + `billing_platform`
2. Extract entities: `webhook`, `events`, `invoices`
3. Filter to webhooks + billing sub-department
4. Return: `invoice.created`, `invoice.finalized`, `invoice.paid`, `invoice.voided` event types

**Avoid False Positives**: Do NOT return subscription webhook events or order webhook events

---

## Disambiguation Examples

### Example 1: "customer"

- **Context**: Customer management document
- **Correct Interpretation**: Customer account object with account hierarchy
- **Context**: CRM integration document
- **Correct Interpretation**: Salesforce Account object or HubSpot Company object
- **Incorrect Cross-context Match**: Do NOT confuse platform customer object with CRM-specific object structure

### Example 2: "invoice"

- **Context**: Billing platform document
- **Correct Interpretation**: Invoice record in billing database
- **Context**: ERP integration document
- **Correct Interpretation**: NetSuite Invoice object or SAP billing document
- **Context**: REST API document
- **Correct Interpretation**: `/api/v1/billing/invoices` resource
- **Incorrect Cross-context Match**: Do NOT conflate internal invoice representation with ERP invoice or API response format

### Example 3: "metrics"

- **Context**: Revenue analytics document
- **Correct Interpretation**: MRR, ARR, churn rate (financial metrics)
- **Context**: Usage analytics document
- **Correct Interpretation**: DAU, MAU, feature usage (product engagement metrics)
- **Incorrect Cross-context Match**: Do NOT relate revenue metrics to usage metrics

### Example 4: "authentication"

- **Context**: REST API document
- **Correct Interpretation**: OAuth 2.0, API keys, JWT for API access
- **Context**: Webhook document
- **Correct Interpretation**: HMAC signature verification for webhook payload
- **Incorrect Cross-context Match**: API authentication vs webhook authentication are different mechanisms

---

## Configuration Recommendations

### Enable Knowledge Graph For:

- Large API catalogs (100+ endpoints across multiple product modules)
- Technical documentation sites (API docs + integration guides + product docs)
- Multi-product platforms (billing + customer + order + analytics + integrations)
- Developer portals (linking API endpoints to use cases to code examples)
- Support knowledge bases (linking errors to causes to solutions)

### Disable Knowledge Graph For:

- Simple SaaS products (single product, < 50 API endpoints)
- Marketing websites (no technical content)
- Single-purpose documentation (e.g., only API reference)

---

## Tenant-Specific Customization Notes

This default definition should be customized per tenant by:

1. **Adding proprietary product modules** (internal module names, custom features)
2. **Defining API versioning strategy** (v1, v2, deprecation timelines)
3. **Adding integration partners** (custom CRM/ERP/payment gateway integrations)
4. **Defining internal terminology** (company-specific acronyms, product names)
5. **Adding customer implementation examples** (use case-specific documentation)

**Customization Path**: `config/knowledge-graph/domain-definitions/{tenantId}/software-b2b-saas.md` (overrides this default)

---

**End of Default Software & B2B SaaS Domain Definition**

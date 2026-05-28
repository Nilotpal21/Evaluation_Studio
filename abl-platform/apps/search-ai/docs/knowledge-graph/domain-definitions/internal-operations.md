# Domain Definition: Internal Operations & Employee Knowledge

> **Version**: 1.0
> **Industry**: B2B SaaS, Technology Companies, Enterprise Software
> **Last Updated**: 2026-02-24
> **Applicable To**: Internal employee documentation, cross-departmental knowledge bases, operational processes

This is a default domain definition for internal operations across Sales, Product, Engineering, Support, and Implementation teams. It provides foundational vocabulary, process taxonomy, and disambiguation rules to prevent false relationships between department-specific uses of common terms.

---

## Product Hierarchy

### 1. Sales Operations (Department: Sales)

#### 1.1 Pipeline Management (Sub-department: Sales Operations)

- **Description**: Deal progression from prospecting to close
- **Key Attributes**:
  - `sales_stage`: Prospecting, Discovery, Demo, Proposal, Negotiation, Closed-Won, Closed-Lost
  - `deal_type`: New Business, Expansion, Cross-Sell, Renewal, Downgrade
  - `customer_segment`: SMB, Mid-Market, Enterprise, Strategic
  - `sales_methodology`: BANT, MEDDIC, CHAMP, SPIN, Challenger
  - `deal_value`: ACV (Annual Contract Value), TCV (Total Contract Value)
  - `forecast_category`: Commit, Best Case, Pipeline, Omitted
- **Identifier Patterns**:
  - `DEAL-####` (Deal/Opportunity ID)
  - `ACCT-####` (Account ID in CRM)
  - `OPP-YYYY-####` (Opportunity with year prefix)
- **Disambiguation Keywords**: pipeline, opportunity, deal, forecast, quota, win rate, sales stage, ACV, ARR
- **Metrics**: ARR (Annual Recurring Revenue), MRR (Monthly Recurring Revenue), ACV, Pipeline Coverage, Win Rate, Sales Cycle Length, Average Deal Size

#### 1.2 Account Management (Sub-department: Account Management)

- **Description**: Post-sale customer relationship and expansion management
- **Key Attributes**:
  - `account_tier`: Strategic, Enterprise, Mid-Market, SMB
  - `health_score`: Red (at-risk), Yellow (needs attention), Green (healthy)
  - `expansion_opportunity`: Upsell, Cross-sell, Additional seats
  - `renewal_date`: Contract renewal date
  - `churn_risk`: High, Medium, Low
  - `csm_assigned`: Customer Success Manager assigned
- **Identifier Patterns**: `CSM-####` (CSM identifier), `ACCT-####` (Account)
- **Disambiguation Keywords**: account management, customer success, expansion, upsell, renewal, churn risk, health score
- **Metrics**: Net Revenue Retention (NRR), Gross Revenue Retention (GRR), Customer Lifetime Value (CLTV), Logo Churn, Revenue Churn

---

### 2. Product Management (Department: Product)

#### 2.1 Product Lifecycle (Sub-department: Product Strategy)

- **Description**: Feature and product development stages from concept to sunset
- **Key Attributes**:
  - `lifecycle_stage`: Discovery, Design, Development, Testing, Launch, Maintenance, Sunset
  - `feature_type`: UI Feature, API Feature, Integration, Infrastructure, Performance Improvement, Technical Debt
  - `priority`: P0 (Critical), P1 (High), P2 (Medium), P3 (Low), P4 (Backlog)
  - `product_line`: Core Platform, Add-On Module, API Product, Mobile App
  - `target_segment`: All Customers, Enterprise Only, SMB Only, Specific Vertical
- **Identifier Patterns**:
  - `FEAT-####` (Feature ID)
  - `PROD-####` (Product Line ID)
  - `INIT-####` (Initiative ID)
- **Disambiguation Keywords**: feature, product roadmap, backlog, initiative, product lifecycle, PRD (Product Requirements Document)
- **Metrics**: Feature Adoption Rate, Time to Market, Feature Usage, Customer Satisfaction (CSAT), Product-Market Fit Score

#### 2.2 Engineering Delivery (Sub-department: Engineering)

- **Description**: Software development execution using Agile/Scrum methodologies
- **Key Attributes**:
  - `story_type`: User Story, Bug, Tech Debt, Spike, Epic
  - `story_points`: 1, 2, 3, 5, 8, 13, 21 (Fibonacci scale)
  - `sprint_number`: Sprint 1, Sprint 2, etc. (2-week iterations)
  - `release_type`: Major (breaking changes), Minor (new features), Patch (bug fixes), Hotfix (emergency)
  - `environment`: Development, Staging, Production
  - `deployment_status`: Pending, In Progress, Deployed, Rolled Back
- **Identifier Patterns**:
  - `STORY-####` (User Story ID)
  - `BUG-####` (Bug Ticket ID)
  - `EPIC-####` (Epic ID)
  - `SPRINT-##` (Sprint number)
- **Disambiguation Keywords**: user story, epic, sprint, velocity, story points, backlog grooming, sprint planning, retrospective, standup
- **Metrics**: Velocity (story points per sprint), Sprint Completion Rate, Cycle Time, Lead Time, Deployment Frequency, Change Failure Rate

---

### 3. Customer Support (Department: Support)

#### 3.1 Ticket Management (Sub-department: Support Operations)

- **Description**: Customer issue tracking and resolution
- **Key Attributes**:
  - `ticket_type`: Bug, Feature Request, How-To, Billing Issue, Technical Issue, Account Issue, Data Issue
  - `priority`: P0 (Production Down), P1 (Major Impact), P2 (Moderate Impact), P3 (Minor Impact), P4 (Informational)
  - `sla_tier`: Enterprise (2hr/8hr), Professional (4hr/24hr), Starter (8hr/48hr)
  - `status`: New, In Progress, Waiting on Customer, Escalated, Resolved, Closed
  - `resolution_category`: Resolved, Workaround Provided, Won't Fix, Duplicate, Cannot Reproduce
  - `escalation_level`: L1 (Tier 1 Support), L2 (Tier 2 Support), L3 (Senior Support Engineer), Engineering
- **Identifier Patterns**:
  - `TICKET-#####` (Support Ticket ID)
  - `CASE-#####` (Support Case ID)
  - `INC-#####` (Incident ID)
- **Disambiguation Keywords**: support ticket, customer issue, escalation, SLA, resolution, troubleshooting, tier 1, tier 2, tier 3
- **Metrics**: First Response Time (FRT), Time to Resolution (TTR), Customer Satisfaction (CSAT), SLA Compliance Rate, Ticket Volume, Escalation Rate

#### 3.2 Knowledge Base Management (Sub-department: Support Content)

- **Description**: Self-service documentation and troubleshooting guides
- **Key Attributes**:
  - `article_type`: How-To Guide, Troubleshooting, FAQ, API Documentation, Known Issue
  - `product_area`: Core Platform, API, Integration, Billing, Security, Admin
  - `difficulty_level`: Beginner, Intermediate, Advanced
  - `last_updated`: Date of last revision
  - `view_count`: Number of article views
  - `helpfulness_score`: Customer rating (thumbs up/down)
- **Identifier Patterns**: `KB-####` (Knowledge Base Article ID)
- **Disambiguation Keywords**: knowledge base, help article, documentation, troubleshooting guide, FAQ
- **Metrics**: Article Views, Deflection Rate (issues resolved without ticket), Helpfulness Score, Search Effectiveness

---

### 4. Implementation & Onboarding (Department: Professional Services)

#### 4.1 Implementation Projects (Sub-department: Implementation)

- **Description**: Customer onboarding and technical implementation from kickoff to go-live
- **Key Attributes**:
  - `implementation_stage`: Pre-Kickoff, Kickoff, Discovery, Configuration, Data Migration, Integration, Testing, Training, Go-Live, Post-Launch Support, Handoff to CSM
  - `project_type`: Standard Implementation, Custom Implementation, Migration (from competitor), Expansion (existing customer), Re-Implementation
  - `implementation_complexity`: Simple, Standard, Complex, Highly Custom
  - `milestone_status`: Not Started, In Progress, Complete, Blocked, At Risk
  - `resource_allocation`: Implementation Engineer, Solutions Architect, Project Manager, Customer Champion
- **Identifier Patterns**:
  - `IMPL-####` (Implementation Project ID)
  - `PROJ-####` (Project ID)
  - `MILESTONE-##` (Milestone number)
- **Disambiguation Keywords**: implementation, onboarding, kickoff, go-live, data migration, configuration, integration, project timeline
- **Metrics**: Time to Value (TTV), Implementation Duration, Customer Readiness Score, Milestone Completion Rate, On-Time Launch Rate, Post-Launch Adoption

#### 4.2 Technical Enablement (Sub-department: Training & Enablement)

- **Description**: Customer training and technical enablement programs
- **Key Attributes**:
  - `training_type`: Live Training, Self-Paced Course, Webinar, Workshop, Certification Program
  - `audience`: End User, Admin, Developer, Executive
  - `delivery_method`: Virtual, In-Person, Recorded, Hands-On Lab
  - `certification_level`: Foundational, Practitioner, Expert
- **Identifier Patterns**: `TRAIN-####` (Training Session ID), `CERT-####` (Certification ID)
- **Disambiguation Keywords**: training, enablement, certification, workshop, webinar, hands-on lab
- **Metrics**: Training Attendance Rate, Certification Completion Rate, Training Satisfaction Score, Time to Proficiency

---

## Attribute Specificity Rules

### Attribute: `status`

- **Applies to**: sales_opportunity, engineering_story, support_ticket, implementation_project
- **Does NOT mix across departments** (each has its own status field)
- **Contextual Meanings**:
  - **sales_opportunity**: Prospecting, Discovery, Demo, Proposal, Negotiation, Closed-Won, Closed-Lost
  - **engineering_story**: Backlog, To Do, In Progress, In Review, Done
  - **support_ticket**: New, In Progress, Waiting on Customer, Escalated, Resolved, Closed
  - **implementation_project**: Not Started, In Progress, Complete, Blocked, At Risk

**CRITICAL**: Never confuse a deal "status" with a ticket "status" — they represent completely different workflows.

### Attribute: `priority`

- **Applies to**: product_feature, engineering_story, support_ticket
- **Does NOT mix across departments**
- **Contextual Meanings**:
  - **product_feature** (Product Management): P0 (launch blocker), P1 (must have), P2 (should have), P3 (nice to have), P4 (backlog)
  - **engineering_story** (Engineering): Story point value (1, 2, 3, 5, 8) OR sprint priority ranking
  - **support_ticket** (Support): P0 (production down), P1 (major impact), P2 (moderate), P3 (minor), P4 (informational)

**CRITICAL**: "P1" in Product means "must have for launch"; "P1" in Support means "major customer impact." These are NOT the same.

### Attribute: `customer` / `account`

- **Applies to**: sales_opportunity, support_ticket, implementation_project, account_management
- **Contextual Meanings**:
  - **sales_opportunity**: Prospect or existing account with open deal (ACCT-#### in CRM)
  - **support_ticket**: Account filing support request (may reference user ID or account ID)
  - **implementation_project**: Customer undergoing onboarding (project-level identifier)
  - **account_management**: Strategic account with assigned CSM (account-level relationship)

**CRITICAL**: An "account" in Sales context (ACCT-####) may have multiple "tickets" in Support (TICKET-#####) and one "implementation project" (IMPL-####). These are related but distinct entities.

### Attribute: `feature`

- **Applies to**: product_feature, support_feature_request, sales_feature_selling_point
- **Contextual Meanings**:
  - **product_feature** (Product/Engineering): Backlog item, user story, or product capability under development (FEAT-####)
  - **support_feature_request** (Support): Customer-requested enhancement logged as ticket (TICKET-##### with type: Feature Request)
  - **sales_feature_selling_point** (Sales): Product capability highlighted in sales process (may reference FEAT-#### but from sales perspective)

**CRITICAL**: A "feature" in Product is a backlog item or roadmap item (FEAT-####). A "feature request" in Support (TICKET-#####) is a customer request that MAY become a backlog item. A "feature" in Sales is a selling point (capability), not a development task.

### Attribute: `project`

- **Applies to**: implementation_project, engineering_initiative
- **Contextual Meanings**:
  - **implementation_project** (Professional Services): Customer onboarding project (IMPL-####), has go-live date, milestones, and handoff to CSM
  - **engineering_initiative** (Engineering): Large body of work spanning multiple sprints (EPIC-####), technical initiative (e.g., "Migrate to Kubernetes")

**CRITICAL**: Implementation "project" is customer-facing (onboarding). Engineering "project" is internal (technical initiative).

---

## Department Boundaries

### Sales Department

- **Includes**: Pipeline management, account management, deal qualification, forecasting, CRM data
- **Excludes**: Product roadmap (Product), customer support tickets (Support), implementation projects (Professional Services)
- **Can relate to**:
  - **Product**: Sales may reference product features when selling (FEAT-#### mentioned in deal notes)
  - **Support**: Sales may check account health (ticket volume, escalations) during renewal
  - **Implementation**: Sales hands off to Implementation after deal closes (DEAL-#### → IMPL-####)
- **Reasoning**: Sales manages revenue pipeline and customer relationships at the deal/account level; Product builds features, Support resolves issues, Implementation delivers technical onboarding.

### Pipeline Management Sub-department

- **Excludes**: Renewals (handled by Account Management sub-department within Sales)
- **Can relate to**: Account Management (new business deal transitions to account management post-sale)
- **Reasoning**: Pipeline Management focuses on new business acquisition; Account Management focuses on post-sale expansion and retention.

### Product Management Department

- **Includes**: Product roadmap, feature prioritization, PRDs (Product Requirements Documents), product strategy
- **Excludes**: Engineering implementation (Engineering), customer feature requests (Support), sales feature discussions (Sales)
- **Can relate to**:
  - **Engineering**: Product defines features (FEAT-####) that Engineering implements (STORY-####)
  - **Support**: Product reviews feature requests from Support (TICKET-##### → FEAT-####)
  - **Sales**: Product provides roadmap visibility to Sales for deal progression
- **Reasoning**: Product defines WHAT to build; Engineering defines HOW and implements; Support collects customer feedback; Sales sells based on product capabilities.

### Engineering Department

- **Includes**: Story implementation, bug fixes, technical debt, code deployment, sprint execution
- **Excludes**: Product roadmap (Product), customer-facing support (Support), implementation consulting (Professional Services)
- **Can relate to**:
  - **Product**: Engineering implements features defined by Product (FEAT-#### → STORY-####)
  - **Support**: Engineering receives escalations for unresolved bugs (TICKET-##### → BUG-####)
- **Reasoning**: Engineering builds and maintains the product; Product defines requirements; Support interfaces with customers; Implementation delivers customer-specific configurations.

### Support Department

- **Includes**: Customer issue resolution, troubleshooting, knowledge base, SLA management, escalations
- **Excludes**: Product roadmap (Product), code fixes (Engineering), customer onboarding (Professional Services)
- **Can relate to**:
  - **Engineering**: Support escalates bugs to Engineering (TICKET-##### → BUG-####)
  - **Product**: Support logs feature requests for Product review (TICKET-##### type: Feature Request)
  - **Implementation**: Support may assist during go-live or post-launch (IMPL-#### + TICKET-#####)
- **Reasoning**: Support resolves customer issues reactively; Product plans proactively; Engineering fixes code; Implementation delivers structured onboarding.

### Professional Services Department (Implementation & Onboarding)

- **Includes**: Implementation projects, customer onboarding, data migration, technical training, go-live support
- **Excludes**: Ongoing support (Support), product development (Product/Engineering), sales qualification (Sales)
- **Can relate to**:
  - **Sales**: Implementation receives handoff from Sales after deal closes (DEAL-#### → IMPL-####)
  - **Support**: Implementation collaborates with Support during go-live or troubleshooting
  - **Product**: Implementation provides product feedback from customer implementations
- **Reasoning**: Implementation delivers time-bound onboarding projects; Support handles ongoing issue resolution; Sales manages revenue pipeline; Product builds the product.

---

## Common Entity Types

### Sales Entities

- **DEAL_ID**: Opportunity or deal identifier (DEAL-####, OPP-####)
- **ACCOUNT_ID**: CRM account identifier (ACCT-####)
- **CONTACT_ID**: Individual person at customer (CONTACT-####)
- **FORECAST_CATEGORY**: Commit, Best Case, Pipeline, Omitted
- **SALES_STAGE**: Prospecting → Closed-Won/Lost progression
- **QUOTA**: Sales rep's target for a period (monthly, quarterly, annual)

### Product & Engineering Entities

- **FEATURE_ID**: Product feature or capability (FEAT-####)
- **STORY_ID**: User story or engineering task (STORY-####)
- **BUG_ID**: Software defect (BUG-####)
- **EPIC_ID**: Large body of work (EPIC-####)
- **SPRINT_ID**: Time-boxed development iteration (SPRINT-##)
- **RELEASE_VERSION**: Software version (v1.2.3, v2.0.0)
- **TECHNICAL_DEBT**: Code refactoring or architecture improvement needs

### Support Entities

- **TICKET_ID**: Support ticket or case (TICKET-#####, CASE-#####)
- **SLA_TARGET**: Response and resolution time commitments
- **ESCALATION_LEVEL**: L1, L2, L3, Engineering
- **RESOLUTION_CATEGORY**: Resolved, Workaround, Won't Fix, Duplicate
- **KNOWLEDGE_BASE_ARTICLE_ID**: Help article (KB-####)

### Implementation Entities

- **IMPLEMENTATION_PROJECT_ID**: Onboarding project (IMPL-####, PROJ-####)
- **MILESTONE**: Project checkpoint (Kickoff, Configuration Complete, Go-Live, etc.)
- **IMPLEMENTATION_STAGE**: Pre-Kickoff → Handoff to CSM progression
- **DATA_MIGRATION**: Process of moving customer data from legacy system
- **INTEGRATION_POINT**: Connection between customer's systems and product

---

## Common Relationship Types

### Cross-Department Relationships

#### Sales → Professional Services

- `HANDS_OFF_TO`: Deal closed → Implementation project starts (DEAL-#### → IMPL-####)
- `REFERENCES_IN_SCOPING`: Sales references implementation complexity during deal scoping

#### Professional Services → Support

- `COLLABORATES_WITH`: Implementation team works with Support during go-live
- `ESCALATES_TO`: Implementation project issue escalated to Support (IMPL-#### → TICKET-#####)

#### Support → Engineering

- `ESCALATES_BUG_TO`: Support escalates unresolved bug to Engineering (TICKET-##### → BUG-####)
- `REQUESTS_FIX_FOR`: Support requests code fix for customer issue

#### Support → Product

- `LOGS_FEATURE_REQUEST_TO`: Support logs customer feature request for Product review (TICKET-##### → backlog consideration)
- `PROVIDES_FEEDBACK_TO`: Support provides product feedback from customer interactions

#### Product → Engineering

- `DEFINES_FOR_IMPLEMENTATION`: Product defines feature that Engineering implements (FEAT-#### → STORY-####)
- `PRIORITIZES_FOR_SPRINT`: Product prioritizes backlog items for Engineering sprints

#### Sales → Product

- `REFERENCES_ROADMAP_ITEM`: Sales references product roadmap during deal progression
- `REQUESTS_FEATURE_FOR_DEAL`: Sales escalates feature request to Product to close deal

#### Professional Services → Product

- `PROVIDES_IMPLEMENTATION_FEEDBACK`: Implementation shares product usability feedback from customer projects
- `REQUESTS_FEATURE_FOR_SCALABILITY`: Implementation requests product enhancement to improve onboarding efficiency

### Within-Department Relationships

#### Sales Internal

- `ACCOUNT_HAS_OPPORTUNITY`: Account has one or more deals (ACCT-#### → DEAL-####)
- `OPPORTUNITY_CONVERTS_TO_CUSTOMER`: Deal closes and becomes managed account

#### Engineering Internal

- `EPIC_CONTAINS_STORY`: Epic broken down into user stories (EPIC-#### → STORY-####)
- `STORY_ASSIGNED_TO_SPRINT`: Story scheduled for specific sprint (STORY-#### → SPRINT-##)
- `BUG_BLOCKS_STORY`: Bug prevents story completion

#### Support Internal

- `TICKET_RESOLVED_BY_KB_ARTICLE`: Ticket resolved using knowledge base article (TICKET-##### → KB-####)
- `TICKET_DUPLICATE_OF`: Ticket is duplicate of earlier ticket

#### Implementation Internal

- `PROJECT_COMPLETES_MILESTONE`: Implementation project reaches checkpoint (IMPL-#### → Milestone: Go-Live)
- `MILESTONE_BLOCKED_BY`: Milestone blocked by external dependency

---

## Use Case Examples

### Use Case 1: Sales "Feature" vs Product "Feature"

**User Query**: "What features are we building next quarter?"

**Expected Behavior**:

1. Detect query intent: Product roadmap inquiry
2. Scope to **Product Management Department** (not Sales)
3. Extract entities: Product features in roadmap (FEAT-#### with planned release dates)
4. Filter to product backlog items with priority P0-P2 and target release Q2 2026
5. Return: List of product features (FEAT-####) with descriptions and target quarters

**Avoid False Positives**:

- Do NOT return: Sales feature selling points (sales collateral mentioning features)
- Do NOT return: Support feature requests (customer requests logged as tickets)

---

### Use Case 2: Support "Priority P1" vs Product "Priority P1"

**User Query**: "Show me all P1 items"

**Expected Behavior (AMBIGUOUS QUERY - REQUIRES DISAMBIGUATION)**:

1. Detect ambiguity: "P1" exists in both Support (major impact ticket) and Product (must-have feature)
2. Ask user: "Are you looking for (1) P1 support tickets (major customer impact) or (2) P1 product features (must-have roadmap items)?"

**Option 1 (Support)**: Filter tickets with priority=P1, return TICKET-##### list
**Option 2 (Product)**: Filter features with priority=P1, return FEAT-#### list

**CRITICAL**: Never merge these two result sets — they represent completely different concepts.

---

### Use Case 3: "Customer" - Sales vs Support vs Implementation Context

**User Query**: "Show me all customers with open issues"

**Expected Behavior**:

1. Detect query intent: Support ticket inquiry (keyword: "open issues")
2. Scope to **Support Department**
3. Extract entities: Accounts with open support tickets (TICKET-##### with status ≠ Closed)
4. Return: Account list (ACCT-####) with open ticket counts and priority breakdown

**Do NOT Confuse With**:

- Sales "customers" (accounts with open deals in pipeline → DEAL-####)
- Implementation "customers" (accounts with active onboarding projects → IMPL-####)

---

### Use Case 4: "Project" - Implementation vs Engineering Context

**User Query**: "What projects are at risk?"

**Expected Behavior (AMBIGUOUS QUERY - REQUIRES DISAMBIGUATION)**:

1. Detect ambiguity: "Projects" could be implementation projects (customer onboarding) or engineering initiatives (internal technical work)
2. Ask user: "Are you asking about (1) implementation projects (customer onboarding) or (2) engineering projects (technical initiatives)?"

**Option 1 (Implementation)**: Filter implementation projects with milestone_status=At Risk (IMPL-####)
**Option 2 (Engineering)**: Filter engineering epics with status=Blocked or At Risk (EPIC-####)

---

### Use Case 5: "Account Health" - Multi-Department Aggregation

**User Query**: "Show me account health for ACCT-1234"

**Expected Behavior (CROSS-DEPARTMENT QUERY)**:

1. Detect query intent: Account health requires data from multiple departments
2. Aggregate data:
   - **Sales**: Open deals, renewal date, ARR, forecast category (ACCT-1234 → DEAL-####)
   - **Support**: Open ticket count, P0/P1 ticket count, average resolution time (ACCT-1234 → TICKET-#####)
   - **Product**: Feature usage, adoption score, login frequency (product telemetry)
   - **Implementation**: Implementation project status if onboarding in progress (ACCT-1234 → IMPL-####)
3. Return: Unified account health view with department-specific metrics

**Relationship Mapping**:

- `ACCT-1234` (Sales) → `DEAL-5678` (Sales) → related to same customer
- `ACCT-1234` (Sales) → `TICKET-9012` (Support) → related to same customer
- `ACCT-1234` (Sales) → `IMPL-3456` (Implementation) → related to same customer

---

## Disambiguation Examples

### Example 1: "status"

- **Context**: Sales opportunity document ("Pipeline review Q1 2026")
- **Correct Interpretation**: `sales_stage` (Prospecting, Discovery, Demo, Proposal, Negotiation, Closed-Won, Closed-Lost)
- **Context**: Engineering sprint board ("Sprint 15 progress")
- **Correct Interpretation**: `story_status` (Backlog, To Do, In Progress, In Review, Done)
- **Context**: Support ticket dashboard ("Open tickets by status")
- **Correct Interpretation**: `ticket_status` (New, In Progress, Waiting on Customer, Escalated, Resolved, Closed)
- **Incorrect Cross-Context Match**: Do NOT relate sales "Closed-Won" to support "Closed" — completely different workflows

### Example 2: "priority"

- **Context**: Product roadmap document ("Q2 2026 feature priorities")
- **Correct Interpretation**: `product_priority` (P0=launch blocker, P1=must have, P2=should have, P3=nice to have)
- **Context**: Support escalation report ("P0/P1 tickets this week")
- **Correct Interpretation**: `ticket_priority` (P0=production down, P1=major impact, P2=moderate, P3=minor)
- **Incorrect Cross-Context Match**: Product "P1 feature" ≠ Support "P1 ticket"

### Example 3: "customer"

- **Context**: Sales forecast document ("Q1 customer pipeline")
- **Correct Interpretation**: Accounts with open deals (ACCT-#### with DEAL-####)
- **Context**: Support dashboard ("Customers with open tickets")
- **Correct Interpretation**: Accounts with active support cases (ACCT-#### with TICKET-#####)
- **Context**: Implementation project plan ("Customer onboarding timeline")
- **Correct Interpretation**: Account undergoing onboarding (ACCT-#### with IMPL-####)
- **Correct Cross-Context Relationship**: Same ACCT-#### may appear in all three contexts — this is valid multi-department view

### Example 4: "feature"

- **Context**: Product roadmap document ("Q2 feature releases")
- **Correct Interpretation**: `product_feature` (FEAT-#### in backlog or roadmap)
- **Context**: Support ticket (type: Feature Request)
- **Correct Interpretation**: `feature_request` (TICKET-##### type=Feature Request)
- **Context**: Sales collateral ("Key features and benefits")
- **Correct Interpretation**: `feature_selling_point` (product capability mentioned in sales process)
- **Correct Cross-Context Relationship**: Support feature request (TICKET-#####) MAY become product backlog item (FEAT-####) after Product review

### Example 5: "project"

- **Context**: Implementation project plan ("ACCT-1234 onboarding")
- **Correct Interpretation**: `implementation_project` (IMPL-#### with go-live date and milestones)
- **Context**: Engineering epic ("Kubernetes migration project")
- **Correct Interpretation**: `engineering_initiative` (EPIC-#### spanning multiple sprints)
- **Incorrect Cross-Context Match**: Do NOT confuse customer onboarding "project" with engineering technical "project"

---

## Configuration Recommendations

### Enable Knowledge Graph For:

- Large B2B SaaS companies with multiple departments (Sales, Product, Engineering, Support, Implementation)
- Companies with ambiguous terminology across departments ("feature," "priority," "status," "customer," "project")
- Cross-functional knowledge bases (documentation spanning multiple teams)
- Employee onboarding systems (need to disambiguate department-specific terms)
- Internal search systems (employees search for documentation across departments)
- Operational analytics (require cross-department entity resolution)

### Disable Knowledge Graph For:

- Single-department systems (only Sales, only Support, etc.)
- External customer-facing knowledge bases (no internal department terminology)
- Simple FAQ systems (no cross-department ambiguity)

---

## Tenant-Specific Customization Notes

This default definition should be customized per tenant by:

1. **Adding company-specific departments** (Finance, Legal, HR, Marketing, etc.)
2. **Defining internal identifiers** (ticket ID format, deal ID format, project codes)
3. **Adding custom workflows** (company-specific sales stages, implementation milestones, support escalation paths)
4. **Defining company-specific terminology** (internal acronyms, product names, team names)
5. **Adding integration-specific entities** (Salesforce opportunity stages, Jira issue types, Zendesk ticket fields)

**Customization Path**: `config/knowledge-graph/domain-definitions/{tenantId}/internal-operations.md` (overrides this default)

---

**End of Default Internal Operations Domain Definition**

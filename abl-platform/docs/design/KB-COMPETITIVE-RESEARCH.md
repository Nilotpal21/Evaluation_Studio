# Knowledge Base / RAG / Search AI -- Competitive Research

## Research Date: 2026-05-06

## Executive Summary

This document captures competitive analysis of information architecture for
knowledge management features across 9+ platforms, plus UX best practices
for complex configuration interfaces. Research was conducted via live web
searches and documentation analysis.

---

## Platform-by-Platform Analysis

---

### 1. Pinecone

**Source**: [Pinecone Docs](https://docs.pinecone.io/guides/indexes/understanding-indexes),
[Pinecone Dashboard Overview](https://www.vskills.in/certification/tutorial/creating-a-pinecone-account-and-dashboard-overview/)

**Product model**: Two products -- Pinecone Database (vector DB) and Pinecone
Assistant (RAG-as-a-service). The console sidebar has a top dropdown to switch
between them.

#### Top-level navigation (sidebar)

| Section         | Purpose                               |
| --------------- | ------------------------------------- |
| Indexes         | List/manage serverless indexes        |
| Collections     | Snapshot/backup of indexes            |
| API Keys        | Manage API credentials                |
| Usage & Billing | Monitor consumption                   |
| Explorer        | Visualize data, perform basic queries |
| Query Builder   | Build complex queries with a UI       |
| Assistant       | Separate product: file-based RAG      |

#### Data hierarchy

```
Organization
  -> Project (billing/API key scope)
       -> Index (one per use case)
            -> Namespace (tenant partition; up to 25K per index)
                 -> Records (ID + vector + metadata)
```

#### Configuration model

- Index creation: choose dense/sparse/full-text, embedding model, metric,
  cloud/region, pod type
- Namespace: optional metadata schema for filter field declaration
- No "pipeline configuration" concept -- Pinecone is a pure vector store
- Assistant: upload files (PDF, DOCX, JSON, MD, TXT), system handles chunking
  and embedding automatically. No user-facing chunking configuration.

#### Search/testing

- Explorer: visual tool for browsing vectors, running similarity queries
- Query Builder: construct complex queries with filters
- Assistant Playground: chat interface for testing RAG over uploaded files

#### Settings vs. configuration

- **Settings**: API keys, billing, team management (top-right/separate)
- **Configuration**: per-index (dimensions, metric, pod type) and
  per-namespace (metadata schema, filter fields)

#### Information hierarchy depth

- 3 levels: Project -> Index -> Namespace
- Console is flat: 5-7 top-level sidebar items, no nesting

#### Key patterns

- **Extremely simple sidebar** -- fewer than 8 items total
- **Product switcher** at top of sidebar (Database vs. Assistant)
- **Zero-config RAG** in Assistant -- upload files and query immediately
- Metadata schema as "progressive config" -- optional, improves performance

---

### 2. Vectara

**Source**: [Console Overview](https://docs.vectara.com/docs/console-ui/vectara-console-overview),
[Manage Documents](https://docs.vectara.com/docs/console-ui/manage-documents),
[Admin Center](https://docs.vectara.com/docs/console-ui/admin-center)

**Product model**: RAG-as-a-service platform. Central concept is "Corpus"
(a searchable collection of documents).

#### Top-level navigation (sidebar)

| Section             | Purpose                                 |
| ------------------- | --------------------------------------- |
| Corpora             | Create and manage corpora (collections) |
| Data                | Upload/manage documents                 |
| API Access          | API keys and OAuth app clients          |
| Team                | User management and permissions         |
| API Request Builder | Build and test API requests in-console  |
| Billing & Usage     | Monitor usage                           |
| Account Settings    | Customer ID, email, preferences         |

#### Per-corpus tabs (inside a corpus)

| Tab            | Purpose                                     |
| -------------- | ------------------------------------------- |
| Data           | Document list + drag-and-drop file uploader |
| Query          | Ask questions, test search against corpus   |
| Analytics      | Usage statistics for the corpus             |
| Access Control | Users and roles with access to this corpus  |
| Configuration  | Embedding model, filter attributes          |

#### Per-document tabs (inside a document)

| Tab      | Purpose                                           |
| -------- | ------------------------------------------------- |
| Overview | Fields + JSON representation                      |
| Parts    | Text segments with context and metadata           |
| Tables   | Ingested tables with ID, title, rows, description |

#### Admin Center (on-prem/VPC deployments)

| Section            | Purpose                                         |
| ------------------ | ----------------------------------------------- |
| Admin Dashboard    | System health, metrics (tenants, queries, docs) |
| Tenant Management  | Account monitoring, quota adjustment            |
| User Management    | Access control, permissions                     |
| Corpora Management | View/edit/delete corpora                        |
| Model Management   | LLM configuration and availability              |
| Text Encoder Mgmt  | Text encoding platform administration           |

#### Configuration model

- Corpus-level: embedding model selection, filter attributes
- Document processing: handled automatically (no user-facing chunking config)
- Post-ingestion: document Parts tab shows how content was chunked

#### Information hierarchy depth

- 3 levels: Account -> Corpus -> Document (-> Parts/Tables)
- Admin Center adds: Platform -> Tenant -> Resource

#### Key patterns

- **Corpus as the organizing unit** -- not "index" or "knowledge base"
- **5 tabs per corpus** provide complete lifecycle management in one view
- **Query tab inside each corpus** -- test search right where data lives
- **API Request Builder** as first-class sidebar item (developer-centric)
- **Document Parts view** for transparency into chunking results
- **Five-minute walkthrough** as onboarding feature

---

### 3. Cohere (Compass + North)

**Source**: [Compass](https://cohere.com/compass),
[Compass Analysis](https://www.analyticsvidhya.com/blog/2024/04/cohere-compass/),
[Dashboard UI Changelog](https://docs.cohere.com/changelog/pricing-update-and-new-dashboard-ui)

**Product model**: Compass is the managed search platform; North is the
enterprise AI workspace. Compass focuses on zero-config intelligent search.

#### Dashboard sections (developer platform)

| Section       | Purpose                                       |
| ------------- | --------------------------------------------- |
| Playground    | Test models (Embed, Rerank, Generate)         |
| API Keys      | Trial keys (rate-limited) and Production keys |
| Custom Models | Fine-tuned generative, embed, classify models |
| Team          | Invite and manage team members                |
| Usage/Billing | Pricing and consumption metrics               |

#### Compass platform (managed search)

- **Not a traditional dashboard** -- Compass abstracts away infrastructure
- Configuration through SDK/API rather than console UI
- Native connectors: Gmail, Outlook, Slack, Salesforce, SharePoint, GDrive
- Document processing: intelligent parsing handles chunking automatically
  (headers, tables, multi-page concepts)
- Built-in Rerank model in retrieval pipeline
- Role-based access controls at document level

#### Configuration model

- **Minimal UI configuration** -- most config is API/SDK-driven
- Compass manages index, embeddings, chunking, reranking automatically
- No user-facing pipeline configuration in the traditional sense
- VPC/on-prem deployment with role-based access

#### Key patterns

- **Zero-config philosophy** -- "Compass manages your index so you don't
  have to. No need to host or scale your own vector database."
- **Intelligent chunking** -- applies domain knowledge for chunk boundaries
  rather than requiring manual configuration
- **Separation of developer tools (API playground) from enterprise search
  (Compass)**
- **Model-first organization** -- dashboard organized around models (Embed,
  Generate, Rerank) rather than data/documents

---

### 4. Algolia

**Source**: [New Navigation Blog](https://www.algolia.com/blog/product/introducing-our-new-navigation),
[Dashboard Tutorial](https://www.algolia.com/doc/guides/getting-started/quick-start/tutorials/getting-started-with-the-dashboard),
[Dashboard Interface Guide](https://app.studyraid.com/en/read/15522/539781/navigating-the-algolia-dashboard-interface)

**Product model**: Search-as-a-service with multiple products (Search,
Recommend). Mature platform with the most detailed configuration UI.

#### Top-level navigation (redesigned 2024)

The sidebar was redesigned to separate concerns. Previously it handled
applications, features, billing, and settings simultaneously -- described
as "bursting at the seams."

**New navigation model:**

| Level     | Location     | Purpose                             |
| --------- | ------------ | ----------------------------------- |
| Products  | Top center   | Switch between Search and Recommend |
| Features  | Left sidebar | Product-specific features           |
| Settings  | Top right    | Account, billing, team              |
| Help/Docs | Top right    | Support and documentation           |

#### Sidebar sections (within Search product)

Grouped by user workflow (not technical taxonomy):

| Group         | Items                                           |
| ------------- | ----------------------------------------------- |
| **Configure** | Indices, Query Suggestions, Data Sources        |
| **Observe**   | Search Analytics, A/B Testing                   |
| **Enhance**   | Rules, AI Synonyms, Re-Ranking, Personalization |

#### Per-index tabs

| Tab             | Purpose                                      |
| --------------- | -------------------------------------------- |
| Browse/Records  | View/add/delete documents (JSON format)      |
| Configuration   | Searchable attributes, ranking, relevance    |
| Replicas        | Create replica indices for sorting/filtering |
| Search API Logs | Request/response debugging                   |
| Stats           | Performance metrics for this index           |

#### Configuration tab sub-sections (inside an index)

| Sub-section             | Options                                   |
| ----------------------- | ----------------------------------------- |
| Relevance Essentials    | Searchable attributes, ranking, sorting   |
| Relevance Optimizations | Typo tolerance, language, synonyms, stop  |
|                         | words, segmentation, special chars, exact |
|                         | matching, word proximity                  |
| Filtering & Faceting    | Facet configuration                       |
| Pagination & Display    | Pagination, highlighting, snippeting      |

#### Search/testing

- **Preview** tab: live search simulation with configured settings
- **Search API Logs**: request-level debugging
- **A/B Testing**: compare search configurations

#### Information hierarchy depth

- 4 levels: Application -> Product -> Index -> Configuration section
- Within Configuration: sub-sections with drag-and-drop reordering

#### Key patterns

- **Workflow-based grouping** (Configure/Observe/Enhance) rather than
  technical taxonomy
- **Product switcher** at top, contextual sidebar below
- **Drag-and-drop attribute ordering** for relevance configuration
- **Preview/simulation** built into the index view
- **Most mature configuration UI** -- deepest progressive disclosure with
  "Relevance Essentials" vs. "Relevance Optimizations" split
- **Index selector dropdown** in header for quick switching
- **Rules engine** as separate "Enhance" category -- promoting
  merchandising/business rules as peer to search configuration

---

### 5. Elastic / OpenSearch Dashboards

**Source**: [Kibana 9.2 Navigation](https://www.elastic.co/search-labs/blog/elastic-kibana-9.2-navigation-refresh),
[Elastic Navigation Redesign](https://www.elastic.co/blog/elastic-redesigned-navigation-menu-kibana),
[OpenSearch Index Management](https://docs.opensearch.org/latest/dashboards/im-dashboards/index/)

**Product model**: Full observability/search/security platform. Knowledge
management is one use case among many. Kibana/Dashboards is the console.

#### Elastic/Kibana navigation (post-9.2 redesign)

Three **Solution Views** -- users configure their space to show one:

| Solution View | Focus                                     |
| ------------- | ----------------------------------------- |
| Search        | Search applications, index management     |
| Observability | Logs, metrics, APM, infrastructure        |
| Security      | SIEM, threat detection, endpoint security |

Within each solution view, the sidebar provides:

| Section          | Items (Search view example)            |
| ---------------- | -------------------------------------- |
| Explore          | Discover, data exploration             |
| Data Management  | Fleet, Index Management, Integrations, |
|                  | Ingest Pipelines                       |
| Stack Management | Admin tasks, advanced settings         |

#### OpenSearch Index Management sidebar

| Section               | Purpose                            |
| --------------------- | ---------------------------------- |
| Indexes               | CRUD operations, mapping, settings |
| Data Streams          | Manage data stream configurations  |
| Force Merge           | Merge index segments               |
| Rollover              | Index rollover capabilities        |
| Component Templates   | Reusable template components       |
| Notification Settings | Alert configuration                |

Additional plugin features: Index State Management (ISM), transforms,
rollups, error prevention.

#### Configuration model

- **Index-level**: mappings (visual editor with nested properties), settings,
  aliases
- **Pipeline-level**: Ingest pipelines with processors
- **Template-level**: Index templates, component templates
- **ISM Policies**: Automated lifecycle management

#### Advanced Settings page sections

General, Appearance, Discover, Notifications, Search, Timeline, Visualization

#### Key patterns

- **Solution Views** -- role-based navigation filtering (70% of users were
  frustrated before this was added)
- **Icon-driven collapsed sidebar** with hover menus
- **Always-visible secondary navigation** for switching between pages
- **Responsive design** with overflow "More" menu
- **Visual mapping editor** -- nested property editing with JSON toggle
- **"One tree, two renderers"** migration approach (legacy + new coexist)
- **Heaviest configuration surface** of all platforms -- reflects the
  complexity of the underlying system

---

### 6. AWS Bedrock Knowledge Bases

**Source**: [KB Info](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-info.html),
[KB Creation Guide](https://dev.to/dipayan_das/create-a-knowledge-base-in-amazon-bedrock-step-by-step-console-guide-3825),
[Getting Started](https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started-console.html)

**Product model**: Managed RAG service within the broader Bedrock AI platform.
Knowledge Bases is one of several features in the Bedrock console.

#### Bedrock console left navigation

| Section               | Sub-items                    |
| --------------------- | ---------------------------- |
| **Playgrounds**       | Text, Image, Chat            |
| **Foundation Models** | Model catalog, Model access  |
| **Tune**              | Custom models (fine-tuning)  |
| **Knowledge Bases**   | List, create, manage KBs     |
| **Agents**            | Agent configuration          |
| **Guardrails**        | Content filtering and safety |
| **Bedrock configs**   | Model access, settings       |

#### Knowledge Base detail page sections

| Section                 | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| Knowledge Base Overview | Name, description, status, embedding model |
| Tags                    | Resource tagging                           |
| Data Source             | Connected sources + Sync button + history  |
| Vector Store            | Provisioned throughput, embedding config   |
| Test (right panel)      | "Chat with your document" interface        |

#### KB creation wizard (10 steps)

1. Navigate to Knowledge Bases
2. Click "Create knowledge base"
3. Select setup type (vector store-based)
4. Define details (name, description, tags)
5. Configure data source (S3 bucket, connectors)
6. Select embedding model (Titan Embeddings default)
7. Configure vector store (OpenSearch Serverless, Aurora pgvector, Neptune)
8. Review configuration
9. Sync documents
10. Test knowledge base

#### Chunking strategies

| Strategy     | Description                 |
| ------------ | --------------------------- |
| Default      | ~500 tokens with overlap    |
| Fixed-size   | User-defined chunk size     |
| Semantic     | Based on meaning boundaries |
| Hierarchical | Parent-child relationships  |

#### Parsing strategies

| Parser           | Best for                      |
| ---------------- | ----------------------------- |
| Default          | Text-heavy documents          |
| Data Automation  | Multimodal content            |
| Foundation Model | Complex/visual-rich documents |

#### Data source connectors

S3, Web domains, Confluence, Salesforce, SharePoint

#### Information hierarchy depth

- 4 levels: Bedrock -> Knowledge Bases -> KB Detail -> Data Source Detail
  (with Sync History)

#### Key patterns

- **Wizard-based creation** -- 10-step sequential flow
- **"Chat with your document"** test panel alongside configuration
- **Sync-based model** -- explicit sync trigger, sync history with warnings
- **Chunking/parsing as progressive disclosure** -- expandable "Additional
  configurations" section during creation
- **Flat KB list** -- all KBs at same level, no folders/grouping
- **AWS-typical pattern**: left nav for feature areas, detail page with
  sections, edit-in-place

---

### 7. Google Vertex AI Search (now Agent Search)

**Source**: [Custom Search Getting Started](https://docs.cloud.google.com/generative-ai-app-builder/docs/try-enterprise-search),
[Create Data Store](https://docs.cloud.google.com/generative-ai-app-builder/docs/create-data-store-es)

**Product model**: Search and conversation platform with "Apps" and "Data
Stores" as the two primary objects. Being renamed to "Agent Search."

#### Console left navigation

| Section     | Purpose                              |
| ----------- | ------------------------------------ |
| Apps        | Search and conversation applications |
| Data Stores | Data repositories connected to apps  |

#### Per-app navigation (inside an app)

| Section        | Purpose                                       |
| -------------- | --------------------------------------------- |
| Configurations | Search behavior, result display, autocomplete |
| Preview        | Test the search app interactively             |
| Settings       | Authentication                                |
| Integration    | Widget code, API integration                  |

#### Configuration tabs (inside Configurations)

| Tab               | Purpose                            |
| ----------------- | ---------------------------------- |
| UI                | Widget display and result settings |
| Autocomplete      | Search suggestion configuration    |
| Response Settings | Advanced feature toggles           |

#### Data store types

- Website content (URL patterns)
- Structured data (NDJSON/BigQuery)
- Unstructured documents (GCS)

#### Documentation navigation hierarchy (lifecycle-oriented)

| Phase       | Purpose                                         |
| ----------- | ----------------------------------------------- |
| Discover    | Overview, responsible AI, data governance       |
| Get Started | Prerequisites, IAM, tutorials                   |
| Checklists  | Per-vertical checklists                         |
| Create      | Data store/app creation, schema management      |
| Configure   | Fields, autocomplete, serving controls, widget  |
| Deploy      | Retrieval, filtering, ranking, answers, widgets |
| Monitor     | Analytics, API monitoring, audit logging        |
| Maintain    | Data refresh, schema, quality, purging          |

#### Information hierarchy depth

- 3 levels: Project -> App -> Data Store
- Config within App: 3-4 tabs

#### Key patterns

- **Two-object model**: Apps (presentation) and Data Stores (content) are
  managed separately and linked
- **Lifecycle-oriented documentation** (Discover -> Create -> Configure ->
  Deploy -> Monitor -> Maintain)
- **Preview built-in** -- test search from within the app
- **Widget-first integration** -- code snippet generation for embedding
- **Advanced website indexing** as a one-way toggle (cannot be turned off
  once enabled) -- an anti-pattern worth noting
- **Vertical-specific checklists** for different use cases (custom search,
  website, recommendations, media, healthcare)

---

### 8. LangChain / LangSmith

**Source**: [LangSmith Dashboards](https://docs.langchain.com/langsmith/dashboards),
[LangSmith Guide](https://www.analyticsvidhya.com/blog/2024/07/ultimate-langsmith-guide/),
[LangSmith Observability](https://www.langchain.com/langsmith/observability)

**Product model**: LLM observability and evaluation platform. Not a knowledge
base product per se -- it's the monitoring/testing layer. Relevant for how
they organize retrieval monitoring.

#### Console left sidebar

| Section    | Purpose                             |
| ---------- | ----------------------------------- |
| Projects   | Tracing project management          |
| Datasets   | Test data and evaluation datasets   |
| Monitoring | Aggregate statistics over time      |
| Dashboards | Prebuilt + custom chart collections |

#### Per-project views

| View             | Purpose                                    |
| ---------------- | ------------------------------------------ |
| Traces tab       | Hierarchical execution tree per run        |
| Metadata tab     | Run metadata inspection                    |
| Monitor tab      | Charts for latency, cost, tokens, feedback |
| Dashboard button | Prebuilt dashboard (top-right)             |

#### Dashboard types

| Type     | Characteristics                            |
| -------- | ------------------------------------------ |
| Prebuilt | Auto-generated per project, not modifiable |
| Custom   | Fully configurable chart collections       |

#### Retrieval-specific features

- RAG evaluation: separates retrieval quality from generation quality
- Context precision (did you retrieve relevant documents?)
- Faithfulness (does the answer match the retrieved context?)
- Cost tracking: per-run cost for LLMs, tools, retrieval steps

#### Key patterns

- **Project-centric organization** -- everything starts from a project
- **Prebuilt + custom dashboards** -- sensible defaults with full
  customization available
- **AI Query** -- type natural language to filter runs (LLM-powered search
  within the observability tool)
- **Trace-first debugging** -- hierarchical tree of every execution step
- **Separated evaluation dimensions** -- retrieval quality and generation
  quality measured independently
- **Cost as first-class metric** alongside latency and accuracy

---

### 9. Enterprise Knowledge Management: Notion AI, Guru, Glean

#### Notion AI

**Source**: [AI-powered Knowledge Hubs Guide](https://www.notion.com/help/guides/ultimate-guide-to-ai-powered-knowledge-hubs-in-notion),
[Knowledge Management Guide](https://www.notion.com/help/guides/organize-connect-and-scale-your-notion-knowledge-management-system)

**Navigation model**: Workspace sidebar with user-created hierarchy

- Sidebar: workspace-level navigation with teamspaces, pages, databases
- No dedicated "Knowledge Base" section -- users build their own structure
- AI Q&A: bottom-right icon, searches across workspace content
- AI Autofill: summarize/extract from wiki entries using prompts

**Key patterns**:

- **User-defined hierarchy** -- no prescribed structure
- **AI overlay** on existing content (Q&A, autofill, suggestions)
- **Database views** as organizing mechanism (Table, Board, Calendar, etc.)
- **Permission-based access** at teamspace and page level
- **AI toggle** per team -- can enable/disable for specific groups

#### Guru

**Source**: [Guru Features](https://www.getguru.com/features),
[Guru Reviews](https://www.selecthub.com/p/knowledge-management-software/getguru/)

**Navigation model**: Knowledge cards organized into collections and boards

- **Cards**: atomic unit of knowledge (a single topic/answer)
- **Collections**: groups of related cards
- **Boards**: visual organization within collections
- Proactive AI suggestions in Slack/Teams
- Verification workflow: cards have owners and expiration dates

**Key patterns**:

- **Card-based knowledge** -- small, digestible units
- **Verification lifecycle** -- cards must be periodically reviewed/verified
- **In-context delivery** -- knowledge pushed to where work happens
  (Slack, Teams, Salesforce, browser extension)
- **HRIS sync** -- automatic permission management from HR systems

#### Glean

**Source**: [Admin Console Overview](https://docs.glean.com/administration/about),
[Data Sources Setup](https://docs.glean.com/get-started/setup/connect-data-sources),
[Connector Management](https://docs.glean.com/connectors/monitoring)

**Navigation model**: Comprehensive admin console with 15+ top-level sections

##### Admin console sidebar

| Section                   | Sub-items                                          |
| ------------------------- | -------------------------------------------------- |
| **General**               | About, Tenant ID                                   |
| **Identity**              | SSO, OAuth, People Data, Roles                     |
| **Search**                | Configuration, result visibility, troubleshooting  |
| **Assistant**             | Configuration, features, warehouse data, analysis  |
| **Actions**               | Overview, setup, management, MCP servers           |
| **Embedded Integrations** | Supported app integrations                         |
| **Glean MCP Servers**     | Setup, host connections, best practices            |
| **Protect**               | Security policies, sensitive findings, AI security |
| **Knowledge**             | Announcements, People & Teams                      |
| **Management**            | Alerts, notifications, features, customization,    |
|                           | LLM config, model mgmt, audit logs, maintenance    |
| **Insights**              | Overview, LLM insights, active users, departments  |
| **Event Logs**            | Data dictionary, queries, log updates              |
| **Developer**             | API tokens, Keycloak credentials                   |
| **Managing Agents**       | Agent library, access, sharing, routing, deletion  |

##### Data source setup flow

1. Navigate to Admin Console -> Platform -> Data Sources
2. Click "Add app" to add new data sources
3. Provide credentials and configuration for crawling
4. Save progress (can resume later)
5. Start crawl -> Crawling (step 1/2) -> Indexing (step 2/2)
6. Moves from "Initial sync in progress" to "All data sources"

**Key patterns**:

- **Heaviest admin console** of all platforms -- 15+ top-level categories
- **Two-phase sync visibility** (crawling then indexing)
- **Actions configuration during data source setup** -- configure what
  agents can do while setting up the connector
- **MCP server management** as first-class section
- **Insights Chat / Admin Chat** -- natural language admin queries
- **Progressive deployment**: Prepare -> Build -> Setup -> Learn ->
  Go Live -> Post-Launch stages

---

## Cross-Platform Pattern Analysis

### Pattern 1: Navigation Organization Models

| Model                  | Used by                      | Characteristics                 |
| ---------------------- | ---------------------------- | ------------------------------- |
| Minimal sidebar (<8)   | Pinecone, Cohere             | Simple, developer-focused       |
| Workflow-grouped       | Algolia                      | Configure/Observe/Enhance       |
| Solution/role views    | Elastic/Kibana               | Search/Observability/Security   |
| Lifecycle stages       | Google Vertex, Glean (setup) | Create/Configure/Deploy/Monitor |
| Feature-area flat list | AWS Bedrock, Vectara         | Each feature gets a section     |
| Comprehensive mega-nav | Glean (admin)                | 15+ sections                    |

**Recommendation**: Workflow-grouped (Algolia-style) is the sweet spot for
knowledge management products. It maps to user intent rather than system
architecture.

### Pattern 2: The "Test Right Here" Pattern

Every successful platform puts testing adjacent to configuration:

| Platform      | How testing is surfaced                         |
| ------------- | ----------------------------------------------- |
| Pinecone      | Explorer + Query Builder + Assistant Playground |
| Vectara       | Query tab inside each corpus                    |
| Algolia       | Preview tab inside each index                   |
| AWS Bedrock   | "Chat with your document" panel                 |
| Google Vertex | Preview section in app navigation               |
| LangSmith     | Trace viewer + AI Query filter                  |
| Glean         | Admin Chat / Insights Chat                      |

**Key insight**: Testing/preview should be accessible from the same context
as configuration -- not a separate page. "Configure, then test" should be
zero-navigation.

### Pattern 3: Data Hierarchy Models

| Platform    | Hierarchy                                 |
| ----------- | ----------------------------------------- |
| Pinecone    | Project -> Index -> Namespace -> Records  |
| Vectara     | Account -> Corpus -> Document -> Parts    |
| Algolia     | Application -> Index -> Records           |
| AWS Bedrock | Service -> KB -> Data Source -> Documents |
| Google      | Project -> App + Data Store (linked)      |
| Elastic     | Cluster -> Index -> Documents             |
| Glean       | Workspace -> Data Sources -> Documents    |

**Key insight**: Most platforms use 3 levels. The "container" (Index/Corpus/KB)
is the primary management unit. Google's approach of separating Apps (search
config) from Data Stores (content) is unique and worth considering.

### Pattern 4: Configuration Depth Strategies

| Strategy                | Platform    | How it works                               |
| ----------------------- | ----------- | ------------------------------------------ |
| Zero-config             | Cohere      | Platform handles everything                |
| Sensible defaults       | Pinecone    | Works OOB, optional schema config          |
| Progressive disclosure  | AWS Bedrock | "Additional configurations" expander       |
| Essentials vs. advanced | Algolia     | "Relevance Essentials" vs. "Optimizations" |
| Full control            | Elastic     | Every parameter exposed                    |

**Key insight**: The best approach depends on audience. For enterprise
knowledge management, "sensible defaults with progressive disclosure" (like
AWS Bedrock) combined with "essentials vs. advanced" separation (like Algolia)
provides the best balance.

### Pattern 5: Settings vs. Configuration Separation

All platforms separate these concerns, but the boundary varies:

| Concern             | Where it lives             | Examples                       |
| ------------------- | -------------------------- | ------------------------------ |
| Account/billing     | Top-right menu or separate | Everywhere                     |
| API keys/auth       | Account settings           | Pinecone, Vectara, Cohere      |
| Per-resource config | Resource detail page       | Index settings, KB settings    |
| Search behavior     | Configuration tabs/pages   | Algolia, Google Vertex         |
| Processing pipeline | Creation wizard or config  | AWS Bedrock (chunking/parsing) |
| Team/permissions    | Separate section           | Everywhere                     |

**Key insight**: "Settings" = things you set once and forget (billing, API
keys, team). "Configuration" = things you iterate on (relevance tuning,
chunking strategy, search behavior). These should live in different places.

### Pattern 6: Sync/Ingestion Status Visibility

| Platform      | How sync status is shown                  |
| ------------- | ----------------------------------------- |
| AWS Bedrock   | Sync button + sync history with warnings  |
| Glean         | Two-phase progress (Crawling -> Indexing) |
| Vectara       | Document status in Data tab               |
| Pinecone      | Index status (Ready/Initializing)         |
| Google Vertex | Data store status indicators              |

**Key insight**: Sync/ingestion is a major anxiety point for users. Visibility
into progress, status, and failure reasons is critical. Glean's two-phase
model (Crawling then Indexing) is the most transparent.

### Pattern 7: Per-Resource Tab Layout

Most platforms use tabs within the resource detail view:

| Platform | Resource | Tabs                                           |
| -------- | -------- | ---------------------------------------------- |
| Vectara  | Corpus   | Data, Query, Analytics, Access, Config         |
| Algolia  | Index    | Browse, Config, Replicas, Logs, Stats          |
| Elastic  | Index    | Mappings, Settings, Stats                      |
| Google   | App      | Configurations, Preview, Settings, Integration |

**Key insight**: 4-6 tabs is the sweet spot. Vectara's layout (Data + Query +
Analytics + Access + Config) covers the full lifecycle of a knowledge
container.

---

## UX Best Practices Research

### Progressive Disclosure

**Source**: [NNG](https://www.nngroup.com/articles/progressive-disclosure/),
[Userpilot](https://userpilot.com/blog/progressive-disclosure-examples/),
[Lollypop Design](https://lollypop.design/blog/2025/may/progressive-disclosure/)

**Core principle**: Reduce cognitive load by revealing information gradually.

**Rules for knowledge management UIs:**

1. **Maximum 3 disclosure levels** -- if you need more, reorganize content
2. **Segment by user role** -- advanced settings for admins, essentials
   for content managers
3. **Common patterns**: accordions, conditional inputs, expandable sections,
   tooltips on info icons
4. **Stepper/wizard** for complex creation flows (AWS Bedrock uses 10 steps)
5. **Conditional inputs** -- show fields only when relevant (e.g., chunking
   options appear only when custom chunking is selected)

**SaaS examples:**

- Asana: sequential screens during onboarding
- Loom: multi-layer menu system, advanced options nested behind clicks
- Userpilot: blurred secondary options, limited choice presentation
- ConvertKit: branched flows based on user selection

### Tab vs. Sidebar Navigation

**Source**: [NNG Tabs](https://www.nngroup.com/articles/tabs-used-right/),
[Eleken Tabs UX](https://www.eleken.co/blog-posts/tabs-ux),
[UX Planet Sidebar](https://uxplanet.org/best-ux-practices-for-designing-a-sidebar-9174ee0ecaa2)

**When to use tabs:**

- 3-6 categories of related content
- Users don't need to compare sections side-by-side
- Content within each tab is distinct
- Short labels (1-2 words)

**When to use sidebar:**

- More than 6 categories
- Multiple user roles with deep functionality
- Cross-page navigation needed
- Admin dashboards, SaaS platforms, developer tools

**Combined approach (best for knowledge management):**

- Left sidebar for top-level navigation (features/sections)
- Tabs within resource detail pages (Data/Query/Config/Analytics)
- Maximum 2 levels of tab depth
- If 3+ levels needed: sidebar + tabs, with accordions for tertiary content

**Critical rules from NNG:**

- Never mix navigation tabs and in-page tabs in the same control
- Use at least 2 visual indicators for selected state (underline + bold,
  color + size change)
- Position tab lists above panels only
- Single-row layouts only -- stacking destroys spatial memory
- Order by usage frequency, highest-use first and selected by default

### Dashboard/Overview Page Patterns

**Source**: [Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-data-dashboards),
[F1Studioz](https://f1studioz.com/blog/smart-saas-dashboard-design/),
[UX Collective](https://uxdesign.cc/design-thoughtful-dashboards-for-b2b-saas-ff484385960d)

**Key findings:**

1. **Information overload is the #1 challenge** -- 46.7% of dashboard users
   affected (75-study review)
2. **4-6 KPIs maximum** on the overview page
3. **F-shaped scanning**: top-left gets most attention, put critical metrics
   there
4. **Dashboard as contextual index**: surface actionable items and warnings,
   allow drill-down for details
5. **Reset/filter elements essential** for analytical dashboards
6. **Metric definitions one click away** -- tooltips or expandable explanations

### Sub-tabs vs. Sections on a Single Page

**Source**: [Design Monks Nested Tabs](https://www.designmonks.co/blog/nested-tab-ui),
[LogRocket Tabs](https://blog.logrocket.com/ux-design/tabs-ux-best-practices/)

**Rules:**

- **Max 2 levels of tabs** -- beyond that, use accordions or sections
- **Don't lose form state** when switching between tabs containing inputs
- **Scrollable single page with sections** when content is sequential/related
- **Tabs** when content categories are distinct and users access them independently
- **Accordion sections** when some content is rarely needed but should remain
  discoverable

**For knowledge management configuration specifically:**

- Use tabs for major categories (Data, Config, Analytics, Access)
- Use sections-on-page (with optional collapse) within each tab for sub-groups
- Use accordions for "Advanced" settings within a config section
- Never nest tabs more than 2 levels deep

---

## Competitive Positioning Summary

### Where Most Platforms Agree

1. **3-level data hierarchy** (Container -> Collection -> Document)
2. **Test/preview adjacent to configuration** (not a separate page)
3. **4-6 tabs per resource detail page**
4. **Settings (account) separate from Configuration (per-resource)**
5. **Sync/ingestion status visibility** is critical
6. **Progressive disclosure** for complex configuration
7. **Workflow-based** or **lifecycle-based** navigation grouping

### Differentiating Approaches Worth Considering

1. **Algolia's Configure/Observe/Enhance** grouping -- most intuitive for
   non-technical users
2. **Vectara's Query tab inside each corpus** -- test where your data lives
3. **AWS Bedrock's wizard + "Additional configurations"** -- progressive
   complexity
4. **Google's Apps + Data Stores separation** -- decouples search config
   from content management
5. **Glean's two-phase sync progress** -- highest transparency
6. **Elastic's Solution Views** -- role-based navigation filtering
7. **Cohere's zero-config philosophy** -- intelligent defaults eliminate
   configuration burden
8. **LangSmith's separated evaluation dimensions** -- retrieval quality
   vs. generation quality as independent metrics
9. **Guru's verification lifecycle** -- knowledge cards with ownership and
   expiration

### Anti-Patterns to Avoid

1. **Glean's 15+ section mega-nav** -- too many top-level items create
   choice paralysis
2. **Google Vertex's one-way toggles** (advanced indexing can't be turned off)
3. **Cohere's API-only configuration** -- some users need UI controls
4. **Elastic's pre-9.2 navigation** -- showing everything to everyone
   frustrated 70% of users
5. **Deep nesting** -- more than 3 levels of hierarchy creates navigation
   confusion

---

## Synthesis: Recommended IA Patterns for Search AI / KB Features

Based on this research, a knowledge management feature should follow these
principles:

### Navigation Structure

```
Left Sidebar (workflow-grouped):
  [Product/Feature Header]

  MANAGE
    - Knowledge Bases (list)
    - Sources & Connectors

  CONFIGURE
    - Search Settings
    - Processing Pipeline

  OBSERVE
    - Analytics & Usage
    - Query Logs

  [Settings gear icon at bottom]
    - API Keys
    - Team & Permissions
```

### Per-KB Detail Page (tabs)

```
[KB Name]  [Status badge]  [Sync button]

  Sources | Content | Search | Analytics | Settings

  Sources tab:    Connected sources, sync status, add new
  Content tab:    Documents, chunks, metadata browser
  Search tab:     Query testing, relevance tuning, preview
  Analytics tab:  Query volume, click-through, coverage gaps
  Settings tab:   Embedding model, chunking, access control
```

### Configuration Approach

- **Level 1**: Essential settings visible by default (what every user needs)
- **Level 2**: "Advanced" accordion sections (power users)
- **Level 3**: Full JSON/API access (developers)

### Key UX Decisions

1. **Wizard for creation, tabs for management** -- guided flow to create,
   flexible tabs to operate
2. **Test where you configure** -- search preview embedded in the KB view
3. **Sync status always visible** -- progress, errors, last sync time
4. **4-5 tabs per KB** -- not more
5. **Workflow grouping in sidebar** (Manage/Configure/Observe) not technical
   taxonomy
6. **Progressive disclosure for pipeline config** -- chunking, parsing,
   embedding settings hidden behind "Advanced"

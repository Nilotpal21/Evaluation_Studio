# Business Requirements Document
## SOP-Driven Agentic AI Platform for Credit Unions

---

## 1. Document Control

| Field | Detail |
|---|---|
| Document Title | BRD — SOP-Driven Agentic AI Platform for Credit Unions |
| Version | 0.5 (Draft) |
| Author | [Product Manager] |
| Reviewers | Engineering Lead, AI/ML Lead, Design, Compliance, Security, CX Operations |
| Approvers | VP Product, CTO, CISO, Head of Compliance |
| Status | Draft for Review |
| Date | [DD-MMM-YYYY] |

---

## 2. Executive Summary

This BRD defines the business requirements for a **vertical, SOP-driven Agentic AI Platform built exclusively for credit unions**. The platform's defining promise:

**The user uploads their SOP. The platform builds the agentic app. An AI Helper guides them. The platform evaluates the app continuously — before deployment, and forever after.**

A non-technical credit union employee uploads the SOP that defines their process. The platform reads it, applies its baked-in credit union expertise, and produces a working agentic app: sub-agents selected, knowledge attached, guardrails applied, memory configured, tools bound, experiences targeted. Throughout authoring, an AI Helper is one click away to onboard, explain, answer questions, suggest edits, and execute actions on user confirmation.

Before submission, the platform runs a comprehensive **Evaluation** against pre-built credit union scenarios, SOP-derived tests, and user-defined tests. The output is a **score-based Evaluation Report** the user can iterate against. The same report goes to the compliance/admin reviewer as a key input — though the reviewer makes the final judgment.

After approval, the app is **deployed** to its target audience. Evaluation does not stop at deploy. The platform **continues to evaluate the live app** against the same test suites and against real production traffic patterns, surfacing regressions, drift, and quality changes in Mission Control. The AI Helper continues to assist with debugging, improving, and expanding the app post-deployment.

The strategic intent is to compress agentic app creation from a multi-week engineering project to bringing a document and pressing a button — with a knowledgeable companion, a continuous evaluator, and credit-union-grade trust throughout.

---

## 3. Business Context and Problem Statement

### 3.1 Why Credit Unions, Exclusively
Credit unions share a uniform shape — common core systems, common LOS/AOS/CRM patterns, common member journeys, and a common regulatory perimeter (GLBA, NCUA, FFIEC, TCPA, state privacy laws). This uniformity is what makes a vertical, opinionated platform possible. The platform doesn't need to ask "what kind of business are you?" — it already knows.

Verticalization is the wedge. A general builder asks the user a hundred questions; this platform asks one: **"What's your SOP?"** And whenever the user gets stuck, the AI Helper is there.

### 3.2 The Real Bottleneck
Credit unions already have SOPs for almost every process. The bottleneck has never been "we don't know our process." It is "we can't translate our process into AI — and we can't prove it's working safely once we do."

Translation today requires:
- A central AI team (rare, expensive, backlogged).
- Weeks-to-months per use case.
- Compliance back-and-forth that often kills the project.
- Manual, ad-hoc testing that no one trusts.

The opportunity is to **make the SOP itself the input**, use the platform's baked-in credit union knowledge to do the translation, give the user an always-available AI Helper, and provide a **continuous evaluation harness** that produces evidence on demand.

### 3.3 Conversation-to-Task is the Outcome
Apps produced by the platform must move member interactions through the full arc — **Initial Query → Discussion → Task Created → Approval → Task Card → Completed** — across digital, voice, text, and email, with observability and audit.

### 3.4 Strategic Goal
Build a platform where a credit union employee can:
- Upload an SOP.
- See a working agentic app generated automatically.
- Get real-time guidance from the AI Helper whenever they need it.
- Review and edit the auto-generated configuration in plain language.
- See the platform flag safety/compliance issues in the SOP.
- See a score-based Evaluation Report before submitting.
- Submit for compliance/admin approval.
- Deploy the app to its target audience.
- Trust that the platform keeps evaluating the app continuously after deployment, surfacing regressions and drift as they appear.

---

## 4. Business Objectives

1. **Collapse time-to-value** — from SOP upload to a deployed, governed, production app in hours, not quarters.
2. **Eliminate the AI translation step** — the user provides process; the platform provides AI.
3. **Bake credit union expertise into the platform** — sub-agents, guardrails, tools, knowledge, and evaluation scenarios are pre-tuned for credit unions.
4. **Close the AI literacy gap with an always-available Helper** — a non-technical user is never blocked, lost, or unsupported.
5. **Make quality measurable, not assumed** — every app has a score-based Evaluation Report at submission and continuously after deployment.
6. **Maintain credit-union-grade trust** — compliance review is mandatory; baseline guardrails are non-negotiable; audit is end-to-end, including evaluation results and Helper actions.
7. **Improve SOPs upstream** — by flagging safety and compliance issues in the SOP itself.
8. **Unify member experience** — every app feels consistent across digital, voice, text, and email through one runtime.

---

## 5. Scope

### 5.1 In Scope
- **SOP Intake** — upload, parse, and structure SOPs.
- **Auto-Generation Engine** — produces a complete agentic app from an SOP, using a credit-union-tuned library of sub-agents, knowledge, guardrails, memory presets, tools, and experiences.
- **AI Helper** — a floating, on-demand AI companion that guides, explains, answers, suggests edits, and (with user confirmation) executes actions.
- **Review Studio** — a plain-language UI where the user reviews and edits the auto-generated configuration.
- **SOP Quality Checker** — flags safety, compliance, and consistency issues in the SOP itself.
- **Evaluation Harness** — pre-deployment and continuous post-deployment evaluation across pre-built credit union scenarios, SOP-derived tests, and user-defined tests. Produces a score-based Evaluation Report.
- **Sub-Agent Library**, **Knowledge Management**, **Guardrails**, **Memory**, **Tools / Connectors Catalog** — all pre-tuned for credit unions.
- **Compliance/Admin Approval Workflow** — mandatory pre-deployment review.
- **Deployment** — single-shot publish to the app's target audience after approval.
- **Mission Control Runtime** — orchestrator, observability, governance, audit, rollback, kill switches, continuous evaluation surfaces.
- **Post-Deployment Assistance** — the AI Helper continues to help users debug, improve, and expand apps after go-live.
- **Marketplace** — platform-curated apps, templates, sub-agents, knowledge packs, guardrail packs, and **evaluation scenario packs**.
- **Member Experience (Agentic MX)** and **Employee Experience (Agentic EX)**.

### 5.2 Out of Scope (Initial Release)
- Any market segment other than credit unions.
- A general-purpose, open-ended low-code or no-code platform.
- Building new core banking, LOS, AOS, or CRM systems.
- Replacing telephony / contact center platforms.
- Underwriting decisioning by AI.
- Letting users author raw prompts, model parameters, or low-level sub-agent internals.
- Public marketplace for third-party builders (deferred).
- SOP content suggestions. The platform only flags safety and compliance issues, never process design.
- The AI Helper helping the user write or improve the SOP before upload.
- Fully autonomous Helper actions without user confirmation.
- **Staged or canary rollouts at launch** — deployment is single-shot to the chosen audience; phased/canary rollout is on the roadmap.
- **Hard pass/fail evaluation gates** — evaluation produces a score; the human reviewer makes the call.

---

## 6. Target Users and Personas

| Persona | Description | Needs |
|---|---|---|
| **The Process Owner (primary user)** | Credit union employee who owns a process. Already has SOPs. No AI background. | Upload SOP, see a working app, review in plain language, see an Evaluation Report they can trust, submit. A knowledgeable companion when stuck. |
| **The Compliance / Admin Reviewer** | Mandatory gate before deployment. | A structured summary of what the app does, what it touches, what guardrails apply, what SOP issues were flagged, the Evaluation Report, and what Helper actions were taken. |
| **The Member (Consumer)** | Credit union member via Agentic MX. | Useful, trustworthy, branded experience. Easy escalation to a human. |
| **The Employee (Consumer)** | Frontline employee via Agentic EX. | Real-time help, automation of busywork, transparency. |
| **The Credit Union Admin** | Platform admin at the credit union. | Manage users, roles, RBAC, install policies, kill switches, evaluation policies. |
| **The Platform Team (internal)** | Curates the sub-agent library, baseline guardrails, knowledge templates, evaluation scenarios, Helper behaviors, Marketplace. | Tools to evolve the platform safely. |

### 6.1 Design Principles for the Process Owner
- **The SOP is the input, not a starting point for a hundred questions.**
- **No AI jargon, anywhere.**
- **Plain-language review.**
- **Editable, but never required.**
- **Show, don't tell** — inline sandbox preview plus a measurable Evaluation Report.
- **The Helper is always one click away.**
- **Evaluation is part of the loop, not a separate ritual.**

---

## 7. Current State and Future State

### 7.1 As-Is
- Process owner files a request with a central AI/engineering team.
- Engineering reads the SOP and translates manually.
- Compliance reviews iteratively; rework is common.
- Testing is ad-hoc and rarely measurable.
- Most ideas are deprioritized; many die in translation.
- Each app is a one-off project.

### 7.2 To-Be
- Process owner uploads the SOP.
- The platform auto-generates the agentic app.
- The AI Helper explains what was built and walks through SOP flags.
- The user reviews and edits in plain language; the Helper proposes edits.
- The platform runs Evaluation; the user iterates until satisfied with the score-based report.
- The owner submits; compliance/admin reviewer sees the Evaluation Report alongside the configuration and SOP flags; approves, rejects, or requests changes.
- The app is deployed.
- Evaluation continues against the live app; regressions and drift are surfaced in Mission Control; the Helper assists with debugging and improvement.

---

## 8. Solution Overview

### 8.1 The Full Lifecycle: Create → Evaluate → Approve → Deploy → Utilize → Iterate

| Stage | What happens |
|---|---|
| **Create** | User uploads SOP. Auto-Generation Engine builds the app. SOP Quality Check runs. User reviews and edits in Review Studio with the AI Helper. |
| **Evaluate (initial)** | Platform runs the Evaluation Harness against the app pre-submission. Produces a score-based Evaluation Report. User iterates as needed. |
| **Approve** | User submits. Compliance/admin reviewer sees a structured summary including the Evaluation Report. Approves, rejects, or requests changes. Dual approval for high-risk apps. |
| **Deploy** | On approval, the app is deployed (single-shot) to its target audience (members, employees, or a specific segment). |
| **Utilize** | The app runs in production via Agentic MX and/or Agentic EX. Mission Control provides live observability and audit. |
| **Continuous Evaluation + Iterate** | The platform keeps running the evaluation harness on the live app. Regressions, drift, and quality changes are surfaced in Mission Control. The Helper assists the user in debugging, improving, and (with new approval) expanding the app. |

### 8.2 The AI Helper — Always One Click Away
The AI Helper is a **floating, on-demand companion** that appears as a persistent button across every screen of the platform. When opened, it provides a chat-style interface anchored in the user's current context.

The Helper's responsibilities:
- **Onboarding and step-by-step explanation.**
- **Platform Q&A** — at any time.
- **Auto-generation explanation** — citing the SOP passage that drove each decision.
- **Edit suggestions in the Review Studio.**
- **Evaluation explanation** — translates the Evaluation Report from numbers into plain language ("Most things look good. The app stumbles on hardship cases — want me to suggest an improvement?").
- **Action on confirmation** — preview, before/after, explicit confirm.
- **Post-deployment assistance** — investigates issues, suggests improvements, expands the app through the same approval workflow.
- **Escalation to a human** when out of scope.

What the Helper does NOT do:
- It does not help the user write or improve the SOP before upload.
- It does not propose changes to process content.
- It does not act autonomously.
- It does not bypass guardrails, governance, evaluation, or approval workflows.

### 8.3 The Evaluation Harness
The Evaluation Harness runs against three sources of tests, combined:

1. **Pre-built credit union scenarios** — a platform-curated library of realistic member and employee scenarios drawn from common credit union processes (card disputes, payment plans, account opening, hardship, wire confirmation, fraud, etc.). Versioned and continuously expanded by the platform team.
2. **SOP-derived tests** — automatically generated from the uploaded SOP. The platform identifies decision points, escalation rules, disclosures, and edge cases in the SOP and creates corresponding test conversations.
3. **User-defined tests** — conversations the user creates in the Review Studio (typed scripts or recorded sandbox runs), saved and rerunnable.

The harness produces a **score-based Evaluation Report** with plain-language metrics:
- How often the app answered correctly.
- How often a guardrail fired.
- How often the app escalated when it should have.
- How often the app cited the correct SOP passage.
- How often it created the right task with the right inputs.
- Coverage across intents present in the SOP.
- Categories where the app performs strongest and weakest, with example conversations.

The report is **not a hard pass/fail gate.** The user iterates against it during authoring. The compliance/admin reviewer uses it as a primary input but makes the final judgment.

**Continuous evaluation** runs the same harness against the deployed app on a schedule and against sampled live traffic patterns. Regressions, drift, and new failure modes appear in Mission Control with severity, examples, and Helper-assisted explanations.

### 8.4 What the Platform Knows Out of the Box (Credit Union Vertical)
- **Sub-agent library**: Knowledge, Authentication, Account Services, Collections, Financial Wellness, Loan & Payments, Member Services.
- **Knowledge templates**: card disputes, Reg D and Reg E basics, fraud and identity protection, hardship and payment plans, account opening disclosures, common member FAQs. *Platform-provided templates are augmented at runtime by the credit union's own Knowledge Library (§9.10.1).*
- **Guardrail packs**: no financial advice, TCPA-safe outbound, no PII echo, escalation triggers, do-not-quote-final-rates, credit-union-appropriate language and tone.
- **Evaluation scenario library**: thousands of pre-built credit union conversation scenarios across all sub-agent domains.
- **Tools catalog**: pre-built connectors to common credit union systems (Symitar, Corelation, Fiserv DNA, MeridianLink, Salesforce, common CCaaS/UCaaS, Marketing Automation).
- **Compliance baseline**: GLBA, NCUA, FFIEC, TCPA, 10DLC SMS, state privacy.

### 8.5 The Review Studio
A single structured page covering: What this app does, Who it serves, What it knows, What it won't do, What it can touch, What it remembers, SOP issues to address, Sandbox preview, **Evaluation Report**, and the Helper button. Every section editable; nothing mandatory; no prompts or model parameters exposed.

### 8.6 Mission Control Runtime
Orchestrator agent, live observability, governance, immutable audit, version control, rollback, kill switches per app, sub-agent, or tool, **continuous evaluation surfaces**, and the AI Helper available across the runtime view.

### 8.7 Consumption Surfaces
- **Agentic MX** — branded, multi-channel (digital, voice, text, email) member experience.
- **Agentic EX** — employee AI assistant.

### 8.8 Marketplace
The Marketplace surfaces curated, pre-built apps and components, all credit-union-specific: Templates, Sub-Agents, Skills, Knowledge Packs, Guardrail Packs, **Evaluation Scenario Packs**. At launch the Marketplace is curated by the platform team.

---

## 9. Functional Requirements

Requirements use MoSCoW priority (M = Must, S = Should, C = Could, W = Won't this release). Each requirement should trace to one or more business objectives.

### 9.1 SOP Intake

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-INT-01 | Accept SOP input via file upload (PDF, DOCX, TXT, MD, HTML), URL, or pasted text. | M | All listed formats parse successfully on a defined test set. |
| FR-INT-02 | Handle multi-file SOPs and link related documents. | M | Multi-file uploads grouped into one app. |
| FR-INT-03 | Extract structured elements from SOPs: process type, member intents, tasks, decision points, disclosures, escalation rules. | M | Extraction precision/recall meets benchmark. |
| FR-INT-04 | Preserve the original SOP as the source of record, with citations into the generated app. | M | Every behavior traceable to a passage. |
| FR-INT-05 | SOPs shall be versioned; uploading a new version triggers re-generation, re-evaluation, and re-review. | M | Version history visible; rollback supported. |

### 9.2 Auto-Generation Engine

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-AGN-01 | Auto-select sub-agents based on the SOP. | M | Selection rationale logged. |
| FR-AGN-02 | Auto-attach relevant knowledge templates. | M | Attachments shown with rationale. |
| FR-AGN-03 | Auto-apply baseline guardrails plus SOP-derived custom guardrails. | M | Baseline cannot be removed. |
| FR-AGN-04 | Auto-configure a memory mode (None, Session, Long-term with consent). | M | Default justified. |
| FR-AGN-05 | Auto-bind required tools/connectors. | M | Bindings visible; data access in plain language. |
| FR-AGN-06 | Auto-select consumption surfaces and channels. | M | Choices justified. |
| FR-AGN-07 | If the SOP is too ambiguous, surface clarifying questions via the Helper. | M | Plain language; integration verified. |
| FR-AGN-08 | Auto-generate SOP-derived evaluation tests as part of generation. | M | Tests available to the Evaluation Harness without user action. |
| FR-AGN-09 | Generation shall be deterministic enough that the same SOP produces the same configuration unless the library changes. | S | Repeat generations match within a tolerance. |

### 9.3 AI Helper

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-HLP-01 | Persistent floating button on every screen. | M | Reachable in one click. |
| FR-HLP-02 | Opens into a chat interface anchored in the user's current context. | M | Helper knows screen, app, step. |
| FR-HLP-03 | Onboards first-time users and explains each step. | M | Tested with non-technical users. |
| FR-HLP-04 | Answers platform questions at any time. | M | Measured against a question bank. |
| FR-HLP-05 | Explains the auto-generated app, citing the SOP passage that drove each choice. | M | Citations clickable. |
| FR-HLP-06 | Explains SOP Quality Check flags in plain language and proposes fixes. | M | Coverage validated against flag taxonomy. |
| FR-HLP-07 | Suggests edits in the Review Studio. | M | Suggestions actionable and contextual. |
| FR-HLP-08 | Performs actions ONLY after explicit user confirmation, with a plain-language preview and (where applicable) sandbox before/after. | M | No Helper action executes without a confirm event. |
| FR-HLP-09 | Every Helper action logged in audit trail with confirmation, timestamp, result. | M | Audit verifiable per app. |
| FR-HLP-10 | Subject to the same baseline guardrails as any other agent. | M | Helper-specific guardrail test suite. |
| FR-HLP-11 | Continues to be available after deployment for debugging, improvement, expansion. | M | Capabilities defined and tested. |
| FR-HLP-12 | Recognizes out-of-scope questions and offers human escalation. | M | Path tested. |
| FR-HLP-13 | Does NOT help the user write or improve the SOP before upload. | M | UX confirms scope limit. |
| FR-HLP-14 | Does NOT propose changes to process content. | M | UX confirms scope limit. |
| FR-HLP-15 | Helper memory follows the same consent model as member-facing memory. | M | Boundaries verified. |
| FR-HLP-16 | Exposes reasoning in plain language without AI jargon. | M | UX audit. |
| FR-HLP-17 | Translates the Evaluation Report from metrics into plain-language insights. | M | Verified against sample reports. |

### 9.4 SOP Quality Check

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-SQC-01 | Flag safety and compliance issues in the SOP. | M | Flag categories defined. |
| FR-SQC-02 | NOT suggest changes to process content. | M | UX review confirms scope limit. |
| FR-SQC-03 | Each flag includes severity (Blocker / Strong Warning / Suggestion) and a plain-language explanation. | M | Severity drives approval workflow. |
| FR-SQC-04 | Blocker flags prevent submission until acknowledged or resolved. | M | Acknowledgement logged. |
| FR-SQC-05 | Provide plain-language suggested fixes where possible. | S | Reviewable side-by-side with the SOP passage. |
| FR-SQC-06 | The AI Helper is the primary surface for explaining and acting on SOP flags. | M | Integration tested. |
| FR-SQC-07 | All SOP quality decisions auditable. | M | Logged per submission. |

### 9.5 Review Studio

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-REV-01 | Plain-language structured summary of the auto-generated app. | M | No AI terminology. |
| FR-REV-02 | Every section editable in plain language; edits round-trip to config. | M | Verified by edit-replay tests. |
| FR-REV-03 | Inline sandbox runs test conversations after every edit. | M | Preview within 5 seconds. |
| FR-REV-04 | "Test as a member" and "test as an employee" modes. | M | Both accessible without leaving the screen. |
| FR-REV-05 | No prompts, model parameters, or AI internals exposed. | M | UX audit. |
| FR-REV-06 | Auto-save work-in-progress. | M | No loss of work on browser close. |
| FR-REV-07 | SOP Quality Check results visible alongside configuration. | M | Same screen. |
| FR-REV-08 | The AI Helper is reachable from the Review Studio without losing context. | M | One-click access. |
| FR-REV-09 | The current Evaluation Report is visible alongside configuration; the user can trigger a re-run after edits. | M | Visible from same screen; re-run on demand. |

### 9.6 Evaluation Harness

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-EVL-01 | Evaluate the app against three combined test sources: pre-built credit union scenarios, SOP-derived tests, and user-defined tests. | M | All three contribute to the Evaluation Report. |
| FR-EVL-02 | Auto-generate SOP-derived tests during auto-generation; refresh them when the SOP is re-uploaded. | M | Test list visible to user. |
| FR-EVL-03 | The user shall be able to create, save, edit, and rerun user-defined tests in the Review Studio. | M | Saved per app and versioned. |
| FR-EVL-04 | Produce a score-based Evaluation Report with plain-language metrics (correctness, guardrail firing, escalation appropriateness, citation accuracy, task creation accuracy, intent coverage, strongest and weakest categories with examples). | M | No exposed ML jargon. |
| FR-EVL-05 | Evaluation shall NOT be a hard pass/fail gate; the reviewer makes the final judgment. | M | State machine does not block submission on score alone. |
| FR-EVL-06 | Evaluation shall run automatically on the first auto-generated app and on every subsequent user edit batch (debounced). | M | Latest report always reflects the latest config. |
| FR-EVL-07 | Evaluation shall continue to run on the deployed app on a configurable schedule and against sampled production traffic patterns. | M | Continuous results visible in Mission Control. |
| FR-EVL-08 | Regressions, drift, and new failure modes shall be flagged with severity and examples. | M | Alerts integrated with Mission Control. |
| FR-EVL-09 | Continuous evaluation shall NEVER act on the live app autonomously (no auto-rollback, no auto-disable beyond pre-configured kill-switch thresholds). | M | Verified by audit; any auto-action requires explicit pre-authorization. |
| FR-EVL-10 | Evaluation Reports shall be versioned and immutable once produced; comparable across versions. | M | History viewable; diffs available. |
| FR-EVL-11 | The AI Helper explains the Evaluation Report and proposes specific fixes. | M | Coverage validated. |
| FR-EVL-12 | The Marketplace shall include Evaluation Scenario Packs that users can install into their app. | S | One-click install. |
| FR-EVL-13 | Continuous evaluation results shall feed the platform-level KPI dashboard at the credit union admin level. | S | Roll-up across all apps. |

### 9.7 Approval Workflow

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-APR-01 | Submission auto-generates a structured plain-language summary for the reviewer (purpose, knowledge, guardrails, tools, data access, SOP flags addressed, Evaluation Report, Helper actions taken). | M | Reviewer sees this first. |
| FR-APR-02 | A compliance/admin reviewer approval is mandatory before deployment. | M | State machine enforces. |
| FR-APR-03 | Apps that touch regulated data or move money require dual approval. | M | Matrix configurable per credit union. |
| FR-APR-04 | Reviewers can approve, reject, or request changes with comments. | M | Workflow tracked. |
| FR-APR-05 | The Evaluation Report is included in the reviewer's view as a primary input. | M | Inline; with drill-down to failing cases. |
| FR-APR-06 | All approval actions logged immutably. | M | Audit trail available. |
| FR-APR-07 | Helper-driven edits visible to the reviewer alongside the user's own edits, with provenance. | M | Per-change provenance. |

### 9.8 Deployment

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-DEP-01 | On approval, the user shall be able to deploy the app to its target audience (members, employees, or a specific segment defined at design time). | M | Single-shot deployment. |
| FR-DEP-02 | Deployment shall produce an immutable deployment record (version, timestamp, deployer, approver(s), config snapshot, evaluation snapshot). | M | Record visible in Mission Control. |
| FR-DEP-03 | The deployed app shall be available across the channels selected by the auto-generation engine and confirmed in the Review Studio. | M | Channel availability verified. |
| FR-DEP-04 | Deployed apps shall be rollback-able to any previously approved and deployed version with one click. | M | Rollback audited. |
| FR-DEP-05 | Re-deployment after changes shall require re-evaluation and re-approval. | M | State machine enforces. |
| FR-DEP-06 | Staged or canary rollout is out of scope for initial release. | M | Documented in scope. |

### 9.9 Sub-Agent Library (Platform-Managed)

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-SUB-01 | Pre-built sub-agent library for credit union domains. | M | Launch set defined. |
| FR-SUB-02 | Auto-generation is the primary consumer; users don't configure sub-agents directly. | M | Studio never asks users to pick sub-agents from scratch. |
| FR-SUB-03 | Each sub-agent declares skills, knowledge, tool needs, guardrails. | M | Machine-readable. |
| FR-SUB-04 | Sub-agents versioned with rollback. | M | Versions captured. |
| FR-SUB-05 | Library updates trigger optional re-generation and re-evaluation prompts for dependent apps. | S | Tenants notified. |

### 9.10 Knowledge Management

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-KM-01 | Automatic indexing/retrieval; never exposed to user. | M | No retrieval configuration in UI. |
| FR-KM-02 | Apps cite SOP passages in responses where appropriate. | M | Citations visible. |
| FR-KM-03 | Knowledge versioned with the SOP. | M | Updates auditable. |
| FR-KM-04 | Knowledge access scoped per app, sub-agent, role. | M | Unauthorized access prevented. |
| FR-KM-05 | Knowledge quality issues flagged. | S | Surfaced in Review Studio; Helper explains. |

#### 9.10.1 Knowledge Library — Expanded Requirements

**Intent.** The Knowledge Library is the credit union's first-class store of knowledge available to generated apps, distinct from the SOP. The SOP defines what an app *does*; the Knowledge Library defines what an app *knows*. Process Owners take an app from an SOP to running; Credit Union Admins curate the broader knowledge layer that all apps draw from. Knowledge sources may be uploaded directly, integrated via connector to an existing system of record, crawled from URLs, or authored in the platform.

**Scope of "knowledge."** Operating manuals, branch procedures, product catalogs, eligibility rules, fee schedules, policy bulletins, internal FAQs, member-facing FAQs, regulatory references applicable to the CU, training guides, escalation matrices, and any other documentary content an app may need to ground its responses. Knowledge is **explicitly not** transactional data (member balances, account state) — that travels through Tools and the Integrations Catalog per §9.13.

**Ingestion modes (all first-class, equal-status).**

| Mode | Description |
|---|---|
| **Manual upload** | Files (PDF, DOCX, MD, HTML, TXT, CSV, XLSX, PPTX) or pasted text uploaded by a CU Admin or delegated Knowledge Editor. |
| **Connector integration** | Authenticated pull from an external knowledge system (Confluence, SharePoint, Salesforce Knowledge, Zendesk Guide, etc.) with scheduled refresh. |
| **Web crawl** | Scheduled crawl of a CU-owned URL, sitemap, or domain. Robots/scope rules enforced. |
| **Structured authoring** | In-platform creation of FAQ entries, glossary terms, policy snippets, and curated answer cards — typed directly in a Knowledge Library editor. |
| **API ingestion** | Programmatic upsert via API for CU IT teams to push from custom systems. |

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-KM-06 | The platform shall provide a **CU-tenant-scoped Knowledge Library** managed by the Credit Union Admin (with delegation to one or more Knowledge Editor roles). | M | Library reachable from the platform's top-level navigation under the CU Admin context. |
| FR-KM-07 | The Knowledge Library shall support all five ingestion modes above. | M | Each mode end-to-end tested with at least one representative source per mode. |
| FR-KM-08 | All ingested sources shall be normalized to a single internal representation (content + metadata + lineage). | M | Storage schema documented; lineage queryable per chunk. |
| FR-KM-09 | Each source shall declare a **refresh model** (push via webhook, pull on schedule, real-time, or manual) and refresh shall be auditable. | M | Refresh log visible per source. SLO ≤ configured cadence ±10%. |
| FR-KM-10 | The platform shall **inherit source permissions** (e.g., a Confluence page restricted to a group shall not be surfaced to app audiences that do not include that group's members). | M | Permission-bridge tests per supported connector. |
| FR-KM-11 | The platform shall **detect and flag** stale knowledge (last update older than a configurable threshold per source class), conflicting content across sources, and coverage gaps (SOP intents with no supporting knowledge). | M | Surfaced in the Knowledge Library UI and Review Studio; severity-tiered. |
| FR-KM-12 | Process Owners shall be able to **select knowledge sources per app** in the Review Studio: default = all CU-tenant sources; override to restrict (allow-list or deny-list, per app and per sub-agent). | M | Selection persisted in the app config; visible to reviewer. |
| FR-KM-13 | Apps shall **cite** the specific knowledge passage(s) used in any response derived from external knowledge (in addition to existing FR-KM-02 SOP citations). | M | Citations clickable; citation-coverage metric appears in the Evaluation Report. |
| FR-KM-14 | Knowledge sources shall be **versioned**. The platform shall retain change history with diff-readable snapshots for at least 12 months. | M | History viewable per source; rollback possible per FR-MC-05. |
| FR-KM-15 | Sensitive-data tagging shall be supported per source ("contains PII", "contains NPI", "regulator-only", etc.) with policy hooks that restrict where tagged content may surface (e.g., never to member-facing apps). | M | Tag taxonomy defined; policy enforcement tested. |
| FR-KM-16 | The Knowledge Library shall expose a **dry-run** retrieval tester: a CU Admin can type a question, see what would be retrieved from which sources, with relevance scores and source attribution. | S | Available from the Knowledge Library UI; round-trip ≤2s. |
| FR-KM-17 | The platform shall support **take-down propagation**: when a source is deleted or marked deprecated, dependent apps and cached references shall be invalidated within 15 minutes. | M | Take-down test verifies propagation SLO. |
| FR-KM-18 | A **Knowledge Quality Check** (parallel to the SOP Quality Check) shall run on ingestion and on a schedule. It shall flag PII not declared, regulatory-conflict signals, broken internal links, and low-quality OCR. Severity model mirrors SOP Quality Check (Blocker / Warning / Suggestion). | M | Coverage matrix defined; reviewer sees flags alongside SOP flags. |
| FR-KM-19 | The platform shall track **knowledge usage** per app: which sources are retrieved how often, which never, which co-occur with low evaluation scores. Visible in Mission Control. | S | Usage dashboard available; integrated into continuous evaluation findings. |
| FR-KM-20 | Knowledge content shall **never train or fine-tune any LLM** outside the user's tenant boundary. Knowledge is retrieved at runtime under access controls. | M | Architectural review; contractual commitment to the CU. |
| FR-KM-21 | The AI Helper shall be aware of Knowledge Library state and answer Platform Q&A about it ("Why isn't this source being used?", "Show me what's stale"). | S | Integrates with FR-HLP-04 question bank. |
| FR-KM-22 | The Knowledge Library shall be **discoverable in audit**: every retrieval per app, per session, with the source ID, the chunk, and the response that used it. | M | Audit query available per app and per session. |
| FR-KM-23 | API ingestion shall support **idempotent upsert** keyed by external ID, allowing CU IT teams to manage syncs from custom systems without duplication. | S | API contract documented; idempotency test passes. |

**Knowledge source contract.** Every source registered with the Knowledge Library carries the same metadata footprint: identity (name, type, owner, tags), auth and permission inheritance, refresh model and cadence, scope (which apps / sub-agents may consume it), lineage (source URL or ref, chunk-to-source mapping), and lifecycle state (active / deprecated / removed with take-down propagation guarantee).

**Non-functional considerations.**
- **Latency:** retrieval-tester dry-run round-trip ≤2s; runtime retrieval folds into the per-channel latency NFRs in §10 NFR-02.
- **Scale:** Knowledge Library shall support at least 10,000 documents per CU tenant and 100k chunks at launch.
- **Cost containment:** ingestion and re-embedding subject to per-tenant budgets and rate limits to keep continuous-eval and Helper-driven re-grounding within the cost envelope (§16 risk: cost overrun).
- **Tenant isolation:** retrieval indices are physically partitioned per CU tenant; cross-tenant retrieval is architecturally impossible, not policy-enforced.

### 9.11 Guardrails

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-GR-01 | Non-disable-able baseline of credit union guardrails. | M | Versioned and documented. |
| FR-GR-02 | Auto-derive additional guardrails from the SOP. | M | Derived rules shown. |
| FR-GR-03 | User can add/adjust custom guardrails in plain English. | M | Rules translated by platform. |
| FR-GR-04 | Guardrails apply at runtime with priority over app behavior. | M | Test suite verifies. |
| FR-GR-05 | Guardrail triggers logged and visible in Mission Control. | M | Per-app dashboard. |
| FR-GR-06 | Sandbox previews guardrail effects before deploy. | M | Shows where a rule would have intervened. |
| FR-GR-07 | The AI Helper operates inside baseline guardrails and never bypasses governance. | M | Helper-specific guardrail tests. |

### 9.12 Memory

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-ME-01 | Platform auto-selects a memory mode. | M | Default justified. |
| FR-ME-02 | Long-term memory requires explicit member consent. | M | Captured and revocable. |
| FR-ME-03 | Memory redactable on request. | M | Tooling supports redaction. |
| FR-ME-04 | User can override memory mode in Review Studio. | M | Override audited. |
| FR-ME-05 | Helper conversation history follows same retention and redaction rules. | M | Privacy review. |

### 9.13 Tools and Integrations Catalog

Connectors in the catalog fall into two functional families: **Transactional connectors** (Core Banking, LOS, AOS, CRM, etc. — touch state, may move money) and **Knowledge connectors** (Confluence, SharePoint, etc. — feed the Knowledge Library per §9.10.1). Both families follow the same disclosure (FR-TI-02), scoping (FR-TI-03), and approval (FR-TI-04) requirements. Knowledge connectors do not bypass FR-TI-04 — introducing a new Knowledge connector that brings new sensitive-data classes still triggers stricter approval.

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-TI-01 | Pre-built tools catalog for common credit union systems. | M | One-click attach by auto-generation. |
| FR-TI-02 | Each tool declares data access in plain language. | M | Audited. |
| FR-TI-03 | Tool bindings scoped per app and role at runtime. | M | Enforced and audited. |
| FR-TI-04 | Money-moving / state-changing tools trigger stricter approval. | M | Tier differentiated. |
| FR-TI-05 | Unbound or unavailable tools flagged with remediation path. | M | Surfaced in Review Studio; Helper explains. |

### 9.14 Marketplace (Curated)

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-MKT-01 | Lists curated Templates, Sub-Agents, Skills, Knowledge Packs, Guardrail Packs, and Evaluation Scenario Packs. | M | All six categories at launch. |
| FR-MKT-02 | Search, filter, preview, install Marketplace items. | M | One-click install. |
| FR-MKT-03 | Items versioned; consumers notified on updates. | M | Diff summary on update. |
| FR-MKT-04 | Platform-curated only at launch. | M | Access scope enforced. |

### 9.15 Sandbox

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-SBX-01 | Sandbox mirrors production behavior; never touches prod data or systems. | M | Isolation verified. |
| FR-SBX-02 | Curated test conversations seeded from SOP and credit union scenarios. | M | One-click scenario set. |
| FR-SBX-03 | Users can create custom test conversations; these become user-defined tests in the Evaluation Harness. | M | Save and rerun. |
| FR-SBX-04 | Failure cases shown with plain-language suggested fixes; Helper presents them. | S | Actionable, not raw logs. |

### 9.16 Mission Control Runtime, Governance, and Reporting

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-MC-01 | Per-app real-time dashboard (conversations, deflection, task completion, guardrail triggers, errors, continuous evaluation status and trend). | M | Sub-minute refresh. |
| FR-MC-02 | Role-based access enforced. | M | Access review verified. |
| FR-MC-03 | All app actions, tool calls, decisions, Helper actions, evaluation runs, and approval events auditable. | M | Immutable audit trail. |
| FR-MC-04 | Kill switches per app, sub-agent, or tool. | M | Stoppable within seconds. |
| FR-MC-05 | Models, prompts, and configurations versioned with rollback. | M | Visible to platform admins. |
| FR-MC-06 | Continuous evaluation findings surface in Mission Control with severity, examples, and Helper-assisted explanation. | M | Alerts route to defined channels. |

### 9.17 Post-Deployment Assistance

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-PPA-01 | The AI Helper can investigate runtime issues with scoped Mission Control access. | M | Read access verified. |
| FR-PPA-02 | The Helper suggests improvements based on runtime patterns and continuous evaluation results. | M | Suggestions scoped to user's apps. |
| FR-PPA-03 | The Helper can expand an app to new channels, sub-agents, or knowledge with user confirmation, routing through the same approval workflow. | M | No bypass of governance. |
| FR-PPA-04 | All post-deployment Helper actions follow the same confirmation, audit, evaluation, and approval rules as authoring-time actions. | M | Audit review. |

### 9.18 Conversation-to-Task

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-CT-01 | Apps create structured tasks from conversations as defined by the SOP. | M | Task schema validated. |
| FR-CT-02 | Tasks route through configurable approval workflows. | M | Matrix derived from SOP and editable. |
| FR-CT-03 | Approved tasks execute against back-office via the Tools catalog. | M | Execution rate measurable. |
| FR-CT-04 | Members notified at defined milestones across channels. | M | Notifications validated. |
| FR-CT-05 | Failed tasks route to a human queue with diagnostics. | M | MTTR measurable. |

### 9.19 Model Integration

**Intent.** The platform's inference layer is not monolithic. While the platform ships with default model choices curated by the Platform Team for balanced cost, latency, and quality on credit-union workloads, each credit union shall be able to **bring its own models** — either via **API keys** to managed providers (OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Google Vertex AI, Cohere, Mistral, others) or via **custom API integration** to self-hosted / proprietary endpoints (OpenAI-compatible or declared-contract). Model integration is per-tenant and per-purpose: different models may serve routing, response generation, embedding, Helper, and evaluation grading.

**Why this matters.** Regulated buyers — credit unions among them — frequently have existing model relationships, data residency commitments, BAAs / DPAs already in place with specific providers, and compliance postures that require inference to occur within their own cloud accounts. A one-size-fits-all platform-side model violates those constraints. Honoring them is table-stakes for enterprise deployment.

**Integration modes (all first-class, equal-status).**

| Mode | Description |
|---|---|
| **API key — managed provider** | Customer provides an API key for a managed LLM provider (OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Google Vertex AI, Cohere, Mistral, etc.). Platform stores credentials in a per-tenant vault and routes inference through the named provider. |
| **Custom API — OpenAI-compatible endpoint** | Customer provides a URL + auth for an OpenAI-compatible inference endpoint (vLLM, TGI, LM Studio, Ollama, internal gateway, etc.). Suited to self-hosted models, fine-tunes, or proprietary inference. |
| **Custom API — declared contract** | Customer provides URL + auth + a documented request/response contract for a non-OpenAI-compatible model. Platform implements a per-tenant adapter; subject to capability matching (FR-MOD-10). |
| **Platform default** | If the CU has not configured BYOM, the platform routes to its curated default model selection. Opt-in / opt-out configurable per tenant. |

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| FR-MOD-01 | The platform shall support **per-tenant model configuration**: a CU Admin can register one or more model endpoints (API key or custom API) and assign them to platform functions. | M | Configuration UI available; scoped per CU tenant. |
| FR-MOD-02 | The platform shall support **per-purpose model routing**: separate model assignments for routing/classification, response generation, AI Helper, embedding (Knowledge Library), and evaluation grading. | M | Each purpose configurable independently; defaults documented. |
| FR-MOD-03 | The platform shall support **API key integration** for at minimum: OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Google Vertex AI. | M | Each provider end-to-end tested with a sample CU configuration. |
| FR-MOD-04 | The platform shall support **OpenAI-compatible custom endpoint integration** with configurable URL, auth (bearer token, API key, signed request), and request/response shape. | M | Reference test endpoint passes round-trip. |
| FR-MOD-05 | The platform shall support **declared-contract custom API integration** for non-OpenAI-compatible endpoints via a per-tenant adapter. | S | Adapter framework documented; at least one reference adapter shipped. |
| FR-MOD-06 | Credentials for all model endpoints shall be stored in a **per-tenant credential vault** with encryption at rest, rotation support, and revocation propagation within 15 minutes. | M | Vault implementation reviewed; rotation drill passes. |
| FR-MOD-07 | The platform shall enforce **data residency** per model configuration: the CU Admin specifies a required region, and inference shall not occur outside that region. | M | Residency enforcement tested per supported provider. |
| FR-MOD-08 | The platform shall inherit the **BAA / DPA posture** of the customer's chosen model provider where applicable; the platform does not provide its own compliance umbrella over the customer's provider relationship. | M | Documented in customer agreement; surfaced in UI. |
| FR-MOD-09 | The platform shall provide **fallback routing**: if a customer's primary model endpoint is unavailable, the CU can pre-authorize fallback to a secondary endpoint or to the platform default. Fallback events are audited. | M | Fallback test passes; audit trail visible. |
| FR-MOD-10 | The platform shall provide a **capability matcher**: when a customer configures a model that lacks a required capability (tool use, JSON mode, vision, long context), the platform shall warn at configuration time and at runtime if a request would require that capability. | M | Capability matrix maintained; warning UX tested. |
| FR-MOD-11 | The platform shall provide **per-tenant cost attribution**: inference cost is borne by the customer's own provider account when BYOM is configured; the platform does not surcharge per token in that path. | M | Billing model documented; reconciled with finance. |
| FR-MOD-12 | The platform shall track **per-model performance metrics**: latency, cost, quality (as measured by the Evaluation Harness), error rates. Visible in Mission Control. | M | Per-model dashboard available. |
| FR-MOD-13 | The platform shall support **model versioning awareness**: when a customer's provider releases a new model version, the customer can pin or opt-in to the upgrade. Behavior shifts are flagged by continuous evaluation. | M | Version pinning configurable per purpose. |
| FR-MOD-14 | All inference requests shall be **auditable**: source app, sub-agent, purpose, model used, latency, cost, response hash, chain-of-trust metadata. | M | Audit query available per app and per session. |
| FR-MOD-15 | The platform shall **never train or fine-tune any third-party model on customer data** without explicit written consent and a documented data-flow agreement. | M | Architectural review; contractual commitment. |
| FR-MOD-16 | The AI Helper shall use a model assignable independently of app-runtime models, so a CU can choose a more capable or more governed model for Helper interactions. | S | Configurable in settings. |
| FR-MOD-17 | The Evaluation Harness grader shall be assignable independently to support the CU's chosen evaluation policy. | S | Configurable in settings. |

**Default vs. BYOM operating model.**
- Customers with no preference run on the **Platform Default** configuration — the Platform Team's curated multi-model setup, optimized for cost/quality/latency on credit-union workloads.
- Customers who require BYOM configure their own endpoints during onboarding. **Hybrid is supported** (e.g., platform default for intent routing, customer's Azure OpenAI tenant for response generation, customer's embedding model for KB retrieval).

**Non-functional considerations.**
- **Latency:** custom endpoints subject to the same latency NFRs as the platform default (§10 NFR-02). Customers configuring slow self-hosted endpoints accept the latency consequence.
- **Cost:** customer-owned inference is billed by the customer's provider; platform fees decouple from token volume in BYOM configurations.
- **Tenant isolation:** under no condition does inference for CU A traverse CU B's model endpoint or credential.
- **Vendor concentration:** the platform actively supports multi-provider configurations to avoid single-vendor lock-in (mitigates §16 cost overrun and outage risks).

---

## 10. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Availability | 99.9% monthly uptime for the runtime, AI Helper, and continuous evaluation services. |
| NFR-02 | Latency | App P95 < 2.5s text, < 1.5s voice. Auto-generation P95 < 60s. Sandbox preview P95 < 5s. AI Helper first-token P95 < 1.5s; full response P95 < 5s. Initial evaluation run P95 < 5 min for a typical app. |
| NFR-03 | Scalability | Support N concurrent conversations, U concurrent users, H concurrent Helper sessions, and E concurrent evaluation runs at launch; scaling plan to 10x. |
| NFR-04 | Reliability | Idempotent task execution; safe retries; Helper actions idempotent and replay-safe; evaluation runs idempotent across retries. |
| NFR-05 | Observability | Tracing, logging, metrics across orchestrator, sub-agents, tools, integrations, auto-generation, SOP quality checker, Evaluation Harness, and the AI Helper. |
| NFR-06 | Accessibility | WCAG 2.1 AA for all user-facing surfaces. |
| NFR-07 | i18n | English at launch. |
| NFR-08 | Multi-tenancy | Per-credit-union tenant isolation. |
| NFR-09 | Usability | Target Process Owner persona moves from SOP upload to submitted-for-approval in ≤2 hours for a well-scoped SOP. ≥X% "felt supported by the Helper" post-task. Process Owner can interpret the Evaluation Report without help in usability testing. |
| NFR-10 | DR | RPO ≤ 15 min, RTO ≤ 4 hr for runtime; RPO ≤ 1 hr, RTO ≤ 8 hr for Studio, Helper, and Evaluation Harness. |

---

## 11. Integration Requirements

| System | Purpose | Direction |
|---|---|---|
| Core Banking (Symitar, Corelation, Fiserv DNA, etc.) | Account, balance, transactions, member profile | Read / Write (scoped) |
| LOS (e.g., MeridianLink) | Loan applications, statuses, documents | Read / Write |
| AOS | New account workflows | Read / Write |
| Collections | Cases, promises-to-pay, payment plans | Read / Write |
| CRM (e.g., Salesforce) | Member 360, cases, notes | Read / Write |
| CCaaS / UCaaS | Voice, chat, telephony orchestration | Bi-directional |
| Marketing Automation | Campaigns, journeys, opt-ins | Outbound triggers |
| Identity / SSO | User, employee, member auth | Federated |
| Data Warehouse / Lake | Analytics, evaluation history, reporting | Outbound (event stream) |

**Knowledge Sources** *(feed the Knowledge Library per §9.10.1; read-only unless paired with a transactional capability)*:

| System | Purpose | Direction |
|---|---|---|
| Confluence (Cloud / Server / Data Center) | Operating procedures, internal docs, runbooks | Read (pull + webhook) |
| SharePoint Online / Server | Policy docs, branch manuals, intranet content | Read (pull + change-events) |
| Salesforce Knowledge | Service / case-deflection KB articles | Read (pull, scheduled) |
| Zendesk Guide / Freshdesk Knowledge | Member-facing FAQ / help center | Read (pull, scheduled) |
| ServiceNow Knowledge Management | IT / operations knowledge | Read (pull, scheduled) |
| Google Drive / OneDrive / Box / Dropbox | Document repositories — policy folders, training materials | Read (pull + change-events) |
| NetDocuments / iManage | Compliance/policy document management | Read (pull, scheduled) |
| Notion / Bloomfire / Guru | Modern internal knowledge platforms | Read (pull + webhook where supported) |
| Generic S3 / GCS / Azure Blob | CU-controlled document dumps | Read (pull on event or schedule) |
| Generic web crawl (CU-owned domain / sitemap) | Public-facing KB, member portal, policy pages | Read (scheduled crawl) |
| Generic RSS / Atom | Bulletins, regulator alerts, policy update feeds | Read (scheduled pull) |
| Headless CMS (Contentful, Sanity, Strapi) | Structured content from CU's marketing/content stack | Read (pull + webhook) |
| Generic API push | CU IT team's custom ingestion path | Inbound (write) |

**Model Providers** *(serve inference per §9.19; per-tenant credentials, configurable per purpose)*:

| System | Purpose | Direction |
|---|---|---|
| OpenAI (API) | LLM inference (managed) | Read/Write (per-tenant API key) |
| Anthropic (API) | LLM inference (managed) | Read/Write (per-tenant API key) |
| Azure OpenAI (customer's tenant) | LLM inference in customer's Azure subscription | Read/Write (federated identity or API key) |
| AWS Bedrock (customer's account) | LLM inference in customer's AWS account | Read/Write (IAM role or API key) |
| Google Vertex AI (customer's project) | LLM inference in customer's GCP project | Read/Write (service account or API key) |
| Cohere / Mistral / additional managed providers | LLM inference (managed) | Read/Write (per-tenant API key) |
| Custom OpenAI-compatible endpoint | Self-hosted or proprietary inference (vLLM, TGI, LM Studio, Ollama, internal gateways) | Read/Write (configurable URL + auth) |
| Custom declared-contract endpoint | Non-OpenAI-compatible inference via per-tenant adapter | Read/Write (configurable URL + auth + adapter) |
| Embedding model providers (any of the above) | Knowledge Library retrieval embeddings | Read/Write (per-tenant) |

Each integration appears in the Tools Catalog as a pre-built, one-click connector consumed by the auto-generation engine.

---

## 12. Security, Privacy, and Compliance

- Alignment with regulations: GLBA, FFIEC and NCUA guidance, TCPA, applicable state privacy laws.
- 10DLC registration for SMS where applicable.
- PII and NPI encrypted in transit and at rest.
- Role-based access; MFA for users, reviewers, admins, and platform admins.
- Tenant isolation for multi-credit-union deployments.
- Data residency configurable per tenant where required.
- Auto-generated content governance: mandatory compliance/admin approval before deployment; dual approval for high-risk apps.
- Baseline credit union guardrails the user cannot disable, versioned and documented.
- The AI Helper operates inside the same guardrails and governance as the rest of the platform. No autonomous publish. Every action confirmed by the user. Every action audited.
- The Evaluation Harness is a decision-support tool, not a substitute for human judgment.
- Continuous evaluation runs on a least-privilege basis and never modifies the live app autonomously.
- SOP Quality Check is a compliance enabler, not a substitute.
- Bias, safety, and abuse testing prior to launch and on a recurring schedule, including against auto-generated apps, Helper behaviors, and evaluation scenarios.
- Explainability: every member-impacting decision must be explainable to a human reviewer, with a citation back to the SOP passage.
- Full audit trail covering SOP uploads, auto-generation, SOP flags, edits, Helper actions, evaluation runs, submissions, approvals, deployments, and runtime.
- **Knowledge source permissions shall be honored, not bypassed.** When a Knowledge connector authenticates via SSO-federated identity, the platform shall respect the source's per-document access rules and shall not surface restricted content to apps whose audience would not have access at the source.
- **Sensitive-data tagging on knowledge content** shall enforce surface-restriction policies per FR-KM-15 (e.g., regulator-only content shall never appear in member-facing app responses).
- **Take-down propagation** (FR-KM-17) shall complete within 15 minutes across retrieval caches, evaluation runs, and Helper context.
- **Knowledge content shall never be used to train or fine-tune any model outside the CU tenant boundary** (FR-KM-20). Contractual and architectural enforcement both required.
- **Audit coverage extends to every knowledge retrieval**: source, chunk, response, app, session — queryable for compliance review and post-incident analysis.
- **Model credentials shall be stored in a per-tenant credential vault** with encryption at rest, rotation support, and revocation propagation within 15 minutes (FR-MOD-06).
- **Data residency for inference is enforced per model configuration** (FR-MOD-07); inference shall not occur outside the CU's declared region.
- **BAA / DPA posture follows the customer's chosen model provider** where applicable (FR-MOD-08); the platform does not provide its own compliance umbrella over the customer's provider relationship.
- **No cross-tenant inference traversal**: under no condition does inference for CU A traverse CU B's model endpoint or credential.
- **Every inference request is auditable** (FR-MOD-14): app, sub-agent, purpose, model used, latency, cost, response hash, chain-of-trust metadata.

---

## 13. Data Requirements

- Canonical member identifier across all systems and tools.
- Event schema for conversations, tasks, approvals, deployments, guardrail triggers, SOP flags, Helper actions, evaluation runs, and outcomes.
- Source-of-truth mapping for each member attribute.
- Data quality monitoring on inbound integrations.
- Training, evaluation, and feedback datasets governed under the same access controls as production data.
- Sandbox data sets isolated from production with synthetic or masked data.
- SOPs and Evaluation Reports are first-class data assets — versioned, retained, auditable.
- Helper conversation transcripts retained per tenant policy with redaction support.
- **Knowledge sources are first-class data assets** alongside SOPs and Evaluation Reports. Each source carries lineage (origin, owner, ingestion mode, refresh model, last-sync timestamp), is versioned, retained per tenant policy, and is auditable end-to-end (ingestion → indexing → retrieval → cited in response).
- **Cross-tenant retrieval is architecturally prevented**, not policy-enforced. Indices are partitioned per CU tenant.
- **Retention policy** for knowledge content matches or exceeds the retention requirement of the source system (e.g., if Confluence retains for 7 years, the Knowledge Library mirror retains for at least 7 years or until take-down).
- **Inference metadata is a first-class data asset** — every request records source app, sub-agent, purpose, model assigned, region, cost, latency, audit hash. Queryable for compliance review and per-CU cost reconciliation.
- **Model assignment per app and per purpose is versioned** alongside the app config and the Evaluation Report (FR-MOD-13 + FR-MC-05); changes are auditable and rollback-able.

---

## 14. User Roles and Permissions

| Role | Capabilities |
|---|---|
| **Process Owner** | Upload SOPs, review and edit auto-generated apps, use the AI Helper, run sandbox tests, run evaluations, submit for approval, deploy on approval. Cannot approve their own app. |
| **Compliance / Admin Reviewer** | Mandatory approver. Read access to SOP, config, SOP flags, Helper action log, Evaluation Report, audit. Approve, reject, or request changes. |
| **Compliance Co-Reviewer** | Required co-approver for high-risk apps. |
| **Credit Union Admin** | Manage tenant settings, users, roles, RBAC, Marketplace install policy, kill switches, evaluation policies. Delegates Knowledge Library administration to one or more Knowledge Editors. |
| **Knowledge Editor** | Delegated by the CU Admin. Add, edit, tag, version, and dry-run-test Knowledge Library sources (§9.10.1). Cannot deploy or approve apps. |
| **Member (Consumer)** | Interact via Agentic MX. |
| **Employee (Consumer)** | Use apps via Agentic EX. |
| **Platform Admin (internal)** | Manage sub-agent library, baseline guardrails, knowledge templates, evaluation scenarios, tools catalog, Helper behaviors, global policy. |
| **Marketplace Curator (internal)** | Curate platform-published items. |

---

## 15. Assumptions, Constraints, Dependencies

### Assumptions
- Credit unions already maintain SOPs.
- Pre-built sub-agents, guardrails, knowledge templates, evaluation scenarios, and tools cover the long tail of credit union use cases over time.
- The AI Helper can reliably explain platform behavior at the depth a non-technical user needs.
- Compliance/admin reviewers will accept a score-based Evaluation Report as a primary input.
- Credit unions will expose required APIs through the Tools Catalog (some via tactical adapters at launch).

### Constraints
- Compliance/admin approval is mandatory before deployment.
- The platform serves credit unions only.
- Users cannot write raw prompts or directly tune model parameters at launch.
- The platform never proposes changes to process content.
- The AI Helper never acts without explicit user confirmation.
- Continuous evaluation never modifies the live app autonomously.
- Deployment is single-shot at launch; staged/canary rollout is roadmap.
- Some core banking integrations will be batch/file at launch.

### Dependencies
- Identity provider for SSO.
- LLM provider strategy supports both **platform-default** (Platform Team's curated selection) and **Bring-Your-Own-Model** per §9.19: customer-supplied API keys (OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Google Vertex AI, etc.) or custom API endpoints (OpenAI-compatible or declared-contract). Multi-provider, per-purpose routing is first-class.
- Evaluation tooling assignable independently of app-runtime models.
- Data warehouse for analytics and evaluation history.
- Contact center platform integration partner.

---

## 16. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Auto-generation produces an unsafe or non-compliant app | High | Medium | Baseline guardrails, mandatory approval, SOP quality checker, evaluation, eval gates, kill switches, audit. |
| SOPs are poorly written and lead to bad apps | High | High | SOP Quality Check with Blocker severity; Helper presents clarifying questions; sandbox previews; evaluation surfaces real failures. |
| Reviewer over-relies on Evaluation Report and skips deeper review | Medium | Medium | Reviewer UX emphasizes that the report is input, not a verdict; Helper-driven edits called out separately; spot-audit program. |
| Evaluation scores look fine but app fails in production | High | Medium | Continuous evaluation against live traffic patterns; drift alerts; Mission Control surfaces regressions immediately. |
| Continuous evaluation produces alert fatigue | Medium | High | Severity tiers; rate limits; Helper-summarized weekly digest; configurable per credit union admin. |
| Users feel the platform took control away from them | Medium | Medium | Plain-language Review Studio; every section editable; Helper explains every decision. |
| AI Helper gives incorrect or misleading guidance | High | Medium | Constrained scope, citations, Helper-specific guardrails, eval harness, user feedback loop. |
| Users over-rely on the Helper and skip review | Medium | Medium | Helper actions require explicit confirmation with previews; reviewer sees Helper edits separately. |
| Helper bypasses governance via action chaining | High | Low | Helper subject to baseline guardrails; cannot deploy autonomously; every action audited and replay-safe. |
| Library or model updates change app behavior silently | High | Medium | Versioned library; explicit re-generation and re-evaluation prompts; full audit; rollback. |
| Vertical scope feels limiting | Medium | Medium | Custom guardrails and edits in Review Studio; roadmap for advanced overrides. |
| Tool/data access escalation through composition | High | Medium | Per-app scoping, dual approval, runtime enforcement, audit. |
| Cost overrun on inference (apps + Helper + continuous eval) | Medium | High | Caching, model routing, per-app and per-tenant budgets and alerts; eval frequency configurable; sampling strategies. |
| Regulatory change mid-build | Medium | Low | Compliance representation in governance forum; modular policy layer; evaluation scenarios refreshable. |
| Knowledge source goes stale and apps drift quietly | High | High | FR-KM-11 staleness flags surfaced in Knowledge Library + Review Studio; continuous evaluation catches knowledge-driven regressions. |
| Knowledge connector credentials breached, exposing CU's internal knowledge | High | Low | SSO-federated identity preferred over static tokens; per-tenant credential vault; rotation drills; revocation propagation tested. |
| Source-system permission change leaks restricted content into a member-facing app | High | Medium | FR-KM-10 inherits source permissions; periodic permission-bridge reconciliation; audit on every retrieval (FR-KM-22). |
| Single-provider concentration / vendor lock-in | Medium | Medium | BYOM (§9.19) supports multiple managed providers and custom endpoints; per-purpose model routing; fallback routing (FR-MOD-09); multi-provider configurations actively supported. |
| Customer-configured model lacks required capability (tool use, JSON mode, vision, long context) | Medium | Medium | FR-MOD-10 capability matcher warns at configuration time and at runtime; reference capability matrix maintained per supported model. |
| Customer's primary model endpoint experiences outage | High | Medium | FR-MOD-09 fallback routing to secondary endpoint or platform default; fallback events audited; per-model SLO monitored in Mission Control. |

---

## 17. Success Metrics / KPIs

### Activation and productivity
- SOPs uploaded per credit union per month.
- Time from SOP upload to submission.
- Time from submission to approval.
- Time from approval to deployment.
- Approval rate on first submission.
- Apps deployed per credit union per quarter.

### Helper effectiveness
- Helper invocations per authoring session.
- Helper-suggested edits accepted vs rejected.
- Post-task survey: "felt supported by the Helper."
- Helper escalations to a human.
- Helper actions reverted by user.

### Quality and safety
- SOP flags per app (counts by severity).
- Initial Evaluation Report score distribution.
- Improvement in Evaluation Report score from first run to submission.
- Continuous evaluation score trend post-deployment.
- Regressions detected by continuous evaluation per month.
- Guardrail trigger rate.
- Rollback rate after deployment.
- Member-reported issues per app.

### Knowledge effectiveness
- Citation coverage on member-impacting responses (% of responses with at least one cited source).
- Knowledge sources active / stale / deprecated (counts and trend).
- Knowledge-driven Helper resolution rate.
- Evaluation score lift attributable to Knowledge Library content vs. platform-template baseline.
- Take-down propagation latency (SLO ≤15 min per FR-KM-17).
- Knowledge Quality Check flags per source, by severity.

### Business outcomes
- Deflection rate.
- Task completion rate from conversation.
- Member satisfaction on AI-led interactions.
- Employee satisfaction with AI Assistant.
- Cost per interaction.

Targets to be set per pilot and revised quarterly.

---

## 18. Implementation Approach

### 18.1 Phasing
- **Phase 0 — Foundations**: Mission Control runtime, sub-agent library, baseline guardrails, knowledge templates, tools catalog, identity, observability, evaluation infrastructure.
- **Phase 1 — SOP-Driven Pilot with Helper and Evaluation**: SOP intake, auto-generation engine, SOP Quality Check, Review Studio, AI Helper, Evaluation Harness (pre-deployment + initial continuous evaluation), approval workflow, deployment, sandbox, one channel (digital), one pilot credit union, one process domain.
- **Phase 2 — Expansion**: Voice, text, email channels. Expand sub-agent, knowledge, and evaluation scenario libraries. Post-deployment Helper assistance hardened. Continuous evaluation depth (drift, traffic sampling). Additional credit unions.
- **Phase 3 — Marketplace and Advanced**: Curated marketplace at scale. Staged/canary rollouts. Advanced overrides. Deeper Agentic EX automation. Partner-published items (deferred decision).

### 18.2 Change Management
- Process Owner onboarding centered on "bring your SOP; the Helper guides; evaluation proves it works."
- Reviewer onboarding with explicit coverage of how to read the Evaluation Report and Helper-driven edits.
- Member communication and opt-out plan.
- Credit union community for sharing patterns.

### 18.3 Operating Model
- AI governance forum (Product, Engineering, Compliance, Security, CX).
- Quarterly review of sub-agent library, baseline guardrails, knowledge templates, evaluation scenarios, tools catalog, and Helper behaviors.
- Continuous evaluation pipeline including Helper-specific scenarios.
- SOP Quality Check rules updated on a defined cadence as regulation evolves.

---

## 19. Appendices

### A. Glossary
- **Credit Union** — The exclusive target market.
- **Process Owner** — Credit union employee who uploads SOPs and authors apps.
- **SOP** — Standard Operating Procedure.
- **Auto-Generation Engine** — Component that turns an SOP into a working agentic app.
- **AI Helper** — Floating, on-demand AI companion that guides the user and can perform actions on user confirmation.
- **SOP Quality Check** — Flags safety/compliance issues in the SOP itself.
- **Review Studio** — Plain-language UI for reviewing and editing the auto-generated app.
- **Evaluation Harness** — Continuous, score-based evaluation across pre-built scenarios, SOP-derived tests, and user-defined tests.
- **Evaluation Report** — Score-based, plain-language summary of app quality at a point in time.
- **Sub-Agent** — A specialized agent selected by the platform.
- **Knowledge Pack / Guardrail Pack / Evaluation Scenario Pack** — Reusable bundles curated by the platform team.
- **Mission Control** — Runtime that governs and observes all apps.
- **Marketplace** — Curated discovery surface.
- **Agentic MX** — Member-facing AI experience.
- **Agentic EX** — Employee-facing AI experience.
- **Knowledge Library** — The credit union's tenant-scoped store of knowledge sources (uploaded, integrated, crawled, or authored) available to generated apps. Distinct from the SOP and from platform-provided knowledge templates.
- **Knowledge Source** — A registered ingestion endpoint within the Knowledge Library: an uploaded document, a connector to an external KB, a web crawl target, an authored entry, or an API push channel.
- **Knowledge Editor** — Credit Union role delegated by the CU Admin to manage Knowledge Library sources (add, tag, version, dry-run test). Cannot deploy or approve apps.
- **Knowledge Quality Check** — Automated evaluation of Knowledge Library content for PII leakage, regulatory conflicts, broken links, low-quality OCR, and other quality signals. Severity tiers mirror SOP Quality Check.
- **BYOM (Bring Your Own Model)** — Per-tenant configuration of LLM inference endpoints, either via API keys to managed providers or via custom API integration to self-hosted endpoints. See §9.19.
- **Model Endpoint** — A specific configured inference target: a provider + region + credential + capability set + assigned purpose.
- **Model Provider** — The vendor or service that fulfills inference requests (OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Google Vertex AI, Cohere, Mistral, or a customer-controlled custom endpoint).
- **Per-Purpose Model Routing** — Different models assigned to different platform functions (routing, response generation, AI Helper, embedding, evaluation grading).
- **Capability Matcher** — Component that validates whether a configured model has the capabilities required by an app (tool use, JSON mode, vision, long context); warns at configuration and at runtime.

# Executive Brief
## SOP-Driven Agentic AI Platform for Credit Unions

## 1. Quick overview

A credit union employee uploads their Standard Operating Procedure. The platform reads it, applies its baked-in credit union expertise, and builds the agentic app — sub-agents selected, knowledge attached, guardrails applied, tools bound, channels chosen. An AI Helper walks the user through every step. Before submission, the platform runs a comprehensive evaluation and produces a score-based report. Compliance approves. The app deploys. **Evaluation does not stop at deploy — the platform keeps proving the app works against live traffic, forever.**

In one sentence: **bring a document, press a button, get a governed, member-facing AI app — and trust that we'll keep proving it works.**

---

## 2. The Problem

Credit unions already know how their processes work. They have SOPs for almost every workflow. The bottleneck is never *"we don't know our process"* — it's *"we can't translate our process into AI, and we can't prove it's working once we do."*

Today, translation requires:
- A central AI/engineering team most CUs don't have at scale.
- Weeks to months per use case.
- Compliance back-and-forth that often kills the project.
- Ad-hoc testing that no one trusts.

Result: most ideas die in translation. Every credit union has a backlog of *"we'd love to automate this if we could."* The appetite is there. The throughput isn't.

Even credit unions that do clear those hurdles hit the next wall: **multi-agent orchestration is hard on its own merits**, and most teams underestimate it until it's in production.

**At design-time**, every iteration costs latency, tokens, and engineering attention. Agent decomposition decisions — one big agent vs. seven small ones, how they hand off, where they share state, which tool each can call — are made by feel, not by data. Debugging a cascade, where Agent A's silent miss steered Agent B in the wrong direction, means reading long traces by hand. Evaluation is ad-hoc: there is no clean way to say *"this composition is X% better than that one"* until production proves it the hard way. Build cycles stretch; confidence stays low.

**Once deployed**, the problems compound. Latency stacks across every agent hop. Cost stacks with every token. One agent's hallucination becomes the next agent's "fact." Failure modes are emergent — each sub-agent passes its own tests, yet together they regress in ways that only show up against real members. Drift is invisible: a sub-agent's behavior shifts a little after a model update, and the downstream impact surfaces weeks later in member complaints. Guardrails written for one agent can be bypassed by another agent in the chain. Trust collapses faster than it builds — one bad answer poisons a member relationship.

The platform's wedge addresses both layers: **the SOP itself becomes the input**, baked-in credit union expertise handles the translation, ad-hoc agent composition is replaced by a pre-composed orchestrator the user never has to assemble, an AI Helper accompanies every step, and a continuous evaluation harness produces evidence on demand — pre-deploy and forever after.

---

## 3. The Solution at a Glance

```
   Upload SOP   →   Auto-Generate App   →   AI Helper Guides   →
   ──────────────────────────────────────────────────────────
   Evaluate (Score-Based Report)   →   Compliance Approves   →
   ──────────────────────────────────────────────────────────
   Deploy   →   Continuous Evaluation Forever   →
                                  Helper Helps You Improve
```

Six stages, one product. The user never writes a prompt, never tunes a model, never picks a sub-agent from a catalog. They review and edit in plain language; the Helper proposes edits with citations back to the SOP. They submit when satisfied with the evaluation score. The compliance reviewer sees a structured summary plus the score-based Evaluation Report. After deployment, the same evaluation harness keeps running against sampled live traffic; regressions surface in Mission Control before members notice them. The Helper continues to assist with debugging, improving, and expanding apps post-deployment.

---

## 4. What's Different

The wedge is **opinionated verticalization**. We do not ask the user *"what kind of business are you?"* — we already know they are a credit union. That single bet unlocks everything else: pre-tuned sub-agents, knowledge templates, guardrail packs aligned to GLBA / NCUA / FFIEC / TCPA, pre-built connectors to Symitar / Corelation / Fiserv DNA / MeridianLink / Salesforce, and an evaluation scenario library trained on real credit-union conversations.

| | Status Quo (DIY) | Horizontal AI Platforms | CCaaS / Chatbot Vendors | **This Platform** |
|---|---|---|---|---|
| Time to deployed app | Weeks to months | Weeks (with engineers) | Weeks (vendor services) | **Hours** |
| Credit-union knowledge baked in | None | None | None | **Yes** |
| Compliance posture | Reactive | DIY | DIY | **Mandatory approval; non-disable-able guardrails** |
| Continuous post-deploy evaluation | None | DIY | None | **Built-in, score-based, vs. live traffic** |
| Primary user | Engineer | Engineer | Vendor PS | **Non-technical CU employee** |
| Knowledge integration | Re-upload everywhere | DIY | Limited | **Native connectors (Confluence, SharePoint, Salesforce Knowledge, etc.)** |
| Model integration | Vendor's choice only | Vendor's choice only | Vendor's choice only | **BYOM: customer's API keys (OpenAI / Anthropic / Azure OpenAI / Bedrock / Vertex) or custom endpoints; per-purpose routing; data residency controls** |
| Department-level organization | Flat namespace | Flat (workspaces are tenants) | Flat | **Projects inside the CU tenant — per-department SOPs, apps, reviewers, knowledge, models, cost envelopes, and KPIs (§9.20). Cross-project isolation enforced architecturally.** |
| Authentication | Ad-hoc | Vendor-managed | Vendor-managed | **Enterprise SSO (SAML 2.0 / OIDC) + mandatory MFA + step-up re-auth for sensitive actions + idle lock + cross-tab logout (§9.21)** |

Three differentiators competitors will struggle to copy:

1. **The AI Helper.** A persistent on-screen companion that explains every auto-generated decision with a citation back to the SOP, suggests edits in plain language, answers product questions at any time, and continues to assist post-deploy. Closes the AI-literacy gap that kills most enterprise AI deployments.
2. **The Evaluation Harness.** Score-based, three combined test sources (pre-built CU scenarios, SOP-derived tests, user-defined tests). Runs pre-deploy. Keeps running continuously post-deploy against sampled live traffic. Turns *"does it work?"* from an argument into a measurement.
3. **The Knowledge Library.** Every CU has knowledge scattered across Confluence, SharePoint, Salesforce Knowledge, intranets, and FAQ sites. We integrate via native connectors, honor source permissions, and surface citations in every response — we don't ask the CU to duplicate everything.
4. **Bring Your Own Model.** Credit unions plug in their own LLM accounts (OpenAI / Anthropic / Azure OpenAI / AWS Bedrock / Google Vertex API keys, or custom API endpoints for self-hosted models). Inference runs where the CU's compliance posture requires it — in their tenant, in their region, billed against their own provider contract. A major regulated-buyer objection most competitors don't address.
5. **Transparency Artifacts.** Every derived app exposes a read-only YAML **application spec** of its full configuration plus a "Pending changes since v{N}" diff before re-deploy. The **sandbox chat** at app and project scope shows the live **orchestration trace** — routing, tool calls, knowledge hits, guardrails fired, hand-offs, and token accounting. Compliance, audit, and internal architecture get one inspectable artifact per deployment record — turning AI from a black box into a reviewable build. Apps promote through **Base / Development / Staging / Production** environments; Production deploys require approval + step-up MFA, and external consumers reach apps via auditable SDK / Platform API keys.

---

## 5. Planning

The product is being built in four phases.

| Phase | Scope | Outcome |
|---|---|---|
| **Phase 0 — Foundations** | Runtime, sub-agent library, baseline guardrails, knowledge templates, tools catalog, evaluation infrastructure, identity, observability | Platform spine is live; nothing customer-facing yet |
| **Phase 1 — SOP-Driven Pilot** | SOP intake, Auto-Generation Engine, SOP Quality Check, Review Studio, AI Helper, Evaluation Harness (pre-deploy + initial continuous), Approval Workflow, Deployment, Sandbox, Knowledge Library, **one channel (digital), one pilot CU, one process domain** | First member-impacting deployment with one CU partner |
| **Phase 2 — Expansion** | Voice / text / email channels, library expansion, post-deployment Helper hardening, deeper continuous evaluation (drift, traffic sampling), additional CUs | Multi-channel, multi-CU |
| **Phase 3 — Marketplace + Advanced** | Curated Marketplace at scale, staged/canary rollouts, deeper Employee AI Assistant, partner-published items (deferred decision) | Network effects, advanced enterprise capabilities |

**Phase 1 plan:**

| Item | Detail |
|---|---|
| Budget | [TBD: $ for Phase 1, broken out by build / infra / GTM] |
| Team shape | [TBD: headcount across Eng, AI/ML, Design, Product, Compliance, GTM] |
| Timeline | [TBD: weeks/months to first deployed member-impacting app] |
| Pilot CU partner | [TBD: selected partner + commitment level] |
| Go-no-go gate | Successful deployment to the pilot CU + score on the Evaluation Harness above an agreed threshold + favorable Process Owner usability outcome |

---

## 6. Top 5 Risks

Drawn from the full risk register in BRD §16; chosen for executive relevance.

| # | Risk | Stakes | Mitigation |
|---|---|---|---|
| 1 | **Unsafe or non-compliant auto-generated app reaches a member** | Brand damage, regulatory enforcement, contractual breach with a CU | Non-disable-able baseline guardrails; mandatory compliance approval; SOP Quality Check with Blocker severity; sandbox; evaluation; kill switches; full audit |
| 2 | **Production performance drifts silently after deployment** | Trust erodes without anyone noticing until member complaints arrive | Continuous evaluation against live traffic; regressions flagged in Mission Control with severity tiers; configurable kill-switch thresholds; weekly Helper-summarized digests |
| 3 | **Process Owners can't get through the product without engineering help** | Adoption fails; investment burns; vertical wedge doesn't unlock | AI Helper as a first-class persistent companion; plain-language Review Studio; Process Owner usability testing as a gating criterion before each phase ships |
| 4 | **AI Helper itself gives wrong or misleading guidance at scale** | Helper amplifies errors; reviewer trust collapses | Helper subject to baseline guardrails; constrained scope (refuses out-of-scope questions); citations; measured against a question bank; user feedback loop; gap-log dashboard |
| 5 | **Inference cost overrun (apps + Helper + continuous evaluation)** | Unit economics break before scale | Per-tenant budgets and alerts; configurable eval cadence; sampling strategies; model routing; caching; cost envelope reviewed quarterly |

Other risks (vertical scope feels limiting, regulatory change mid-build, knowledge source credential breach, tool/data access escalation, library updates changing behavior silently) are documented in BRD §16.

---

## 7. Top 5 KPIs

| KPI | Why Leadership Cares |
|---|---|
| **Time from SOP upload to deployment (P50, P95)** | The core product promise. If this isn't dramatically below the DIY baseline, we don't have a wedge. |
| **Approval rate on first submission** | Measures how good Auto-Generation + SOP Quality Check + Helper are at producing reviewer-ready apps. Low rate = product still rough. |
| **Continuous evaluation score trend post-deployment** | The continuous-eval differentiator made concrete. Flat-or-down trend = we are shipping silent quality erosion. |
| **AI Helper "felt supported" survey + suggestion accept rate** | Tests whether the Helper actually closes the AI-literacy gap as promised. Predicts adoption. |
| **Apps deployed per CU per quarter** | The activation flywheel. Repeat deployment per CU is the leading indicator of ARR expansion and retention. |

Full metric tree (30+ KPIs across activation, Helper effectiveness, quality/safety, knowledge effectiveness, and business outcomes) lives in BRD §17.

---

## 8. Where We Are / What We Need

**Status today:** [TBD: short narrative — what's built, what's in design, what's the next milestone.]

**Decisions this exec briefing should resolve:**

1. **Phase 1 pilot CU partner** — selection criteria, commitment level, success definition.
2. **LLM provider(s)** for production use across apps, Helper, and Evaluation Harness — latency, cost, compliance, vendor concentration risk.
3. **Cost envelope** per member interaction at scale (apps + Helper + continuous eval).
4. **Marketplace openness** timeline — curated-only at launch; when (if at all) do we open to partner-published items?
5. **Helper escalation-to-human** staffing model — SLAs, coverage hours, ownership.

---

## Appendices

**A. Glossary (quick reference)**
- **Process Owner** — Primary user. Non-technical credit-union employee who owns a process and uploads SOPs.
- **SOP** — Standard Operating Procedure.
- **Auto-Generation Engine** — Turns an SOP into a working agentic app.
- **AI Helper** — Persistent on-screen companion; explains, suggests, acts on user confirmation.
- **SOP Quality Check** — Flags safety/compliance issues in the SOP itself.
- **Review Studio** — Plain-language UI for reviewing and editing the auto-generated app.
- **Evaluation Harness** — Score-based test suite; pre-deploy and continuous post-deploy.
- **Evaluation Report** — Plain-language, score-based summary of app quality.
- **Knowledge Library** — Credit union's tenant-scoped store of knowledge; supports uploads, connectors, web crawl, and authored entries.
- **Mission Control** — Runtime, observability, governance, audit, kill switches.
- **Agentic MX / EX** — Member-facing / employee-facing AI experiences.
- **Workspace** — The credit union tenant (the outermost scope of authority and data isolation).
- **Project** — A business-area grouping inside a workspace (Card Services, Member Onboarding, Lending, etc.). Scopes SOPs, Apps, Knowledge, reviewers, model overrides, tool bindings, cost envelopes, and KPIs. See §9.20.
- **Project Admin** — Per-project administrative role delegated by the CU Admin. Manages project settings (membership, reviewer pool, knowledge scope, model overrides, tool bindings, cost envelope). Cannot create or archive projects.
- **SSO** — Single Sign-On via the credit union's enterprise IdP (SAML 2.0 / OIDC). Primary authentication path.
- **MFA** — Mandatory second factor (TOTP / WebAuthn / passkey / IdP-asserted) for every workforce sign-in.
- **Step-up re-authentication** — Fresh MFA challenge required for sensitive actions (deploy, approve, baseline-guardrail edits, credential rotation, membership changes).

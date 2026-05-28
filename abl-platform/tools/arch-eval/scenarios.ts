/**
 * 20 complex-domain scenarios for arch-ai round-2 battle-test.
 *
 * Round 1 (10 scenarios) confirmed arch-ai handles standard use cases well.
 * Round 2 stresses it with:
 *   - Multi-step orchestration (pipeline + approval gates)
 *   - Regulatory constraints (HIPAA, PCI, KYC/AML, GDPR)
 *   - Multilingual + voice
 *   - Mixed reasoning/scripted/hybrid agent needs
 *   - Named tool integrations explicit in the spec
 *   - Cross-role handoffs (customer -> agent -> supervisor)
 *   - Long-running state and resumability
 *
 * Each scenario carries `expectedAgents` (rough count) and
 * `expectedToolHints` (tool names that should appear). The arch-vs-me
 * comparison reads these alongside the architect's topology/agents/ABL.
 */

export interface Scenario {
  id: string;
  domain: string;
  projectName: string;
  seedMessage: string;
  channels: string[];
  language: string;
  capabilities: string;
  complexity: 'small' | 'medium' | 'large';
  expectedAgents: number;
  expectedToolHints?: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 's11-insurance-claims',
    domain: 'Insurance — Claims Processing',
    projectName: 'ClaimFlow Round2',
    seedMessage:
      'Insurance claims processing assistant for auto + property. Customer files a claim via web or phone; system collects policy + incident details + photos, runs fraud risk scoring, routes to adjuster, tracks status, handles supplemental document requests, and notifies on payout. Channels: Web Chat, Voice, Email. Compliance: PII / audit log / SOC2.',
    channels: ['Web Chat', 'Voice', 'Email'],
    language: 'English',
    capabilities:
      'Claim intake with structured policy/incident/loss-amount capture; photo and document upload; fraud risk score via FraudCheck API; adjuster assignment with workload balancing; status tracking and ETA; supplemental document chase; payout notification with deposit method confirmation; escalation to supervisor for >$50k or fraud-flagged claims.',
    complexity: 'large',
    expectedAgents: 6,
    expectedToolHints: [
      'create_claim',
      'lookup_policy',
      'upload_evidence',
      'fraud_score',
      'assign_adjuster',
      'claim_status',
      'request_documents',
      'send_payout_notification',
    ],
  },
  {
    id: 's12-telco-billing-dispute',
    domain: 'Telco — Billing Dispute IVR',
    projectName: 'CarrierCare Round2',
    seedMessage:
      'Voice-first billing dispute resolution for a US wireless carrier. Authenticates caller with last4-SSN + zip, pulls billing history, classifies dispute type (overage / equipment fee / international roaming / promotional credit), applies pre-authorized credit rules, files formal dispute when needed, schedules supervisor callback for >$200 disputes. Channel: Voice. English + Spanish. PCI sensitive — never read full card number aloud.',
    channels: ['Voice'],
    language: 'English',
    capabilities:
      'Caller auth via last4-SSN + zip + zone match; billing history retrieval (last 6 cycles); dispute classification + per-class credit policy; auto-credit up to $50 / per-cycle limit; formal dispute filing for higher amounts; supervisor callback scheduling with SLA; language switch English<->Spanish on detection; mask account/card numbers in TTS output.',
    complexity: 'large',
    expectedAgents: 5,
    expectedToolHints: [
      'authenticate_caller',
      'get_billing_history',
      'classify_dispute',
      'apply_credit',
      'file_dispute',
      'schedule_callback',
    ],
  },
  {
    id: 's13-multimodal-medical-triage',
    domain: 'Healthcare — Multimodal Symptom Triage',
    projectName: 'CareTriage Round2',
    seedMessage:
      'Multimodal pre-visit triage for an urgent-care network. Accepts text symptoms, voice description, and photo of visible injury/rash. Triages to: self-care / book appointment / urgent care / 911. Books with calendar API when appropriate. HIPAA-compliant. English + Spanish + Mandarin Chinese. Never diagnose; cite the triage protocol used.',
    channels: ['Web Chat', 'Voice'],
    language: 'English',
    capabilities:
      'Structured symptom intake (onset, severity 1-10, location, duration, associated symptoms); image upload + visual triage hints (no diagnosis, only "consult clinician"); language switching; appointment booking via calendar.create; nurse-line handoff for ambiguous urgent; 911 prompt for chest pain/stroke red-flags; structured PHI capture with explicit consent; cite which protocol version was used.',
    complexity: 'large',
    expectedAgents: 5,
    expectedToolHints: [
      'capture_symptoms',
      'upload_image',
      'classify_urgency',
      'book_appointment',
      'connect_nurse_line',
    ],
  },
  {
    id: 's14-b2b-saas-onboarding',
    domain: 'B2B SaaS — Multi-Tenant Onboarding',
    projectName: 'TenantLaunch Round2',
    seedMessage:
      'B2B SaaS onboarding for a developer-tools product. New paying tenant fills profile, sets up SSO (Okta / Google Workspace / Azure AD), connects integrations (Slack + Jira + GitHub), invites teammates, sets per-environment defaults, runs a "first project" tutorial, schedules a customer-success kickoff. Channel: Web Chat. Persists across multi-day sessions.',
    channels: ['Web Chat'],
    language: 'English',
    capabilities:
      'Stepwise tenant profile capture (company / size / use case / tier); SSO IdP selection with deep-link to admin console; integration setup with OAuth handoff to Slack/Jira/GitHub; teammate-invite flow with role assignment; environment defaults (dev/staging/prod); guided tutorial with skip-and-resume; CS kickoff scheduling via Calendly; resume-anywhere state machine across days.',
    complexity: 'large',
    expectedAgents: 6,
    expectedToolHints: [
      'create_tenant',
      'configure_sso',
      'connect_integration',
      'invite_teammate',
      'set_env_defaults',
      'schedule_kickoff',
    ],
  },
  {
    id: 's15-travel-itinerary',
    domain: 'Travel — Full Itinerary Booking',
    projectName: 'JourneyBuilder Round2',
    seedMessage:
      'Full-itinerary travel booking assistant: flights, hotels, car rental, activities. Handles group bookings (up to 9 travelers), fare-class rules, hotel cancellation policies, activity availability windows, and bundle pricing. Issues confirmations and stores PNR/PNR-like locators. Channel: Web Chat + Email. English + Spanish + French.',
    channels: ['Web Chat', 'Email'],
    language: 'English',
    capabilities:
      'Flight search with multi-city + fare-class filtering; hotel search by city/dates/rating/refundable; car rental with insurance options; activity discovery by destination/date/group-size; bundled pricing with breakdown; group-traveler form for up to 9 with per-traveler preference; cancellation and change rules per leg; PNR + booking confirmations stored.',
    complexity: 'large',
    expectedAgents: 7,
    expectedToolHints: [
      'search_flights',
      'search_hotels',
      'rent_car',
      'find_activities',
      'price_bundle',
      'book_itinerary',
      'send_confirmation',
    ],
  },
  {
    id: 's16-fin-advisor-compliance',
    domain: 'FinServ — Compliance-Grade Financial Advisor',
    projectName: 'AdvisorCompliant Round2',
    seedMessage:
      'Financial advisor assistant with strict compliance posture. Performs KYC (govt ID + address verification), AML risk screening, suitability assessment (income/net worth/risk-tolerance/horizon), then provides only generic-education on investments — never product-specific recommendations. Routes to licensed advisor for actionable advice. Every advice turn logged to immutable audit trail.',
    channels: ['Web Chat'],
    language: 'English',
    capabilities:
      'KYC intake (gov ID upload + address verification + SSN last4); AML sanctions screen via SanctionCheck API; suitability questionnaire (10-item scored); generic-education on investment categories (no specific tickers / funds); strict "consult a licensed advisor" for product picks; complete audit log of each turn (input, classified intent, output, citations) to immutable WORM store.',
    complexity: 'large',
    expectedAgents: 5,
    expectedToolHints: [
      'verify_identity',
      'aml_screen',
      'suitability_assess',
      'fetch_education_content',
      'write_audit_log',
      'transfer_to_advisor',
    ],
  },
  {
    id: 's17-legal-contract-review',
    domain: 'Legal — Contract Review Pipeline',
    projectName: 'ClauseGuard Round2',
    seedMessage:
      'Contract review assistant for in-house legal. Accepts PDF/DOCX of a contract, extracts clauses by type (term, payment, IP, indemnity, termination, governing law), flags risky clauses (auto-renew, unilateral amendment, broad indemnity), proposes redlines, escalates to senior counsel for novel issues. Pipeline pattern.',
    channels: ['Web Chat'],
    language: 'English',
    capabilities:
      'Document upload + parse (PDF/DOCX); clause extraction with type classification; risk scoring per clause (low/medium/high) with rationale; proposed redline with track-changes diff; comparison to playbook standards; senior-counsel escalation for novel/high-risk clauses; export of marked-up document.',
    complexity: 'large',
    expectedAgents: 5,
    expectedToolHints: [
      'parse_contract',
      'extract_clauses',
      'score_clause_risk',
      'propose_redline',
      'compare_to_playbook',
      'export_markup',
    ],
  },
  {
    id: 's18-edtech-tutor',
    domain: 'EdTech — Adaptive Tutoring',
    projectName: 'TutorAdapt Round2',
    seedMessage:
      'Adaptive tutoring assistant for K-12 math. Student profile (grade, strengths, gaps), diagnostic test, generates per-session learning plan, runs problem-solving with hints, tracks mastery, escalates difficulty. Multilingual (English / Spanish). Parental-consent gate for under-13. Coppa/FERPA compliant.',
    channels: ['Web Chat'],
    language: 'English',
    capabilities:
      'Student profile setup (grade, topic strengths/gaps) with parental consent for U13; diagnostic test (15-20 items); learning-plan generation; adaptive problem delivery with stepped hints; mastery tracking (Bayesian or simple counter); difficulty escalation on >=3 correct in a row; parent dashboard digest; switch English<->Spanish on detection.',
    complexity: 'medium',
    expectedAgents: 5,
    expectedToolHints: [
      'create_student_profile',
      'run_diagnostic',
      'generate_lesson_plan',
      'deliver_problem',
      'update_mastery',
      'send_parent_digest',
    ],
  },
  {
    id: 's19-field-service-dispatch',
    domain: 'Field Service — Work Order Dispatch',
    projectName: 'DispatchOps Round2',
    seedMessage:
      'Field service dispatcher for a home-services company (HVAC + plumbing). Customer reports issue, system classifies urgency, locates technician with the right skill + parts inventory within radius, schedules window, sends ETA SMS, handles reschedules. Channel: Web Chat + SMS. SLA: <2hr for emergencies, <24hr standard.',
    channels: ['Web Chat', 'SMS'],
    language: 'English',
    capabilities:
      'Issue classification (HVAC / plumbing / electrical / appliance) with urgency tag (emergency / urgent / standard / scheduled); technician availability + skill match within service radius; parts-inventory pre-check; window booking; SMS ETA confirmation + en-route notification; reschedule with auto-reassignment; SLA breach alert routing to operations supervisor.',
    complexity: 'medium',
    expectedAgents: 5,
    expectedToolHints: [
      'classify_issue',
      'find_technician',
      'check_parts',
      'book_window',
      'send_eta_sms',
      'reschedule',
      'alert_supervisor',
    ],
  },
  {
    id: 's20-mortgage-origination',
    domain: 'Lending — Mortgage Origination',
    projectName: 'LoanForward Round2',
    seedMessage:
      'Mortgage origination workflow assistant. Applicant intake (personal + employment + income + assets), credit pull authorization, document collection (W2/paystubs/bank statements), pre-approval letter generation, underwriting handoff. Strict TILA/RESPA disclosure timing. PII + audit logs.',
    channels: ['Web Chat'],
    language: 'English',
    capabilities:
      'Applicant intake with structured personal/employment/income/assets capture; credit pull authorization with hard-pull disclosure; document chase (W2, paystubs last 2, bank statements last 2 months) with secure upload; pre-approval letter generation; underwriting hand-off package; TILA/RESPA disclosure timing enforcement; complete audit log per applicant.',
    complexity: 'large',
    expectedAgents: 6,
    expectedToolHints: [
      'create_application',
      'pull_credit',
      'request_documents',
      'verify_income',
      'generate_preapproval',
      'handoff_to_underwriting',
    ],
  },
  {
    id: 's21-returns-fraud-ecomm',
    domain: 'E-commerce — Returns + Fraud Detection',
    projectName: 'ReturnsGuard Round2',
    seedMessage:
      'E-commerce returns assistant with fraud-detection. Customer initiates return, system classifies reason (damaged / wrong-item / didnt-fit / changed-mind), scores fraud risk by order/return history pattern, applies refund or restocking-fee policy, generates RMA + return label. Sends to manual review when fraud score > 0.7.',
    channels: ['Web Chat', 'Email'],
    language: 'English',
    capabilities:
      'Return reason classification (5 buckets); fraud risk scoring using order/return ratio + value + customer tenure + IP geolocation; per-reason refund vs store-credit policy; restocking fee for ChangedMind > $50; RMA + return label generation; manual review queue for fraud-flagged returns; customer notification with timeline.',
    complexity: 'medium',
    expectedAgents: 5,
    expectedToolHints: [
      'classify_return_reason',
      'score_fraud',
      'apply_refund_policy',
      'generate_rma',
      'send_label',
      'queue_manual_review',
    ],
  },
  {
    id: 's22-prior-authorization',
    domain: 'Healthcare — Drug Prior Authorization',
    projectName: 'PriorAuthFlow Round2',
    seedMessage:
      'Drug prior authorization for a PBM. Prescriber submits drug request, system checks plan formulary, validates clinical criteria (step therapy / quantity limit / age), gathers supporting clinical info, decides approve / deny / require peer-to-peer review. HIPAA. Audit trail.',
    channels: ['Web Chat', 'API'],
    language: 'English',
    capabilities:
      'Submitter intake (prescriber NPI, member ID, drug NDC, diagnosis ICD-10); formulary lookup with tier + utilization-mgmt rules; clinical-criteria check (step therapy / quantity limits / age); clinical-info gathering (chart notes, prior trials); auto-approve trivial cases; deny with rationale + appeal info; peer-to-peer scheduling for complex cases; HIPAA audit log.',
    complexity: 'large',
    expectedAgents: 5,
    expectedToolHints: [
      'lookup_formulary',
      'check_clinical_criteria',
      'gather_clinical_info',
      'decision_engine',
      'schedule_p2p',
      'audit_log',
    ],
  },
  {
    id: 's23-gov-benefits-intake',
    domain: 'Government — Benefits Intake',
    projectName: 'BenefitsAccess Round2',
    seedMessage:
      'Government benefits eligibility intake (SNAP / Medicaid analog). Multilingual (English + Spanish + Vietnamese + Mandarin), accessibility-first (plain language, screen-reader friendly), document upload for proofs, eligibility scoring against program rules, application submission to caseworker queue. Audit + privacy-preserving.',
    channels: ['Web Chat', 'Voice'],
    language: 'English',
    capabilities:
      'Multilingual intake (4 languages with on-the-fly switch); plain-language form (8th-grade reading level); household composition + income capture; document upload (ID, paystubs, lease/mortgage); program eligibility scoring per rule set; submission to caseworker queue with priority tag; status check on later returns; ADA-conformant prompts; privacy-preserving (minimal-PII default, opt-in expansion).',
    complexity: 'large',
    expectedAgents: 5,
    expectedToolHints: [
      'detect_language',
      'capture_household',
      'capture_income',
      'upload_proofs',
      'score_eligibility',
      'submit_application',
    ],
  },
  {
    id: 's24-cybersec-incident',
    domain: 'Cybersecurity — Incident Response',
    projectName: 'IncidentCommander Round2',
    seedMessage:
      'SOC incident response assistant. Receives alert from SIEM, classifies severity (P1-P4), correlates with recent alerts, suggests runbook, executes containment steps when authorized, routes to on-call analyst, manages status communications, prompts for post-mortem inputs.',
    channels: ['Slack', 'API'],
    language: 'English',
    capabilities:
      'Alert ingestion + parsing; severity classification with correlation across last 24h; runbook suggestion from playbook library; containment-step execution with explicit confirmation (isolate host / disable account); on-call analyst routing via PagerDuty; stakeholder status updates on private channel; post-mortem template generation with timeline.',
    complexity: 'large',
    expectedAgents: 6,
    expectedToolHints: [
      'parse_alert',
      'classify_severity',
      'correlate_alerts',
      'suggest_runbook',
      'execute_containment',
      'page_on_call',
      'post_status_update',
      'generate_postmortem',
    ],
  },
  {
    id: 's25-realestate-closer',
    domain: 'Real Estate — Transaction Closing',
    projectName: 'CloseTrack Round2',
    seedMessage:
      'Real-estate transaction-closing coordinator. Tracks contract milestones (offer accepted, contingencies, financing, inspection, appraisal, walkthrough, closing), chases parties for missing docs, schedules settlement, sends closing-day prompts, exports HUD-1/CD record.',
    channels: ['Web Chat', 'Email'],
    language: 'English',
    capabilities:
      'Transaction-state machine tracking all closing milestones; party roster (buyer/seller/agent/lender/inspector/title); doc-chase via Email with reminders; appointment scheduling for inspection/appraisal/walkthrough; closing-day checklist with party-by-party prompts; contingency-deadline alerts; HUD-1/CD export.',
    complexity: 'medium',
    expectedAgents: 5,
    expectedToolHints: [
      'update_milestone',
      'request_document',
      'schedule_appointment',
      'send_reminder',
      'generate_hud_record',
    ],
  },
  {
    id: 's26-hr-review-cycle',
    domain: 'HR — Performance Review Cycle',
    projectName: 'ReviewOps Round2',
    seedMessage:
      'HR performance review cycle assistant. Drives multi-rater (self + manager + peer + skip-level) feedback collection, calibration session prep, comp-recommendation computation, individual review delivery. Three roles: employee, manager, HRBP. Sensitive PII.',
    channels: ['Web Chat', 'Slack'],
    language: 'English',
    capabilities:
      'Cycle-cohort enrollment; multi-rater scheduling + reminder; rater-specific question sets (self / manager / peer / skip-level); response aggregation; calibration session pack (rating-distribution + outliers); comp-rec computation per band/perf-tier; final review delivery + ack capture; HRBP escalation for outlier perf-rec.',
    complexity: 'large',
    expectedAgents: 6,
    expectedToolHints: [
      'enroll_cohort',
      'send_review_request',
      'collect_responses',
      'aggregate_ratings',
      'compute_comp_rec',
      'generate_review',
      'escalate_to_hrbp',
    ],
  },
  {
    id: 's27-devops-incident',
    domain: 'DevOps — Incident Commander',
    projectName: 'OnCallOps Round2',
    seedMessage:
      'DevOps incident commander. Alert in -> severity classify -> page on-call -> open status page -> coordinate Zoom -> capture timeline -> post-mortem prompt. Used by 50-engineer team with PagerDuty + Statuspage.io + Slack. Sev1 wakes humans; Sev3/4 routed to async.',
    channels: ['Slack', 'API'],
    language: 'English',
    capabilities:
      'Alert webhook intake; severity classification (Sev1-4) using error-budget + customer-impact heuristics; PagerDuty escalation per sev tier; Statuspage update creation/edit/resolve; Slack incident channel creation + Zoom bridge linking; timeline-event capture from updates in channel; auto-generate post-mortem skeleton at resolution.',
    complexity: 'medium',
    expectedAgents: 5,
    expectedToolHints: [
      'classify_sev',
      'page_on_call',
      'open_statuspage',
      'create_incident_channel',
      'log_timeline_event',
      'generate_postmortem',
    ],
  },
  {
    id: 's28-multilingual-support-hub',
    domain: 'Multilingual — Global Support Hub',
    projectName: 'GlobalCare Round2',
    seedMessage:
      'Multilingual customer support hub spanning English, Spanish, Brazilian Portuguese, Arabic, Mandarin. Auto-detects user language, routes to regional team within business hours, queues for human agent off-hours, translates ticket history for non-language-matching agents. Sentiment-aware escalation.',
    channels: ['Web Chat', 'WhatsApp'],
    language: 'English',
    capabilities:
      'Language auto-detect from first message; regional-team routing by language + region time-zone; off-hours queue with callback time selection; ticket-history translation for agents in different language; sentiment classification + escalation if angry/frustrated >=2 turns; cross-language summary for handoffs.',
    complexity: 'medium',
    expectedAgents: 5,
    expectedToolHints: [
      'detect_language',
      'route_to_region',
      'queue_for_callback',
      'translate_history',
      'classify_sentiment',
      'escalate_to_human',
    ],
  },
  {
    id: 's29-recipe-meal-plan',
    domain: 'Lifestyle — Recipe + Meal Planning',
    projectName: 'MealMate Round2',
    seedMessage:
      'Adaptive recipe + meal-planning assistant. Captures dietary restrictions (vegan/gluten-free/etc), allergens, household size, budget, meal frequency. Builds weekly plan with grocery list, tracks nutrition macros, swaps recipes on dislike. Channel: Web Chat + iOS API.',
    channels: ['Web Chat', 'API'],
    language: 'English',
    capabilities:
      'Profile setup (diet, allergens, dislikes, household size, weekly budget, meal count); weekly plan generation with macro targets; grocery list with quantity aggregation; recipe swap on dislike with similarity-preserve; nutrition macro tracking per day; cuisine variety constraint; budget cap enforcement with substitution suggestions.',
    complexity: 'medium',
    expectedAgents: 4,
    expectedToolHints: [
      'capture_profile',
      'generate_meal_plan',
      'build_grocery_list',
      'swap_recipe',
      'track_nutrition',
    ],
  },
  {
    id: 's30-crypto-aml',
    domain: 'FinServ — Crypto AML Monitoring',
    projectName: 'ChainGuard Round2',
    seedMessage:
      'Crypto AML transaction monitoring + SAR filing. Ingests transaction stream from custodial wallets, scores suspicious patterns (structuring, mixer use, sanctioned addresses), opens case for analyst review, drafts Suspicious Activity Report (SAR), tracks regulator deadlines (30/60 days). Strict audit trail.',
    channels: ['API', 'Web Chat'],
    language: 'English',
    capabilities:
      'Tx-stream ingestion with normalization; pattern detection (structuring, mixer/tumbler usage, sanctioned-address hit via OFAC list, high-velocity); case open with risk tier + evidence bundle; analyst review queue; SAR draft generation per FinCEN template; deadline tracking with reminders; immutable audit trail of every decision; cross-case correlation (same wallet across multiple alerts).',
    complexity: 'large',
    expectedAgents: 6,
    expectedToolHints: [
      'ingest_transactions',
      'detect_pattern',
      'check_sanctions',
      'open_case',
      'queue_for_analyst',
      'draft_sar',
      'track_deadline',
      'correlate_cases',
    ],
  },
];

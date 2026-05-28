/**
 * Content-based specialist router for IN_PROJECT mode.
 *
 * Routes user messages to the appropriate specialist based on keyword matching.
 * First match wins; falls back to 'abl-construct-expert'.
 */

import type { AnySpecialistId } from '../types/constants.js';

interface RouteRule {
  patterns: RegExp[];
  specialist: AnySpecialistId;
}

/**
 * RoutingDecision — outcome of `routeByContent`.
 *
 * Carries the resolved specialist plus the matched-pattern source string so
 * the engine can emit a `routing_decision` trace span event at turn-start.
 *
 *   - `specialist`: the chosen specialist (default fallthrough fills a sentinel).
 *   - `matchedPattern`: `pattern.source` of the regex that fired, or `null` on
 *     default fallthrough (no rule matched and we fell back).
 *   - `pageContextBias`: optional bias resolved at a higher layer
 *     (coordinator-bridge.getPageContextSpecialistBias). Routing itself never
 *     populates this — left undefined here, filled at the bridge layer for
 *     trace fidelity. Kept on the type so the four-layer plumbing is uniform.
 */
export interface RoutingDecision {
  specialist: AnySpecialistId;
  matchedPattern: string | null;
  pageContextBias?: AnySpecialistId | null;
}

const ROUTE_RULES: RouteRule[] = [
  // ── Session/trace runtime analysis ───────────────────────────────────
  // These natural requests need session_ops/trace_diagnosis/query_traces.
  // Keep this before observer/construct routing so "check my last session"
  // and "compare today vs yesterday sessions" do not fall through to the
  // default construct expert.
  {
    patterns: [
      /\b(?:last|latest|most\s+recent|recent|today'?s?|yesterday'?s?|this\s+(?:week|month)|last\s+(?:week|month)|past\s+\d+|last\s+\d+|\d+\s+days?\s+ago)\s+(?:session|sessions|trace|traces|run|runs)\b/i,
      /\b(?:session|sessions|trace|traces|run|runs)\s+(?:from|for|in|over|during|since)\s+(?:today|yesterday|this\s+(?:week|month)|last\s+(?:week|month)|past\s+\d+|last\s+\d+|\d+\s+days?)/i,
      /\b(?:check|show|find|inspect|open|review)\b.*\b(?:session|sessions|trace|traces|run|runs)\b/i,
      /\bcompare\b.*\b(?:today|yesterday|this\s+week|last\s+week|this\s+month|last\s+month|sessions?|traces?|runs?)\b/i,
      /\b(?:prod|production|staging|stage|dev|development)\b.*\b(?:session|sessions|trace|traces|health|errors?|failures?)\b/i,
    ],
    specialist: 'diagnostician',
  },
  // ── Observer (B59/B60) — production-change patterns ──────────────────
  // MUST appear before diagnostician: catches "why did [metric] drop/change"
  // before the diagnostician's broad "why did" pattern swallows it.
  // Only matches production-intelligence questions (metric changes, briefings,
  // knowledge gaps, improvement loop). General "why is X broken" still goes
  // to diagnostician below.
  {
    patterns: [
      /\bwhy\s+did\s+.*\b(drop|increase|change|spike|decline|fall|rise|grow|shrink)/i,
      /\bbriefing\b/i,
      /\bweekly\s+(report|summary|review)/i,
      /\bwhat\s+changed/i,
      /\bwhat\s+improved/i,
      /\bwhat\s+regressed/i,
      /\bknowledge\s+gap/i,
      /\bunanswered\s+question/i,
      /\bproduction\s+(issue|behavior|pattern)/i,
      /\babandonment\b/i,
      /\bresolution\s+(drop|rate|decline)/i,
      /\broot\s+cause\b.*\b(metric|resolution|escalation|abandonment|drop|spike)/i,
      /\bimpact\s+(of|analysis)/i,
      /\bbefore.and.after/i,
      /\bimprovement\s+loop/i,
    ],
    specialist: 'observer',
  },
  // ── ABL Construct Expert (authoring asks that mention failures/routing) ──
  // MUST appear before diagnostician and multi-agent-architect: these are
  // modification asks that happen to mention "error", "backoff", or "routing".
  {
    patterns: [
      /\b(add|configure|set\s+up)\b.*\berror\s+handling\b/i,
      /\b(add|configure|set\s+up)\b.*\b(exponential\s+backoff|retry\s+backoff|retry\s+logic)\b/i,
      /\bescalation\s+routing\b/i,
      /\bconfigure\s+escalation\b/i,
      /\b(add|configure|set\s+up)\b.*\b(destination|zendesk|human\s+(handoff|transfer)|routing\s+queue)\b/i,
    ],
    specialist: 'abl-construct-expert',
  },
  // ── Entity Collection Expert ─────────────────────────────────────────
  // MUST appear before diagnostician: "lookup table validation" contains
  // "validat" which the diagnostician would catch. Entity-collection patterns
  // are specific (require "gather" or gather-related keywords).
  {
    patterns: [
      /\bgather\b.*\b(field|validation|lookup|activation|depends|extraction|progressive)/i,
      /\blookup\s+table/i,
      /\blookup\b.*\bvalidation/i,
      /\bdepends.on\b/i,
      /\bprogressive\s+(field|activation)/i,
      /\bextraction\s+(hint|pattern|confidence)/i,
      /\binfer\b.*\bconfidence/i,
      /\bagent.level\b.*\bgather/i,
      /\bflow.step\b.*\bgather/i,
      /\binfer\b.*\bconfirm\b/i,
      /\bcorrection\b.*\bgather/i,
      /\brequired\b.*\boptional\b.*\bfield/i,
      /\bsensitive\s+field/i,
      /\bmask.config\b/i,
      /\benum.values?\b/i,
      /\bfuzzy.match/i,
    ],
    specialist: 'entity-collection',
  },
  // ── Diagnostician (highest priority for diagnostic/debugging intent) ──
  // Catches static validation, debugging, trace analysis, and general
  // "what's wrong" questions. Does NOT catch production metric changes
  // (those go to observer above).
  {
    patterns: [
      /\bhealth/i,
      /\bstatus/i,
      /\breview\s+(my\s+)?(agents?|project)/i,
      /\boverview/i,
      /\bvalidat/i,
      /\bdiagnos/i,
      /\bwhat.s\s+wrong/i,
      /\bwhat.s\s+(the\s+)?(issue|problem)/i,
      /\bcheck\s+(for\s+)?(issues?|errors?|warnings?|problems?)/i,
      /\btrace/i,
      /\bdebug/i,
      /\bwhy\s+(is|did|does|was|isn.t|doesn.t|won.t|can.t)/i,
      /\bhow\s+did\s+(the|my)/i,
      /\bwhen\s+did/i,
      /\bobservability\b/i,
      /\banalyze\s+(trace|session|error|issue|log)/i,
      /\bnot\s+(return|work|respond|handoff|hand off|complet|trigger)/i,
      /\b(broken|failing|stuck|error|issue)\b/i,
      /\bhandoff.*(issue|problem|fail|broken|not|wrong)/i,
      /\b(issue|problem|fail|broken|not|wrong).*handoff/i,
    ],
    specialist: 'diagnostician',
  },
  // ── Performance Analyst ───────────────────────────────────────────────
  // Must appear AFTER observer. Handles current-state metrics, not changes.
  // NOTE: /\btoxic/i removed — "toxicity guardrail" should go to construct expert.
  {
    patterns: [
      /\bperformance\b/i,
      /\bquality\s*(score|eval)/i,
      /\binsight/i,
      /\bsentiment/i,
      /\bescalation\s*(rate|issue)/i,
      /\bhow\s+(is|are)\s+(my|the)\s+(agent|bot)/i,
      /\boptimize/i,
      /\bmetrics?\b/i,
      /\banalytics/i,
      /\boutcome/i,
      /\bfrustrat/i,
      /\banalyze\b/i,
    ],
    specialist: 'analyst',
  },
  // ── Integration Methodologist ─────────────────────────────────────────
  // All tool types, auth, and API integration asks.
  {
    patterns: [
      // External / remote agent (A2A) intent — Spec 1 Phase 4.1.
      // Placed at top so they win over generic SaaS / setup matches.
      /\b(external|remote|partner|third.party)\s+agent\b/i,
      /\bconnect\s+(to|with)\s+(?:our|my|the|their)?\s*\w+\s+agent\b/i,
      /\ba2a\s+(handoff|integration|connection|endpoint)\b/i,
      /\bregister\s+(?:an?|the)\s+(external|remote)\s+agent\b/i,
      /\bagent[- ]card\b/i,
      /\btest\s+(my\s+)?tool/i,
      /\bconfigure\s+(endpoint|tool)/i,
      /\bimport\s+openapi/i,
      /\bapi\s+(integration|endpoint|setup)/i,
      /\bwebhook\s+(setup|config)/i,
      /\btool\s+(endpoint|url|config)/i,
      /\bset\s+up\s+(the\s+)?tool/i,
      /\bconnect\s+(the\s+)?api/i,
      /\bsearchai\b/i,
      /\bsearch.ai\b/i,
      /\bknowledge\s+base\s+tool/i,
      /\bconnector\s+tool/i,
      /\bsalesforce\b/i,
      /\bworkflow\s+tool/i,
      /\basync.webhook/i,
      /\bjit.auth/i,
      /\boauth/i,
      /\bauth\s+profiles?\b/i,
      /\bauth\.profile\b/i,
      /\boauth\s+connections?\b/i,
      /\bconsent.mode/i,
      /\bidentity.tier/i,
      /\bconnection.mode/i,
      /\bauth.profile/i,
      /\bproject\s+connections?\b/i,
      /\bmcp(\s+server(s)?|\s+server\s+config(s)?)?\b/i,
      /\bconfig\s+variables?\b/i,
      /\bpii\s+patterns?\b/i,
      /\bcircuit.breaker/i,
      /\brate.limit/i,
      /\bcontext.access/i,
      // SaaS providers — naming a provider is a strong integration signal.
      /\b(slack|zendesk|notion|jira|stripe|hubspot|gmail|google\s+workspace|github|gitlab|salesforce|outlook|teams|discord|asana|linear|airtable|shopify|sendgrid|twilio|servicenow)\b/i,
      // Integration verbs — "hook up", "connect my/the/to", "integrate with", "wire up".
      /\b(hook\s+up|connect\s+(my|the|to)|integrate\s+with|wire\s+up)\b/i,
      // Generic integration setup — "set up integration", "setup my new integration".
      /\b(set\s+up|setup)\s+(?:my\s+)?(?:new\s+)?integration\b/i,
      // Auth-profile credential types — api key, bearer token, oauth app.
      /\b(api\s+key|bearer\s+token|oauth\s+app)\b/i,
    ],
    specialist: 'integration-methodologist',
  },
  // ── Channel & Voice Expert ────────────────────────────────────────────
  {
    patterns: [
      /\bconfigure\s+(voice|channel)\b/i,
      /\bvoice\s+(agent|channel|prompt|bot|call)\b/i,
      /\b(barge.in|dtmf|tts|stt)\b/i,
      /\b(whatsapp|sms|mms)\b/i,
      /\bweb\s*chat\b/i,
      /\bquick\s+repl(?:y|ies)\b/i,
      /\btemplate\s+message\b/i,
      /\binteractive\s+element/i,
    ],
    specialist: 'channel-voice',
  },
  // ── Multi-Agent Architect ─────────────────────────────────────────────
  // Topology, routing, delegation, fan-out — anything about agent relationships.
  {
    patterns: [
      /\badd\s+(a\s+)?new?\s+agent/i,
      /\bnew\s+agent/i,
      /\bremove\s+agent/i,
      /\bredesign/i,
      /\btopology/i,
      /\b(change|modify)\s+(the\s+)?topology/i,
      /\brouting\b/i,
      /\bintent\s+classif/i,
      /\bfan.out\b/i,
      /\bmulti.intent/i,
      /\bdelegate\b/i,
      /\bsub.agent/i,
      /\bhandoff\s+(to|from|rule|config)/i,
      /\bsingle\s+agent\b.*\bsupervisor/i,
      /\bsupervisor\b.*\bspecialist/i,
      /\bthin\s+entry\s+point\b/i,
      /\bentry\s+point\b/i,
      /\bhub.and.spoke\b/i,
      /\bsplit\b.*\binto\b.*\bagents?\b/i,
      /\bmulti.supervisor/i,
      /\bhierarchical\s+(delegat|rout)/i,
      /\bparent\s+supervisor/i,
      /\bchild\s+supervisor/i,
      /\bcontext\s+propagat/i,
      /\bON_RETURN_MAP\b/i,
      /\bcross.agent\b/i,
      /\bhandoff\s+contract\b/i,
      /\bworkflow(s)?\b/i,
      /\bapproval(s)?\b/i,
      /\bhuman[-\s]?tasks?\b/i,
      /\bagent[-\s]?transfer\b/i,
      /\bomnichannel\b/i,
    ],
    specialist: 'multi-agent-architect',
  },
  // ── Testing & Eval ────────────────────────────────────────────────────
  {
    patterns: [/\btest\b/i, /\brun\s+test/i, /\beval/i, /\bscenario/i],
    specialist: 'testing-eval',
  },
  // ── Project Configuration ────────────────────────────────────────────
  // Explicit patterns for project config queries. Routes to abl-construct-expert
  // deterministically rather than relying on the default fallback.
  {
    patterns: [
      /\b(rename|change\s+name|update\s+name)\b.*\bproject\b/i,
      /\bproject\s+(name|description|settings|config)\b/i,
      /\b(entry|main)\s+agent\b/i,
      /\b(message\s+)?retention\b/i,
      /\bthinking\s+(budget|mode|settings)\b/i,
      /\b(enable|disable)\s+thinking\b/i,
      /\b(change|set|update)\s+(the\s+)?(project\s+)?language\b/i,
    ],
    specialist: 'abl-construct-expert',
  },
  // ── ABL Construct Expert (agent modification + read) ──────────────────
  {
    patterns: [
      /\bmodify\s+agent/i,
      /\bchange\s+(the\s+)?persona/i,
      /\badd\s+(a\s+)?tool/i,
      /\bremove\s+(a\s+)?tool/i,
      /\bupdate\s+agent/i,
      /\bedit\s+agent/i,
      /\bimprove\s+(my|the)\s+agent/i,
    ],
    specialist: 'abl-construct-expert',
  },
  {
    patterns: [/\bshow\s+agent/i, /\bread\s+agent/i, /\bagent\s+code/i, /\bview\s+code/i],
    specialist: 'abl-construct-expert',
  },
];

/**
 * Route a user message to the appropriate specialist.
 *
 * Returns a structured `RoutingDecision` carrying both the resolved specialist
 * and the matched regex `pattern.source` so the engine can emit a
 * `routing_decision` trace span event with cause-of-routing visible to the
 * observability surface. On default fallthrough (no rule matched and the
 * diagnostic fallback also missed), `matchedPattern` is `null`.
 */
export function routeByContent(userMessage: string): RoutingDecision {
  for (const rule of ROUTE_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(userMessage)) {
        return { specialist: rule.specialist, matchedPattern: pattern.source };
      }
    }
  }

  // General diagnostic fallback — catch common help-seeking patterns.
  // We still capture the regex source so traces explain why the turn went to
  // diagnostician vs the abl-construct-expert default.
  const diagnosticFallback =
    /\b(broken|not working|wrong|issue|problem|stuck|fail|crash|down|help)\b/i;
  if (diagnosticFallback.test(userMessage)) {
    return { specialist: 'diagnostician', matchedPattern: diagnosticFallback.source };
  }

  // Default fallback for unmatched intent.
  return { specialist: 'abl-construct-expert', matchedPattern: null };
}

/**
 * Card Router — selects knowledge cards based on user-intent cues in the ask.
 *
 * Part of the 4-layer knowledge architecture:
 *   L0: Platform foundation (always loaded, hand-curated)
 *   L1: Specialist baselines (loaded via specialist prompts — not managed here)
 *   L2: Construct cards (intent-triggered, auto-generated from docs-internal MDX)
 *   L3: Docs RAG fallback (BM25 keyword search over docs-internal chunks)
 *
 * Selection logic:
 *   1. Always include L0 (platform foundation)
 *   2. Match user message keywords against L2 card trigger patterns
 *   3. Fill remaining token budget with L3 BM25-ranked doc chunks
 *   4. Deduplicate L3 against MDX files already covered by matched L2 cards
 *
 * Token estimation: ~4 chars per token (same as content-block-resolver.ts).
 */

import { PLATFORM_LIMITS_CARD } from './platform-limits.js';
import { loadL3Index, searchBm25, type L3SearchResult } from './l3-search.js';
import { getCoveredFiles } from './cards/_mapping.js';
import { ABL_ANATOMY_CARD } from './cards/generated/abl-anatomy.js';
import { EXECUTION_CONFIG_CARD } from './cards/generated/execution-config.js';
import { LIMITATIONS_VS_CONSTRAINTS_CARD } from './cards/generated/limitations-vs-constraints.js';
import { FLOW_PATTERNS_CARD } from './cards/generated/flow-patterns.js';
import { FLOW_REASONING_ZONES_CARD } from './cards/generated/flow-reasoning-zones.js';
import { FLOW_TRANSFORM_CARD } from './cards/generated/flow-transform.js';
import { FLOW_DIGRESSIONS_CARD } from './cards/generated/flow-digressions.js';
import { GATHER_FIELDS_CARD } from './cards/generated/gather-fields.js';
import { GATHER_VALIDATION_PII_CARD } from './cards/generated/gather-validation-pii.js';
import { TOOL_BINDING_AUTH_CARD } from './cards/generated/tool-binding-auth.js';
import { TOOL_RESOLUTION_CARD } from './cards/generated/tool-resolution.js';
import { TOOL_TEMPLATES_CARD } from './cards/generated/tool-templates.js';
import { INTEGRATION_SETUP_WORKFLOW_CARD } from './cards/generated/integration-setup-workflow.js';
import { OAUTH_FLOW_PRIMER_CARD } from './cards/generated/oauth-flow-primer.js';
import { INTEGRATION_FAILURE_DIAGNOSIS_CARD } from './cards/generated/integration-failure-diagnosis.js';
import { HANDOFF_DELEGATE_CARD } from './cards/generated/handoff-delegate.js';
import { ROUTING_INTENTS_CARD } from './cards/generated/routing-intents.js';
import { CROSS_AGENT_CONTRACTS_CARD } from './cards/generated/cross-agent-contracts.js';
import { GUARDRAILS_TIERS_CARD } from './cards/generated/guardrails-tiers.js';
import { ERROR_HANDLING_CARD } from './cards/generated/error-handling.js';
import { ESCALATE_A2A_CARD } from './cards/generated/escalate-a2a.js';
import { EXTERNAL_AGENTS_CARD } from './cards/generated/external-agents.js';
import { CEL_FUNCTIONS_CARD } from './cards/generated/cel-functions.js';
import { CEL_PITFALLS_CARD } from './cards/generated/cel-pitfalls.js';
import { MEMORY_FULL_CARD } from './cards/generated/memory-full.js';
import { NLU_ENTITIES_CARD } from './cards/generated/nlu-entities.js';
import { BEHAVIOR_PROFILES_CARD } from './cards/generated/behavior-profiles.js';
import { HOOKS_LIFECYCLE_CARD } from './cards/generated/hooks-lifecycle.js';
import { RICH_CONTENT_CARD } from './cards/generated/rich-content.js';
import { ATTACHMENTS_KB_CARD } from './cards/generated/attachments-kb.js';
import { KB_TOOL_SEQUENCES_CARD } from './cards/generated/kb-tool-sequences.js';
import { PROJECT_CONFIG_CARD } from './cards/generated/project-config.js';
import { DIAGNOSTICS_WORKFLOW_CARD } from './cards/generated/diagnostics-workflow.js';
import { OBSERVER_ANALYTICS_CARD } from './cards/generated/observer-analytics.js';
import { TESTING_WORKFLOW_CARD } from './cards/generated/testing-workflow.js';
import { RUNTIME_CONSTRUCT_DECISION_CARD } from './cards/runtime-construct-decision.js';
import {
  CHANNELS_OVERVIEW_CARD,
  CHANNELS_MESSAGING_CARD,
  CHANNELS_VOICE_CARD,
  CHANNELS_SDK_CARD,
  DEPLOYMENTS_LIFECYCLE_CARD,
  AUTH_PROFILES_CARD,
  CONNECTIONS_INTEGRATIONS_CARD,
  KB_ADMINISTRATION_CARD,
  WORKFLOWS_AUTHORING_CARD,
  TESTING_EVALS_CARD,
  API_MANAGEMENT_CARD,
  EXTERNAL_AGENTS_A2A_CARD,
} from './cards/platform/index.js';
import {
  CHANNELS_OPERATIONS_CARD,
  DEPLOYMENT_OPERATIONS_CARD,
  AUTH_OPERATIONS_CARD,
  CONNECTION_OPERATIONS_CARD,
  KB_OPERATIONS_CARD,
  EXTERNAL_AGENT_OPERATIONS_CARD,
  PROJECT_LIFECYCLE_CARD,
} from './cards/expertise/index.js';

/** Approximate chars per token for budget calculations. */
const CHARS_PER_TOKEN = 4;

/** Maximum tokens allocated to knowledge cards per request. */
export const MAX_KNOWLEDGE_TOKENS = 14000;

export interface PageContextInput {
  area?: string;
  page?: string;
  tab?: string;
  entityType?: string;
}

interface CardEntry {
  id: string;
  content: string;
  patterns: RegExp[];
  pageMatch?: {
    page?: string | string[];
    tab?: string;
    entityType?: string;
  };
  pairedExpertise?: string;
}

/**
 * Registry of L2 construct cards.
 * Each entry maps keyword patterns to a card's content string.
 * Patterns are tested against the user message — first match loads the card.
 *
 * Order matters: cards are checked in registry order and the budget
 * is consumed as cards are added. Place higher-priority cards first.
 */
const CARD_REGISTRY: CardEntry[] = [
  // ═══════════════════════════════════════════════════════════════
  // Runtime Construct Decisioning
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'runtime-construct-decision',
    content: RUNTIME_CONSTRUCT_DECISION_CARD,
    patterns: [
      /\bruntime\s+(logic|construct|decision|semantics|possibilit)/i,
      /\bwhen\s+to\s+(use|have)\s+(on.result|on.success|handoff|delegate|escalate|complete|gather|tool)/i,
      /\bON_RESULT\b/i,
      /\bON_SUCCESS\b/i,
      /\bON_FAILURE\b/i,
      /\bCALL\b.*\bWITH\b.*\bAS\b/i,
      /\btool\s+result\s+(handling|routing|branch)/i,
      /\bset\s+variables?\s+after\s+tool/i,
      /\bcontext\s+pass/i,
      /\bcompletion\s+(logic|condition|gate|exit)/i,
      /\bundeclared\s+(field|variable|reference)/i,
      /\bvalid\s+agents?\b.*\bsyntax\b/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // ABL Structure & Identity
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'abl-anatomy',
    content: ABL_ANATOMY_CARD,
    patterns: [
      /\bsection/i,
      /\bwhat\s+(sections?|constructs?|keywords?)/i,
      /\banatomy/i,
      /\bwhat\s+does\s+abl/i,
      /\bwhat\s+can\s+(an?\s+)?agent\s+(have|contain|include)/i,
      /\boverview\b/i,
      /\bstructure\b.*\bagent/i,
      /\bagent\b.*\bstructure/i,
    ],
  },
  {
    id: 'execution-config',
    content: EXECUTION_CONFIG_CARD,
    patterns: [
      /\bmodel\b/i,
      /\btemperature\b/i,
      /\bfallback.model/i,
      /\bthinking\b/i,
      /\breasoning.effort/i,
      /\boperation.models?\b/i,
      /\bpipeline\b/i,
      /\bcompaction\b/i,
      /\bmax.tokens\b/i,
      /\bmax.iterations\b/i,
      /\binline.gather\b/i,
      /\bexecution\s+(config|settings?|mode|limits?|models?)\b/i,
      /\bvoice\s+(config|provider|speed)/i,
      /\bcontext\s+window\b/i,
      /\btool.result.*strateg/i,
      /\bprior.turns?\b/i,
      /\bessential.fields\b/i,
      /\btruncate\b/i,
    ],
  },
  {
    id: 'limitations-vs-constraints',
    content: LIMITATIONS_VS_CONSTRAINTS_CARD,
    patterns: [
      /\blimitation/i,
      /\bconstraint\b/i,
      /\bREQUIRE\b/,
      /\bWARN\b.*\bconstraint/i,
      /\bLIMIT\b.*\bconstraint/i,
      /\bRESTRICT\b/,
      /\bBEFORE\s+tool_call\b/i,
      /\bBEFORE\s+respond\b/i,
      /\benforce/i,
      /\bblock\s+turn/i,
      /\bwhat.s\s+the\s+difference/i,
      /\banti.goal/i,
      /\bboundar(y|ies)\b/i,
      /\bmust\s+not\b/i,
      /\bshould\s+never\b/i,
      /\bout\s+of\s+scope\b/i,
      /\bconstraint\s+phase/i,
      /\bpre_booking\b/i,
      /\bpre_payment\b/i,
      /\bLIMITATIONS:/,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // FLOW Domain
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'flow-patterns',
    content: FLOW_PATTERNS_CARD,
    patterns: [
      /\bflow\b/i,
      /\bflow\s+step\b/i,
      /\bstep\s+(transition|branch|result|logic)\b/i,
      /\bTHEN\b/,
      /\bON_INPUT\b/i,
      /\bCALL\b.*\bAS\b/i,
      /\bHUMAN_APPROVAL\b/i,
      /\bAWAIT_ATTACHMENT\b/i,
      /\bCOMPLETE_WHEN\b/i,
      /\bCORRECTION/i,
      /\bscripted\b/i,
      /\bhybrid\b/i,
      /\bON_RESULT\b/i,
      /\bON_SUCCESS\b/i,
      /\bON_FAILURE\b/i,
      /\bSET:/,
      /\bCLEAR:/,
      /\bPRESENT:/,
      /\bflow\s+transition\b/i,
      /\btransition\s+(to|between|after|from)\b/i,
      /\bentry.point\b/i,
      /\bflow\s+graph/i,
      /\bstep\s+guard/i,
      /\bmaxAttempts\b/i,
      /\bMAX_ATTEMPTS\b/i,
      /\bON_EXHAUSTED\b/i,
      /\bglobal.digression/i,
      /\bIF.*THEN.*ELSE\b/i,
      /\bbranch\s+on\s+(input|user)/i,
      /\bstate\s+machine/i,
      /\bstateful\s+flow/i,
      /\bconversation\s+flow/i,
      /\bflow\s+pattern/i,
    ],
  },
  {
    id: 'flow-reasoning-zones',
    content: FLOW_REASONING_ZONES_CARD,
    patterns: [
      /\breasoning\s*zone/i,
      /\bREASONING:\s*true/i,
      /\bEXIT_WHEN\b/i,
      /\bMAX_TURNS\b/i,
      /\bAVAILABLE_TOOLS\b/i,
      /\bhybrid\s+(flow|agent|mode)/i,
      /\bllm\s+inside\s+flow/i,
      /\bstep\s+.*\breasoning\b/i,
    ],
  },
  {
    id: 'flow-transform',
    content: FLOW_TRANSFORM_CARD,
    patterns: [
      /\bTRANSFORM\b/i,
      /\bFILTER\b.*\bMAP\b/i,
      /\bSORT_BY\b/i,
      /\barray\s+pipeline/i,
      /\bloop\b.*\b(items?|array|list)\b/i,
      /\bFOR_EACH\b/i,
      /\bFOREACH\b/i,
      /\biterat/i,
      /\bprocess\s+(a\s+)?list/i,
    ],
  },
  {
    id: 'flow-digressions',
    content: FLOW_DIGRESSIONS_CARD,
    patterns: [
      /\bdigression/i,
      /\bsub.intent/i,
      /\boff.script/i,
      /\binterrupt/i,
      /\bcancel\b.*\bflow/i,
      /\bhelp\b.*\bflow/i,
      /\bglobal_digression/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // GATHER Domain
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'gather-fields',
    content: GATHER_FIELDS_CARD,
    patterns: [
      /\bgather\b/i,
      /\bactivation\b.*\bwhen\b/i,
      /\bextraction\b.*\b(hint|pattern|confidence|pipeline|tier)\b/i,
      /\binfer\b.*\b(confidence|confirm)\b/i,
      /\bdepends.on\b/i,
      /\bprogressive\b/i,
      /\bconditional\s+field/i,
      /\bcollection\s+flow/i,
      /\bagent.level\b.*\bgather/i,
      /\bflow.step\b.*\bgather/i,
      /\brequired\b.*\boptional\b.*\bfield/i,
      /\bcorrection\b.*\bfield/i,
      /\bobject\b.*\bfield/i,
      /\brange\b.*\bfield/i,
      /\blist\b.*\bfield/i,
      /\bfield\b.*\b(type|collect|gather|declare)/i,
    ],
  },
  {
    id: 'gather-validation-pii',
    content: GATHER_VALIDATION_PII_CARD,
    patterns: [
      /\bvalidation\b.*\b(pattern|range|enum|custom|llm)\b/i,
      /\bsensitive\b.*\b(display|mask|redact)\b/i,
      /\bmask.config\b/i,
      /\btransient\b/i,
      /\bPII\b/i,
      /\bpii\b/i,
      /\bredact\b/i,
      /\bsensitive\s+field/i,
      /\bPII_TYPE\b/i,
      /\bSENSITIVE_DISPLAY\b/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Tools Domain
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'tool-binding-auth',
    content: TOOL_BINDING_AUTH_CARD,
    patterns: [
      /\btool\s+type/i,
      /\bwhat\s+tools?\s+(types?|are)/i,
      /\bconnector\b/i,
      /\bworkflow\s+tool/i,
      /\bsearchai\b/i,
      /\bsearch.ai\b/i,
      /\blambda\b/i,
      /\basync.webhook\b/i,
      /\bwebhook\s+tool/i,
      /\bjit.auth\b/i,
      /\boauth/i,
      /\bconsent.mode\b/i,
      /\bidentity.tier/i,
      /\bauth.profile/i,
      /\bconnection.mode\b/i,
      /\bper.user\b/i,
      /\bbearer\b/i,
      /\bapi.key\b/i,
      /\btool\s+auth\b/i,
      /\bcredential(s)?\b/i,
      /\bcircuit.breaker/i,
      /\brate.limit/i,
      /\bconfirmation\b.*\btool/i,
      /\btool\s+(endpoint|url|config|binding)/i,
      /\bset\s+up\s+(the\s+)?tool/i,
      /\bconnect\s+(the\s+)?api/i,
      /\btools_ops\b/i,
      /\bauth_ops\b/i,
    ],
  },
  {
    id: 'tool-resolution',
    content: TOOL_RESOLUTION_CARD,
    patterns: [
      /\btool\s+resolv/i,
      /\bProjectTool/i,
      /\btools\.abl/i,
      /\btool\s+not\s+found/i,
      /\bE721\b/,
      /\btool\s+(lookup|discover|register)/i,
      /\bhow\s+(do|does)\s+.*tool.*\b(find|resolve|work)\b/i,
      /\bmcp\s+server\b/i,
      /\bconnector\s+registry/i,
      /\bstdio\s+allowlist/i,
    ],
  },
  {
    id: 'tool-templates',
    content: TOOL_TEMPLATES_CARD,
    patterns: [
      /\btemplate\b/i,
      /\{\{#each\b/,
      /\b#each\b/i,
      /\{\{#if\b/,
      /\binterpolat/i,
      /\b\{\{secrets\./,
      /\b\{\{env\./,
      /\b\{\{config\./,
      /\b\{\{_context\./,
      /\b\{\{session\./,
      /\b_result\b/,
      /\b_error\b/,
      /\bdisplay.*results?\b/i,
      /\brender.*list\b/i,
      /\beach\b.*\b(item|order|result|product)/i,
      /\bnamespace/i,
      /\bplaceholder/i,
      /\bsecrets?\s+(chain|resolv|provider)/i,
    ],
  },
  {
    id: 'integration-setup-workflow',
    content: INTEGRATION_SETUP_WORKFLOW_CARD,
    patterns: [
      /\b(slack|zendesk|notion|jira|stripe|hubspot|gmail|github|salesforce|outlook|teams|discord|asana|linear|airtable|shopify|sendgrid|twilio|servicenow)\b/i,
      /\b(hook\s+up|connect\s+(my|the|to)|integrate\s+with|wire\s+up)\b/i,
      /\b(set\s+up|setup)\s+(?:my\s+)?(?:new\s+)?integration\b/i,
      /\b(api\s+key|bearer\s+token|oauth\s+app)\b/i,
    ],
  },
  {
    id: 'oauth-flow-primer',
    content: OAUTH_FLOW_PRIMER_CARD,
    patterns: [
      /\boauth\b/i,
      /\bconsent\b/i,
      /\bauthorize\b/i,
      /\bcallback\b/i,
      /\bclient[\s_-]?secret\b/i,
      /\baccess[\s_-]?token\b/i,
    ],
  },
  {
    id: 'integration-failure-diagnosis',
    content: INTEGRATION_FAILURE_DIAGNOSIS_CARD,
    patterns: [
      /\b(failing|failed|error|broken|stuck|not\s+working)\b.*\b(agent|tool|integration)\b/i,
      /\b(401|403|429|5\d\d)\b/i,
      /\bwhy\s+is\b.*\b(agent|tool|integration)\b/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Multi-Agent Domain
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'handoff-delegate',
    content: HANDOFF_DELEGATE_CARD,
    patterns: [
      /\bhandoff\b/i,
      /\bdelegate\b/i,
      /\bsub.agent\b/i,
      /\bchild\s+agent/i,
      /\bcall\s+(a|another)\s+agent/i,
      /\btransfer\s+(to|control)/i,
      /\bRETURN:\s*true/i,
      /\bON_RETURN\b/i,
      /\bhistory\s+(mode|strategy)/i,
      /\bcontext\s+pass/i,
      /\bmemory_grants\b/i,
      /\bRETURN_HANDLERS\b/i,
      /\bmulti.supervisor/i,
      /\bhierarchical\s+(delegat|rout)/i,
      /\bsupervisor\s+chain/i,
      /\bnested\s+routing/i,
      /\bparent\s+supervisor/i,
      /\bchild\s+supervisor/i,
      /\bcontext\s+propagat/i,
      /\bshared\s+context\b/i,
      /\bhistory:\s*auto\b/i,
      /\bgrant.memory\b/i,
      /\bPURPOSE\b/,
      /\bUSE_RESULT\b/i,
      /\bdelegate.*depth/i,
      /\bRETURNS\s+mapping/i,
    ],
  },
  {
    id: 'routing-intents',
    content: ROUTING_INTENTS_CARD,
    patterns: [
      /\brouting\b/i,
      /\bintent\s+classif/i,
      /\bmulti.intent\b/i,
      /\bfan.out\b/i,
      /\bparallel\s+intent/i,
      /\bconfidence\s+threshold/i,
      /\bdefault.agent\b/i,
      /\bdirect.response/i,
      /\bsupervisor\s+rout/i,
      /\bintent\s+categor/i,
      /\broute\b.*\bintent/i,
      /\bINTENTS:/,
      /\bMULTI_INTENT:/,
      /\bdisambiguat/i,
      /\bROUTING:/,
      /\badd\s+(a\s+)?new?\s+agent/i,
      /\bnew\s+agent/i,
      /\btopology\b/i,
      /\bsupervisor\b.*\bspecialist/i,
      /\bentry\s+agent\b/i,
      /\bhub.and.spoke\b/i,
      /\bsplit\b.*\binto\b.*\bagents?\b/i,
      /\bshould\s+this\s+be\s+one\s+agent\b/i,
    ],
  },
  {
    id: 'cross-agent-contracts',
    content: CROSS_AGENT_CONTRACTS_CARD,
    patterns: [
      /\bcross.agent\b/i,
      /\bhandoff\s+contract/i,
      /\bshared\s+entity/i,
      /\bagent\s+compatib/i,
      /\bcontract\s+verif/i,
      /\bpass\s+field/i,
      /\bexpect\s+return/i,
      /\bH-01\b/,
      /\bH-11\b/,
      /\bH-12\b/,
      /\bSV-01\b/,
      /\bSV-05\b/,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Safety & Quality
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'guardrails-tiers',
    content: GUARDRAILS_TIERS_CARD,
    patterns: [
      /\bguardrail\b/i,
      /\btier\b.*\b(local|model|llm)\b/i,
      /\bmodel.based\b/i,
      /\bllm.based\b/i,
      /\bllmCheck\b/i,
      /\btool_input\b/i,
      /\btool_output\b/i,
      /\bstreaming\b.*\bguardrail/i,
      /\breask\b/i,
      /\bcontent\s+safety/i,
      /\btoxicity\b/i,
      /\bhate\s+speech/i,
      /\bmoderation\b/i,
      /\bpii\s+filter/i,
    ],
  },
  {
    id: 'error-handling',
    content: ERROR_HANDLING_CARD,
    patterns: [
      /\berror.handler/i,
      /\bERROR_HANDLERS\b/,
      /\bretry\b.*\bbackoff\b/i,
      /\bbackoff\b/i,
      /\btool.timeout\b/i,
      /\bconnection.timeout\b/i,
      /\berror\s+recovery/i,
      /\bhandle\s+(the\s+)?error/i,
      /\bwhat\s+happens?\s+(when|if)\s+.*fail/i,
      /\bretry\s+logic/i,
      /\bON_ERROR\b/i,
    ],
  },
  {
    id: 'escalate-a2a',
    content: ESCALATE_A2A_CARD,
    patterns: [
      /\bdestination\b/i,
      /\bescalat(e|ion)\b/i,
      /\bzendesk\b/i,
      /\bhuman\s+(handoff|transfer|agent)/i,
      /\brouting\s+queue/i,
      /\bsip\s+transfer/i,
      /\bvoice\s+transfer/i,
      /\boutbound\s+webhook/i,
      /\ba2a\b/i,
      /\bagent.to.agent\b/i,
    ],
  },
  {
    id: 'external-agents',
    content: EXTERNAL_AGENTS_CARD,
    patterns: [
      /\b(external|remote|partner|third.party)\s+agent\b/i,
      /\bLOCATION:\s*remote\b/i,
      /\ba2a\s+(handoff|integration|endpoint)\b/i,
      /\bagent[- ]card\b/i,
      /\bconnect\s+(to|with)\s+.*\s+agent\b/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // CEL & Expressions
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'cel-functions',
    content: CEL_FUNCTIONS_CARD,
    patterns: [
      /\bCEL\b/,
      /\bcel\s+expression\b/i,
      /\bexpression\b.*\b(cel|condition|format|function)\b/i,
      /\bformat\s+(currency|date|number)/i,
      /\bmask\s+(card|ssn|phone|data|number)/i,
      /\bFORMAT_CURRENCY\b/i,
      /\bFORMAT_DATE\b/i,
      /\bCOALESCE\b/i,
      /\bcontains_pii\b/i,
      /\bredact_pii\b/i,
      /\bbuilt.in\s+function/i,
      /\bavailable\s+function/i,
      /\bwhat\s+functions?\b/i,
      /\bUPPER\b/,
      /\bLOWER\b/,
      /\bMASK\(/,
      /\bIS\s+SET\b/i,
      /\bIS\s+NOT\s+SET\b/i,
      /\bROUND\b/,
      /\bABS\(/,
      /\bLENGTH\(/,
      /\bARRAY_FIND\b/i,
      /\bNOW\(\)/,
      /\bUNIQUE_ID\b/i,
      /\bORDINAL\b/i,
      /\bTRIM\(/,
      /\bSPLIT\(/,
      /\bJOIN\(/,
    ],
  },
  {
    id: 'cel-pitfalls',
    content: CEL_PITFALLS_CARD,
    patterns: [
      /\bsilent/i,
      /\bfallback\b.*\bcel/i,
      /\breserved\b.*\bword/i,
      /\bBigInt/i,
      /\bnull.inject/i,
      /\bcel\b.*\b(bug|fail|error|wrong|broken|silent)/i,
      /\bcondition\s+vs\s+when/i,
      /\b===\b/,
      /\bflat.namespace/i,
      /\bnamespace\s+collision/i,
      /\bcel\s+pitfall/i,
      /\bcel\s+gotcha/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Memory & State
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'memory-full',
    content: MEMORY_FULL_CARD,
    patterns: [
      /\bmemory\b/i,
      /\bsession.memory\b/i,
      /\bpersistent.memory\b/i,
      /\bremember\b.*\b(across|between)\b.*\bsession/i,
      /\bstore\b.*\buser\s+(preference|data|history)\b/i,
      /\bresume\b.*\bsession/i,
      /\bstale\s+memory\b/i,
      /\bhandoff\b.*\bcontext\b/i,
      /\bremember\b.*\brecall\b/i,
      /\bsession:/i,
      /\bpersistent:/i,
      /\brecall:/i,
      /\bremember:/i,
      /\bgather\b.*\bmemory\b/i,
      /\bREAD_MEMORY\b/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Supporting Constructs
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'nlu-entities',
    content: NLU_ENTITIES_CARD,
    patterns: [
      /\bNLU\b/,
      /\bintent\s+definition/i,
      /\bentity\s+extraction/i,
      /\bpattern\s+match/i,
      /\bglossary\b/i,
      /\bembeddings?\b.*\b(intent|nlu|threshold)/i,
      /\bINTENTS:/,
      /\blanguage\s+detection/i,
      /\bcode.switching\b/i,
      /\bintent\s+pattern/i,
      /\bentity\s+type/i,
      /\bsynonym/i,
      /\bLOOKUP_TABLE/i,
    ],
  },
  {
    id: 'behavior-profiles',
    content: BEHAVIOR_PROFILES_CARD,
    patterns: [
      /\bbehavior\s+profile/i,
      /\bBEHAVIOR_PROFILES?\b/,
      /\bVIP\b/i,
      /\btier\b.*\b(gold|platinum|premium)\b/i,
      /\bflow.modification/i,
      /\bgather.override/i,
      /\btools.hide\b/i,
      /\btools.add\b/i,
      /\bpersona.override\b/i,
      /\bresponse.rules?\b/i,
      /\bcontext.dependent\b/i,
      /\bfrustrat.*profile/i,
    ],
  },
  {
    id: 'hooks-lifecycle',
    content: HOOKS_LIFECYCLE_CARD,
    patterns: [
      /\bhook\b/i,
      /\bbefore.agent\b/i,
      /\bafter.agent\b/i,
      /\bbefore.turn\b/i,
      /\bafter.turn\b/i,
      /\blifecycle\b/i,
      /\bON_START\b/i,
      /\binitializ.*session/i,
      /\bACTION_HANDLERS\b/i,
      /\bRETURN_HANDLERS\b/i,
      /\bMESSAGES:/,
      /\bCOMPLETE:/,
    ],
  },
  {
    id: 'rich-content',
    content: RICH_CONTENT_CARD,
    patterns: [
      /\bcarousel\b/i,
      /\bchart\b/i,
      /\btable\b.*\b(display|show|data)\b/i,
      /\bKPI\b/,
      /\bprogress\s+(bar|circle)/i,
      /\bfeedback\s+(widget|form|stars|thumbs)/i,
      /\bform\b.*\b(inline|fields?)\b/i,
      /\bquick.replies?\b/i,
      /\brich\s+content/i,
      /\bbutton\b.*\b(display|show|add)\b/i,
      /\bcard\b.*\b(display|swipe|product)\b/i,
    ],
  },
  {
    id: 'attachments-kb',
    content: ATTACHMENTS_KB_CARD,
    patterns: [
      /\battachment\b/i,
      /\bOCR\b/i,
      /\btranscription\b/i,
      /\bAWAIT_ATTACHMENT\b/i,
      /\bembedding/i,
      /\bvector\s*(store|search|index)\b/i,
    ],
  },
  {
    id: 'kb-tool-sequences',
    content: KB_TOOL_SEQUENCES_CARD,
    patterns: [
      /\bknowledge\s*base\b/i,
      /\bkb\b/i,
      /\bsearchai\b/i,
      /\bingest/i,
      /\bsharepoint\b/i,
      /\bdocument.*(upload|add|ingest|index)/i,
      /\b(upload|add)\s+(file|url|text|document)/i,
      /\bcrawl/i,
      /\bupload\b.*\b(file|doc|pdf|kb)/i,
      /\bfile\s+upload/i,
      /\bcreate\s+(a\s+)?(kb|knowledge)/i,
      /\bsearch\s+(the\s+)?(kb|knowledge)/i,
      /\bkb_search\b/i,
      /\bkb_manage\b/i,
      /\bkb_ingest\b/i,
      /\bkb_health\b/i,
      /\bkb_connector\b/i,
      /\bkb_documents\b/i,
      /\bconnector\b.*\b(sync|create|auth)/i,
    ],
    pairedExpertise: 'kb-operations',
  },

  // ═══════════════════════════════════════════════════════════════
  // Project-Level
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'project-config',
    content: PROJECT_CONFIG_CARD,
    patterns: [
      /\bauth\.profile\b/i,
      /\bauth\s+profile/i,
      /\bconnection(s)?\b/i,
      /\bmcp(\s+server(s)?|\s+server\s+config(s)?)?\b/i,
      /\bconfig\s+variable(s)?\b/i,
      /\bvariable\s+namespace(s)?\b/i,
      /\blookup\s+table(s)?\b/i,
      /\bpii\s+pattern(s)?\b/i,
      /\bsecret(s)?\b.*\bproject\b/i,
      /\bsessions?\b/i,
      /\bsession[-\s]?lifecycle\b/i,
      /\bevals?\b/i,
      /\bevaluator(s)?\b/i,
      /\bworkflow(s)?\b/i,
      /\bapproval(s)?\b/i,
      /\bproject\s+(import|export|bundle|archive|restore)\b/i,
      /\bgit\s+(status|history|push|pull|promote)\b/i,
      /\breusable\s+module(s)?\b/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Workflow Cards
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'diagnostics-workflow',
    content: DIAGNOSTICS_WORKFLOW_CARD,
    patterns: [
      /\bvalidat(e|ion)\b.*\b(agent|project|config)/i,
      /\bdiagnos(e|tic|is)\b/i,
      /\bwhat.s\s+wrong/i,
      /\breview\s+(my\s+)?(agents?|project)/i,
      /\bcheck\s+(for\s+)?(issues?|errors?|warnings?)/i,
      /\bdebug\b/i,
      /\bwhy\s+(is|did|does|was)\b/i,
      /\b(broken|failing|stuck|error)\b.*\bagent/i,
      /\bagent\b.*\b(broken|failing|stuck|error)\b/i,
      /\bhealth\s+check/i,
      /\bdiagnostic\s+code/i,
    ],
  },
  {
    id: 'observer-analytics',
    content: OBSERVER_ANALYTICS_CARD,
    patterns: [
      /\bperformance\b.*\b(metric|data|report|review)/i,
      /\b(metric|insight|analytics)\b.*\b(agent|project)/i,
      /\bquality\s*(score|eval|metric)/i,
      /\bsentiment\b.*\b(trend|rate|data)/i,
      /\bescalation\s*(rate|trend)/i,
      /\babandonment\s*(rate|trend)/i,
      /\bhow\s+(is|are)\s+(my|the)\s+(agent|bot)\s+performing/i,
      /\btool\s+(success|error)\s+rate/i,
      /\bfrustration\s+rate/i,
      /\bbriefing\b/i,
      /\bweekly\s+(report|summary|review)/i,
      /\bwhat\s+changed/i,
      /\bwhat\s+(improved|regressed)/i,
      /\bimprovement\s+loop/i,
      /\bknowledge\s+gap/i,
      /\broot\s+cause\b/i,
      /\bbefore\s+and\s+after/i,
    ],
  },
  {
    id: 'testing-workflow',
    content: TESTING_WORKFLOW_CARD,
    patterns: [
      /\brun\s+test/i,
      /\btest\s+(scenario|agent|flow|coverage)/i,
      /\beval(uat)?\b/i,
      /\bscenario\s+tax/i,
      /\bcoverage\s+model/i,
      /\bhappy\s+path/i,
      /\bedge\s+case/i,
      /\btest\s+result/i,
      /\bhow\s+should\s+we\s+test\b/i,
      /\bgolden\s+corpus/i,
      /\bregression\s+(scenario|test|eval)/i,
      /\bred.team/i,
      /\bjailbreak\b/i,
      /\bpre.ship\s+checklist/i,
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // Platform Cards (auto-generated from docs-internal)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'channels-overview',
    content: CHANNELS_OVERVIEW_CARD,
    patterns: [/\b(channel|channels|deploy.*agent|go\s+live)\b/i],
    pageMatch: { page: 'deployments' },
    pairedExpertise: 'channels-operations',
  },
  {
    id: 'channels-messaging',
    content: CHANNELS_MESSAGING_CARD,
    patterns: [/\b(slack|whatsapp|teams|telegram|messenger|line|instagram|zendesk|sms)\b/i],
    pairedExpertise: 'channels-operations',
  },
  {
    id: 'channels-voice',
    content: CHANNELS_VOICE_CARD,
    patterns: [/\b(voice|livekit|twilio|audiocodes|sip|vxml|s2s|realtime\s+voice|phone)\b/i],
    pairedExpertise: 'channels-operations',
  },
  {
    id: 'channels-sdk',
    content: CHANNELS_SDK_CARD,
    patterns: [/\b(web\s+sdk|mobile\s+sdk|embed|widget|api\s+sdk|chat\s+widget)\b/i],
    pairedExpertise: 'channels-operations',
  },
  {
    id: 'deployments-lifecycle',
    content: DEPLOYMENTS_LIFECYCLE_CARD,
    patterns: [/\b(deploy|promote|rollback|retire|environment|staging|production|go\s+live)\b/i],
    pageMatch: { page: 'deployments' },
    pairedExpertise: 'deployment-operations',
  },
  {
    id: 'auth-profiles',
    content: AUTH_PROFILES_CARD,
    patterns: [
      /\b(auth\s+profile|oauth|api[_\s]key|bearer|client[_\s]secret|client[_\s]id|azure[_\s]ad|credential|mTLS)\b/i,
    ],
    pageMatch: { page: 'settings-auth-profiles' },
    pairedExpertise: 'auth-operations',
  },
  {
    id: 'connections-integrations',
    content: CONNECTIONS_INTEGRATIONS_CARD,
    patterns: [
      /\b(connection|connector|integration|salesforce|hubspot|google\s+drive|sharepoint|jira|servicenow|dropbox)\b/i,
    ],
    pageMatch: { page: 'connections' },
    pairedExpertise: 'connection-operations',
  },
  {
    id: 'kb-administration',
    content: KB_ADMINISTRATION_CARD,
    patterns: [
      /\b(knowledge\s+base|kb|ingest|embedding|chunk|crawler|sync|source|vector|semantic\s+search)\b/i,
    ],
    pageMatch: { page: 'search-ai' },
    pairedExpertise: 'kb-operations',
  },
  {
    id: 'workflows-authoring',
    content: WORKFLOWS_AUTHORING_CARD,
    patterns: [/\b(workflow|node|trigger|human\s+task|approval|yaml\s+flow|workflow\s+step)\b/i],
    pageMatch: { page: 'workflows' },
  },
  {
    id: 'testing-evals',
    content: TESTING_EVALS_CARD,
    patterns: [
      /\b(eval|test\s+persona|scenario|evaluator|judge|regression|batch\s+eval|eval\s+set)\b/i,
    ],
    pageMatch: { page: ['evals', 'experiments'] },
  },
  {
    id: 'api-management',
    content: API_MANAGEMENT_CARD,
    patterns: [/\b(management\s+api|deployment\s+api|tool\s+secret|callback\s+api|hmac)\b/i],
  },
  {
    id: 'external-agents-a2a',
    content: EXTERNAL_AGENTS_A2A_CARD,
    patterns: [/\b(external\s+agent|a2a|register\s+agent|agent\s+card|remote\s+agent)\b/i],
    pageMatch: { page: 'external-agents' },
    pairedExpertise: 'external-agent-operations',
  },

  // ═══════════════════════════════════════════════════════════════
  // Expertise Cards (hand-written operational guides)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'channels-operations',
    content: CHANNELS_OPERATIONS_CARD,
    patterns: [/\b(set\s+up|configure|create)\b.*\b(channel|slack|whatsapp|voice)\b/i],
  },
  {
    id: 'deployment-operations',
    content: DEPLOYMENT_OPERATIONS_CARD,
    patterns: [/\b(how\s+to|ready\s+to|should\s+I)\b.*\b(deploy|promote|rollback)\b/i],
  },
  {
    id: 'auth-operations',
    content: AUTH_OPERATIONS_CARD,
    patterns: [/\b(set\s+up|configure|create)\b.*\b(auth|oauth|credential)\b/i],
  },
  {
    id: 'connection-operations',
    content: CONNECTION_OPERATIONS_CARD,
    patterns: [/\b(set\s+up|configure|create|connect)\b.*\b(integration|connector|connection)\b/i],
  },
  {
    id: 'kb-operations',
    content: KB_OPERATIONS_CARD,
    patterns: [/\b(set\s+up|configure|add|manage)\b.*\b(knowledge|kb|source|embedding)\b/i],
  },
  {
    id: 'external-agent-operations',
    content: EXTERNAL_AGENT_OPERATIONS_CARD,
    patterns: [/\b(register|set\s+up|configure)\b.*\b(external|a2a|remote)\s+agent\b/i],
  },
  {
    id: 'project-lifecycle',
    content: PROJECT_LIFECYCLE_CARD,
    patterns: [
      /\b(what\s+should\s+I|next\s+step|ready\s+to\s+deploy|project\s+status|what'?s\s+missing)\b/i,
    ],
    pageMatch: { page: 'overview' },
  },
];

export const REGISTERED_CARD_IDS = CARD_REGISTRY.map((card) => card.id);

export interface CardSelection {
  /** Card IDs that were selected. */
  selectedIds: string[];
  /** Card IDs that were skipped due to token budget exhaustion. */
  skippedIds: string[];
  /** L3 chunks injected from BM25 retrieval. */
  l3Chunks: L3SearchResult[];
  /** Combined card content to inject into the system prompt. */
  content: string;
  /** Estimated token count of the combined content. */
  estimatedTokens: number;
}

/**
 * Select knowledge cards based on user message content.
 *
 * Always includes L0 (platform foundation). Then loads any forced cards,
 * then matches the user message against L2 card trigger patterns,
 * adding cards until the token budget is reached.
 *
 * @param userMessage - The user's message to match against (optional).
 *   If absent, only L0 is returned.
 * @param maxTokens - Token budget for all knowledge content (default: 14000).
 * @param forceCardIds - Card IDs to load regardless of keyword match (still
 *   respects token budget). Used e.g. in BUILD phase to ensure delegate
 *   knowledge is always available.
 */
export function selectKnowledgeCards(
  userMessage?: string,
  maxTokens: number = MAX_KNOWLEDGE_TOKENS,
  forceCardIds?: string[],
  pageContext?: PageContextInput,
): CardSelection {
  const parts: string[] = [];
  const selectedIds: string[] = [];
  const skippedIds: string[] = [];
  let totalChars = 0;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // L0: Always include platform foundation
  parts.push(PLATFORM_LIMITS_CARD);
  selectedIds.push('platform-limits');
  totalChars += PLATFORM_LIMITS_CARD.length;

  // Forced cards: load regardless of keyword match (still respects token budget)
  const forcedSet = new Set(forceCardIds ?? []);
  if (forcedSet.size > 0) {
    for (const card of CARD_REGISTRY) {
      if (!forcedSet.has(card.id)) continue;
      if (totalChars + card.content.length > maxChars) continue;
      parts.push(card.content);
      selectedIds.push(card.id);
      totalChars += card.content.length;
    }
  }

  // Page-context matching — load cards associated with the user's current page
  if (pageContext?.page) {
    for (const card of CARD_REGISTRY) {
      if (!card.pageMatch) continue;
      if (selectedIds.includes(card.id)) continue;
      const pages = Array.isArray(card.pageMatch.page)
        ? card.pageMatch.page
        : card.pageMatch.page
          ? [card.pageMatch.page]
          : [];
      const pageMatches = pages.includes(pageContext.page);
      const tabMatches = !card.pageMatch.tab || card.pageMatch.tab === pageContext.tab;
      if (pageMatches && tabMatches) {
        if (totalChars + card.content.length > maxChars) {
          skippedIds.push(card.id);
          continue;
        }
        parts.push(card.content);
        selectedIds.push(card.id);
        totalChars += card.content.length;
      }
    }
  }

  // L2: Match user message against card patterns (skip already-loaded)
  const loadedSet = new Set(selectedIds);
  if (userMessage && userMessage.trim().length > 0) {
    for (const card of CARD_REGISTRY) {
      if (loadedSet.has(card.id)) continue;
      const matches = card.patterns.some((p) => p.test(userMessage));
      if (!matches) continue;
      if (totalChars + card.content.length > maxChars) {
        skippedIds.push(card.id);
        continue;
      }
      parts.push(card.content);
      selectedIds.push(card.id);
      totalChars += card.content.length;
    }
  }

  // Expertise pairing — co-load paired expertise cards for selected factual cards
  for (const id of [...selectedIds]) {
    const entry = CARD_REGISTRY.find((e) => e.id === id);
    if (!entry?.pairedExpertise) continue;
    if (selectedIds.includes(entry.pairedExpertise)) continue;
    const paired = CARD_REGISTRY.find((e) => e.id === entry.pairedExpertise);
    if (!paired) continue;
    if (totalChars + paired.content.length > maxChars) {
      skippedIds.push(paired.id);
      continue;
    }
    parts.push(paired.content);
    selectedIds.push(paired.id);
    totalChars += paired.content.length;
  }

  // L3: BM25 fallthrough — file-grouped retrieval.
  // Rank files by their best chunk score, then inject all chunks from
  // top files (in document order) until the budget is full. This gives
  // the LLM coherent document sections rather than scattered fragments.
  const l3Chunks: L3SearchResult[] = [];
  if (userMessage && userMessage.trim().length > 0 && totalChars < maxChars) {
    try {
      const l3Index = loadL3Index();
      const coveredFiles = getCoveredFiles(selectedIds);
      const candidates = searchBm25(l3Index, userMessage, 50);

      const fileScores = new Map<string, number>();
      const fileChunks = new Map<string, L3SearchResult[]>();
      for (const candidate of candidates) {
        if (candidate.score === 0) break;
        if (coveredFiles.has(candidate.file)) continue;
        const current = fileScores.get(candidate.file) ?? 0;
        if (candidate.score > current) {
          fileScores.set(candidate.file, candidate.score);
        }
        const chunks = fileChunks.get(candidate.file) ?? [];
        chunks.push(candidate);
        fileChunks.set(candidate.file, chunks);
      }

      const rankedFiles = Array.from(fileScores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([file]) => file);

      for (const file of rankedFiles) {
        const chunks = fileChunks.get(file) ?? [];
        const smallestChunk = Math.min(...chunks.map((c) => c.text.length));
        if (totalChars + smallestChunk > maxChars) break;

        for (const chunk of chunks) {
          if (totalChars + chunk.text.length > maxChars) continue;
          parts.push(chunk.text);
          l3Chunks.push(chunk);
          totalChars += chunk.text.length;
        }
      }
    } catch {
      // L3 index not available — degrade gracefully to L0+L2 only
    }
  }

  return {
    selectedIds,
    skippedIds,
    l3Chunks,
    content: parts.join('\n\n'),
    estimatedTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
  };
}

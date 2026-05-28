/**
 * NLU Context Builder
 *
 * Builds enriched NLU context from ExecutionContext.
 * Determines dialog acts, conversation phase, pending questions,
 * slot-filling bias, and domain context injection.
 */

import type { ExecutionContext, FlowState } from '../constructs/types.js';
import type { AgentIR } from '../ir/schema.js';
import type {
  NLUContext,
  ConversationTurn,
  ConversationPhase,
  DialogAct,
  IntentDefinition,
  CategoryDefinition,
  EntityDefinition,
  FewShotExample,
  NLUIRConfig,
} from './types.js';
import { filterExamplesByLanguage } from './language.js';

// =============================================================================
// CONTEXT BUILDER
// =============================================================================

export class NLUContextBuilder {
  /**
   * Build enriched NLU context from ExecutionContext
   */
  static build(execCtx: ExecutionContext, messageHistory?: ConversationTurn[]): NLUContext {
    const { agentIR, state, userInput } = execCtx;
    const nluConfig = (agentIR as AgentIR & { nlu?: NLUIRConfig }).nlu;
    const flowState = state.flowState;

    // Determine conversation phase
    const conversationPhase = NLUContextBuilder.determinePhase(flowState, state.conversationPhase);

    // Extract pending question from last assistant message
    const pendingQuestion = NLUContextBuilder.extractPendingQuestion(messageHistory);

    // Get declared intents/categories/entities from NLU config
    const declaredIntents = NLUContextBuilder.gatherIntents(nluConfig, state.context);
    const declaredCategories = nluConfig?.categories || [];
    const declaredEntities = nluConfig?.entities || [];
    const glossary = nluConfig?.glossary || [];

    // Determine missing fields for slot-filling bias
    const missingFields = NLUContextBuilder.determineMissingFields(flowState, agentIR);

    // Build few-shot examples
    const fewShotExamples = NLUContextBuilder.buildFewShotExamples(
      declaredIntents,
      state.context._session_language as string | undefined,
    );

    // Determine dialog act
    const dialogAct = NLUContextBuilder.inferDialogAct(
      userInput || '',
      pendingQuestion,
      flowState?.collectedData || {},
    );

    return {
      userMessage: userInput || '',
      detectedLanguage: state.context._session_language as string | undefined,

      conversationHistory: messageHistory || [],
      turnNumber: (messageHistory?.length || 0) + 1,

      dialogAct,
      conversationPhase,
      pendingQuestion,

      agentGoal: agentIR.identity.goal,
      agentDomain: state.context._agent_domain as string | undefined,
      currentStep: flowState?.currentStep,
      collectedData: flowState?.collectedData || state.gatherProgress || {},
      missingFields,

      declaredIntents,
      declaredCategories,
      declaredEntities,
      glossary,
      fewShotExamples,

      sessionLanguage: state.context._session_language as string | undefined,
      supportedLanguages: nluConfig?.languages,
    };
  }

  /**
   * Determine conversation phase from flow state
   */
  static determinePhase(flowState?: FlowState, currentPhase?: string): ConversationPhase {
    if (flowState?.isComplete) return 'complete';
    if (flowState?.inDigression) return 'digressing';

    if (flowState?.waitingForInput) {
      // If waiting for input after presenting data, likely confirming
      if (flowState.stepHistory.length > 0 && !flowState.waitingForInput.includes('_on_input_')) {
        return 'collecting';
      }
    }

    if (currentPhase === 'start' || !flowState?.stepHistory?.length) return 'greeting';
    if (flowState?.collectedData && Object.keys(flowState.collectedData).length > 0) {
      return 'collecting';
    }

    return 'collecting';
  }

  /**
   * Extract pending question from last assistant message
   */
  static extractPendingQuestion(history?: ConversationTurn[]): string | undefined {
    if (!history || history.length === 0) return undefined;

    // Find the last assistant message
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') {
        const content = history[i].content;
        // Check if it ends with a question mark
        if (content.includes('?')) {
          // Extract the last sentence with a question mark
          const sentences = content.split(/(?<=[.!?])\s+/);
          const questions = sentences.filter((s) => s.includes('?'));
          return questions[questions.length - 1]?.trim();
        }
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Gather intents from NLU config + dynamic intents from state
   */
  static gatherIntents(
    nluConfig?: NLUIRConfig,
    stateContext?: Record<string, unknown>,
  ): IntentDefinition[] {
    const declared = nluConfig?.intents || [];
    const dynamic = (stateContext?._dynamic_intents as IntentDefinition[]) || [];
    return [...declared, ...dynamic];
  }

  /**
   * Determine missing fields for slot-filling bias
   */
  static determineMissingFields(flowState?: FlowState, agentIR?: AgentIR): string[] | undefined {
    if (flowState?.waitingForInput) {
      return flowState.waitingForInput.filter((f) => f !== '_on_input_');
    }
    return undefined;
  }

  /**
   * Build few-shot examples from intent definitions
   */
  static buildFewShotExamples(intents: IntentDefinition[], language?: string): FewShotExample[] {
    const examples: FewShotExample[] = [];

    for (const intent of intents) {
      if (intent.examples) {
        for (const example of intent.examples) {
          examples.push({
            input: example,
            output: `intent: ${intent.name}`,
            intent: intent.name,
            language: undefined, // Could be enhanced with language tagging
          });
        }
      }
    }

    // Filter by language if specified
    if (language && examples.length > 0) {
      return filterExamplesByLanguage(examples, language);
    }

    return examples;
  }

  /**
   * Infer dialog act from user message and context
   */
  static inferDialogAct(
    userMessage: string,
    pendingQuestion?: string,
    collectedData?: Record<string, unknown>,
  ): DialogAct {
    const msgLower = userMessage.toLowerCase().trim();

    // Greeting
    if (/^(hi|hello|hey|good\s+(morning|afternoon|evening)|hola|bonjour)\b/i.test(msgLower)) {
      return 'greeting';
    }

    // Farewell
    if (/^(bye|goodbye|thanks|thank you|see you|adios|au revoir)\b/i.test(msgLower)) {
      return 'farewell';
    }

    // Confirmation
    if (/^(yes|yeah|yep|sure|correct|confirm|ok|okay|right|si|oui)\b/i.test(msgLower)) {
      return 'confirmation';
    }

    // Denial
    if (/^(no|nope|wrong|incorrect|not right|nah)\b/i.test(msgLower)) {
      return 'denial';
    }

    // Correction — check if user is correcting a collected value
    if (/^(actually|no,?\s|i meant|change|not\s+\w+,)/i.test(msgLower)) {
      return 'correction';
    }

    // Complaint
    if (
      /\b(frustrated|annoyed|angry|terrible|awful|horrible|unacceptable|complaint)\b/i.test(
        msgLower,
      )
    ) {
      return 'complaint';
    }

    // Question (ends with ?)
    if (
      msgLower.endsWith('?') ||
      /^(what|where|when|how|why|who|which|can|do|does|is|are)\b/i.test(msgLower)
    ) {
      return 'question';
    }

    // Command (imperative verbs)
    if (/^(book|reserve|cancel|change|update|show|find|search|get|send|make)\b/i.test(msgLower)) {
      return 'command';
    }

    // If there's a pending question, this is likely an answer
    if (pendingQuestion) {
      return 'answer';
    }

    return 'information';
  }
}

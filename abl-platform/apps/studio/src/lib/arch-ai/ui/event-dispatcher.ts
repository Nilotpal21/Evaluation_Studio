/**
 * @arch-ai-ui
 *
 * Pure function: maps a live Arch event to mutations on ArchUIStore and the
 * shared artifact/build stores.
 *
 * The current chat surface consumes two event contracts:
 *   1. Durable replay events (`TurnEvent`) from /sessions/:id/events
 *   2. Live raw SSE events (`ArchSSEEvent`) from POST /api/arch-ai/message
 *
 * Current BUILD UX relies on the raw build/file/tool stream, so this
 * dispatcher intentionally handles both shapes until the route contracts are
 * fully unified.
 */

import type { ArchUIStore } from './store';
import { useArchUIStore } from './store';
import type {
  ArchError,
  ArchUIPhase,
  ArchSSEEvent,
  ArchSuggestion,
  ChatMessage,
  LiveArchEvent,
  TurnEvent,
} from './types';
import { mutate as mutateSWR } from 'swr';
import { useArchAIStore } from '../store/arch-ai-store';
import { normalizeGateRequestInput } from '@/lib/arch-ai/gate-request';
import { useProjectStore } from '@/store/project-store';
import { syncDiffArtifact } from './proposal-artifacts';
import { buildBlueprintDocumentArtifact } from '@/lib/arch-ai/blueprint-document';
import type { BlueprintDocumentArtifact } from '@/lib/arch-ai/blueprint-document';
import { getBlueprintStage } from '@/lib/arch-ai/blueprint-flow';

type BuildAgentUIStatus =
  | 'queued'
  | 'generating'
  | 'parsed'
  | 'fixing'
  | 'validated'
  | 'compiled'
  | 'warning'
  | 'error';

type FileCompileStatus = 'pending' | 'compiling' | 'success' | 'warning' | 'error' | 'fixing';
type KbCardMessage = NonNullable<ChatMessage['kbCards']>[number];

interface SearchArtifactEntry {
  id: string;
  receivedAt: string;
  card: KbCardMessage;
}

interface SearchArtifactTabData {
  entries: SearchArtifactEntry[];
}

const MAX_SEARCH_ARTIFACT_ENTRIES = 50;
const CLIENT_SIDE_TOOL_NAMES = new Set(['ask_user', 'collect_file', 'collect_secret']);
const DEFAULT_STREAM_ERROR_MESSAGE = 'An unexpected error occurred.';

interface NormalizedErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

function normalizeEventErrorPayload(event: unknown): NormalizedErrorPayload {
  const eventRecord = isRecord(event) ? event : {};
  const nested = isRecord(eventRecord.error) ? eventRecord.error : eventRecord;
  return {
    code: typeof nested.code === 'string' && nested.code.length > 0 ? nested.code : 'STREAM_ERROR',
    message: typeof nested.message === 'string' ? nested.message : DEFAULT_STREAM_ERROR_MESSAGE,
    retryable: typeof nested.retryable === 'boolean' ? nested.retryable : true,
  };
}

function appendBuildLogEntry(input: {
  eventType: string;
  agent?: string;
  stage?: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  useArchAIStore.getState().appendBuildLog(input);
}

function isClientSideTool(toolName: string): boolean {
  return CLIENT_SIDE_TOOL_NAMES.has(toolName);
}

function blueprintFileLabel(value: string | undefined): string {
  return (
    (value ?? '')
      .split('/')
      .pop()
      ?.replace(/\.abl\.ya?ml$/i, '')
      .replace(/\.(json|md)$/i, '')
      .trim()
      .toLowerCase() ?? ''
  );
}

function isBlueprintDocumentArtifact(value: unknown): value is BlueprintDocumentArtifact {
  if (!isRecord(value)) return false;
  return (
    typeof value.markdown === 'string' &&
    typeof value.agentCount === 'number' &&
    typeof value.handoffCount === 'number' &&
    (value.status === 'concept' || value.status === 'draft' || value.status === 'locked')
  );
}

function parseBlueprintDocumentContent(content: string): BlueprintDocumentArtifact | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isBlueprintDocumentArtifact(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function syncBlueprintDocumentFileArtifact(input: {
  label?: string;
  path?: string;
  content?: string;
  eventId: string;
}): boolean {
  if (
    blueprintFileLabel(input.label) !== 'blueprint' &&
    blueprintFileLabel(input.path) !== 'blueprint'
  ) {
    return false;
  }

  const artifact =
    typeof input.content === 'string' ? parseBlueprintDocumentContent(input.content) : null;
  if (!artifact) {
    return false;
  }

  const store = useArchAIStore.getState();
  const strayCodeTab = store.artifactTabs.find(
    (tab) => tab.type === 'agent_code' && blueprintFileLabel(tab.label) === 'blueprint',
  );
  if (strayCodeTab) {
    store.removeTab(strayCodeTab.id);
  }

  const tabId = upsertArtifactTab('blueprint-document', 'Blueprint', artifact, input.eventId);
  store.setActiveTab(tabId);
  store.setOverlayState('artifacts');
  return true;
}

/**
 * Dispatch a single live event into the Arch UI store.
 *
 * The `_store` parameter exists for signature parity with the store's
 * `dispatchEnvelope` action slot — callers pass `getState()` so the function
 * signature matches, but all mutations go through `useArchUIStore.setState()`
 * for atomicity.
 */
export function dispatchEnvelope(env: LiveArchEvent, _store: ArchUIStore): void {
  if (isTurnEventEnvelope(env)) {
    const store = useArchUIStore.getState();
    const lastSeenSeq = store.seenSeqByTurn.get(env.turnId) ?? -1;
    if (env.seq <= lastSeenSeq && typeof env.replaySeq !== 'number') {
      return;
    }
    store.markSeqSeen(env.turnId, env.seq);
    dispatchTurnEvent(env);
    return;
  }

  dispatchRawSseEvent(env);
}

function dispatchTurnEvent(env: TurnEvent): void {
  switch (env.type) {
    case 'turn_started': {
      const msgId = cryptoRandomId();
      const msg: ChatMessage = {
        id: msgId,
        role: 'assistant',
        content: '',
        specialist: env.specialist ? { name: env.specialist, icon: '' } : undefined,
        timestamp: new Date(env.timestamp).toISOString(),
        isStreaming: true,
      };
      useArchUIStore.setState((s) => ({
        state: 'streaming' as const,
        currentMsgId: msgId,
        messages: [...s.messages, msg],
        currentSpecialist: env.specialist
          ? { name: env.specialist, icon: '' }
          : s.currentSpecialist,
        error: null,
        statusMessage: null,
      }));
      return;
    }

    case 'text_delta': {
      // Self-heal: if currentMsgId was cleared by an earlier tool_call within
      // the same turn (e.g. tool-first LLM behaviour where the engine emits
      // tool_call at seq=2 before any text), re-create the streaming assistant
      // message so post-tool text is never silently dropped. This mirrors the
      // raw-SSE text_delta path, which has used ensureAssistantMessage since
      // the v1 dispatcher shipped.
      useArchUIStore.setState((s) => {
        const ensured = ensureAssistantMessage(
          s,
          env.specialist ? { name: env.specialist, icon: '' } : (s.currentSpecialist ?? undefined),
        );
        return {
          state: 'streaming' as const,
          currentMsgId: ensured.currentMsgId,
          messages: ensured.messages.map((m) =>
            m.id === ensured.currentMsgId
              ? { ...m, content: (m.content ?? '') + env.delta, isStreaming: true }
              : m,
          ),
        };
      });
      return;
    }

    case 'status': {
      useArchUIStore.setState({ statusMessage: env.label });
      return;
    }

    case 'artifact_updated': {
      syncArtifactPanelState(env);
      const { update } = env;
      useArchUIStore.setState((s) => {
        switch (update.artifact) {
          case 'topology':
            return { topology: update.payload };
          case 'spec':
            return { specDocument: update };
          case 'journal':
            return {
              journal: [...s.journal, update.entry as Record<string, unknown>],
            };
          case 'build':
            return {};
          default:
            return {};
        }
      });
      return;
    }

    case 'plan_proposed':
    case 'plan_approved':
    case 'plan_refining':
    case 'plan_cancelled':
    case 'plan_invalidated': {
      syncPlanLifecycleState(env);
      return;
    }

    case 'interactive_tool': {
      const toolCall = {
        toolCallId: env.toolCallId,
        toolName: env.tool,
        input: env.payload as Record<string, unknown>,
      };
      useArchUIStore.setState((s) => {
        const pendingInteraction = {
          kind: 'widget' as const,
          id: env.toolCallId,
          payload: (isRecord(env.payload) ? env.payload : {}) as SessionPendingInteraction extends {
            payload: infer P;
          }
            ? P
            : never,
          createdAt: new Date(env.timestamp).toISOString(),
        };
        const duplicate = findDuplicatePendingWidgetMessage(
          s.messages,
          env.tool,
          env.payload,
          s.currentMsgId,
        );

        if (duplicate) {
          return buildDuplicateWidgetState(s, duplicate);
        }

        if (s.currentMsgId) {
          return {
            state: 'widget_pending' as const,
            currentMsgId: null,
            messages: s.messages.map((m) =>
              m.id === s.currentMsgId ? { ...m, toolCall, isStreaming: false } : m,
            ),
            session: updateSessionPendingInteraction(s.session, pendingInteraction),
          };
        }

        return {
          state: 'widget_pending' as const,
          currentMsgId: null,
          messages: [
            ...s.messages,
            {
              id: cryptoRandomId(),
              role: 'assistant' as const,
              content: '',
              toolCall,
              timestamp: new Date(env.timestamp).toISOString(),
            },
          ],
          session: updateSessionPendingInteraction(s.session, pendingInteraction),
        };
      });
      return;
    }

    case 'turn_committed': {
      useArchUIStore.setState((s) => ({
        lastCommittedSeq: env.seq,
        phase: (env.phase as ArchUIPhase) ?? useArchUIStore.getState().phase,
        session: updateSessionPhase(
          s.session,
          ((env.phase as ArchUIPhase) ?? useArchUIStore.getState().phase) as ArchUIPhase,
        ),
      }));
      return;
    }

    case 'turn_ended': {
      useArchUIStore.setState((s) => ({
        state: s.state === 'widget_pending' ? ('widget_pending' as const) : ('idle' as const),
        currentMsgId: null,
        statusMessage: null,
        messages: finalizeCurrentAssistantMessage(s.messages, s.currentMsgId),
        suggestions: mapSuggestions(env.suggestions),
        session: updateSessionPendingInteraction(s.session, null),
        ...(env.error && !s.error
          ? {
              error: {
                message: env.error.message,
                type: 'generic' as const,
                recoverable: env.error.retryable ?? false,
              },
            }
          : {}),
      }));
      return;
    }

    case 'phase_transition': {
      useArchUIStore.setState((s) => ({
        phase: env.to as ArchUIPhase,
        session: updateSessionPhase(s.session, env.to as ArchUIPhase),
      }));
      return;
    }

    case 'error': {
      const errorPayload = normalizeEventErrorPayload(env);
      useArchUIStore.setState((s) => ({
        state: 'idle' as const,
        currentMsgId: null,
        statusMessage: null,
        messages: finalizeCurrentAssistantMessage(s.messages, s.currentMsgId),
        session: updateSessionPendingInteraction(s.session, null),
        error: {
          message: errorPayload.message,
          type: 'generic',
          recoverable: errorPayload.retryable,
        } as ArchError,
      }));
      return;
    }

    default:
      return;
  }
}

function dispatchRawSseEvent(env: ArchSSEEvent): void {
  switch (env.type) {
    case 'specialist': {
      // Step 1: read previous specialist BEFORE setState (synchronous capture)
      // so the transition-narration check sees the pre-change value.
      const prevSpecialist = useArchUIStore.getState().currentSpecialist;
      const nextSpecialist = { name: env.name, icon: env.icon };
      const hasPriorAssistantMessage = useArchUIStore
        .getState()
        .messages.some((m) => m.role === 'assistant');

      // Step 2: dispatch state change (existing behavior preserved).
      useArchUIStore.setState((s) => {
        const shouldCreateMessage = s.phase !== 'BUILD' && s.phase !== 'CREATE';
        const ensured = shouldCreateMessage ? ensureAssistantMessage(s, nextSpecialist) : null;
        let messages = ensured?.messages ?? s.messages;
        if (shouldCreateMessage && ensured?.currentMsgId) {
          messages = messages.map((message) =>
            message.id === ensured.currentMsgId
              ? { ...message, specialist: nextSpecialist }
              : message,
          );
        }
        return {
          state: shouldCreateMessage ? ('streaming' as const) : s.state,
          currentMsgId: ensured?.currentMsgId ?? s.currentMsgId,
          messages,
          currentSpecialist: shouldCreateMessage ? nextSpecialist : s.currentSpecialist,
          error: null,
        };
      });

      // Step 3: emit narration AFTER state change, only on non-trivial transition.
      // - Skip if there was no prior specialist (first turn — nothing to narrate).
      // - Skip if specialist is unchanged.
      // - Skip if no assistant message has been rendered yet.
      if (
        prevSpecialist?.name &&
        prevSpecialist.name !== nextSpecialist.name &&
        hasPriorAssistantMessage
      ) {
        const display = SPECIALIST_DISPLAY[nextSpecialist.name] ?? nextSpecialist.name;
        useArchUIStore.getState().appendStatusMessage({
          id: cryptoRandomId(),
          type: 'info',
          text: `Switching to ${display} for ${transitionReason(nextSpecialist.name)}…`,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    case 'text_delta': {
      useArchUIStore.setState((s) => {
        const ensured = ensureAssistantMessage(s, s.currentSpecialist ?? undefined);
        return {
          state: 'streaming' as const,
          currentMsgId: ensured.currentMsgId,
          error: null,
          messages: ensured.messages.map((message) =>
            message.id === ensured.currentMsgId
              ? { ...message, content: (message.content ?? '') + env.delta, isStreaming: true }
              : message,
          ),
        };
      });
      return;
    }

    case 'tool_call': {
      const toolCall = {
        toolCallId: env.toolCallId,
        toolName: env.toolName,
        input: env.input,
      };

      if (!isClientSideTool(env.toolName)) {
        // Non-widget (internal) tool calls are mid-turn operations, NOT turn
        // terminators. The LLM commonly emits tool_call → tool_result → more
        // text_delta in the same turn (tool-first models do this at seq=2,
        // before any preamble text). Attach the toolCall to the streaming
        // assistant message but KEEP currentMsgId alive so subsequent
        // text_delta events continue streaming into the same bubble. Only
        // widget tools (handled below) terminate the streaming turn because
        // they hand control back to the user.
        useArchUIStore.setState((s) => {
          const ensured = ensureAssistantMessage(s, s.currentSpecialist ?? undefined);
          return {
            currentMsgId: ensured.currentMsgId,
            messages: ensured.messages.map((m) =>
              m.id === ensured.currentMsgId ? { ...m, toolCall } : m,
            ),
          };
        });
        return;
      }

      const createdAt = new Date().toISOString();
      useArchUIStore.setState((s) => {
        const pendingInteraction = {
          kind: 'widget' as const,
          id: env.toolCallId,
          payload: env.input,
          createdAt,
        };
        const duplicate = findDuplicatePendingWidgetMessage(
          s.messages,
          env.toolName,
          env.input,
          s.currentMsgId,
        );

        if (duplicate) {
          return buildDuplicateWidgetState(s, duplicate);
        }

        if (s.currentMsgId) {
          return {
            state: 'widget_pending' as const,
            currentMsgId: null,
            messages: s.messages.map((m) =>
              m.id === s.currentMsgId ? { ...m, toolCall, isStreaming: false } : m,
            ),
            session: updateSessionPendingInteraction(s.session, pendingInteraction),
          };
        }

        const synthesizedContent = extractWidgetPromptText(env.input);
        return {
          state: 'widget_pending' as const,
          currentMsgId: null,
          messages: [
            ...finalizeCurrentAssistantMessage(s.messages, s.currentMsgId),
            {
              id: cryptoRandomId(),
              role: 'assistant',
              content: synthesizedContent,
              specialist: s.currentSpecialist ?? undefined,
              toolCall,
              timestamp: createdAt,
            } satisfies ChatMessage,
          ],
          session: updateSessionPendingInteraction(s.session, pendingInteraction),
        };
      });
      return;
    }

    case 'gate_request': {
      const widgetInput = normalizeGateRequestInput(env.gateType, env.data);
      const createdAt = new Date().toISOString();
      useArchUIStore.setState((s) => {
        const finalized = finalizeCurrentAssistantMessage(s.messages, s.currentMsgId);
        if (!widgetInput) {
          return {
            state: 'idle' as const,
            currentMsgId: null,
            messages: [
              ...finalized,
              {
                id: cryptoRandomId(),
                role: 'assistant',
                content:
                  'Arch reached an approval step, but the payload could not be rendered correctly. You can continue the conversation and retry that step.',
                specialist: s.currentSpecialist ?? undefined,
                timestamp: createdAt,
              } satisfies ChatMessage,
            ],
            session: updateSessionPendingInteraction(s.session, null),
          };
        }
        const duplicate = findDuplicatePendingWidgetMessage(
          s.messages,
          'gate_request',
          widgetInput,
          s.currentMsgId,
        );

        if (duplicate) {
          return buildDuplicateWidgetState(s, duplicate);
        }

        return {
          state: 'widget_pending' as const,
          currentMsgId: null,
          messages: [
            ...finalized,
            {
              id: cryptoRandomId(),
              role: 'assistant',
              content: '',
              specialist: s.currentSpecialist ?? undefined,
              toolCall: {
                toolCallId:
                  env.data.gateId && typeof env.data.gateId === 'string'
                    ? env.data.gateId
                    : cryptoRandomId(),
                toolName: 'gate_request',
                input: widgetInput,
              },
              timestamp: createdAt,
            } satisfies ChatMessage,
          ],
          session: updateSessionPendingInteraction(s.session, {
            kind: 'widget',
            id:
              env.data.gateId && typeof env.data.gateId === 'string'
                ? env.data.gateId
                : `gate_${cryptoRandomId()}`,
            payload: {
              ...((widgetInput as unknown as Record<string, unknown>) ?? {}),
            } as SessionPendingInteraction extends {
              payload: infer P;
            }
              ? P
              : never,
            createdAt,
          }),
        };
      });
      return;
    }

    case 'progress': {
      useArchUIStore.setState({
        state: 'streaming',
        statusMessage: env.total > 0 ? `Step ${env.step} of ${env.total}: ${env.label}` : env.label,
      });
      return;
    }

    case 'phase_transition': {
      useArchUIStore.setState((s) => ({
        phase: env.to as ArchUIPhase,
        session: updateSessionPhase(s.session, env.to as ArchUIPhase),
      }));
      return;
    }

    case 'activity': {
      useArchUIStore.setState((s) => {
        const ensured = ensureAssistantMessage(s, s.currentSpecialist ?? undefined);
        return {
          state: 'streaming' as const,
          currentMsgId: ensured.currentMsgId,
          messages: appendActivityToCurrentMessage(ensured.messages, ensured.currentMsgId, env),
        };
      });
      return;
    }

    case 'file_content_delta': {
      if (
        syncBlueprintDocumentFileArtifact({
          label: env.agentName,
          content: env.delta,
          eventId: `file-stream-${env.agentName}`,
        })
      ) {
        return;
      }

      const store = useArchAIStore.getState();
      store.appendFileContent(env.agentName, env.delta);
      const currentFile = useArchAIStore.getState().filePanelFiles[env.agentName];
      const nextTabData = {
        name: env.agentName,
        content: currentFile?.streamingContent ?? env.delta,
        generating: true,
        compileStatus: 'compiling' as const,
      };

      const existingTab = store.artifactTabs.find(
        (tab) => tab.type === 'agent_code' && tab.label === env.agentName,
      );
      if (existingTab) {
        store.updateTab(existingTab.id, nextTabData);
        store.setActiveTab(existingTab.id);
      } else {
        store.addTab({
          type: 'agent_code',
          label: env.agentName,
          data: nextTabData,
          toolCallId: `file-stream-${env.agentName}`,
        });
      }
      return;
    }

    case 'file_changed': {
      const store = useArchAIStore.getState();
      if (env.action === 'delete') {
        const deletedName = env.path.split('/').pop()?.replace('.abl.yaml', '') ?? env.path;
        store.removeFile(deletedName);
        const deletedTab = store.artifactTabs.find(
          (tab) => tab.type === 'agent_code' && tab.label === deletedName,
        );
        if (deletedTab) {
          store.removeTab(deletedTab.id);
        }
        return;
      }

      const content = env.content ?? '';
      const isMockFile = env.path.startsWith('mock-server/');
      if (isMockFile) {
        const mockPath = env.path.replace('mock-server/', '');
        const mockKey = `mock:${mockPath}`;
        store.addFile(mockKey, content, { fileType: 'mock', displayName: mockPath });
        const existingMockTab = store.artifactTabs.find(
          (tab) => tab.type === 'agent_code' && tab.label === mockPath,
        );
        if (existingMockTab) {
          store.updateTab(existingMockTab.id, {
            name: mockPath,
            content,
            isMock: true,
          });
        } else {
          store.addTab({
            type: 'agent_code',
            label: mockPath,
            data: { name: mockPath, content, isMock: true },
            toolCallId: `file-${mockKey}`,
          });
        }
        return;
      }

      const fileName = env.path.split('/').pop()?.replace('.abl.yaml', '') ?? env.path;
      if (
        syncBlueprintDocumentFileArtifact({
          label: fileName,
          path: env.path,
          content,
          eventId: `file-${fileName}`,
        })
      ) {
        return;
      }

      store.addFile(fileName, content);
      if (content) {
        store.updateFileStatus(fileName, 'compiling');
      }

      updateTopologyBuildStatus(fileName, 'generating');

      const existingTab = store.artifactTabs.find(
        (tab) => tab.type === 'agent_code' && tab.label === fileName,
      );
      if (existingTab) {
        store.updateTab(existingTab.id, {
          ...(existingTab.data as Record<string, unknown>),
          name: fileName,
          content,
          compileStatus: content ? 'compiling' : 'pending',
          generating: false,
        });
      } else {
        store.addTab({
          type: 'agent_code',
          label: fileName,
          data: {
            name: fileName,
            content,
            compileStatus: content ? 'compiling' : 'pending',
            generating: false,
          },
          toolCallId: `file-${fileName}`,
        });
      }
      return;
    }

    case 'compile_result': {
      const store = useArchAIStore.getState();
      const compileStatus = env.status === 'pass' ? 'success' : 'error';
      const agentKey =
        env.agent
          .replace(/\.abl\.yaml$/, '')
          .split('/')
          .pop() ?? env.agent;
      const fileStatus =
        env.warnings && env.warnings.length > 0 ? ('warning' as const) : compileStatus;
      appendBuildLogEntry({
        eventType: 'compile_result',
        agent: agentKey,
        message: `${agentKey} compile ${env.status}${env.errors?.length ? `: ${env.errors[0]}` : ''}`,
        data: {
          status: env.status,
          warningCount: env.warnings?.length ?? 0,
          errorCount: env.errors?.length ?? 0,
          warnings: env.warnings,
          errors: env.errors,
        },
      });
      store.updateFileStatus(agentKey, fileStatus, env.warnings);

      const currentState = useArchAIStore.getState();
      const file = currentState.filePanelFiles[agentKey];
      const tab = currentState.artifactTabs.find(
        (artifactTab) => artifactTab.type === 'agent_code' && artifactTab.label === agentKey,
      );
      if (tab) {
        currentState.updateTab(tab.id, {
          ...(tab.data as Record<string, unknown>),
          name:
            (typeof (tab.data as Record<string, unknown>)?.name === 'string'
              ? ((tab.data as Record<string, unknown>).name as string)
              : file?.displayName) ?? agentKey,
          content: file?.content || file?.streamingContent || '',
          generating: false,
          compileStatus: fileStatus,
        });
      }

      updateTopologyBuildStatus(
        agentKey,
        fileStatus === 'success' ? 'validated' : fileStatus === 'warning' ? 'warning' : 'error',
      );

      store.setBuildAgentStatus(
        agentKey,
        fileStatus === 'success' ? 'validated' : fileStatus === 'warning' ? 'validated' : 'error',
        { warnings: env.warnings ?? [], errors: env.errors ?? [] },
      );
      return;
    }

    case 'journal_entry': {
      useArchAIStore.getState().addJournalEntry({
        type: env.entryType,
        summary: env.summary,
        description: env.description,
        phase: useArchUIStore.getState().phase,
      });
      return;
    }

    case 'spec_document_update': {
      useArchAIStore.getState().updateSpecDocument(env.path, env.value, env.version);
      return;
    }

    case 'tool_result': {
      if (env.toolCallId === 'create_project' && isRecord(env.result)) {
        const result = env.result as Record<string, unknown>;
        const projectId = typeof result.projectId === 'string' ? result.projectId : null;
        const success = result.success === true && projectId !== null;
        if (!success || !projectId) {
          return;
        }

        useArchAIStore.getState().setCreatedProjectId(projectId);
        useProjectStore.getState().addProject({
          id: projectId,
          name:
            (typeof result.projectName === 'string' ? result.projectName : null) ??
            (typeof result.name === 'string' ? result.name : null) ??
            'Untitled',
          slug: '',
          description: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          agentCount:
            typeof (result.stats as Record<string, unknown> | undefined)?.saved === 'number'
              ? ((result.stats as Record<string, unknown>).saved as number)
              : 0,
          sessionCount: 0,
          kind: 'application',
        });

        useArchUIStore.setState((s) => ({
          state: 'idle' as const,
          currentMsgId: null,
          statusMessage: null,
          session: updateSessionProjectId(s.session, projectId),
          messages: [
            ...finalizeCurrentAssistantMessage(s.messages, s.currentMsgId),
            {
              id: cryptoRandomId(),
              role: 'assistant',
              content: '',
              specialist: s.currentSpecialist ?? undefined,
              toolCall: {
                toolCallId: env.toolCallId,
                toolName: 'create_project',
                input: {},
                result,
              },
              timestamp: new Date().toISOString(),
            } satisfies ChatMessage,
          ],
        }));
        return;
      }

      useArchUIStore.setState((s) => ({
        messages: upsertToolResultMessage(
          finalizeCurrentAssistantMessage(s.messages, s.currentMsgId),
          env.toolCallId,
          env.toolName,
          env.result,
          s.currentSpecialist ?? undefined,
        ),
      }));
      return;
    }

    case 'build_agent_start': {
      const store = useArchAIStore.getState();
      store.setBuildPhase('generating');
      appendBuildLogEntry({
        eventType: 'build_agent_start',
        agent: env.agent,
        message: `${env.agent} started (${env.mode})`,
        data: { mode: env.mode, role: env.role },
      });
      store.setBuildStage(env.agent, 'gen', 'active');
      store.setBuildAgentStatus(env.agent, 'generating');
      if (!store.filePanelFiles[env.agent]) {
        store.addFile(env.agent, '', { fileType: 'agent' });
        store.showFilePanel();
      }
      store.updateFileStatus(env.agent, 'compiling');

      const existingAgentTab = store.artifactTabs.find(
        (tab) => tab.type === 'agent_code' && tab.label === env.agent,
      );
      if (!existingAgentTab) {
        const hasExistingAgentTabs = store.artifactTabs.some((tab) => tab.type === 'agent_code');
        store.addTab({
          type: 'agent_code',
          label: env.agent,
          data: {
            name: env.agent,
            content: '',
            generating: true,
            compileStatus: 'compiling',
          },
          toolCallId: `build-start-${env.agent}`,
        });
        if (hasExistingAgentTabs) {
          const topologyTab = store.artifactTabs.find((tab) => tab.type === 'topology');
          if (topologyTab) {
            store.setActiveTab(topologyTab.id);
          }
        }
      } else {
        store.updateTab(existingAgentTab.id, {
          ...(existingAgentTab.data as Record<string, unknown>),
          name: env.agent,
          content: '',
          generating: true,
          compileStatus: 'compiling',
        });
      }

      updateTopologyBuildStatus(env.agent, 'generating');
      useArchUIStore.setState({
        state: 'streaming',
        statusMessage: `Generating ${env.agent}\u2026`,
      });
      return;
    }

    case 'build_agent_stage': {
      const store = useArchAIStore.getState();
      const detail = env.detail;
      appendBuildLogEntry({
        eventType: 'build_agent_stage',
        agent: env.agent,
        stage: env.stage,
        message: `${env.agent}: ${detail ?? env.stage}`,
        data: { detail },
      });
      if (env.stage === 'compiling') {
        store.setBuildStage(env.agent, 'gen', 'complete');
        store.setBuildStage(env.agent, 'comp', 'active');
        store.updateFileStatus(env.agent, 'compiling');
        store.setBuildAgentStatus(env.agent, 'parsed');
        useArchUIStore.setState({
          state: 'streaming',
          statusMessage: `Compiling ${env.agent}\u2026`,
        });
        return;
      }

      if (env.stage === 'fixing') {
        store.updateFileStatus(env.agent, 'fixing');
        store.setBuildAgentStatus(env.agent, 'fixing');
        useArchUIStore.setState({
          state: 'streaming',
          statusMessage: detail
            ? `Fixing ${env.agent}: ${detail}`
            : `Fixing compilation errors for ${env.agent}\u2026`,
        });
        return;
      }

      if (env.stage === 'recompiling') {
        store.updateFileStatus(env.agent, 'fixing');
        store.setBuildAgentStatus(env.agent, 'fixing');
        useArchUIStore.setState({
          state: 'streaming',
          statusMessage: detail ? `${env.agent}: ${detail}` : `Recompiling ${env.agent}\u2026`,
        });
        return;
      }

      if (env.stage === 'enriching') {
        const currentStatus = useArchAIStore.getState().buildState.agents[env.agent]?.status;
        store.setBuildStage(env.agent, 'comp', 'complete');
        store.setBuildStage(env.agent, 'enrich', 'active');
        store.setBuildAgentStatus(env.agent, 'validated');
        useArchUIStore.setState({
          state: 'streaming',
          statusMessage:
            currentStatus === 'error' || currentStatus === 'fixing'
              ? detail
                ? `${env.agent}: ${detail}`
                : `${env.agent} fixed successfully`
              : `Running diagnostics on ${env.agent}\u2026`,
        });
        return;
      }

      if (env.stage === 'done') {
        store.setBuildStage(env.agent, 'enrich', 'complete');
        store.setBuildStage(env.agent, 'done', 'complete');
        return;
      }

      store.setBuildStage(env.agent, 'gen', 'active');
      store.setBuildAgentStatus(env.agent, 'generating');
      useArchUIStore.setState({
        state: 'streaming',
        statusMessage: detail ? `${env.agent}: ${detail}` : `${env.agent}: ${env.stage}\u2026`,
      });
      return;
    }

    case 'build_agent_compiled': {
      const store = useArchAIStore.getState();
      appendBuildLogEntry({
        eventType: 'build_agent_compiled',
        agent: env.agent,
        message: `${env.agent} compiled in ${env.elapsed}ms`,
        data: { elapsed: env.elapsed, warnings: env.warnings, usage: env.usage },
      });
      store.setBuildStage(env.agent, 'gen', 'complete');
      store.setBuildStage(env.agent, 'comp', 'complete');
      store.setBuildStage(env.agent, 'enrich', 'complete');
      store.setBuildStage(env.agent, 'done', 'complete');
      store.setAgentElapsed(env.agent, env.elapsed);
      if (env.usage) {
        store.setAgentUsage(env.agent, env.usage);
      }
      store.setBuildAgentStatus(env.agent, 'validated', {
        warnings: env.warnings,
        toolCount: env.toolCount,
        handoffCount: env.handoffCount,
        elapsed: env.elapsed,
      });
      const summary = getLiveBuildProgressSummary();
      if (summary.total > 0) {
        useArchUIStore.setState({
          state: 'streaming',
          statusMessage: `${summary.done} of ${summary.total} agents complete`,
        });
      }
      return;
    }

    case 'build_agent_enriched': {
      return;
    }

    case 'build_agent_error': {
      const store = useArchAIStore.getState();
      appendBuildLogEntry({
        eventType: 'build_agent_error',
        agent: env.agent,
        stage: env.stage,
        message: `${env.agent} failed${env.stage ? ` during ${env.stage}` : ''}: ${env.error}`,
        data: { error: env.error },
      });
      const failingStage =
        env.stage === 'compiling' ? 'comp' : env.stage === 'enriching' ? 'enrich' : 'gen';
      store.setBuildStage(env.agent, failingStage, 'error');
      store.updateFileStatus(env.agent, 'error', [env.error]);
      store.setBuildAgentStatus(env.agent, 'error', { errors: [env.error] });
      const errorTab = store.artifactTabs.find(
        (tab) => tab.type === 'agent_code' && tab.label === env.agent,
      );
      if (errorTab) {
        store.updateTab(errorTab.id, {
          ...(errorTab.data as Record<string, unknown>),
          name:
            (typeof (errorTab.data as Record<string, unknown>)?.name === 'string'
              ? ((errorTab.data as Record<string, unknown>).name as string)
              : env.agent) ?? env.agent,
          content:
            typeof (errorTab.data as Record<string, unknown>)?.content === 'string'
              ? ((errorTab.data as Record<string, unknown>).content as string)
              : '',
          generating: false,
          compileStatus: 'error',
        });
      }
      useArchUIStore.setState({
        state: 'streaming',
        statusMessage: `Generation failed for ${env.agent}: ${env.error}`,
      });
      return;
    }

    case 'build_agent_validated': {
      const store = useArchAIStore.getState();
      appendBuildLogEntry({
        eventType: 'build_agent_validated',
        agent: env.agent,
        message: `${env.agent} validated${env.warnings.length ? ` with ${env.warnings.length} warning(s)` : ''}`,
        data: {
          warnings: env.warnings,
          toolCount: env.toolCount,
          handoffCount: env.handoffCount,
          fixRounds: env.fixRounds,
        },
      });
      store.setBuildAgentStatus(env.agent, 'validated', {
        warnings: env.warnings,
        toolCount: env.toolCount,
        handoffCount: env.handoffCount,
        fixRounds: env.fixRounds,
      });
      const summary = getLiveBuildProgressSummary();
      if (summary.total > 0) {
        useArchUIStore.setState({
          state: 'streaming',
          statusMessage: `${summary.done} of ${summary.total} agents compiled`,
        });
      }
      return;
    }

    case 'build_reconciled': {
      const store = useArchAIStore.getState();
      appendBuildLogEntry({
        eventType: 'build_reconciled',
        message: `Build reconciled: ${env.summary.compiled} compiled, ${env.summary.warnings} warnings, ${env.summary.errors} errors`,
        data: { agents: env.agents, summary: env.summary },
      });
      store.setBuildReconciled(env.agents, env.summary);
      for (const [agentName, agentState] of Object.entries(env.agents)) {
        const reconciledStatus =
          agentState.status === 'compiled'
            ? 'success'
            : agentState.status === 'warning'
              ? 'warning'
              : 'error';
        store.updateFileStatus(agentName, reconciledStatus, agentState.warnings);
        const currentState = useArchAIStore.getState();
        const tab = currentState.artifactTabs.find(
          (artifactTab) => artifactTab.type === 'agent_code' && artifactTab.label === agentName,
        );
        if (tab) {
          const file = currentState.filePanelFiles[agentName];
          currentState.updateTab(tab.id, {
            ...(tab.data as Record<string, unknown>),
            name:
              (typeof (tab.data as Record<string, unknown>)?.name === 'string'
                ? ((tab.data as Record<string, unknown>).name as string)
                : file?.displayName) ?? agentName,
            content: file?.content || file?.streamingContent || '',
            generating: false,
            compileStatus: reconciledStatus,
          });
        }
        updateTopologyBuildStatus(
          agentName,
          agentState.status === 'compiled'
            ? 'validated'
            : agentState.status === 'warning'
              ? 'warning'
              : 'error',
        );
      }

      useArchUIStore.setState({
        statusMessage:
          env.summary.errors > 0
            ? `Build complete: ${env.summary.compiled}/${env.summary.total} compiled, ${env.summary.errors} failed`
            : `All ${env.summary.total} agents compiled successfully`,
      });
      return;
    }

    case 'build_retry_start': {
      const store = useArchAIStore.getState();
      store.setBuildPhase('generating');
      appendBuildLogEntry({
        eventType: 'build_retry_start',
        message: `Retrying ${env.agents.length} failed agent(s)`,
        data: { agents: env.agents },
      });
      for (const agentName of env.agents) {
        store.setBuildAgentStatus(agentName, 'queued');
      }
      useArchUIStore.setState({
        state: 'streaming',
        statusMessage: `Retrying ${env.agents.length} agent${env.agents.length !== 1 ? 's' : ''}\u2026`,
      });
      return;
    }

    case 'build_agent_diagnostics': {
      if (env.summary.total <= 0) {
        return;
      }
      useArchUIStore.setState({
        state: 'streaming',
        statusMessage: `${env.agent}: ${env.summary.total} diagnostic finding${env.summary.total !== 1 ? 's' : ''} (${env.summary.errors} errors, ${env.summary.warnings} warnings)`,
      });
      return;
    }

    case 'done': {
      useArchUIStore.setState((s) => {
        const currentMessageId = s.currentMsgId;
        const messages = finalizeCurrentAssistantMessage(s.messages, currentMessageId, (message) =>
          env.completion ? { ...message, completion: env.completion } : message,
        );
        return {
          state: s.state === 'widget_pending' ? ('widget_pending' as const) : ('idle' as const),
          currentMsgId: null,
          statusMessage: null,
          messages,
          suggestions: mapSuggestions(env.suggestions),
          session:
            s.state === 'widget_pending'
              ? s.session
              : updateSessionPendingInteraction(s.session, null),
        };
      });
      return;
    }

    case 'error': {
      const errorPayload = normalizeEventErrorPayload(env);
      useArchUIStore.setState((s) => ({
        state: 'idle' as const,
        currentMsgId: null,
        statusMessage: null,
        messages: finalizeCurrentAssistantMessage(s.messages, s.currentMsgId),
        session:
          s.state === 'widget_pending'
            ? s.session
            : updateSessionPendingInteraction(s.session, null),
        error: {
          message: errorPayload.message,
          type: 'generic',
          recoverable: errorPayload.retryable,
        } as ArchError,
      }));
      return;
    }

    default:
      return;
  }
}

function extractWidgetPromptText(input: Record<string, unknown>): string {
  if (typeof input.question === 'string' && input.question.trim().length > 0) {
    return input.question.trim();
  }
  if (typeof input.message === 'string' && input.message.trim().length > 0) {
    return input.message.trim();
  }
  if (typeof input.description === 'string' && input.description.trim().length > 0) {
    return input.description.trim();
  }
  return '';
}

function stableWidgetValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableWidgetValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableWidgetValue(value[key])]),
    );
  }
  return value;
}

function widgetInputKey(toolName: string, input: unknown): string {
  return JSON.stringify({ toolName, input: stableWidgetValue(input) });
}

function findDuplicatePendingWidgetMessage(
  messages: ChatMessage[],
  toolName: string,
  input: unknown,
  currentMsgId: string | null,
): ChatMessage | null {
  const key = widgetInputKey(toolName, input);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.id === currentMsgId) {
      continue;
    }
    if (
      message.role !== 'assistant' ||
      !message.toolCall ||
      message.toolCall.result !== undefined
    ) {
      continue;
    }
    if (widgetInputKey(message.toolCall.toolName, message.toolCall.input) === key) {
      return message;
    }
  }
  return null;
}

function buildDuplicateWidgetState(
  state: Pick<ArchUIStore, 'messages' | 'currentMsgId' | 'session'>,
  duplicate: ChatMessage,
): Pick<ArchUIStore, 'state' | 'currentMsgId' | 'messages' | 'session'> {
  const currentMessage = state.currentMsgId
    ? state.messages.find((message) => message.id === state.currentMsgId)
    : null;
  const duplicateContent = duplicate.content.trim();
  const currentContent = currentMessage?.content.trim() ?? '';
  const shouldDropCurrent =
    currentMessage && (currentContent.length === 0 || currentContent === duplicateContent);

  return {
    state: 'widget_pending',
    currentMsgId: null,
    messages: shouldDropCurrent
      ? state.messages.filter((message) => message.id !== state.currentMsgId)
      : finalizeCurrentAssistantMessage(state.messages, state.currentMsgId),
    session: state.session,
  };
}

function isTurnEventEnvelope(value: LiveArchEvent): value is TurnEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'turnId' in value &&
    typeof value.turnId === 'string' &&
    'seq' in value &&
    typeof value.seq === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function syncPlanLifecycleState(env: Extract<TurnEvent, { type: `plan_${string}` }>): void {
  const store = useArchAIStore.getState();
  const tabId = upsertArtifactTab('plan', 'Plan', env.payload, env.eventId);
  store.setActiveTab(tabId);
  store.setOverlayState('artifacts');
}

function isKbCardMessage(value: unknown): value is KbCardMessage {
  return isRecord(value) && typeof value.type === 'string';
}

function cryptoRandomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}`;
}

/**
 * Display labels and transition reasons for specialist-change narration
 * (shown as inline status messages between assistant turns).
 *
 * Keys are specialist IDs (kebab-case), used by the `specialist` SSE event
 * arm. If the specialist is not in this map we fall back to the raw name.
 */
const SPECIALIST_DISPLAY: Record<string, string> = {
  'project-manager': 'Project Manager',
  'multi-agent-architect': 'Multi-Agent Architect',
  'abl-construct-expert': 'ABL Construct Expert',
  'integration-methodologist': 'Integration Methodologist',
  'guardrails-engineer': 'Guardrails Engineer',
  'voice-engineer': 'Voice Engineer',
  analyst: 'Analyst',
  diagnostician: 'Diagnostician',
};

function transitionReason(specialistName: string): string {
  switch (specialistName) {
    case 'integration-methodologist':
      return 'tool/connection setup';
    case 'multi-agent-architect':
      return 'topology and routing';
    case 'abl-construct-expert':
      return 'ABL construct details';
    case 'guardrails-engineer':
      return 'safety and policy';
    case 'voice-engineer':
      return 'voice configuration';
    case 'analyst':
      return 'performance review';
    case 'diagnostician':
      return 'troubleshooting';
    case 'project-manager':
      return 'project coordination';
    default:
      return 'this part of the work';
  }
}

function ensureAssistantMessage(
  state: Pick<ArchUIStore, 'messages' | 'currentMsgId'> & {
    currentSpecialist: ArchUIStore['currentSpecialist'];
  },
  specialist?: { name: string; icon: string },
): { messages: ChatMessage[]; currentMsgId: string } {
  const activeMessageId = state.currentMsgId;
  if (activeMessageId) {
    const existing = state.messages.find((message) => message.id === activeMessageId);
    if (existing) {
      return { messages: state.messages, currentMsgId: activeMessageId };
    }
  }

  const messageId = cryptoRandomId();
  return {
    currentMsgId: messageId,
    messages: [
      ...state.messages,
      {
        id: messageId,
        role: 'assistant',
        content: '',
        specialist: specialist ?? state.currentSpecialist ?? undefined,
        timestamp: new Date().toISOString(),
        isStreaming: true,
      } satisfies ChatMessage,
    ],
  };
}

function finalizeCurrentAssistantMessage(
  messages: ChatMessage[],
  currentMsgId: string | null,
  updater?: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  if (!currentMsgId) {
    return messages;
  }
  return messages.map((message) => {
    if (message.id !== currentMsgId) {
      return message;
    }
    const finalized = { ...message, isStreaming: false };
    return updater ? updater(finalized) : finalized;
  });
}

function updateSessionPhase(
  session: ArchUIStore['session'],
  phase: ArchUIPhase | string,
): ArchUIStore['session'] {
  if (!session) return session;
  const nextPhase =
    phase === 'IN_PROJECT'
      ? session.metadata.phase
      : (phase as NonNullable<ArchUIStore['session']>['metadata']['phase']);
  return {
    ...session,
    metadata: {
      ...session.metadata,
      phase: nextPhase,
    },
  };
}

type SessionPendingInteraction = NonNullable<
  ArchUIStore['session']
>['metadata']['pendingInteraction'];

function updateSessionPendingInteraction(
  session: ArchUIStore['session'],
  pendingInteraction: SessionPendingInteraction,
): ArchUIStore['session'] {
  if (!session) return session;
  return {
    ...session,
    metadata: {
      ...session.metadata,
      pendingInteraction,
    },
  };
}

function updateSessionProjectId(
  session: ArchUIStore['session'],
  projectId: string,
): ArchUIStore['session'] {
  if (!session) return session;
  return {
    ...session,
    metadata: {
      ...session.metadata,
      projectId,
    },
  };
}

function mapSuggestions(
  suggestions:
    | Array<{
        text?: string;
        label?: string;
        prompt?: string;
        description?: string;
        category?: string;
        icon?: string;
        id?: string;
      }>
    | undefined,
): ArchSuggestion[] {
  return (suggestions ?? [])
    .map((suggestion) => {
      const text =
        typeof suggestion.text === 'string'
          ? suggestion.text
          : typeof suggestion.label === 'string'
            ? suggestion.label
            : typeof suggestion.prompt === 'string'
              ? suggestion.prompt
              : '';
      if (!text) {
        return null;
      }
      return {
        id: suggestion.id ?? cryptoRandomId(),
        label: typeof suggestion.label === 'string' ? suggestion.label : text,
        description: typeof suggestion.description === 'string' ? suggestion.description : '',
        category: (suggestion.category ?? 'feature') as ArchSuggestion['category'],
        prompt: typeof suggestion.prompt === 'string' ? suggestion.prompt : text,
        icon: suggestion.icon ?? 'sparkles',
      } satisfies ArchSuggestion;
    })
    .filter((suggestion): suggestion is ArchSuggestion => suggestion !== null);
}

function appendActivityToCurrentMessage(
  messages: ChatMessage[],
  currentMsgId: string,
  event: Extract<ArchSSEEvent, { type: 'activity' }>,
): ChatMessage[] {
  const timestamp = event.timestamp;
  return messages.map((message) => {
    if (message.id !== currentMsgId) {
      return message;
    }

    const groupId = event.group ?? event.id;
    const groupLabel = event.groupLabel ?? event.label;
    const groups = [...(message.activityGroups ?? [])];
    const groupIndex = groups.findIndex((group) => group.id === groupId);
    const step = {
      id: event.id,
      status: event.status,
      label: event.label,
      detail: event.detail,
      timestamp,
    } as const;

    if (groupIndex >= 0) {
      const existing = groups[groupIndex];
      const steps = existing.steps.some((existingStep) => existingStep.id === event.id)
        ? existing.steps.map((existingStep) => (existingStep.id === event.id ? step : existingStep))
        : [...existing.steps, step];
      groups[groupIndex] = {
        ...existing,
        label: groupLabel,
        status:
          event.status === 'done' ? existing.status : event.status === 'error' ? 'error' : 'active',
        steps,
        summary: event.detail ?? existing.summary,
        endTime:
          event.status === 'done' || event.status === 'error' || event.status === 'warning'
            ? timestamp
            : existing.endTime,
      };
    } else {
      groups.push({
        id: groupId,
        label: groupLabel,
        steps: [step],
        status: event.status === 'done' ? 'done' : event.status === 'error' ? 'error' : 'active',
        summary: event.detail,
        startTime: timestamp,
        endTime:
          event.status === 'done' || event.status === 'error' || event.status === 'warning'
            ? timestamp
            : undefined,
      });
    }

    return {
      ...message,
      activityGroups: groups,
    };
  });
}

function getLiveBuildProgressSummary(): { total: number; done: number } {
  const agentStates = useArchAIStore.getState().buildState.agents;
  const total = Object.keys(agentStates).length;
  const done = Object.values(agentStates).filter(
    (agent) =>
      agent.status === 'validated' || agent.status === 'compiled' || agent.status === 'warning',
  ).length;
  return { total, done };
}

function syncArtifactPanelState(env: Extract<TurnEvent, { type: 'artifact_updated' }>): void {
  const store = useArchAIStore.getState();
  const eventId = env.eventId;
  const rawUpdate = env.update as unknown as Record<string, unknown>;
  const artifact = typeof rawUpdate.artifact === 'string' ? rawUpdate.artifact : null;

  if (artifact === 'build_progress') {
    applyCompatBuildProgress(rawUpdate);
    return;
  }

  switch (env.update.artifact) {
    case 'topology': {
      store.addArtifactVersion('topology', env.update.payload, eventId);
      const topologyTabId = upsertArtifactTab('topology', 'Topology', env.update.payload, eventId);
      const uiState = useArchUIStore.getState();
      const session = uiState.session;
      const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
      const topologyPayload =
        env.update.payload && typeof env.update.payload === 'object'
          ? (env.update.payload as Record<string, unknown>)
          : {};
      const blueprintTabId = upsertArtifactTab(
        'blueprint-document',
        'Blueprint',
        buildBlueprintDocumentArtifact({
          metadata,
          topology: topologyPayload,
          stage: session ? getBlueprintStage(session) : undefined,
          approved:
            topologyPayload.approved === true ||
            topologyPayload.locked === true ||
            metadata.topologyApproved === true,
          locked: topologyPayload.locked === true || metadata.topologyApproved === true,
        }),
        eventId,
      );
      store.setActiveTab(
        uiState.phase === 'BUILD' || uiState.phase === 'CREATE' ? topologyTabId : blueprintTabId,
      );
      store.setOverlayState('artifacts');
      invalidateCurrentProjectTopologyCache();
      return;
    }

    case 'widget': {
      syncWidgetArtifact(env.update, eventId);
      return;
    }

    case 'spec': {
      const specTabId = upsertArtifactTab('spec-document', 'Spec', env.update, eventId);
      if (useArchUIStore.getState().phase === 'INTERVIEW') {
        store.setActiveTab(specTabId);
      }
      if (store.specDocument) {
        for (const patch of env.update.patches) {
          if (patch.op === 'delete') {
            store.setSpecDocumentVersion(env.update.version);
            continue;
          }
          store.updateSpecDocument(patch.path, patch.value, env.update.version);
        }
      } else {
        store.setSpecDocumentVersion(env.update.version);
      }
      return;
    }

    case 'journal': {
      const entry = env.update.entry as Record<string, unknown>;
      store.addJournalEntry({
        type: typeof entry.type === 'string' ? entry.type : 'journal',
        summary: deriveJournalSummary(entry),
        description: deriveJournalDescription(entry),
        phase: typeof entry.phase === 'string' ? entry.phase : undefined,
      });
      upsertArtifactTab('journal', 'Journal', entry, eventId);
      return;
    }

    case 'file': {
      if (env.update.fileKind !== 'agent') return;
      syncAgentFileArtifact(env.update, eventId);
      return;
    }

    case 'build': {
      if (env.update.scope === 'agent') {
        syncBuildAgentArtifact(env.update.agent, env.update.state);
      }
      return;
    }

    case 'project': {
      store.setCreatedProjectId(env.update.payload.projectId);
      return;
    }

    case 'health': {
      const tabId = upsertArtifactTab('health', 'Health', env.update.payload, eventId);
      store.setActiveTab(tabId);
      store.setOverlayState('artifacts');
      return;
    }

    case 'diff': {
      syncDiffArtifact(env.update, eventId);
      return;
    }

    case 'plan': {
      const tabId = upsertArtifactTab('plan', 'Plan', env.update.payload, eventId);
      store.setActiveTab(tabId);
      store.setOverlayState('artifacts');
      return;
    }

    default:
      return;
  }
}

function getCurrentProjectIdForTopologyCache(): string | null {
  const projectId = useProjectStore.getState().currentProjectId;
  if (typeof projectId === 'string' && projectId.trim().length > 0) {
    return projectId;
  }

  const metadata = useArchUIStore.getState().session?.metadata;
  if (isRecord(metadata) && typeof metadata.projectId === 'string') {
    const sessionProjectId = metadata.projectId.trim();
    return sessionProjectId.length > 0 ? sessionProjectId : null;
  }

  return null;
}

function invalidateCurrentProjectTopologyCache(): void {
  const projectId = getCurrentProjectIdForTopologyCache();
  if (!projectId) {
    return;
  }

  void mutateSWR(`/api/projects/${projectId}/topology`, undefined, { revalidate: true });
}

function upsertArtifactTab(
  type:
    | 'topology'
    | 'spec-document'
    | 'journal'
    | 'summary'
    | 'agent_code'
    | 'health'
    | 'diff'
    | 'plan'
    | 'blueprint-document',
  label: string,
  data: unknown,
  toolCallId: string,
): string {
  const store = useArchAIStore.getState();
  const existing = store.artifactTabs.find((tab) => tab.type === type && tab.label === label);
  if (existing) {
    store.updateTab(existing.id, data);
    return existing.id;
  }
  return store.addTab({ type, label, data, toolCallId });
}

function upsertToolResultMessage(
  messages: ChatMessage[],
  toolCallId: string,
  toolName: string | undefined,
  result: unknown,
  specialist: ChatMessage['specialist'],
): ChatMessage[] {
  let updated = false;
  const nextMessages = messages.map((message) => {
    if (message.toolCall?.toolCallId !== toolCallId) {
      return message;
    }

    updated = true;
    return {
      ...message,
      toolCall: {
        ...message.toolCall,
        toolName: toolName ?? message.toolCall.toolName,
        result,
      },
    };
  });

  if (updated) {
    return nextMessages;
  }

  return [
    ...nextMessages,
    {
      id: cryptoRandomId(),
      role: 'assistant',
      content: '',
      specialist,
      toolCall: {
        toolCallId,
        toolName: toolName ?? 'tool_result',
        input: {},
        result,
      },
      timestamp: new Date().toISOString(),
    } satisfies ChatMessage,
  ];
}

function syncWidgetArtifact(
  update: Extract<
    Extract<TurnEvent, { type: 'artifact_updated' }>['update'],
    { artifact: 'widget' }
  >,
  eventId: string,
): void {
  switch (update.variant) {
    case 'model_comparison':
      appendToolWidgetResultMessage('recommend_model', update.payload, eventId);
      return;
    case 'constraint_coverage':
      appendToolWidgetResultMessage('analyze_constraints', update.payload, eventId);
      return;
    case 'kb_status_card':
    case 'upload_progress_card':
    case 'search_results_card':
    case 'kb_health_card':
    case 'connector_status_card':
    case 'doc_processing_card':
    case 'external_agent_card':
      if (isKbCardMessage(update.payload)) {
        syncSearchArtifact(update.payload, eventId);
        appendKbCardMessage(update.payload);
      }
      return;
    case 'integration_suggestion_card':
      if (isRecord(update.payload)) {
        appendKbCardMessage({
          ...update.payload,
          type: 'integration_suggestion_card',
        });
      }
      return;
    default:
      return;
  }
}

function appendToolWidgetResultMessage(
  toolName: 'recommend_model' | 'analyze_constraints',
  result: unknown,
  toolCallId: string,
): void {
  useArchUIStore.setState((s) => ({
    currentMsgId: null,
    messages: [
      ...finalizeCurrentAssistantMessage(s.messages, s.currentMsgId),
      {
        id: cryptoRandomId(),
        role: 'assistant',
        content: '',
        specialist: s.currentSpecialist ?? undefined,
        toolCall: {
          toolCallId,
          toolName,
          input: {},
          result,
        },
        timestamp: new Date().toISOString(),
      } satisfies ChatMessage,
    ],
  }));
}

function appendKbCardMessage(card: KbCardMessage): void {
  useArchUIStore.setState((s) => {
    const messages = finalizeCurrentAssistantMessage(s.messages, s.currentMsgId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant') {
        continue;
      }

      const nextCards = [...(message.kbCards ?? []), card];
      return {
        currentMsgId: null,
        messages: messages.map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, kbCards: nextCards } : entry,
        ),
      };
    }

    return {
      currentMsgId: null,
      messages: [
        ...messages,
        {
          id: cryptoRandomId(),
          role: 'assistant',
          content: '',
          specialist: s.currentSpecialist ?? undefined,
          kbCards: [card],
          timestamp: new Date().toISOString(),
        } satisfies ChatMessage,
      ],
    };
  });
}

function isSearchArtifactEntry(value: unknown): value is SearchArtifactEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.receivedAt === 'string' &&
    isKbCardMessage(value.card)
  );
}

function isSearchArtifactTabData(value: unknown): value is SearchArtifactTabData {
  return (
    isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => isSearchArtifactEntry(entry))
  );
}

function syncSearchArtifact(card: KbCardMessage, eventId: string): void {
  const store = useArchAIStore.getState();
  const existing = store.artifactTabs.find(
    (tab) => tab.type === 'search-ai' && tab.label === 'Search AI',
  );
  const currentEntries = isSearchArtifactTabData(existing?.data) ? existing.data.entries : [];
  const nextEntry: SearchArtifactEntry = {
    id: eventId,
    receivedAt: new Date().toISOString(),
    card,
  };
  const nextData: SearchArtifactTabData = {
    entries: [...currentEntries.filter((entry) => entry.id !== eventId), nextEntry].slice(
      -MAX_SEARCH_ARTIFACT_ENTRIES,
    ),
  };

  if (existing) {
    useArchAIStore.setState((state) => ({
      artifactTabs: state.artifactTabs.map((tab) =>
        tab.id === existing.id
          ? {
              ...tab,
              data: nextData,
              version: tab.version + 1,
              isNew: state.activeTabId === tab.id ? false : true,
            }
          : tab,
      ),
    }));
    return;
  }

  store.addTab({
    type: 'search-ai',
    label: 'Search AI',
    data: nextData,
    toolCallId: eventId,
  });
}

function syncAgentFileArtifact(
  update: Extract<Extract<TurnEvent, { type: 'artifact_updated' }>['update'], { artifact: 'file' }>,
  eventId: string,
): void {
  const store = useArchAIStore.getState();
  const label = update.agent;

  if (update.action === 'delete') {
    store.removeFile(label);
    const existing = store.artifactTabs.find(
      (tab) => tab.type === 'agent_code' && tab.label === label,
    );
    if (existing) {
      store.removeTab(existing.id);
    }
    return;
  }

  if (update.action === 'delta') {
    if (typeof update.content === 'string' && update.content.length > 0) {
      if (
        syncBlueprintDocumentFileArtifact({
          label,
          path: update.path,
          content: update.content,
          eventId,
        })
      ) {
        return;
      }

      store.appendFileContent(label, update.content);
      const current = useArchAIStore.getState().filePanelFiles[label];
      upsertArtifactTab(
        'agent_code',
        label,
        {
          name: label,
          content: current?.streamingContent ?? update.content,
          generating: true,
          compileStatus: 'compiling' as const,
        },
        eventId,
      );
    }
    return;
  }

  const content = typeof update.content === 'string' ? update.content : '';
  if (
    syncBlueprintDocumentFileArtifact({
      label,
      path: update.path,
      content,
      eventId,
    })
  ) {
    return;
  }

  store.addFile(label, content);
  store.showFilePanel();
  upsertArtifactTab(
    'agent_code',
    label,
    {
      name: label,
      content,
      generating: update.action !== 'end',
    },
    eventId,
  );
}

function syncBuildAgentArtifact(agent: string, state: Record<string, unknown>): void {
  const store = useArchAIStore.getState();
  const status = mapBuildStatus(typeof state.status === 'string' ? state.status : 'queued');
  const warnings = extractStrings(state.warnings);
  const errors = extractStrings(state.errors);
  const toolCount = typeof state.toolCount === 'number' ? state.toolCount : undefined;
  const handoffCount = typeof state.handoffCount === 'number' ? state.handoffCount : undefined;
  const elapsed = typeof state.elapsedMs === 'number' ? state.elapsedMs : undefined;
  const fixRounds = typeof state.fixRounds === 'number' ? state.fixRounds : undefined;

  store.setBuildPhase('generating');
  store.setBuildAgentStatus(agent, status, {
    warnings,
    errors,
    toolCount,
    handoffCount,
    elapsed,
    fixRounds,
  });

  const file = store.filePanelFiles[agent];
  if (file) {
    store.updateFileStatus(agent, mapFileCompileStatus(status), warnings);
  }

  updateTopologyBuildStatus(agent, status);
}

function applyCompatBuildProgress(update: Record<string, unknown>): void {
  const payload =
    typeof update.payload === 'object' && update.payload !== null
      ? (update.payload as Record<string, unknown>)
      : null;
  if (!payload) return;

  const agentName = typeof payload.agentName === 'string' ? payload.agentName : null;
  const status = typeof payload.status === 'string' ? payload.status : null;
  if (!agentName || !status) return;

  syncBuildAgentArtifact(agentName, {
    status: status === 'generated' ? 'generating' : status === 'validated' ? 'validated' : status,
    warnings: [],
    errors: status === 'error' ? ['Compilation failed'] : [],
  });
}

function updateTopologyBuildStatus(agent: string, status: BuildAgentUIStatus): void {
  const store = useArchAIStore.getState();
  const topologyTab = store.artifactTabs.find((tab) => tab.type === 'topology');
  if (!topologyTab) return;

  const currentData = (topologyTab.data ?? {}) as Record<string, unknown>;
  const currentBuildStatus =
    currentData.buildStatus && typeof currentData.buildStatus === 'object'
      ? (currentData.buildStatus as Record<string, string>)
      : {};

  store.updateTab(topologyTab.id, {
    ...currentData,
    buildStatus: {
      ...currentBuildStatus,
      [agent]: status === 'validated' ? 'compiled' : status === 'generating' ? 'generated' : status,
    },
  });
}

function mapBuildStatus(status: string): BuildAgentUIStatus {
  switch (status) {
    case 'generating':
      return 'generating';
    case 'parsed':
      return 'parsed';
    case 'fixing':
    case 'retrying':
      return 'fixing';
    case 'validated':
      return 'validated';
    case 'compiled':
      return 'compiled';
    case 'warning':
      return 'warning';
    case 'error':
    case 'interrupted':
      return 'error';
    default:
      return 'queued';
  }
}

function mapFileCompileStatus(status: BuildAgentUIStatus): FileCompileStatus {
  switch (status) {
    case 'generating':
    case 'parsed':
      return 'compiling';
    case 'fixing':
      return 'fixing';
    case 'validated':
    case 'compiled':
      return 'success';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

function extractStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function deriveJournalSummary(entry: Record<string, unknown>): string {
  if (typeof entry.summary === 'string' && entry.summary.length > 0) {
    return entry.summary;
  }

  const content =
    typeof entry.content === 'object' && entry.content !== null
      ? (entry.content as Record<string, unknown>)
      : null;
  if (content) {
    if (typeof content.summary === 'string' && content.summary.length > 0) {
      return content.summary;
    }
    if (typeof content.what === 'string' && content.what.length > 0) {
      return content.what;
    }
    if (typeof content.target === 'string' && typeof content.result === 'string') {
      return `${content.target}: ${content.result}`;
    }
  }

  if (typeof entry.type === 'string') {
    return entry.type;
  }

  return 'Journal entry';
}

function deriveJournalDescription(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.description === 'string' && entry.description.length > 0) {
    return entry.description;
  }

  const content =
    typeof entry.content === 'object' && entry.content !== null
      ? (entry.content as Record<string, unknown>)
      : null;
  if (!content) return undefined;

  if (typeof content.rationale === 'string' && content.rationale.length > 0) {
    return content.rationale;
  }
  if (typeof content.reason === 'string' && content.reason.length > 0) {
    return content.reason;
  }
  if (typeof content.to === 'string' && content.to.length > 0) {
    return content.to;
  }
  return undefined;
}

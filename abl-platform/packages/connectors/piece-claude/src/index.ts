/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPiece } from '@activepieces/pieces-framework';
import { claude as apClaude, claudeAuth } from '@activepieces/piece-claude';
import { askClaudeAction } from './actions/ask-claude';
import { extractStructuredDataAction } from './actions/extract-structured-data';

// All AP claude actions except ask_claude and extract-structured-data — replaced by URL-native versions.
const apActions = Object.values(apClaude.actions()).filter(
  (a) => a.name !== 'ask_claude' && a.name !== 'extract-structured-data',
) as never[];

export const claude = createPiece({
  displayName: 'Anthropic Claude',
  logoUrl: 'https://cdn.activepieces.com/pieces/claude.png',
  authors: [],
  description: 'AI assistant by Anthropic',
  auth: claudeAuth as any,
  actions: [...apActions, askClaudeAction as never, extractStructuredDataAction as never],
  triggers: Object.values(apClaude.triggers()) as never[],
});

export default claude;

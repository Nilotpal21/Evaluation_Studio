/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPiece } from '@activepieces/pieces-framework';
import { openai as apOpenAI, openaiAuth } from '@activepieces/piece-openai';
import { visionPromptAction } from './actions/vision-prompt';

// All AP openai actions except vision_prompt — replaced by our URL-native version.
const apActions = Object.values(apOpenAI.actions()).filter(
  (a) => a.name !== 'vision_prompt',
) as never[];

export const openai = createPiece({
  displayName: 'OpenAI',
  logoUrl: 'https://cdn.activepieces.com/pieces/openai.png',
  authors: [],
  description: 'AI language model by OpenAI',
  auth: openaiAuth as any,
  actions: [...apActions, visionPromptAction as never],
  triggers: Object.values(apOpenAI.triggers()) as never[],
});

export default openai;

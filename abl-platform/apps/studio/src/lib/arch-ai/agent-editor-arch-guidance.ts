export const AGENT_EDITOR_ARCH_GUIDANCE_STORAGE_KEY = 'abl.agent-editor.arch-guidance-enabled';

export function isAgentEditorArchGuidanceEnabled(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    return window.localStorage.getItem(AGENT_EDITOR_ARCH_GUIDANCE_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

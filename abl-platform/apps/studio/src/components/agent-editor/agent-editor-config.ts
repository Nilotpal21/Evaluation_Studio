/**
 * Agent Editor Configuration
 *
 * Developer-only config constants controlling the editor container layout.
 * Change these values in code to test different experiences.
 * NOT exposed in any settings UI.
 *
 * containerMode: global default for how the editor opens
 *   - 'slider': side panel sliding in from the right
 *   - 'modal': centered modal overlay
 *   - 'page': full-page dedicated route (navigates away)
 *
 * listViewMode: override for the agent list (table) view specifically
 *   - 'slider': opens slider overlay on top of the list (default)
 *   - 'page': navigates to a full-page editor (old behavior)
 *   - null: uses containerMode as fallback
 *
 * canvasViewMode: override for the canvas view specifically
 *   - 'slider': opens slider overlay on top of the canvas (default)
 *   - null: uses containerMode as fallback
 */

export const AGENT_EDITOR_CONFIG = {
  containerMode: 'slider' as const,

  /** How the list/table view opens the editor. Set to 'slider' for overlay behavior. */
  listViewMode: 'page' as 'slider' | 'page' | null,

  /** How the canvas view opens the editor. */
  canvasViewMode: 'slider' as 'slider' | null,

  slider: { width: 920, position: 'right' as const },
  modal: { width: 900, height: '85vh' as const },
  page: { maxWidth: 1200 },
  menu: { width: 220, collapsible: true, defaultCollapsed: false, collapsedWidth: 56 },
} as const;

export type ContainerMode = typeof AGENT_EDITOR_CONFIG.containerMode;
export type ListViewMode = typeof AGENT_EDITOR_CONFIG.listViewMode;
export type CanvasViewMode = typeof AGENT_EDITOR_CONFIG.canvasViewMode;

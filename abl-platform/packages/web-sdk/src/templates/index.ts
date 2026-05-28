/**
 * Template System Barrel
 *
 * Exports the registry, types, and utilities.
 * Renderer imports will be added in Phase 2 — the import order
 * determines registration order in the default registry.
 */

// Registry
export { TemplateRegistry, defaultRegistry, MAX_RENDERERS } from './registry.js';
export type { RendererMatch } from './registry.js';

// Types
export type { TemplateRenderer, TemplateContext } from './types.js';

// Utilities
export { isSafeUrl } from './utils/safe-url.js';
export { getString, setStrings, DEFAULT_STRINGS } from './utils/strings.js';
export {
  RICH_CONTENT_SUPPORT_SPECS,
  WEB_FALLBACK_RICH_CONTENT_TYPES,
  hasRenderableRichContentPayload,
} from './support.js';
export { extractStructuredTextPreview } from './utils/structured-preview.js';

// Renderer imports — import order determines registration order in defaultRegistry.
// These are side-effect imports: each module calls defaultRegistry.register() at load time.
import './renderers/markdown.js';
import './renderers/channel-fallback.js';
import './renderers/carousel.js';
import './renderers/image.js';
import './renderers/video.js';
import './renderers/audio.js';
import './renderers/file.js';
import './renderers/list.js';
import './renderers/kpi.js';
import './renderers/table.js';
import './renderers/chart.js';
import './renderers/form.js';
import './renderers/progress.js';
import './renderers/feedback.js';
import './renderers/actions.js';
import './renderers/quick-replies.js';

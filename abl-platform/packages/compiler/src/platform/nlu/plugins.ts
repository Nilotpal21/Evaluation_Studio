/**
 * NLU Plugin System
 *
 * Provides a pipeline for custom NLU processors that can run
 * before and after the main LLM-based NLU processing.
 *
 * Pipeline: plugins.preProcess → [embeddings → LLM → fallback] → plugins.postProcess
 */

import type { NLUPlugin, NLUPluginResult, NLUContext, NLUTask } from './types.js';
import { createLogger } from '../logger.js';

// =============================================================================
// PLUGIN PIPELINE
// =============================================================================

export class NLUPluginPipeline {
  private readonly log = createLogger('nlu-plugins');
  private plugins: NLUPlugin[];

  constructor(plugins: NLUPlugin[] = []) {
    this.plugins = plugins;
  }

  /**
   * Run pre-process plugins. Returns short-circuit result if any plugin is confident.
   */
  async preProcess(ctx: NLUContext, task: NLUTask): Promise<NLUPluginResult | null> {
    for (const plugin of this.plugins) {
      if (plugin.preProcess) {
        try {
          const result = await plugin.preProcess(ctx, task);
          if (result) {
            return result;
          }
        } catch (error) {
          // Plugin errors should not break the pipeline
          this.log.warn('NLU plugin preProcess error', {
            plugin: plugin.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return null;
  }

  /**
   * Run post-process plugins. Each plugin can modify the result.
   */
  async postProcess(ctx: NLUContext, task: NLUTask, result: unknown): Promise<unknown> {
    let current = result;

    for (const plugin of this.plugins) {
      if (plugin.postProcess) {
        try {
          current = await plugin.postProcess(ctx, task, current);
        } catch (error) {
          this.log.warn('NLU plugin postProcess error', {
            plugin: plugin.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return current;
  }

  /**
   * Register a new plugin
   */
  register(plugin: NLUPlugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Unregister a plugin by name
   */
  unregister(name: string): void {
    this.plugins = this.plugins.filter((p) => p.name !== name);
  }

  /**
   * Get list of registered plugins
   */
  getPlugins(): NLUPlugin[] {
    return [...this.plugins];
  }
}

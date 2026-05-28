/**
 * Template Registry
 *
 * Central registry for rich content template renderers.
 * Renderers self-register on import; the registry matches
 * messages to applicable renderers in registration order.
 */

import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { Message } from '../core/types.js';
import type { TemplateRenderer } from './types.js';

/** Maximum number of renderers that can be registered */
export const MAX_RENDERERS = 50;

/**
 * Structured extract failure emitted when a renderer throws during match().
 */
export interface TemplateRegistryMatchError {
  rendererType: string;
  sourceMessage: Message;
  error: Error;
}

export interface TemplateRegistryEvents {
  matchError: TemplateRegistryMatchError;
}

function normalizeMatchError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function formatMatchErrorWarning(event: TemplateRegistryMatchError): string {
  return [
    `[rich-content] extract() failed for renderer "${event.rendererType}" on message "${event.sourceMessage.id}"`,
    `message: ${event.error.message}`,
    `stack: ${event.error.stack ?? '(no stack available)'}`,
  ].join('\n');
}

/**
 * A matched renderer paired with the data it extracted from a message.
 */
export interface RendererMatch<T = unknown> {
  renderer: TemplateRenderer<T>;
  data: T;
}

/**
 * Registry for rich content template renderers.
 *
 * Renderers are stored in registration order. `match()` iterates
 * all registered renderers and returns those whose `extract()`
 * returns a defined value, preserving registration order.
 */
export class TemplateRegistry extends TypedEventEmitter<TemplateRegistryEvents> {
  private renderers: TemplateRenderer[] = [];

  /**
   * Register a template renderer.
   *
   * @throws Error if the maximum number of renderers has been reached.
   */
  register<T>(renderer: TemplateRenderer<T>): void {
    if (this.renderers.length >= MAX_RENDERERS) {
      throw new Error(
        `TemplateRegistry: cannot register renderer "${renderer.type}" — maximum of ${MAX_RENDERERS} renderers reached`,
      );
    }
    this.renderers.push(renderer as TemplateRenderer);
  }

  /**
   * Match a message against all registered renderers.
   *
   * Returns an array of `{ renderer, data }` pairs for every renderer
   * whose `extract()` returned a defined value, in registration order.
   */
  match(message: Message): RendererMatch[] {
    const matches: RendererMatch[] = [];
    for (const renderer of this.renderers) {
      try {
        const data = renderer.extract(message);
        if (data !== undefined) {
          matches.push({ renderer, data });
        }
      } catch (error) {
        const matchError: TemplateRegistryMatchError = {
          rendererType: renderer.type,
          sourceMessage: message,
          error: normalizeMatchError(error),
        };
        // eslint-disable-next-line no-console
        console.warn(formatMatchErrorWarning(matchError));
        this.emit('matchError', matchError);
      }
    }
    return matches;
  }

  /**
   * Return the count of currently registered renderers.
   */
  get size(): number {
    return this.renderers.length;
  }
}

/** Default singleton registry used by the SDK */
export const defaultRegistry = new TemplateRegistry();

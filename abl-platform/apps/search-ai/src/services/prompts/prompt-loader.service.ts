/**
 * Prompt Loader Service - NFR-4
 *
 * Dynamic prompt loading with version management for maintainability.
 *
 * **Key Features:**
 * - Load prompts by name and version from YAML files
 * - In-memory caching of loaded prompts
 * - Load latest version of prompts
 * - Render prompts with variable substitution
 * - Scan for available versions
 *
 * **Usage:**
 * ```typescript
 * const loader = new PromptLoaderService();
 * const prompt = loader.loadPrompt('critical-field-detection', 2);
 * const rendered = loader.renderPrompt(prompt.system_prompt, { domain: 'Jira' });
 * ```
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '@abl/compiler/platform';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('PromptLoader');

// ─── Types ───────────────────────────────────────────────────────────────

export interface PromptMetadata {
  version: number;
  author: string;
  created: string;
  description: string;
  model: string;
  performance: {
    max_latency_ms: number;
    max_tokens: number;
  };
}

export interface PromptDefinition {
  metadata: PromptMetadata;
  system_prompt: string;
  user_prompt_template?: string;
  tool?: any;
  test_cases?: any[];
  changelog?: any[];
}

// ─── Service ─────────────────────────────────────────────────────────────

/**
 * Prompt Loader Service with version management and caching
 *
 * IMPLEMENTS:
 * - NFR-4: Prompt versioning for maintainability
 * - In-memory caching for performance
 * - Dynamic loading from YAML files
 * - Variable substitution for prompt rendering
 */
export class PromptLoaderService {
  private promptsDir: string;
  private loadedPrompts: Map<string, PromptDefinition>;

  constructor() {
    // Prompts are stored in apps/search-ai/src/prompts/
    this.promptsDir = join(__dirname, '../../prompts');
    this.loadedPrompts = new Map();

    logger.info('PromptLoaderService initialized', { promptsDir: this.promptsDir });
  }

  /**
   * Load prompt by name and version
   *
   * @param name - Prompt name (e.g., 'critical-field-detection')
   * @param version - Prompt version (defaults to 1)
   * @returns Loaded prompt definition
   * @throws Error if prompt file not found
   */
  loadPrompt(name: string, version: number = 1): PromptDefinition {
    const cacheKey = `${name}:v${version}`;

    // Check cache
    if (this.loadedPrompts.has(cacheKey)) {
      logger.debug('Prompt cache hit', { name, version });
      return this.loadedPrompts.get(cacheKey)!;
    }

    // Load from file
    const promptPath = join(this.promptsDir, `v${version}`, `${name}.yaml`);

    try {
      const fileContent = readFileSync(promptPath, 'utf-8');
      const promptData = parseYaml(fileContent);

      const prompt: PromptDefinition = {
        metadata: {
          version: promptData.version,
          author: promptData.author,
          created: promptData.created,
          description: promptData.description,
          model: promptData.model,
          performance: promptData.performance,
        },
        system_prompt: promptData.system_prompt,
        user_prompt_template: promptData.user_prompt_template,
        tool: promptData.tool,
        test_cases: promptData.test_cases,
        changelog: promptData.changelog,
      };

      // Cache prompt
      this.loadedPrompts.set(cacheKey, prompt);

      logger.info('Prompt loaded from file', { name, version, path: promptPath });

      return prompt;
    } catch (error) {
      logger.error('Failed to load prompt', {
        name,
        version,
        path: promptPath,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new Error(`Prompt not found: ${name} v${version}`);
    }
  }

  /**
   * Get latest version of prompt
   *
   * Scans the prompts directory for all available versions and loads the latest
   *
   * @param name - Prompt name
   * @returns Latest version of the prompt
   * @throws Error if no versions found
   */
  loadLatestPrompt(name: string): PromptDefinition {
    // Scan prompts directory for latest version
    const versions = this.getAvailableVersions(name);

    if (versions.length === 0) {
      const error = new Error(`No versions found for prompt: ${name}`);
      logger.error('No versions found for prompt', { name });
      throw error;
    }

    const latestVersion = Math.max(...versions);

    logger.debug('Loading latest prompt version', { name, latestVersion });

    return this.loadPrompt(name, latestVersion);
  }

  /**
   * Get all available versions for a prompt
   *
   * Scans the prompts directory (v1/, v2/, v3/, etc.) and checks for the
   * existence of the prompt file in each version directory
   *
   * @param name - Prompt name
   * @returns Sorted array of available version numbers
   */
  private getAvailableVersions(name: string): number[] {
    const versions: number[] = [];

    try {
      // Check if prompts directory exists
      if (!existsSync(this.promptsDir)) {
        logger.warn('Prompts directory does not exist', { promptsDir: this.promptsDir });
        return versions;
      }

      const versionDirs = readdirSync(this.promptsDir);

      for (const dir of versionDirs) {
        // Match version directories: v1, v2, v3, etc.
        if (dir.match(/^v\d+$/)) {
          const version = parseInt(dir.substring(1), 10);
          const promptPath = join(this.promptsDir, dir, `${name}.yaml`);

          if (existsSync(promptPath)) {
            versions.push(version);
          }
        }
      }

      logger.debug('Available versions scanned', {
        name,
        versions: versions.sort((a, b) => a - b),
      });
    } catch (error) {
      logger.error('Failed to scan prompt versions', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return versions.sort((a, b) => a - b);
  }

  /**
   * Render prompt with variables
   *
   * Simple placeholder replacement: {variable} -> value
   *
   * @param template - Prompt template with {placeholders}
   * @param variables - Key-value pairs for substitution
   * @returns Rendered prompt string
   */
  renderPrompt(template: string, variables: Record<string, any>): string {
    let rendered = template;

    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{${key}}`;
      rendered = rendered.replace(
        new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        String(value),
      );
    }

    logger.debug('Prompt rendered', {
      variableCount: Object.keys(variables).length,
      templateLength: template.length,
      renderedLength: rendered.length,
    });

    return rendered;
  }

  /**
   * Clear cache for all prompts or specific prompt
   *
   * Useful for testing or when prompts are updated at runtime
   *
   * @param name - Optional prompt name to clear specific prompt
   */
  clearCache(name?: string): void {
    if (name) {
      // Clear all versions of a specific prompt
      const keysToDelete: string[] = [];
      for (const key of this.loadedPrompts.keys()) {
        if (key.startsWith(`${name}:`)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach((key) => this.loadedPrompts.delete(key));

      logger.info('Prompt cache cleared for specific prompt', {
        name,
        keysCleared: keysToDelete.length,
      });
    } else {
      // Clear all cached prompts
      const size = this.loadedPrompts.size;
      this.loadedPrompts.clear();

      logger.info('All prompt caches cleared', { keysCleared: size });
    }
  }

  /**
   * Get cache statistics
   *
   * Useful for monitoring and debugging
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.loadedPrompts.size,
      keys: Array.from(this.loadedPrompts.keys()),
    };
  }
}

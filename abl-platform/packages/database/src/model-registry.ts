/**
 * Model Registry for Database Affinity
 *
 * Manages model-to-database binding for dual-database scenarios (SearchAI).
 *
 * Database Affinity:
 * - 'platform' (default): abl_platform - application config, user data, KB metadata
 * - 'searchaicontent': search_ai - search content (chunks, documents, embeddings)
 *
 * Usage:
 * - Runtime/Studio: Models use default mongoose connection (no registry needed)
 * - SearchAI: Uses registry to bind models to two separate databases
 * - Tests: Models use default mongoose connection (no registry needed)
 */

import type { Connection, Schema, Model } from 'mongoose';

export type DatabaseAffinity = 'platform' | 'searchaicontent';

interface ModelDefinition {
  name: string;
  schema: Schema;
  affinity: DatabaseAffinity;
}

export class ModelRegistry {
  private static modelDefinitions = new Map<string, ModelDefinition>();

  /**
   * Register a model definition with its schema and database affinity
   * Called automatically when models are imported
   */
  static registerModelDefinition(
    name: string,
    schema: Schema,
    affinity: DatabaseAffinity = 'platform',
  ): void {
    this.modelDefinitions.set(name, {
      name,
      schema,
      affinity,
    });
  }

  /**
   * Get all models for SearchAI content database
   */
  static getSearchAIContentModels(): ModelDefinition[] {
    return Array.from(this.modelDefinitions.values()).filter(
      (def) => def.affinity === 'searchaicontent',
    );
  }

  /**
   * Get all models for platform database (default)
   */
  static getPlatformModels(): ModelDefinition[] {
    return Array.from(this.modelDefinitions.values()).filter((def) => def.affinity === 'platform');
  }

  /**
   * Bind models to their appropriate connections
   *
   * Used ONLY by SearchAI to set up dual-database environment.
   * Runtime/Studio/Tests don't call this - they use default mongoose connection.
   *
   * @param platformConn - Connection to abl_platform database
   * @param searchaiContentConn - Connection to search_ai database
   * @returns Object mapping model names to bound model instances
   */
  static bindModelsForSearchAI(
    platformConn: Connection,
    searchaiContentConn: Connection,
  ): Record<string, Model<any>> {
    const models: Record<string, Model<any>> = {};

    // Bind platform models to platform connection (abl_platform)
    for (const def of this.getPlatformModels()) {
      models[def.name] = platformConn.model(def.name, def.schema);
    }

    // Bind SearchAI content models to content connection (search_ai)
    for (const def of this.getSearchAIContentModels()) {
      models[def.name] = searchaiContentConn.model(def.name, def.schema);
    }

    return models;
  }

  /**
   * Get model definition by name
   */
  static getModelDefinition(name: string): ModelDefinition | undefined {
    return this.modelDefinitions.get(name);
  }

  /**
   * Check if a model has been registered
   */
  static hasModel(name: string): boolean {
    return this.modelDefinitions.has(name);
  }

  /**
   * Get all registered model names
   */
  static getModelNames(): string[] {
    return Array.from(this.modelDefinitions.keys());
  }

  /**
   * Clear registry (for testing)
   */
  static clear(): void {
    this.modelDefinitions.clear();
  }
}

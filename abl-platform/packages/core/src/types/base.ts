/**
 * Core base types for Agent ABL
 */

/**
 * Unique identifier for ABL elements
 */
export type ElementId = string;

/**
 * Version string in semver format
 */
export type Version = `${number}.${number}.${number}`;

/**
 * ABL document kinds
 */
export type DocumentKind =
  | 'supervisor'
  | 'agent'
  | 'agent-based'
  | 'behavior_profile'
  | 'contract'
  | 'config';

/**
 * Base document metadata
 */
export interface DocumentMeta {
  id: ElementId;
  kind: DocumentKind;
  version: Version;
  name: string;
  description?: string;
  author?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Primitive types supported in ABL
 */
export type PrimitiveType = 'string' | 'number' | 'boolean' | 'date' | 'datetime';

/**
 * Complex types
 */
export type ComplexType =
  | { kind: 'array'; itemType: TypeDefinition }
  | { kind: 'object'; properties: Record<string, TypeDefinition> }
  | { kind: 'enum'; values: string[] }
  | { kind: 'union'; types: TypeDefinition[] }
  | { kind: 'nullable'; innerType: TypeDefinition };

/**
 * Full type definition
 */
export type TypeDefinition = PrimitiveType | ComplexType;

/**
 * Variable source types
 */
export type VariableSource = 'system' | 'user' | 'agent' | 'computed';

/**
 * Variable definition with type and metadata
 */
export interface VariableDefinition {
  name: string;
  type: TypeDefinition;
  default?: unknown;
  required: boolean;
  description?: string;
  source?: VariableSource;
  updatedBy?: string[]; // List of agents that can update this
}

/**
 * Helper function to check if a type is primitive
 */
export function isPrimitiveType(type: TypeDefinition): type is PrimitiveType {
  return typeof type === 'string';
}

/**
 * Helper function to check if a type is complex
 */
export function isComplexType(type: TypeDefinition): type is ComplexType {
  return typeof type === 'object' && 'kind' in type;
}

/**
 * Parse a version string
 */
export function parseVersion(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Create a new document meta with defaults
 */
export function createDocumentMeta(
  kind: DocumentKind,
  name: string,
  options: Partial<Omit<DocumentMeta, 'kind' | 'name' | 'createdAt' | 'updatedAt'>> = {},
): DocumentMeta {
  const now = new Date();
  return {
    id: options.id ?? crypto.randomUUID(),
    kind,
    version: options.version ?? '1.0.0',
    name,
    description: options.description,
    author: options.author,
    createdAt: now,
    updatedAt: now,
  };
}

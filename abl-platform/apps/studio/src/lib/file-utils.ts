/**
 * File Upload Utilities for Arch AI (Phase 2)
 *
 * Phase 1: Basic text file extraction ✓
 * Phase 2: Structured parsing (OpenAPI, JSON Schema) ✓
 *
 * Handles client-side file processing for multi-modal chat:
 * - Content extraction (text, JSON, YAML)
 * - Size validation & MIME type checking
 * - Intelligent parsing for known formats (OpenAPI, JSON Schema)
 * - Structured context formatting for LLM
 * - Data URL conversion for AI SDK attachments
 */

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const SUPPORTED_TEXT_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
  'application/x-yaml',
  'text/yaml',
];

export interface FileAttachment {
  name: string;
  contentType: string;
  url: string; // data URL for inline content
}

export interface FileMetadata {
  type: 'openapi' | 'json-schema' | 'json' | 'yaml' | 'markdown' | 'text';
  summary?: string;
  details?: {
    version?: string;
    title?: string;
    endpointCount?: number;
    schemaCount?: number;
    operationCount?: number;
  };
}

/**
 * Extract file content with intelligent parsing and structured formatting
 */
export async function extractFileContent(file: File): Promise<FileAttachment> {
  // Validate size
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB (max 10MB)`);
  }

  // Validate type
  const isTextFile =
    SUPPORTED_TEXT_TYPES.includes(file.type) ||
    file.name.endsWith('.md') ||
    file.name.endsWith('.txt');
  const isJsonFile = file.name.endsWith('.json') || file.type === 'application/json';
  const isYamlFile = file.name.endsWith('.yaml') || file.name.endsWith('.yml');

  if (!isTextFile && !isJsonFile && !isYamlFile) {
    throw new Error(
      `Unsupported file type: ${file.type || 'unknown'}. Supported: .txt, .md, .json, .yaml, .yml`,
    );
  }

  // Read file content
  let content: string;
  try {
    content = await readAsText(file);
  } catch (err) {
    throw new Error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse and analyze content
  let parsedContent: unknown;
  let metadata: FileMetadata | null = null;

  if (isJsonFile) {
    try {
      parsedContent = JSON.parse(content);
      metadata = analyzeJsonContent(parsedContent, file.name);
    } catch (err) {
      throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (isYamlFile) {
    try {
      const yaml = await import('yaml');
      parsedContent = yaml.parse(content);
      metadata = analyzeJsonContent(parsedContent, file.name);
    } catch (err) {
      throw new Error(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Create structured context with metadata
  const formattedContent = metadata
    ? createStructuredContext(file.name, content, metadata)
    : content;

  // Convert to data URL for AI SDK experimental_attachments
  const contentType = file.type || detectContentType(file.name);
  const base64Content = btoa(unescape(encodeURIComponent(formattedContent)));

  return {
    name: file.name,
    contentType,
    url: `data:${contentType};base64,${base64Content}`,
  };
}

/**
 * Analyze JSON/YAML content to detect type and extract metadata
 */
function analyzeJsonContent(content: unknown, filename: string): FileMetadata | null {
  if (typeof content !== 'object' || content === null) {
    return { type: 'json' };
  }

  const obj = content as Record<string, unknown>;

  // Detect OpenAPI specification
  if ('openapi' in obj || 'swagger' in obj) {
    const version = (obj.openapi as string) || (obj.swagger as string);
    const info = obj.info as Record<string, unknown> | undefined;
    const paths = obj.paths as Record<string, unknown> | undefined;
    const components = obj.components as Record<string, unknown> | undefined;

    let endpointCount = 0;
    let operationCount = 0;

    if (paths && typeof paths === 'object') {
      endpointCount = Object.keys(paths).length;
      for (const path of Object.values(paths)) {
        if (typeof path === 'object' && path !== null) {
          operationCount += Object.keys(path).filter((k) =>
            ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(k),
          ).length;
        }
      }
    }

    let schemaCount = 0;
    if (components && typeof components === 'object') {
      const schemas = (components as any).schemas;
      if (schemas && typeof schemas === 'object') {
        schemaCount = Object.keys(schemas).length;
      }
    }

    return {
      type: 'openapi',
      summary: `OpenAPI ${version} specification: ${endpointCount} endpoints, ${operationCount} operations, ${schemaCount} schemas`,
      details: {
        version,
        title: info?.title as string,
        endpointCount,
        operationCount,
        schemaCount,
      },
    };
  }

  // Detect JSON Schema
  if ('$schema' in obj || ('type' in obj && 'properties' in obj)) {
    const title = obj.title as string | undefined;
    const schemaVersion = obj.$schema as string | undefined;
    const type = obj.type as string | undefined;

    return {
      type: 'json-schema',
      summary: `JSON Schema${title ? `: ${title}` : ''} (type: ${type || 'unknown'})`,
      details: {
        version: schemaVersion,
        title,
      },
    };
  }

  // Generic JSON
  return { type: 'json' };
}

/**
 * Create structured context format for LLM
 */
function createStructuredContext(
  filename: string,
  content: string,
  metadata: FileMetadata,
): string {
  const lines = [
    `[File: ${filename}]`,
    metadata.type === 'openapi'
      ? 'Type: OpenAPI Specification'
      : metadata.type === 'json-schema'
        ? 'Type: JSON Schema'
        : `Type: ${metadata.type.toUpperCase()}`,
  ];

  if (metadata.summary) {
    lines.push(`Summary: ${metadata.summary}`);
  }

  if (metadata.details) {
    if (metadata.details.title) lines.push(`Title: ${metadata.details.title}`);
    if (metadata.details.version) lines.push(`Version: ${metadata.details.version}`);
  }

  lines.push('', content, '', '[End File]');

  return lines.join('\n');
}

/**
 * Read file as text using FileReader API
 */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/**
 * Detect content type from file extension
 */
function detectContentType(filename: string): string {
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'application/x-yaml';
  if (filename.endsWith('.md')) return 'text/markdown';
  return 'text/plain';
}

/**
 * Batch process multiple files with intelligent parsing
 */
export async function extractMultipleFiles(files: File[]): Promise<FileAttachment[]> {
  const MAX_FILES = 5;
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files: ${files.length} (max ${MAX_FILES})`);
  }

  const results = await Promise.allSettled(files.map(extractFileContent));

  const attachments: FileAttachment[] = [];
  const errors: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      attachments.push(result.value);
    } else {
      errors.push(`${files[i].name}: ${result.reason.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`File processing errors:\n${errors.join('\n')}`);
  }

  return attachments;
}

import { z } from 'zod';

export interface ProjectIOPromptLibraryVersion {
  versionId: string;
  versionNumber: number;
  template: string;
  variables: string[];
  description?: string;
  status: 'draft' | 'active' | 'archived';
  sourceHash: string;
  publishedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectIOPromptLibraryBundle {
  promptId: string;
  name: string;
  description?: string;
  tags: string[];
  status: 'active' | 'archived';
  nextVersionNumber: number;
  versions: ProjectIOPromptLibraryVersion[];
}

const promptLibraryVersionSchema = z
  .object({
    versionId: z.string().min(1),
    versionNumber: z.number().int().min(1),
    template: z.string(),
    variables: z.array(z.string()).default([]),
    description: z.string().optional(),
    status: z.enum(['draft', 'active', 'archived']),
    sourceHash: z.string().min(1),
    publishedAt: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const promptLibraryBundleSchema = z
  .object({
    promptId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    status: z.enum(['active', 'archived']),
    nextVersionNumber: z.number().int().min(0),
    versions: z.array(promptLibraryVersionSchema),
  })
  .strict();

const PROMPT_BUNDLE_FILE_PATH_PATTERN = /^prompts\/[^/]+\.prompt\.json$/;

function sanitizePromptFileName(promptName: string): string {
  return promptName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

export function promptBundleFilePath(promptName: string): string {
  return `prompts/${sanitizePromptFileName(promptName)}.prompt.json`;
}

export function isPromptBundleFilePath(filePath: string): boolean {
  return PROMPT_BUNDLE_FILE_PATH_PATTERN.test(filePath);
}

export function serializePromptLibraryBundleForFile(bundle: ProjectIOPromptLibraryBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function parsePromptLibraryBundleFile(
  filePath: string,
  content: string,
): { success: true; data: ProjectIOPromptLibraryBundle } | { success: false; error: string } {
  if (!isPromptBundleFilePath(filePath)) {
    return {
      success: false,
      error: `Invalid prompt bundle path "${filePath}"`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    return {
      success: false,
      error: `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const validated = promptLibraryBundleSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      success: false,
      error: `Invalid prompt bundle in ${filePath}: ${validated.error.message}`,
    };
  }

  return {
    success: true,
    data: validated.data,
  };
}

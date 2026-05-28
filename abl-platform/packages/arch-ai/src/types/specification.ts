/**
 * Specification types — Contract: specification-schema.md
 * The term "brief" is DEPRECATED. Use "specification" everywhere.
 */

import { z } from 'zod';

export const CONVERSATION_NOTE_CATEGORIES = [
  'compliance',
  'integration',
  'sla',
  'channel',
  'escalation',
  'general',
] as const;

export type ConversationNoteCategory = (typeof CONVERSATION_NOTE_CATEGORIES)[number];

export const ConversationNoteSchema = z.object({
  icon: z.string(),
  label: z.string().min(1),
  detail: z.string().min(1),
  category: z.enum(CONVERSATION_NOTE_CATEGORIES),
});

export type ConversationNote = z.infer<typeof ConversationNoteSchema>;

// Contract 3 specifies z.date(). Using z.coerce.date() so JSON strings
// from MongoDB/API are accepted and coerced to Date objects.
export const FileRefSchema = z.object({
  name: z.string().min(1),
  size: z.number(),
  type: z.string(),
  uploadedAt: z.coerce.date(),
});

export type FileRef = z.infer<typeof FileRefSchema>;

/**
 * Storage schema — allows empty projectName (in-progress specification).
 *
 * Contract 3 specifies projectName as z.string().min(1).max(100) but also
 * defines the default as projectName: ''. These are contradictory.
 * Resolution: the storage schema allows empty (specs start empty and fill
 * during Interview). Completeness is enforced by canExitInterview() which
 * checks projectName.trim().length > 0 before phase transition.
 */
export const SpecificationSchema = z.object({
  version: z.number().int().min(1),
  projectName: z
    .string()
    .max(100)
    .default('')
    .transform((s) => s.trim()),
  description: z.string().max(500).nullable().default(null),
  channels: z.array(z.string()).default([]),
  language: z.string().default('English'),
  uploadedFiles: z.array(FileRefSchema).default([]),
  conversationNotes: z.array(ConversationNoteSchema).default([]),
});

/**
 * Validation schema — used at phase exit to ensure spec is complete.
 * This matches contract 3's literal Zod schema with min(1) on projectName.
 */
export const CompleteSpecificationSchema = z.object({
  version: z.number().int().min(1),
  projectName: z.string().min(1).max(100),
  description: z.string().max(500).nullable().default(null),
  channels: z.array(z.string()).default([]),
  language: z.string().default('English'),
  uploadedFiles: z.array(FileRefSchema).default([]),
  conversationNotes: z.array(ConversationNoteSchema).default([]),
});

export type Specification = z.infer<typeof SpecificationSchema>;

export function createDefaultSpecification(): Specification {
  return {
    version: 1,
    projectName: '',
    description: null,
    channels: [],
    language: 'English',
    uploadedFiles: [],
    conversationNotes: [],
  };
}

export function canExitInterview(spec: Specification): boolean {
  return spec.projectName.trim().length > 0;
}

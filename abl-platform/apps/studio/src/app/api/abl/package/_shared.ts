import { z } from 'zod';

const MAX_FILE_COUNT = 500;
const MAX_FILE_SIZE_CHARS = 1024 * 1024;

const packageFilesBaseSchema = z
  .object({
    files: z.record(z.string()).describe('Relative archive path -> UTF-8 file content'),
  })
  .strict();

function validateFileRecord(value: { files: Record<string, string> }, ctx: z.RefinementCtx): void {
  const entries = Object.entries(value.files);
  if (entries.length > MAX_FILE_COUNT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: `Too many files (max ${MAX_FILE_COUNT})`,
    });
  }

  for (const [filePath, content] of entries) {
    if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\0')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files', filePath],
        message: `Invalid file path: ${filePath}`,
      });
    }

    if (content.length > MAX_FILE_SIZE_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files', filePath],
        message: `File too large (max 1MB): ${filePath}`,
      });
    }
  }
}

export const packageFilesSchema = packageFilesBaseSchema.superRefine(validateFileRecord);

export const transcriptDiagnosisSchema = packageFilesBaseSchema
  .extend({
    transcript: z.unknown(),
  })
  .strict()
  .superRefine(validateFileRecord);

export type PackageFilesBody = z.infer<typeof packageFilesSchema>;
export type TranscriptDiagnosisBody = z.infer<typeof transcriptDiagnosisSchema>;

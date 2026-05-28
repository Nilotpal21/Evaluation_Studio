import { z } from 'zod';

/** OAuth launch widget input — server side schema validation */
export const oauthLaunchInputSchema = z.object({
  authProfileId: z.string().min(1),
  authProfileRef: z.string().min(1),
  connectorName: z.string().min(1),
  connectionMode: z.enum(['shared', 'per_user']),
  scopes: z.array(z.string()),
  requirementKey: z.string().optional(),
  environment: z.string().nullable().optional(),
  providerLabel: z.string().min(1),
});

/** Integration plan widget input — server side schema validation */
export const integrationPlanInputSchema = z.object({
  steps: z.array(z.object({ id: z.string().min(1), description: z.string() })),
  rationale: z.string().optional(),
});

/** Client-side tool schemas (no execute — stop for user interaction) */
export const askUserSchema = z.object({
  question: z.string().describe('The question to display'),
  widgetType: z
    .enum([
      'SingleSelect',
      'MultiSelect',
      'TextInput',
      'Confirmation',
      'OAuthLaunch',
      'IntegrationPlan',
    ])
    .describe('Widget type'),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe('Options for Select widgets'),
  allowCustom: z.boolean().optional().describe('Allow custom text entry'),
  defaultValue: z
    .string()
    .optional()
    .describe('Initial value for TextInput or SingleSelect when a draft is known'),
  defaultValues: z
    .array(z.string())
    .optional()
    .describe('Initial selected values for MultiSelect when a draft is known'),
  placeholder: z.string().optional().describe('Placeholder for TextInput'),
  multiline: z.boolean().optional().describe('Multiline TextInput'),
  confirmLabel: z.string().optional().describe('Confirm button label'),
  denyLabel: z.string().optional().describe('Deny button label'),
  minSelect: z.number().optional().describe('Min selections for MultiSelect'),
  maxSelect: z.number().optional().describe('Max selections for MultiSelect'),
});

export const collectFileSchema = z.object({
  message: z.string().describe('Prompt message'),
  accept: z.array(z.string()).optional().describe('Allowed MIME types'),
  maxFiles: z.number().optional().describe('Max files'),
});

export const updateSpecSchema = z.object({
  field: z
    .enum(['projectName', 'description', 'channels', 'language'])
    .optional()
    .describe('Spec field to update'),
  value: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Value for the field (string for projectName/description/language, string[] for channels)',
    ),
  note: z
    .object({
      icon: z.string().describe('Emoji icon'),
      label: z.string().describe('Short label'),
      detail: z.string().describe('Detailed description'),
      category: z.enum(['compliance', 'integration', 'sla', 'channel', 'escalation', 'general']),
    })
    .optional()
    .describe('Conversation note'),
});

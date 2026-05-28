/**
 * Variable Namespace Model
 *
 * Organizational grouping for environment variables and config variables.
 * Many-to-many relationship with variables via VariableNamespaceMembership.
 * Each project has an auto-created "default" namespace that cannot be deleted.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

/**
 * Accepted color values for a variable namespace.
 *
 * The canonical token list lives in `@agent-platform/design-tokens` as
 * `NAMESPACE_COLOR_TOKENS` (the UI resolves these to themed CSS at render
 * time). It is duplicated here to keep the database package free of a
 * presentation-layer dependency; the parity contract test in
 * `__tests__/variable-namespace-color-tokens.test.ts` fails if the two
 * lists drift.
 *
 * Legacy 6-digit hex values are also accepted so namespaces persisted
 * before the token migration continue to validate.
 */
const NAMESPACE_COLOR_TOKENS = [
  'accent',
  'success',
  'warning',
  'purple',
  'info',
  'error',
  'orange',
] as const;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isValidNamespaceColor(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  return (
    (NAMESPACE_COLOR_TOKENS as readonly string[]).includes(value) || HEX_COLOR_PATTERN.test(value)
  );
}

export { NAMESPACE_COLOR_TOKENS as VARIABLE_NAMESPACE_COLOR_TOKENS };

// ─── Document Interface ──────────────────────────────────────────────────

export interface IVariableNamespace {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  order: number;
  isDefault: boolean;
  createdBy: string;
  updatedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const VariableNamespaceSchema = new Schema<IVariableNamespace>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    description: { type: String, default: null },
    icon: { type: String, default: null },
    color: {
      type: String,
      default: null,
      validate: {
        validator: (v: string | null) => isValidNamespaceColor(v),
        message:
          'Color must be a namespace color token or a 6-digit hex color (e.g. #1a2b3c), or null',
      },
    },
    order: { type: Number, required: true, default: 0 },
    isDefault: { type: Boolean, required: true, default: false },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'variable_namespaces' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

VariableNamespaceSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

VariableNamespaceSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
VariableNamespaceSchema.index({ tenantId: 1, projectId: 1, order: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const VariableNamespace =
  (mongoose.models.VariableNamespace as any) ||
  model<IVariableNamespace>('VariableNamespace', VariableNamespaceSchema);

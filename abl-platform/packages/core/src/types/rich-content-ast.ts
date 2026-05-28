/**
 * Rich Content Template AST Sub-Types
 *
 * These interfaces define the AST (camelCase) representations of
 * the 12 rich content template types. They are imported and
 * re-exported from agent-based.ts.
 *
 * Naming convention: camelCase field names (AST convention).
 * The compiler transforms these to snake_case IR equivalents.
 */

import type { ActionElementAST } from './agent-based.js';

export interface RichContentCollectionBindingAST<TItem> {
  from: string;
  template?: TItem;
}

export type RichContentCollectionAST<TItem> =
  | TItem[]
  | RichContentCollectionBindingAST<TItem>
  | string;

// =============================================================================
// TIER 1: Basic Templates (AST)
// =============================================================================

export interface QuickReplyAST {
  id: string;
  label: string;
  iconUrl?: string;
}

export interface ListTemplateAST {
  title?: string;
  items: RichContentCollectionAST<ListItemAST>;
}

export interface ListItemAST {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  defaultActionUrl?: string;
}

export interface MediaContentAST {
  url: string;
  alt?: string;
  thumbnailUrl?: string;
  caption?: string;
}

export interface FileContentAST {
  url: string;
  filename: string;
  sizeBytes?: number;
  mimeType?: string;
}

// =============================================================================
// TIER 2: Data-Rich Templates (AST)
// =============================================================================

export interface KPITemplateAST {
  label: string;
  value: string | number;
  unit?: string;
  trend?: 'up' | 'down' | 'flat';
  iconUrl?: string;
}

export interface TableTemplateAST {
  columns: RichContentCollectionAST<TableColumnAST>;
  rows: RichContentCollectionAST<Record<string, string | number>>;
  maxVisibleRows?: number;
}

export interface TableColumnAST {
  key: string;
  header: string;
  align?: 'left' | 'center' | 'right';
}

export interface ChartTemplateAST {
  type: 'bar' | 'line' | 'pie';
  title?: string;
  data: RichContentCollectionAST<ChartDataPointAST>;
}

export interface ChartDataPointAST {
  label: string;
  value: string | number;
  color?: string;
}

export interface FormTemplateAST {
  title?: string;
  fields: RichContentCollectionAST<ActionElementAST>;
  submitLabel?: string;
}

export interface ProgressTemplateAST {
  label?: string;
  value: number;
  max?: number;
  variant?: 'bar' | 'circle';
}

export interface FeedbackTemplateAST {
  prompt: string;
  type: 'thumbs' | 'stars' | 'scale';
  max?: number;
}

/**
 * Lean ID Plugin
 *
 * Adds `id` field (aliasing `_id`) to lean query results.
 * Mongoose `.lean()` strips virtuals, so the `id` virtual getter
 * is lost. This plugin re-adds it via post hooks on query operations.
 *
 * This is essential because the rest of the codebase
 * uses `id` — not `_id` — everywhere.
 */

import type { Schema } from 'mongoose';

function addId(doc: any): void {
  if (doc && doc._id != null && doc.id == null) {
    doc.id = typeof doc._id === 'object' ? doc._id.toString() : doc._id;
  }
}

function processResult(result: any): void {
  if (Array.isArray(result)) {
    result.forEach(addId);
  } else if (result) {
    addId(result);
  }
}

export function leanIdPlugin(schema: Schema): void {
  // Post hooks for all query types that may return lean documents
  const queryTypes = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
  ] as const;

  for (const queryType of queryTypes) {
    schema.post(queryType, function postLeanId(result: any) {
      // Only process lean results — full Mongoose docs already have the `id` virtual
      if ((this as any).mongooseOptions().lean) {
        processResult(result);
      }
    });
  }
}

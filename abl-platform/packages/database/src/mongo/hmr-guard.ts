/**
 * HMR Guard for Mongoose Models
 *
 * In Next.js dev mode, module hot-reload re-evaluates model files,
 * causing OverwriteModelError when model() is called for an already-registered name.
 * This module clears all registered models so they can be safely re-registered.
 *
 * MUST be imported BEFORE any model file in the barrel export (ESM evaluates
 * imports in source-text order, so placement matters).
 */
import mongoose from 'mongoose';

if (process.env.NODE_ENV !== 'production') {
  mongoose.deleteModel(/.*/);
}

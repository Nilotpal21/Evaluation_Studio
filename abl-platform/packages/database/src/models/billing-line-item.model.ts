/**
 * Billing Line Item Model
 *
 * Tracks individual billing line items for a deal within a billing period.
 * Supports base charges, overage fees, add-ons, and credit top-ups.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IBillingLineItem {
  _id: string;
  dealId: string;
  periodLabel: string;
  description: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  category: 'base' | 'overage' | 'addon' | 'credit_topup';
  invoiced: boolean;
  invoiceId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const BillingLineItemSchema = new Schema<IBillingLineItem>(
  {
    _id: { type: String, default: uuidv7 },
    dealId: { type: String, required: true },
    periodLabel: { type: String, required: true },
    description: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    category: {
      type: String,
      enum: ['base', 'overage', 'addon', 'credit_topup'],
      required: true,
    },
    invoiced: { type: Boolean, default: false },
    invoiceId: { type: String, default: undefined },
  },
  { timestamps: true, collection: 'billing_line_items' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

BillingLineItemSchema.index({ dealId: 1, periodLabel: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const BillingLineItem =
  (mongoose.models.BillingLineItem as any) ||
  model<IBillingLineItem>('BillingLineItem', BillingLineItemSchema);

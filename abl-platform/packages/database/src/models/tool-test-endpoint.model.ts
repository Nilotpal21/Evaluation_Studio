/**
 * Tool Test Endpoint Model
 *
 * Stores the Studio-hosted public Test API companion metadata for a single
 * project tool. Public routes resolve requests by capability hash, while the
 * raw capabilities are retained so Studio can reconstruct stable public URLs.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

export const TOOL_TEST_ENDPOINT_STATUSES = ['active', 'disabled', 'rotated'] as const;
export type ToolTestEndpointStatus = (typeof TOOL_TEST_ENDPOINT_STATUSES)[number];

export const TOOL_TEST_RESPONSE_MODES = ['static_json'] as const;
export type ToolTestResponseMode = (typeof TOOL_TEST_RESPONSE_MODES)[number];

const CAPABILITY_HASH_REGEX = /^[a-f0-9]{64}$/;
const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;
const MAX_CAPABILITY_LENGTH = 255;

export interface IToolTestEndpoint {
  _id: string;
  tenantId: string;
  projectId: string;
  projectToolId: string;
  toolName: string;
  invokeCapability: string;
  invokeCapabilityHash: string;
  specCapability: string;
  specCapabilityHash: string;
  status: ToolTestEndpointStatus;
  responseMode: ToolTestResponseMode;
  staticResponse: unknown;
  sampleInput: Record<string, unknown> | null;
  createdBy: string;
  lastEditedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const ToolTestEndpointSchema = new Schema<IToolTestEndpoint>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    projectToolId: { type: String, required: true },
    toolName: {
      type: String,
      required: true,
      minlength: 2,
      maxlength: 64,
      match: TOOL_NAME_REGEX,
      trim: true,
      lowercase: true,
    },
    invokeCapability: {
      type: String,
      required: true,
      maxlength: MAX_CAPABILITY_LENGTH,
    },
    invokeCapabilityHash: {
      type: String,
      required: true,
      match: CAPABILITY_HASH_REGEX,
    },
    specCapability: {
      type: String,
      required: true,
      maxlength: MAX_CAPABILITY_LENGTH,
    },
    specCapabilityHash: {
      type: String,
      required: true,
      match: CAPABILITY_HASH_REGEX,
    },
    status: {
      type: String,
      enum: TOOL_TEST_ENDPOINT_STATUSES,
      default: 'active',
    },
    responseMode: {
      type: String,
      enum: TOOL_TEST_RESPONSE_MODES,
      default: 'static_json',
    },
    staticResponse: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    sampleInput: {
      type: Schema.Types.Mixed,
      default: null,
    },
    createdBy: { type: String, required: true },
    lastEditedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tool_test_endpoints' },
);

ToolTestEndpointSchema.plugin(tenantIsolationPlugin);

ToolTestEndpointSchema.index({ tenantId: 1, projectId: 1, projectToolId: 1 }, { unique: true });
ToolTestEndpointSchema.index({ invokeCapabilityHash: 1 }, { unique: true });
ToolTestEndpointSchema.index({ specCapabilityHash: 1 }, { unique: true });
ToolTestEndpointSchema.index({ tenantId: 1, projectId: 1, toolName: 1 });
ToolTestEndpointSchema.index({ tenantId: 1, projectId: 1, status: 1 });

export const ToolTestEndpoint =
  (mongoose.models.ToolTestEndpoint as mongoose.Model<IToolTestEndpoint>) ||
  model<IToolTestEndpoint>('ToolTestEndpoint', ToolTestEndpointSchema);

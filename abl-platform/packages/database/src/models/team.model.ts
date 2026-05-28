/**
 * Team Model
 *
 * Teams allow group ownership of agents. A team has members with roles
 * (lead or member), and can be assigned as the owner of agents in a project.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITeamMember {
  userId: string;
  role: 'lead' | 'member';
  addedBy: string;
  addedAt: Date;
}

export interface ITeam {
  _id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  members: ITeamMember[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TeamMemberSchema = new Schema<ITeamMember>(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ['lead', 'member'], required: true },
    addedBy: { type: String, required: true },
    addedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const TeamSchema = new Schema<ITeam>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    description: { type: String, default: null },
    members: { type: [TeamMemberSchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'teams' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

TeamSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
TeamSchema.index({ tenantId: 1, name: 1 }, { unique: true });
TeamSchema.index({ 'members.userId': 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

TeamSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const Team = (mongoose.models.Team as any) || model<ITeam>('Team', TeamSchema);

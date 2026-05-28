/**
 * Arch Conversation Model
 *
 * Persists Arch AI assistant conversation history per user per project.
 * These are developer-to-Arch chats — completely separate from end-user
 * runtime sessions (Session model).
 *
 * Keyed by (userId, projectId) — each user gets their own conversation
 * per project, private and not shared with teammates.
 *
 * Messages are stored as an embedded array with a max cap. Older messages
 * beyond the cap are folded into a summary preamble by the client before
 * saving (see arch-store.ts compactConversation).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '@agent-platform/database/mongo';

// ─── Constants ──────────────────────────────────────────────────────────

/** Max messages stored per conversation document */
const MAX_STORED_MESSAGES = 100;

// ─── Embedded Subdocument: Message ──────────────────────────────────────

export interface IArchMessage {
  id: string;
  role: 'arch' | 'user';
  content: string;
  timestamp: string;
  agentName?: string;
}

const ArchMessageSubSchema = new Schema<IArchMessage>(
  {
    id: { type: String, required: true },
    role: { type: String, required: true, enum: ['arch', 'user'] },
    content: { type: String, required: true },
    timestamp: { type: String, required: true },
    agentName: { type: String, default: undefined },
  },
  { _id: false },
);

// ─── Document Interface ────────────────────────────────────────────────

export interface IArchConversationRecord {
  _id: string;
  userId: string;
  projectId: string;
  messages: IArchMessage[];
  lastActivityAt: Date;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ────────────────────────────────────────────────────────────

const ArchConversationSchema = new Schema<IArchConversationRecord>(
  {
    _id: { type: String, default: uuidv7 },
    userId: { type: String, required: true },
    projectId: { type: String, required: true },
    messages: {
      type: [ArchMessageSubSchema],
      default: [],
      validate: {
        validator: (msgs: IArchMessage[]) => msgs.length <= MAX_STORED_MESSAGES,
        message: `Conversation exceeds max ${MAX_STORED_MESSAGES} messages — compact before saving`,
      },
    },
    lastActivityAt: { type: Date, default: () => new Date() },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'arch_conversations_v4' },
);

// ─── Indexes ───────────────────────────────────────────────────────────

// Primary lookup: one conversation per user per project
ArchConversationSchema.index({ userId: 1, projectId: 1 }, { unique: true });

// Find all conversations for a user (e.g., cleanup, listing)
ArchConversationSchema.index({ userId: 1, lastActivityAt: -1 });

// Find all conversations for a project (e.g., project deletion cascade)
ArchConversationSchema.index({ projectId: 1 });

// ─── Model ─────────────────────────────────────────────────────────────

export const ArchConversationModel =
  (mongoose.models.ArchConversationModel as any) ||
  model<IArchConversationRecord>('ArchConversationModel', ArchConversationSchema);

import mongoose, { Schema, Document } from 'mongoose';

export interface IEvaluationTagConfig extends Document {
  tenantId: string;
  projectId: string;
  tag: string;
  direction: 'higher_is_better' | 'lower_is_better';
  threshold: number;
  displayName?: string;
  description?: string;
}

const evaluationTagConfigSchema = new Schema<IEvaluationTagConfig>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    tag: { type: String, required: true },
    direction: {
      type: String,
      enum: ['higher_is_better', 'lower_is_better'],
      default: 'higher_is_better',
    },
    threshold: { type: Number, required: true },
    displayName: { type: String },
    description: { type: String },
  },
  { timestamps: true },
);

evaluationTagConfigSchema.index({ tenantId: 1, projectId: 1, tag: 1 }, { unique: true });

export const EvaluationTagConfig = mongoose.model<IEvaluationTagConfig>(
  'EvaluationTagConfig',
  evaluationTagConfigSchema,
);

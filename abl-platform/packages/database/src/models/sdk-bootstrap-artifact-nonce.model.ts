import mongoose, { Schema, model } from 'mongoose';

export interface ISDKBootstrapArtifactNonce {
  _id: string;
  tenantId: string;
  projectId: string;
  channelId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SDKBootstrapArtifactNonceSchema = new Schema<ISDKBootstrapArtifactNonce>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    channelId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'sdk_bootstrap_artifact_nonces' },
);

SDKBootstrapArtifactNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
SDKBootstrapArtifactNonceSchema.index({ tenantId: 1, projectId: 1, channelId: 1 });

export const SDKBootstrapArtifactNonce =
  (mongoose.models.SDKBootstrapArtifactNonce as any) ||
  model<ISDKBootstrapArtifactNonce>('SDKBootstrapArtifactNonce', SDKBootstrapArtifactNonceSchema);

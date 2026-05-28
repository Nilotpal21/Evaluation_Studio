export function getModelCapabilitiesUrl(modelId: string): string {
  return `/api/model-capabilities?modelId=${encodeURIComponent(modelId)}`;
}

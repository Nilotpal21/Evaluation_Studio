import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_SIDECAR_CONTRACT_SCHEMA,
  CLASSIFIER_SIDECAR_REQUEST_FIXTURE,
  CLASSIFIER_SIDECAR_RESPONSE_FIXTURE,
  isClassifierSidecarRequest,
  isClassifierSidecarResponse,
} from '../classifier-sidecar-contract.js';

describe('classifier sidecar contract', () => {
  it('accepts the canonical request and response fixtures', () => {
    expect(isClassifierSidecarRequest(CLASSIFIER_SIDECAR_REQUEST_FIXTURE)).toBe(true);
    expect(isClassifierSidecarResponse(CLASSIFIER_SIDECAR_RESPONSE_FIXTURE)).toBe(true);
  });

  it('rejects renamed request and response fields', () => {
    const invalidRequest = {
      ...CLASSIFIER_SIDECAR_REQUEST_FIXTURE,
      topK: CLASSIFIER_SIDECAR_REQUEST_FIXTURE.top_k,
    };
    delete (invalidRequest as Record<string, unknown>).top_k;

    const invalidResponse = {
      ...CLASSIFIER_SIDECAR_RESPONSE_FIXTURE,
      selected: CLASSIFIER_SIDECAR_RESPONSE_FIXTURE.selected
        ? {
            ...CLASSIFIER_SIDECAR_RESPONSE_FIXTURE.selected,
            matchedText: CLASSIFIER_SIDECAR_RESPONSE_FIXTURE.selected.matched_text,
          }
        : null,
      topK: CLASSIFIER_SIDECAR_RESPONSE_FIXTURE.top_k,
    };
    delete (invalidResponse as Record<string, unknown>).top_k;
    if (invalidResponse.selected && typeof invalidResponse.selected === 'object') {
      delete (invalidResponse.selected as Record<string, unknown>).matched_text;
    }

    expect(isClassifierSidecarRequest(invalidRequest)).toBe(false);
    expect(isClassifierSidecarResponse(invalidResponse)).toBe(false);
  });

  it('locks request and response schemas as closed objects', () => {
    const schema = CLASSIFIER_SIDECAR_CONTRACT_SCHEMA as {
      $defs: Record<string, { additionalProperties?: boolean; required?: string[] }>;
      required?: string[];
    };

    expect(schema.required).toEqual(['request', 'response']);
    expect(schema.$defs.request.additionalProperties).toBe(false);
    expect(schema.$defs.response.additionalProperties).toBe(false);
    expect(schema.$defs.request.required).toEqual(
      expect.arrayContaining([
        'text',
        'locale',
        'task',
        'top_k',
        'threshold',
        'candidates',
        'tenantId',
        'projectId',
        'sessionId',
      ]),
    );
    expect(schema.$defs.response.required).toEqual(
      expect.arrayContaining([
        'accepted',
        'threshold',
        'selected',
        'top_k',
        'tenantId',
        'projectId',
        'sessionId',
      ]),
    );
  });
});

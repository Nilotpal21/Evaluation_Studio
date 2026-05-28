// Keep the schema as raw JSON in this explicit contract file so both the
// TypeScript tests and the Python sidecar can lock against the exact same
// payload without extra barrel/package wiring.
const CLASSIFIER_SIDECAR_CONTRACT_SCHEMA_JSON = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-platform.dev/schemas/classifier-sidecar-contract.v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["request", "response"],
  "properties": {
    "request": {
      "$ref": "#/$defs/request"
    },
    "response": {
      "$ref": "#/$defs/response"
    }
  },
  "$defs": {
    "nonEmptyString": {
      "type": "string",
      "minLength": 1
    },
    "score": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "candidate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "phrases", "examples", "keywords"],
      "properties": {
        "id": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "phrases": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/nonEmptyString"
          }
        },
        "examples": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/nonEmptyString"
          }
        },
        "keywords": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/nonEmptyString"
          }
        }
      }
    },
    "scoreEntry": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "score"],
      "properties": {
        "id": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "score": {
          "$ref": "#/$defs/score"
        }
      }
    },
    "selectedMatch": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "score", "matched_text"],
      "properties": {
        "id": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "score": {
          "$ref": "#/$defs/score"
        },
        "matched_text": {
          "$ref": "#/$defs/nonEmptyString"
        }
      }
    },
    "request": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "text",
        "locale",
        "task",
        "top_k",
        "threshold",
        "candidates",
        "tenantId",
        "projectId",
        "sessionId"
      ],
      "properties": {
        "text": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "locale": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "task": {
          "type": "string",
          "const": "flow_escape"
        },
        "top_k": {
          "type": "integer",
          "minimum": 1
        },
        "threshold": {
          "$ref": "#/$defs/score"
        },
        "candidates": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/candidate"
          }
        },
        "tenantId": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "projectId": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "sessionId": {
          "$ref": "#/$defs/nonEmptyString"
        }
      }
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "accepted",
        "threshold",
        "selected",
        "top_k",
        "tenantId",
        "projectId",
        "sessionId"
      ],
      "properties": {
        "accepted": {
          "type": "boolean"
        },
        "threshold": {
          "$ref": "#/$defs/score"
        },
        "selected": {
          "oneOf": [
            {
              "$ref": "#/$defs/selectedMatch"
            },
            {
              "type": "null"
            }
          ]
        },
        "top_k": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/scoreEntry"
          }
        },
        "tenantId": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "projectId": {
          "$ref": "#/$defs/nonEmptyString"
        },
        "sessionId": {
          "$ref": "#/$defs/nonEmptyString"
        }
      }
    }
  }
}` as const;

export const CLASSIFIER_SIDECAR_TASKS = ['flow_escape'] as const;
export type ClassifierSidecarTask = (typeof CLASSIFIER_SIDECAR_TASKS)[number];

export interface ClassifierSidecarCandidate {
  id: string;
  phrases: string[];
  examples: string[];
  keywords: string[];
}

export interface ClassifierSidecarRequest {
  text: string;
  locale: string;
  task: ClassifierSidecarTask;
  top_k: number;
  threshold: number;
  candidates: ClassifierSidecarCandidate[];
  tenantId: string;
  projectId: string;
  sessionId: string;
}

export interface ClassifierSidecarTopKEntry {
  id: string;
  score: number;
}

export interface ClassifierSidecarSelectedMatch extends ClassifierSidecarTopKEntry {
  matched_text: string;
}

export interface ClassifierSidecarResponse {
  accepted: boolean;
  threshold: number;
  selected: ClassifierSidecarSelectedMatch | null;
  top_k: ClassifierSidecarTopKEntry[];
  tenantId: string;
  projectId: string;
  sessionId: string;
}

export const CLASSIFIER_SIDECAR_CONTRACT_SCHEMA = JSON.parse(
  CLASSIFIER_SIDECAR_CONTRACT_SCHEMA_JSON,
) as Record<string, unknown>;

export const CLASSIFIER_SIDECAR_REQUEST_FIXTURE: ClassifierSidecarRequest = {
  text: 'get atms near me',
  locale: 'en',
  task: 'flow_escape',
  top_k: 3,
  threshold: 0.76,
  candidates: [
    {
      id: 'atm_locator',
      phrases: ['atm locator', 'find atm'],
      examples: ['Find an ATM near me', 'Where is the nearest cash machine?'],
      keywords: ['atm', 'cash machine', 'branch'],
    },
    {
      id: 'speak_to_agent',
      phrases: ['talk to a person', 'speak to an agent'],
      examples: ['I need to talk to someone', 'Can I reach support?'],
      keywords: ['agent', 'representative', 'support'],
    },
  ],
  tenantId: 'tenant-1',
  projectId: 'project-1',
  sessionId: 'session-1',
};

export const CLASSIFIER_SIDECAR_RESPONSE_FIXTURE: ClassifierSidecarResponse = {
  accepted: true,
  threshold: 0.76,
  selected: {
    id: 'atm_locator',
    score: 0.84,
    matched_text: 'Find an ATM near me',
  },
  top_k: [
    {
      id: 'atm_locator',
      score: 0.84,
    },
    {
      id: 'speak_to_agent',
      score: 0.29,
    },
  ],
  tenantId: 'tenant-1',
  projectId: 'project-1',
  sessionId: 'session-1',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isClassifierSidecarCandidate(value: unknown): value is ClassifierSidecarCandidate {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isStringArray(value.phrases) &&
    isStringArray(value.examples) &&
    isStringArray(value.keywords) &&
    Object.keys(value).length === 4
  );
}

export function isClassifierSidecarRequest(value: unknown): value is ClassifierSidecarRequest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.text) &&
    isNonEmptyString(value.locale) &&
    CLASSIFIER_SIDECAR_TASKS.includes(value.task as ClassifierSidecarTask) &&
    typeof value.top_k === 'number' &&
    Number.isInteger(value.top_k) &&
    value.top_k >= 1 &&
    isScore(value.threshold) &&
    Array.isArray(value.candidates) &&
    value.candidates.length >= 1 &&
    value.candidates.every(isClassifierSidecarCandidate) &&
    isNonEmptyString(value.tenantId) &&
    isNonEmptyString(value.projectId) &&
    isNonEmptyString(value.sessionId) &&
    Object.keys(value).length === 9
  );
}

export function isClassifierSidecarTopKEntry(value: unknown): value is ClassifierSidecarTopKEntry {
  if (!isRecord(value)) {
    return false;
  }

  return isNonEmptyString(value.id) && isScore(value.score) && Object.keys(value).length === 2;
}

export function isClassifierSidecarSelectedMatch(
  value: unknown,
): value is ClassifierSidecarSelectedMatch {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isScore(value.score) &&
    isNonEmptyString(value.matched_text) &&
    Object.keys(value).length === 3
  );
}

export function isClassifierSidecarResponse(value: unknown): value is ClassifierSidecarResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.accepted === 'boolean' &&
    isScore(value.threshold) &&
    (value.selected === null || isClassifierSidecarSelectedMatch(value.selected)) &&
    Array.isArray(value.top_k) &&
    value.top_k.length >= 1 &&
    value.top_k.every(isClassifierSidecarTopKEntry) &&
    isNonEmptyString(value.tenantId) &&
    isNonEmptyString(value.projectId) &&
    isNonEmptyString(value.sessionId) &&
    Object.keys(value).length === 7
  );
}

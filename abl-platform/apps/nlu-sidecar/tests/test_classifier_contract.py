from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict

import pytest
from pydantic import ValidationError

import app as sidecar_app
from app import (
    app,
    SemanticMatchRequest,
    SemanticMatchResponse,
    load_classifier_sidecar_contract_schema,
)


TENANCY_HEADERS = {
    'x-abl-tenant-id': 'tenant-1',
    'x-abl-project-id': 'project-1',
    'x-abl-session-id': 'session-1',
    'Content-Type': 'application/json',
}

SEMANTIC_MATCH_REQUEST = {
    'text': 'get atms near me',
    'locale': 'en',
    'task': 'flow_escape',
    'top_k': 3,
    'threshold': 0.76,
    'candidates': [
        {
            'id': 'atm_locator',
            'phrases': ['atm locator', 'find atm'],
            'examples': ['Find an ATM near me'],
            'keywords': ['atm', 'branch'],
        },
        {
            'id': 'speak_to_agent',
            'phrases': ['talk to an agent'],
            'examples': ['I need support'],
            'keywords': ['agent', 'support'],
        },
    ],
    'tenantId': 'tenant-1',
    'projectId': 'project-1',
    'sessionId': 'session-1',
}


@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


@pytest.fixture(autouse=True)
def _reset_backend_flags(monkeypatch):
    monkeypatch.setattr(sidecar_app, 'SEMANTIC_MATCH_BACKEND_ENABLED', False)
    yield


def _normalize_schema(schema: Dict[str, Any], defs: Dict[str, Any]) -> Dict[str, Any]:
    if '$ref' in schema:
        ref_name = schema['$ref'].split('/')[-1]
        return _normalize_schema(defs[ref_name], defs)

    if 'anyOf' in schema:
        return {'variants': [_normalize_schema(item, defs) for item in schema['anyOf']]}

    if 'oneOf' in schema:
        return {'variants': [_normalize_schema(item, defs) for item in schema['oneOf']]}

    normalized: Dict[str, Any] = {}

    if 'type' in schema:
        normalized['type'] = schema['type']

    if 'const' in schema:
        normalized['const'] = schema['const']

    if 'minimum' in schema:
        normalized['minimum'] = (
            float(schema['minimum']) if schema.get('type') == 'number' else schema['minimum']
        )

    if 'maximum' in schema:
        normalized['maximum'] = (
            float(schema['maximum']) if schema.get('type') == 'number' else schema['maximum']
        )

    if 'minLength' in schema:
        normalized['minLength'] = schema['minLength']

    if 'minItems' in schema:
        normalized['minItems'] = schema['minItems']

    if schema.get('type') == 'object':
        normalized['additionalProperties'] = schema.get('additionalProperties', True)
        normalized['required'] = sorted(schema.get('required', []))
        normalized['properties'] = {
            key: _normalize_schema(value, defs)
            for key, value in sorted(schema.get('properties', {}).items())
        }

    if schema.get('type') == 'array':
        normalized['items'] = _normalize_schema(schema['items'], defs)

    return normalized


def test_semantic_match_request_schema_matches_shared_contract():
    shared_schema = load_classifier_sidecar_contract_schema()
    pydantic_schema = SemanticMatchRequest.model_json_schema()

    assert _normalize_schema(shared_schema['$defs']['request'], shared_schema['$defs']) == _normalize_schema(
        pydantic_schema,
        pydantic_schema.get('$defs', {}),
    )


def test_semantic_match_response_schema_matches_shared_contract():
    shared_schema = load_classifier_sidecar_contract_schema()
    pydantic_schema = SemanticMatchResponse.model_json_schema()

    assert _normalize_schema(shared_schema['$defs']['response'], shared_schema['$defs']) == _normalize_schema(
        pydantic_schema,
        pydantic_schema.get('$defs', {}),
    )


def test_semantic_match_rejects_renamed_request_fields():
    invalid_request = deepcopy(SEMANTIC_MATCH_REQUEST)
    invalid_request['topK'] = invalid_request.pop('top_k')

    with pytest.raises(ValidationError):
        SemanticMatchRequest.model_validate(invalid_request)


def test_semantic_match_round_trips_contract_when_backend_enabled(client, monkeypatch):
    monkeypatch.setattr(sidecar_app, 'SEMANTIC_MATCH_BACKEND_ENABLED', True)

    response = client.post(
        '/semantic-match',
        headers=TENANCY_HEADERS,
        json=SEMANTIC_MATCH_REQUEST,
    )

    assert response.status_code == 200
    payload = response.json
    SemanticMatchResponse.model_validate(payload)
    assert payload == {
        'accepted': False,
        'threshold': 0.76,
        'selected': None,
        'top_k': [
            {'id': 'atm_locator', 'score': 0.0},
            {'id': 'speak_to_agent', 'score': 0.0},
        ],
        'tenantId': 'tenant-1',
        'projectId': 'project-1',
        'sessionId': 'session-1',
    }

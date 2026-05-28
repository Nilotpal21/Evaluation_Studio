"""Tests for the NLU sidecar Flask app.

Covers the hardened contract (Slice 1/6 — Gather Interrupt Semantic Routing):
  * tenancy headers required on every tenanted route (400 otherwise)
  * tenancy in body must agree with headers (400 otherwise)
  * strict pydantic validation of /extract and /detect-correction bodies
  * 501 Not Implemented when the ML backend is not configured, with the
    stable `NLU_SIDECAR_NOT_IMPLEMENTED` error code
  * structured JSON logs carry tenantId/projectId/sessionId per request
"""
from __future__ import annotations

import json
import logging
from typing import Dict

import pytest

import app as sidecar_app
from app import app


TENANCY_HEADERS = {
    'x-abl-tenant-id': 'tenant-1',
    'x-abl-project-id': 'project-1',
    'x-abl-session-id': 'session-1',
    'Content-Type': 'application/json',
}

TENANCY_BODY = {
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
    # Default to "backend not configured" so 501 is the observed behavior
    # unless a test flips the flag.
    monkeypatch.setattr(sidecar_app, 'EXTRACT_BACKEND_ENABLED', False)
    monkeypatch.setattr(sidecar_app, 'CORRECTION_BACKEND_ENABLED', False)
    yield


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


def test_health_returns_ok_without_tenancy(client):
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json == {'status': 'ok'}


# ---------------------------------------------------------------------------
# Tenancy enforcement
# ---------------------------------------------------------------------------


def test_extract_rejects_missing_tenancy_headers(client):
    response = client.post(
        '/extract',
        json={'text': 'hi', 'fields': [], 'locale': 'en', **TENANCY_BODY},
    )
    assert response.status_code == 400
    assert response.json['error']['code'] == 'NLU_SIDECAR_MISSING_TENANCY'


def test_detect_correction_rejects_missing_tenancy_headers(client):
    response = client.post(
        '/detect-correction',
        json={'text': 'hi', 'context': {}, 'locale': 'en', **TENANCY_BODY},
    )
    assert response.status_code == 400
    assert response.json['error']['code'] == 'NLU_SIDECAR_MISSING_TENANCY'


def test_extract_rejects_tenancy_body_header_mismatch(client):
    body = {
        'text': 'hi',
        'fields': [],
        'locale': 'en',
        'tenantId': 'tenant-OTHER',
        'projectId': 'project-1',
        'sessionId': 'session-1',
    }
    response = client.post('/extract', json=body, headers=TENANCY_HEADERS)
    assert response.status_code == 400
    assert response.json['error']['code'] == 'NLU_SIDECAR_TENANCY_MISMATCH'


# ---------------------------------------------------------------------------
# Pydantic validation
# ---------------------------------------------------------------------------


def test_extract_rejects_missing_required_fields(client):
    # text missing
    response = client.post(
        '/extract',
        json={'fields': [], 'locale': 'en', **TENANCY_BODY},
        headers=TENANCY_HEADERS,
    )
    assert response.status_code == 400
    assert response.json['error']['code'] == 'NLU_SIDECAR_INVALID_REQUEST'


def test_extract_rejects_unknown_fields(client):
    body = {
        'text': 'hi',
        'fields': [],
        'locale': 'en',
        'unexpected': 'nope',
        **TENANCY_BODY,
    }
    response = client.post('/extract', json=body, headers=TENANCY_HEADERS)
    assert response.status_code == 400
    assert response.json['error']['code'] == 'NLU_SIDECAR_INVALID_REQUEST'


# ---------------------------------------------------------------------------
# 501 when backend disabled
# ---------------------------------------------------------------------------


def test_extract_returns_501_when_backend_disabled(client):
    body = {'text': 'I want to go to Paris', 'fields': [], 'locale': 'en', **TENANCY_BODY}
    response = client.post('/extract', json=body, headers=TENANCY_HEADERS)
    assert response.status_code == 501
    assert response.json['error']['code'] == 'NLU_SIDECAR_NOT_IMPLEMENTED'


def test_detect_correction_returns_501_when_backend_disabled(client):
    body = {
        'text': 'actually Barcelona',
        'context': {'destination': 'Paris'},
        'locale': 'en',
        **TENANCY_BODY,
    }
    response = client.post('/detect-correction', json=body, headers=TENANCY_HEADERS)
    assert response.status_code == 501
    assert response.json['error']['code'] == 'NLU_SIDECAR_NOT_IMPLEMENTED'


# ---------------------------------------------------------------------------
# 200 when backend enabled (stub path — returns empty entities for now)
# ---------------------------------------------------------------------------


def test_extract_returns_200_with_tenancy_echoed_when_backend_enabled(client, monkeypatch):
    monkeypatch.setattr(sidecar_app, 'EXTRACT_BACKEND_ENABLED', True)
    body = {'text': 'hello', 'fields': [], 'locale': 'en', **TENANCY_BODY}
    response = client.post('/extract', json=body, headers=TENANCY_HEADERS)
    assert response.status_code == 200
    payload = response.json
    assert payload['entities'] == {}
    assert payload['confidence'] == {}
    # Tenancy must round-trip so runtime can audit the correlation.
    assert payload['tenantId'] == 'tenant-1'
    assert payload['projectId'] == 'project-1'
    assert payload['sessionId'] == 'session-1'


def test_detect_correction_returns_200_with_tenancy_echoed_when_backend_enabled(
    client, monkeypatch
):
    monkeypatch.setattr(sidecar_app, 'CORRECTION_BACKEND_ENABLED', True)
    body = {'text': 'hello', 'context': {}, 'locale': 'en', **TENANCY_BODY}
    response = client.post('/detect-correction', json=body, headers=TENANCY_HEADERS)
    assert response.status_code == 200
    payload = response.json
    assert payload['is_correction'] is False
    assert payload['confidence'] == 0.0
    assert payload['tenantId'] == 'tenant-1'
    assert payload['projectId'] == 'project-1'
    assert payload['sessionId'] == 'session-1'


# ---------------------------------------------------------------------------
# Structured logging carries tenancy
# ---------------------------------------------------------------------------


def test_structured_log_carries_tenancy(client, caplog):
    # The `nlu-sidecar` logger intentionally has `propagate=False` in
    # production so it doesn't double-log through the root handler. That
    # means pytest's default caplog (which hooks root) cannot see records.
    # Attach caplog's handler directly to the named logger for this test.
    sidecar_logger = logging.getLogger('nlu-sidecar')
    sidecar_logger.addHandler(caplog.handler)
    caplog.set_level(logging.INFO, logger='nlu-sidecar')
    try:
        body = {'text': 'hello', 'fields': [], 'locale': 'en', **TENANCY_BODY}
        client.post('/extract', json=body, headers=TENANCY_HEADERS)

        tenancy_logs = [
            record
            for record in caplog.records
            if record.name == 'nlu-sidecar' and getattr(record, 'tenantId', None) == 'tenant-1'
        ]
        assert tenancy_logs, 'expected at least one log record tagged with tenantId'
        for record in tenancy_logs:
            assert getattr(record, 'projectId') == 'project-1'
            assert getattr(record, 'sessionId') == 'session-1'
            assert getattr(record, 'path') == '/extract'
    finally:
        sidecar_logger.removeHandler(caplog.handler)

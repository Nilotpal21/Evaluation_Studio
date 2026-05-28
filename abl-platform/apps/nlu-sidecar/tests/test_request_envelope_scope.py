from __future__ import annotations

import pytest

import app as sidecar_app
from app import (
    app,
    get_request_scope_metrics_snapshot,
    reset_request_scope_metrics,
)


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
def _reset_scope_metrics_and_backends(monkeypatch):
    reset_request_scope_metrics()
    monkeypatch.setattr(sidecar_app, 'EXTRACT_BACKEND_ENABLED', False)
    monkeypatch.setattr(sidecar_app, 'CORRECTION_BACKEND_ENABLED', False)
    yield


def test_missing_headers_record_scope_metric(client):
    response = client.post(
        '/extract',
        json={'text': 'hello', 'fields': [], 'locale': 'en', **TENANCY_BODY},
    )

    assert response.status_code == 400

    snapshot = get_request_scope_metrics_snapshot()
    assert snapshot['missing_headers'] == {
        '/extract|__missing_tenant__|__missing_project__': 1,
    }


def test_header_body_mismatch_records_metric_under_header_scope(client):
    response = client.post(
        '/detect-correction',
        headers=TENANCY_HEADERS,
        json={
            'text': 'actually Berlin',
            'context': {'destination': 'Paris'},
            'locale': 'en',
            'tenantId': 'tenant-other',
            'projectId': 'project-1',
            'sessionId': 'session-1',
        },
    )

    assert response.status_code == 400

    snapshot = get_request_scope_metrics_snapshot()
    assert snapshot['body_mismatch'] == {
        '/detect-correction|tenant-1|project-1': 1,
    }


def test_accepted_requests_are_counted_by_tenant_and_project_scope(client):
    response = client.post(
        '/extract',
        headers=TENANCY_HEADERS,
        json={'text': 'hello', 'fields': [], 'locale': 'en', **TENANCY_BODY},
    )

    assert response.status_code == 501

    snapshot = get_request_scope_metrics_snapshot()
    assert snapshot['accepted'] == {
        '/extract|tenant-1|project-1': 1,
    }

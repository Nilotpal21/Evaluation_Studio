/**
 * ToolTestingSection Component
 *
 * Testing section with run button and result display.
 */

import { useCallback, useEffect, useState } from 'react';
import { Code2, Play, RefreshCw, Save } from 'lucide-react';
import { Button } from '../../ui/Button';
import { TestResultCard } from '../TestResultCard';
import {
  getToolTestEndpointFixture,
  updateToolTestEndpointFixture,
  type ToolTestEndpointFixture,
  type ToolTestJsonValue,
} from '../../../api/tools';
import type { ToolTestResult } from '../../../store/tool-store';

const EMPTY_STATIC_RESPONSE_JSON = '{}';
const EMPTY_SAMPLE_INPUT_JSON = 'null';

interface ToolTestingSectionProps {
  projectId?: string | null;
  toolId?: string | null;
  latestTestResult: ToolTestResult | null;
  onTestClick: () => void;
  onRerunTest: () => void;
  onClearResult: () => void;
  onReconnectProfile?: (reauth: NonNullable<ToolTestResult['oauthReauth']>) => void;
}

export function ToolTestingSection({
  projectId,
  toolId,
  latestTestResult,
  onTestClick,
  onRerunTest,
  onClearResult,
  onReconnectProfile,
}: ToolTestingSectionProps) {
  const [fixture, setFixture] = useState<ToolTestEndpointFixture | null>(null);
  const [fixtureLoading, setFixtureLoading] = useState(false);
  const [fixtureLoaded, setFixtureLoaded] = useState(false);
  const [fixtureLoadFailed, setFixtureLoadFailed] = useState(false);
  const [fixtureSaving, setFixtureSaving] = useState(false);
  const [fixtureError, setFixtureError] = useState<string | null>(null);
  const [staticResponseJson, setStaticResponseJson] = useState('');
  const [sampleInputJson, setSampleInputJson] = useState('');

  const syncFixtureEditors = useCallback((nextFixture: ToolTestEndpointFixture) => {
    setStaticResponseJson(JSON.stringify(nextFixture.staticResponse, null, 2));
    setSampleInputJson(
      nextFixture.sampleInput === null ? 'null' : JSON.stringify(nextFixture.sampleInput, null, 2),
    );
  }, []);

  const syncEmptyFixtureEditors = useCallback(() => {
    setStaticResponseJson(EMPTY_STATIC_RESPONSE_JSON);
    setSampleInputJson(EMPTY_SAMPLE_INPUT_JSON);
  }, []);

  useEffect(() => {
    if (!projectId || !toolId) {
      setFixture(null);
      setFixtureLoaded(false);
      setFixtureLoadFailed(false);
      syncEmptyFixtureEditors();
      return;
    }

    let cancelled = false;
    setFixtureLoading(true);
    setFixtureLoaded(false);
    setFixtureLoadFailed(false);
    setFixtureError(null);

    getToolTestEndpointFixture(projectId, toolId)
      .then((nextFixture) => {
        if (cancelled) return;
        setFixtureLoadFailed(false);
        setFixture(nextFixture);
        if (nextFixture) {
          syncFixtureEditors(nextFixture);
        } else {
          syncEmptyFixtureEditors();
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFixture(null);
        setFixtureLoadFailed(true);
        setFixtureError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setFixtureLoading(false);
          setFixtureLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, syncEmptyFixtureEditors, syncFixtureEditors, toolId]);

  const handleFormatFixture = () => {
    setFixtureError(null);
    try {
      setStaticResponseJson(JSON.stringify(JSON.parse(staticResponseJson), null, 2));
      setSampleInputJson(JSON.stringify(JSON.parse(sampleInputJson), null, 2));
    } catch {
      setFixtureError('Fixture JSON is invalid.');
    }
  };

  const handleResetFixture = () => {
    setFixtureError(null);
    if (fixture) {
      syncFixtureEditors(fixture);
    } else {
      syncEmptyFixtureEditors();
    }
  };

  const handleSaveFixture = async () => {
    if (!projectId || !toolId) return;

    let parsedStaticResponse: ToolTestJsonValue;
    let parsedSampleInput: unknown;
    try {
      parsedStaticResponse = JSON.parse(staticResponseJson) as ToolTestJsonValue;
      parsedSampleInput = JSON.parse(sampleInputJson);
    } catch {
      setFixtureError('Fixture JSON is invalid.');
      return;
    }

    if (
      parsedSampleInput !== null &&
      (typeof parsedSampleInput !== 'object' || Array.isArray(parsedSampleInput))
    ) {
      setFixtureError('Sample input must be a JSON object or null.');
      return;
    }

    setFixtureSaving(true);
    setFixtureError(null);
    try {
      const nextFixture = await updateToolTestEndpointFixture(projectId, toolId, {
        staticResponse: parsedStaticResponse,
        sampleInput: parsedSampleInput as Record<string, unknown> | null,
      });
      setFixture(nextFixture);
      syncFixtureEditors(nextFixture);
    } catch (error: unknown) {
      setFixtureError(error instanceof Error ? error.message : String(error));
    } finally {
      setFixtureSaving(false);
    }
  };

  const hasToolContext = Boolean(projectId && toolId);
  const showFixtureEditor = hasToolContext && (fixtureLoading || fixtureLoaded || fixtureError);
  const canEditFixture = !fixtureLoading && fixtureLoaded && !fixtureLoadFailed;

  return (
    <div className="space-y-5">
      {/* Actions bar */}
      <div className="flex items-center justify-end">
        <Button
          variant="primary"
          size="sm"
          icon={<Play className="w-4 h-4" />}
          onClick={onTestClick}
        >
          Run Test
        </Button>
      </div>

      {showFixtureEditor && (
        <div className="border border-default rounded-lg bg-background-elevated">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-default">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Tool-Test Fixture</h3>
              <p className="text-xs text-muted mt-1">
                {fixture ? `v${fixture.version} - ${fixture.status}` : 'Not created'}
              </p>
            </div>
            {canEditFixture && (
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Code2 className="w-3.5 h-3.5" />}
                  onClick={handleFormatFixture}
                >
                  Format
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
                  onClick={handleResetFixture}
                >
                  Reset
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Save className="w-3.5 h-3.5" />}
                  loading={fixtureSaving}
                  onClick={handleSaveFixture}
                >
                  Save
                </Button>
              </div>
            )}
          </div>

          {fixtureLoading ? (
            <div className="px-4 py-5 text-sm text-muted">Loading fixture...</div>
          ) : canEditFixture ? (
            <div className="p-4 space-y-3">
              {fixtureError && (
                <div className="rounded-md border border-error/30 bg-error-subtle px-3 py-2 text-xs text-error">
                  {fixtureError}
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted">Static response</span>
                  <textarea
                    value={staticResponseJson}
                    onChange={(event) => setStaticResponseJson(event.target.value)}
                    rows={10}
                    spellCheck={false}
                    className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-xs font-mono p-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-y"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-muted">Sample input</span>
                  <textarea
                    value={sampleInputJson}
                    onChange={(event) => setSampleInputJson(event.target.value)}
                    rows={10}
                    spellCheck={false}
                    className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-xs font-mono p-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-y"
                  />
                </label>
              </div>
            </div>
          ) : fixtureError ? (
            <div className="px-4 py-5 text-sm text-error">{fixtureError}</div>
          ) : null}
        </div>
      )}

      {latestTestResult ? (
        <TestResultCard
          result={latestTestResult}
          onRerun={onRerunTest}
          onClear={onClearResult}
          onReconnectProfile={onReconnectProfile}
        />
      ) : (
        <div className="text-center py-16 text-muted text-sm">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-background-muted mb-4">
            <Play className="w-8 h-8" />
          </div>
          <p className="font-medium">No test results yet</p>
          <p className="text-xs mt-1">Click "Run Test" to execute your tool with sample inputs</p>
        </div>
      )}
    </div>
  );
}

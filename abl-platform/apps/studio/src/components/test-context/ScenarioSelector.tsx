/**
 * ScenarioSelector — Scenario dropdown + CRUD.
 * Save, load, and delete test scenarios.
 */

import { useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTestContextStore } from '../../store/test-context-store';

interface ScenarioSelectorProps {
  agentPath: string;
  projectId?: string;
}

export function ScenarioSelector({ agentPath, projectId }: ScenarioSelectorProps) {
  const t = useTranslations('test_context.scenario');
  const { scenarios, activeScenarioId, loadScenario, saveScenario, deleteScenario, hasContext } =
    useTestContextStore();
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');

  const handleSave = () => {
    if (!saveName.trim()) return;
    saveScenario(saveName.trim(), saveDescription.trim(), agentPath, projectId);
    setSaveName('');
    setSaveDescription('');
    setShowSaveForm(false);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {/* Scenario dropdown */}
        <select
          value={activeScenarioId || ''}
          onChange={(e) => {
            if (e.target.value) loadScenario(e.target.value);
          }}
          className="flex-1 px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground"
        >
          <option value="">{t('no_scenario')}</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {/* Save button */}
        <button
          onClick={() => setShowSaveForm(!showSaveForm)}
          disabled={!hasContext()}
          className="p-1 text-muted hover:text-accent disabled:opacity-30 transition-colors"
          title={t('save_as_scenario')}
        >
          <Check className="w-3.5 h-3.5" />
        </button>

        {/* Delete active scenario */}
        {activeScenarioId && (
          <button
            onClick={() => deleteScenario(activeScenarioId)}
            className="p-1 text-muted hover:text-error transition-colors"
            title={t('delete_scenario')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Save form */}
      {showSaveForm && (
        <div className="space-y-1.5 p-2 bg-background-subtle rounded border border-default">
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={t('scenario_name')}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground placeholder:text-subtle"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
            }}
          />
          <input
            type="text"
            value={saveDescription}
            onChange={(e) => setSaveDescription(e.target.value)}
            placeholder={t('description_optional')}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground placeholder:text-subtle"
          />
          <div className="flex gap-1.5">
            <button
              onClick={handleSave}
              disabled={!saveName.trim()}
              className="px-2 py-1 text-xs bg-accent text-accent-foreground rounded hover:opacity-90 disabled:opacity-30"
            >
              {t('save')}
            </button>
            <button
              onClick={() => setShowSaveForm(false)}
              className="px-2 py-1 text-xs text-muted hover:text-foreground"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

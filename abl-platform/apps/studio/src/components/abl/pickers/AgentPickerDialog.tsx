'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Package, Lock, Search } from 'lucide-react';
import { useImportedSymbols, type ImportedAgent } from '../../../hooks/useImportedSymbols';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';

interface AgentPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (agentName: string) => void;
  localAgents: Array<{ name: string; description?: string }>;
  title?: string;
}

export function AgentPickerDialog({
  open,
  onClose,
  onSelect,
  localAgents,
  title,
}: AgentPickerDialogProps) {
  const t = useTranslations('agents.agent_picker');
  const [search, setSearch] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const { agents: importedAgents } = useImportedSymbols();

  // Filter local agents
  const filteredLocal = useMemo(() => {
    if (!search) return localAgents;
    const q = search.toLowerCase();
    return localAgents.filter(
      (a) => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q),
    );
  }, [localAgents, search]);

  // Filter and group imported agents by alias
  const filteredImported = useMemo(() => {
    if (!search) return importedAgents;
    const q = search.toLowerCase();
    return importedAgents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.alias.toLowerCase().includes(q) ||
        a.moduleProjectName.toLowerCase().includes(q),
    );
  }, [importedAgents, search]);

  const importedByAlias = useMemo(() => {
    const groups: Record<
      string,
      { agents: ImportedAgent[]; moduleProjectName: string; version?: string }
    > = {};
    for (const agent of filteredImported) {
      if (!groups[agent.alias]) {
        groups[agent.alias] = {
          agents: [],
          moduleProjectName: agent.moduleProjectName,
          version: agent.resolvedVersion,
        };
      }
      groups[agent.alias].agents.push(agent);
    }
    return groups;
  }, [filteredImported]);

  const handleSelect = () => {
    if (selectedAgent) {
      onSelect(selectedAgent);
      onClose();
      setSelectedAgent(null);
      setSearch('');
    }
  };

  const displayTitle = title ?? t('title');

  return (
    <Dialog open={open} onClose={onClose} title={displayTitle} maxWidth="lg" noBodyWrapper>
      <div className="flex max-h-[70vh] flex-col">
        {/* Search */}
        <div className="px-6 py-3 border-b border-default">
          <Input
            type="text"
            placeholder={t('search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon={<Search className="h-3.5 w-3.5" />}
            autoFocus
          />
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* Local agents */}
          {filteredLocal.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wide text-muted px-2 py-1">
                {t('project_agents', { count: filteredLocal.length })}
              </div>
              {filteredLocal.map((agent) => (
                <Button
                  variant="ghost"
                  size="md"
                  key={agent.name}
                  className={`flex w-full justify-start items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-default ${
                    selectedAgent === agent.name
                      ? 'bg-accent/10 border border-accent/30'
                      : 'border border-transparent hover:bg-background-muted'
                  }`}
                  onClick={() => setSelectedAgent(agent.name)}
                >
                  <Bot className="h-3.5 w-3.5 text-muted" />
                  <span className="font-mono text-xs">{agent.name}</span>
                  {agent.description && (
                    <span className="text-muted text-xs truncate">— {agent.description}</span>
                  )}
                </Button>
              ))}
            </div>
          )}

          {/* Imported agents */}
          {Object.keys(importedByAlias).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted px-2 py-1">
                {t('imported_modules', { count: filteredImported.length })}
              </div>
              {Object.entries(importedByAlias).map(([alias, group]) => (
                <div key={alias} className="mb-2">
                  <div className="flex items-center gap-1.5 px-3 py-1">
                    <Package className="h-3 w-3 text-accent" />
                    <span className="text-xs font-medium">{alias}</span>
                    <span className="text-[10px] text-muted">
                      ({group.moduleProjectName}
                      {group.version ? ` v${group.version}` : ''})
                    </span>
                  </div>
                  {group.agents.map((agent) => {
                    const mountedName = `${agent.alias}__${agent.name}`;
                    return (
                      <Button
                        variant="ghost"
                        size="md"
                        key={mountedName}
                        className={`flex w-full justify-start items-center gap-2 px-5 py-2 rounded-lg text-left text-sm transition-default ${
                          selectedAgent === mountedName
                            ? 'bg-accent/10 border border-accent/30'
                            : 'border border-transparent hover:bg-background-muted'
                        }`}
                        onClick={() => setSelectedAgent(mountedName)}
                      >
                        <Lock className="h-3 w-3 text-muted" />
                        <span className="font-mono text-xs">
                          {agent.alias}.{agent.name}
                        </span>
                        <Badge
                          variant="purple"
                          appearance="outlined"
                          className="ml-auto text-[10px]"
                        >
                          {t('imported_badge')}
                        </Badge>
                      </Button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {filteredLocal.length === 0 && filteredImported.length === 0 && (
            <p className="text-sm text-muted text-center py-8">{t('no_agents')}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-default">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSelect} disabled={!selectedAgent}>
            {t('select')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

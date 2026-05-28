/**
 * NewToolDropdown Component
 *
 * Dropdown menu for creating new tools. Shows on "New Tool" button.
 */

import { useState, useRef, useEffect } from 'react';
import { Plus, ChevronDown } from 'lucide-react';
import { Button } from '../ui/Button';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { useFeatures } from '../../hooks/use-features';
import type { ToolType } from '../../store/tool-store';

const TOOL_TYPE_OPTIONS = [
  { type: 'http' as ToolType, label: 'HTTP', description: 'Call external REST APIs' },
  { type: 'sandbox' as ToolType, label: 'Code Tool', description: 'JavaScript/Python execution' },
  { type: 'mcp' as ToolType, label: 'MCP Server', description: 'Manage servers & import tools' },
];

interface NewToolDropdownProps {
  onMcpSelect?: () => void;
  testid?: string;
}

export function NewToolDropdown({ onMcpSelect, testid }: NewToolDropdownProps) {
  const { currentProject } = useProjectStore();
  const { navigate } = useNavigationStore();
  const { hasCodeTools } = useFeatures();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const projectId = currentProject?.id;

  const visibleOptions = TOOL_TYPE_OPTIONS.filter((opt) => opt.type !== 'sandbox' || hasCodeTools);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelect = (toolType: ToolType) => {
    setIsOpen(false);

    // MCP tools are created via server registration, not manual creation
    if (toolType === 'mcp') {
      onMcpSelect?.();
      return;
    }

    // Regular tools navigate to creation form
    if (!projectId) return;
    navigate(`/projects/${projectId}/tools/new?type=${toolType}`);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        icon={<Plus className="w-4 h-4" />}
        onClick={() => setIsOpen(!isOpen)}
        data-testid={testid}
      >
        New Tool
        <ChevronDown className="w-3.5 h-3.5 ml-1.5 -mr-0.5" />
      </Button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-64 bg-background-elevated border border-default rounded-xl shadow-xl overflow-hidden z-50">
          {visibleOptions.map((option) => (
            <button
              key={option.type}
              onClick={() => handleSelect(option.type)}
              className="w-full text-left px-4 py-3 hover:bg-background-muted transition-default border-b border-default last:border-b-0"
            >
              <div className="text-sm font-medium text-foreground">{option.label}</div>
              <div className="text-xs text-muted mt-0.5">{option.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

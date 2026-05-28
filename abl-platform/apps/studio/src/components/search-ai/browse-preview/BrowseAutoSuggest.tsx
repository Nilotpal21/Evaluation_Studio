/**
 * BrowseAutoSuggest
 *
 * Search input with auto-suggest dropdown.
 * Search fires on Enter key, suggestion click, or clear button — not on keystroke.
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Suggestion {
  text: string;
  category?: string;
}

interface BrowseAutoSuggestProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  suggestions?: Suggestion[];
  isLoading?: boolean;
  placeholder?: string;
}

export function BrowseAutoSuggest({
  value,
  onChange,
  onSearch,
  suggestions = [],
  isLoading = false,
  placeholder,
}: BrowseAutoSuggestProps) {
  const t = useTranslations('search_ai.browse');
  const resolvedPlaceholder = placeholder ?? t('search_documents_placeholder');
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Show dropdown when suggestions available
  useEffect(() => {
    setShowDropdown(suggestions.length > 0 && value.trim().length >= 2);
    setHighlightedIndex(-1);
  }, [suggestions, value]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showDropdown) {
        if (e.key === 'Enter' && value.trim()) {
          onSearch(value.trim());
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prev) => Math.max(prev - 1, -1));
          break;
        case 'Enter':
          e.preventDefault();
          if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
            const selected = suggestions[highlightedIndex].text;
            onChange(selected);
            onSearch(selected);
            setShowDropdown(false);
          } else if (value.trim()) {
            onSearch(value.trim());
            setShowDropdown(false);
          }
          break;
        case 'Escape':
          setShowDropdown(false);
          break;
      }
    },
    [showDropdown, highlightedIndex, suggestions, value, onChange, onSearch],
  );

  const handleSuggestionClick = (suggestion: Suggestion) => {
    onChange(suggestion.text);
    onSearch(suggestion.text);
    setShowDropdown(false);
  };

  const handleClear = () => {
    onChange('');
    onSearch('');
    inputRef.current?.focus();
  };

  return (
    <div className="relative flex-1">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (suggestions.length > 0 && value.trim().length >= 2) {
              setShowDropdown(true);
            }
          }}
          placeholder={resolvedPlaceholder}
          className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-sm py-2.5 pl-9 pr-9"
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {isLoading && <Loader2 className="w-3.5 h-3.5 text-muted animate-spin" />}
          {value && !isLoading && (
            <button
              onClick={handleClear}
              className="text-muted hover:text-foreground transition-default"
              aria-label={t('clear_search')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {showDropdown && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-1 rounded-xl border border-default bg-background-elevated shadow-xl overflow-hidden animate-fade-in-scale"
          role="listbox"
        >
          <div className="max-h-60 overflow-y-auto p-1">
            {suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.text}-${index}`}
                onClick={() => handleSuggestionClick(suggestion)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-default text-left ${
                  index === highlightedIndex
                    ? 'bg-background-muted text-foreground'
                    : 'text-muted hover:bg-background-muted hover:text-foreground'
                }`}
                role="option"
                aria-selected={index === highlightedIndex}
              >
                <Search className="w-3.5 h-3.5 shrink-0 opacity-60" />
                <span className="truncate">{suggestion.text}</span>
                {suggestion.category && (
                  <span className="ml-auto text-xs text-subtle shrink-0">
                    {suggestion.category}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

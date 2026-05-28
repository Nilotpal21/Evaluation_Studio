'use client';

import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Search } from 'lucide-react';
import clsx from 'clsx';
import { springs, transitions } from '../../../lib/animation';

export interface PickerItem {
  id: string;
  name: string;
  description?: string;
  category?: string;
  [key: string]: unknown;
}

export interface PickerTab {
  id: string;
  label: string;
  filter?: (item: PickerItem) => boolean;
}

export interface CreateOption {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}

interface BasePickerModalProps<T extends PickerItem> {
  open: boolean;
  onClose: () => void;
  title: string;
  searchPlaceholder?: string;
  tabs?: PickerTab[];
  initialTab?: string;
  items: T[];
  categories?: string[];
  renderItem: (item: T, isSelected: boolean) => ReactNode;
  renderPreview: (item: T | null) => ReactNode;
  onSelect: (item: T) => void;
  createOptions?: CreateOption[];
  footer?: ReactNode;
  emptyMessage?: string;
  loading?: boolean;
}

export function BasePickerModal<T extends PickerItem>({
  open,
  onClose,
  title,
  searchPlaceholder = 'Search...',
  tabs,
  initialTab,
  items,
  categories,
  renderItem,
  renderPreview,
  onSelect,
  createOptions,
  footer,
  emptyMessage = 'No items found',
  loading = false,
}: BasePickerModalProps<T>) {
  const initialSelectedTab = initialTab ?? tabs?.[0]?.id ?? 'all';
  const [query, setQuery] = useState('');
  const [selectedTab, setSelectedTab] = useState(initialSelectedTab);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedItem, setSelectedItem] = useState<T | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter items by search query and active tab
  const filteredItems = items.filter((item) => {
    // Apply search filter
    const matchesSearch =
      !query ||
      item.name.toLowerCase().includes(query.toLowerCase()) ||
      item.description?.toLowerCase().includes(query.toLowerCase());

    if (!matchesSearch) return false;

    // Apply tab filter
    if (tabs && selectedTab !== 'all') {
      const tab = tabs.find((t) => t.id === selectedTab);
      if (tab?.filter && !tab.filter(item)) return false;
    }

    return true;
  });

  // Group by category if categories provided
  const groupedItems: Record<string, T[]> = {};
  if (categories && categories.length > 0) {
    for (const cat of categories) {
      groupedItems[cat] = filteredItems.filter((item) => item.category === cat);
    }
  } else {
    groupedItems['All'] = filteredItems;
  }

  // Reset state when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedTab(initialSelectedTab);
      setSelectedIndex(0);
      setSelectedItem(filteredItems[0] ?? null);
      setTimeout(() => searchInputRef.current?.focus(), 100);

      // Screen reader announcement
      const announcement = `${title} opened. ${filteredItems.length} items available.`;
      const ariaLive = document.createElement('div');
      ariaLive.setAttribute('role', 'status');
      ariaLive.setAttribute('aria-live', 'polite');
      ariaLive.className = 'sr-only';
      ariaLive.textContent = announcement;
      document.body.appendChild(ariaLive);
      setTimeout(() => document.body.removeChild(ariaLive), 1000);
    }
  }, [open, title, initialSelectedTab]);

  // Update selected item when filtered items change
  useEffect(() => {
    if (filteredItems.length > 0 && selectedIndex < filteredItems.length) {
      setSelectedItem(filteredItems[selectedIndex]);
    } else {
      setSelectedItem(null);
    }
  }, [filteredItems, selectedIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedItem) {
          onSelect(selectedItem);
          onClose();
        }
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, filteredItems, selectedIndex, selectedItem, onSelect, onClose]);

  const handleItemClick = useCallback((item: T, index: number) => {
    setSelectedIndex(index);
    setSelectedItem(item);
  }, []);

  const handleItemDoubleClick = useCallback(
    (item: T) => {
      onSelect(item);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <RadixDialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            {/* Backdrop */}
            <RadixDialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-overlay backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transitions.backdrop}
              />
            </RadixDialog.Overlay>

            {/* Centering wrapper */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <RadixDialog.Content
                asChild
                onEscapeKeyDown={() => onClose()}
                onPointerDownOutside={() => onClose()}
              >
                <motion.div
                  className="relative w-full max-w-5xl h-[80vh] bg-background-elevated border border-default rounded-2xl shadow-xl bg-noise flex flex-col"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={springs.default}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-default">
                    <RadixDialog.Title className="text-lg font-semibold text-foreground">
                      {title}
                    </RadixDialog.Title>
                    <RadixDialog.Close asChild>
                      <button
                        className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default"
                        aria-label="Close dialog"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </RadixDialog.Close>
                  </div>

                  {/* Search + Tabs */}
                  <div className="px-6 py-3 border-b border-default space-y-3">
                    {/* Search */}
                    <div className="relative">
                      <Search
                        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none"
                        aria-hidden="true"
                      />
                      <input
                        ref={searchInputRef}
                        type="text"
                        value={query}
                        onChange={(e) => {
                          setQuery(e.target.value);
                          setSelectedIndex(0);
                        }}
                        placeholder={searchPlaceholder}
                        className="w-full pl-10 pr-4 py-2 text-sm bg-background-muted border border-default rounded-lg text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus transition-default"
                        aria-label={searchPlaceholder}
                        role="searchbox"
                      />
                    </div>

                    {/* Tabs */}
                    {tabs && tabs.length > 0 && (
                      <div className="flex gap-2">
                        {tabs.map((tab) => (
                          <button
                            key={tab.id}
                            onClick={() => {
                              setSelectedTab(tab.id);
                              setSelectedIndex(0);
                            }}
                            className={clsx(
                              'px-3 py-1.5 text-xs font-medium rounded-lg transition-default',
                              selectedTab === tab.id
                                ? 'bg-accent text-accent-foreground'
                                : 'text-muted hover:text-foreground hover:bg-background-muted',
                            )}
                          >
                            {tab.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Main content: Left list + Right preview */}
                  <div className="flex-1 flex min-h-0">
                    {/* Left panel: Item list */}
                    <div className="w-[40%] border-r border-default flex flex-col">
                      {/* Items list */}
                      <div className="flex-1 overflow-y-auto" role="listbox" aria-label="Items">
                        {loading ? (
                          <div className="p-6 text-center text-muted" role="status">
                            Loading...
                          </div>
                        ) : filteredItems.length === 0 ? (
                          <div className="p-6 text-center text-muted" role="status">
                            {emptyMessage}
                          </div>
                        ) : (
                          <>
                            {Object.entries(groupedItems).map(([category, categoryItems]) => {
                              if (categoryItems.length === 0) return null;
                              return (
                                <div key={category}>
                                  {Object.keys(groupedItems).length > 1 && (
                                    <div
                                      className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-subtle bg-background-muted sticky top-0"
                                      role="presentation"
                                      aria-label={`${category} category`}
                                    >
                                      {category}
                                    </div>
                                  )}
                                  {categoryItems.map((item) => {
                                    const globalIndex = filteredItems.indexOf(item);
                                    const isSelected = globalIndex === selectedIndex;
                                    return (
                                      <div
                                        key={item.id}
                                        role="option"
                                        aria-selected={isSelected}
                                        onClick={() => handleItemClick(item, globalIndex)}
                                        onDoubleClick={() => handleItemDoubleClick(item)}
                                        className={clsx(
                                          'cursor-pointer transition-default',
                                          isSelected && 'bg-accent-subtle border-l-2 border-accent',
                                        )}
                                        aria-label={`${item.name}: ${item.description || 'No description'}`}
                                      >
                                        {renderItem(item, isSelected)}
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })}
                          </>
                        )}
                      </div>

                      {/* Create New section */}
                      {createOptions && createOptions.length > 0 && (
                        <div className="border-t border-default p-4 space-y-2">
                          <div className="text-xs font-semibold uppercase tracking-wider text-subtle mb-2">
                            Create New
                          </div>
                          {createOptions.map((option) => (
                            <button
                              key={option.id}
                              onClick={option.onClick}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted rounded-lg transition-default text-left"
                            >
                              {option.icon}
                              <span>{option.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Right panel: Preview */}
                    <div className="flex-1 overflow-y-auto p-6">{renderPreview(selectedItem)}</div>
                  </div>

                  {/* Footer */}
                  {footer && (
                    <div className="px-6 py-3 border-t border-default flex items-center justify-between">
                      {footer}
                    </div>
                  )}
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}

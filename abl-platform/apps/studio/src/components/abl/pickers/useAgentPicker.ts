'use client';

import { useCallback, useState } from 'react';

export function useAgentPicker() {
  const [open, setOpen] = useState(false);
  const [callback, setCallback] = useState<((name: string) => void) | null>(null);

  const openAgentPicker = useCallback((onSelect: (name: string) => void) => {
    setCallback(() => onSelect);
    setOpen(true);
  }, []);

  const closeAgentPicker = useCallback(() => {
    setOpen(false);
    setCallback(null);
  }, []);

  const selectAgent = useCallback(
    (name: string) => {
      callback?.(name);
      closeAgentPicker();
    },
    [callback, closeAgentPicker],
  );

  return {
    agentPickerOpen: open,
    openAgentPicker,
    closeAgentPicker,
    selectAgent,
  };
}

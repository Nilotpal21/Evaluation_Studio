'use client';

import { motion } from 'framer-motion';
import { useState, useCallback, useEffect, useRef } from 'react';
import { Lock } from 'lucide-react';

interface SecretInputProps {
  input: { flowId: string; field: string; label: string };
  onSubmit: (answer: string, secrets: { flowId: string; values: Record<string, string> }) => void;
}

export function SecretInput({ input, onSubmit }: SecretInputProps) {
  const { flowId, field, label } = input;
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || submitted) return;
    setSubmitted(true);
    onSubmit('(secret collected)', { flowId, values: { [field]: trimmed } });
  }, [value, submitted, onSubmit, flowId, field]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  if (submitted) {
    return (
      <div
        data-widget="SecretInput"
        className="my-3 flex items-center gap-2 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted"
      >
        <Lock className="h-3.5 w-3.5 flex-shrink-0" />
        <span>Secret collected</span>
      </div>
    );
  }

  const canSubmit = !!value.trim();

  return (
    <motion.div
      data-widget="SecretInput"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3"
    >
      <div className="mb-2 flex items-center gap-2 text-sm text-foreground-muted">
        <Lock className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter secret value..."
          autoComplete="off"
          className="w-full rounded-lg border border-border bg-background-elevated px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/40 transition-colors focus:border-accent"
        />
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`btn-press self-end rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
            canSubmit
              ? 'bg-accent text-accent-foreground hover:bg-accent-muted'
              : 'cursor-not-allowed border border-border bg-background-subtle text-foreground/30'
          }`}
        >
          Submit
        </button>
      </div>
    </motion.div>
  );
}

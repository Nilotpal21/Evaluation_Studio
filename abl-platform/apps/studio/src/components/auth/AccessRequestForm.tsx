'use client';

import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';

interface AccessRequestFormProps {
  email: string;
}

export function AccessRequestForm({ email }: AccessRequestFormProps) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setStatus('submitting');
    setError('');

    try {
      const response = await fetch('/api/auth/access-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          name: name.trim() || undefined,
          message: message.trim() || undefined,
        }),
      });

      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(data?.error || 'Unable to send request.');
        setStatus('error');
        return;
      }

      setStatus('sent');
    } catch {
      setError('Unable to send request.');
      setStatus('error');
    }
  };

  if (status === 'sent') {
    return (
      <div className="mt-4 rounded-lg border border-success/25 bg-success/10 px-3 py-3 text-sm text-success">
        Request sent to a platform admin.
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-default p-3">
      <div>
        <label htmlFor="access-request-name" className="block text-xs font-medium text-muted mb-1">
          Name
        </label>
        <input
          id="access-request-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full px-3 py-2 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
          placeholder="Your name"
        />
      </div>

      <div>
        <label
          htmlFor="access-request-message"
          className="block text-xs font-medium text-muted mb-1"
        >
          Message
        </label>
        <textarea
          id="access-request-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          className="w-full px-3 py-2 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default resize-none"
          placeholder="Why do you need access?"
        />
      </div>

      {error && <p className="text-xs text-error">{error}</p>}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={status === 'submitting' || !email.trim()}
        className="w-full py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center justify-center gap-2 transition-default btn-press"
      >
        {status === 'submitting' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Send className="w-4 h-4" />
        )}
        Send request
      </button>
    </div>
  );
}

'use client';

import { useState, useCallback } from 'react';

const COMMON_CHANNELS = ['Voice', 'Chat', 'WhatsApp', 'SMS', 'Slack', 'Email'];

interface ChannelTagsProps {
  channels: string[];
  onChange: (channels: string[]) => void;
  disabled?: boolean;
}

/**
 * ChannelTags — tag-style channel selector with add/remove.
 * S1-F12 req 3: array of channel tags, add/remove via tag UI.
 */
export function ChannelTags({ channels, onChange, disabled }: ChannelTagsProps) {
  const [showAdd, setShowAdd] = useState(false);

  const addChannel = useCallback(
    (channel: string) => {
      if (!channels.includes(channel)) {
        onChange([...channels, channel]);
      }
      setShowAdd(false);
    },
    [channels, onChange],
  );

  const removeChannel = useCallback(
    (channel: string) => {
      onChange(channels.filter((c) => c !== channel));
    },
    [channels, onChange],
  );

  const availableChannels = COMMON_CHANNELS.filter((c) => !channels.includes(c));

  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {channels.map((channel) => (
        <span
          key={channel}
          className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/5 px-2.5 py-1 text-xs text-foreground"
        >
          {channel}
          {!disabled && (
            <button
              onClick={() => removeChannel(channel)}
              className="text-foreground-muted hover:text-destructive"
            >
              &times;
            </button>
          )}
        </span>
      ))}
      {!disabled && !showAdd && (
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-foreground-muted transition-colors hover:border-accent/50 hover:text-accent"
        >
          + Add
        </button>
      )}
      {showAdd && (
        <div className="flex flex-wrap gap-1">
          {availableChannels.map((channel) => (
            <button
              key={channel}
              onClick={() => addChannel(channel)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground-muted transition-colors hover:border-accent hover:text-accent"
            >
              {channel}
            </button>
          ))}
          <button onClick={() => setShowAdd(false)} className="px-1 text-xs text-foreground-muted">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

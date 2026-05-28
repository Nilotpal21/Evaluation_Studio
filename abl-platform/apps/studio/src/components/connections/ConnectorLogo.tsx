'use client';

import { clsx } from 'clsx';
import { useState } from 'react';
import { connectorIntent, getIntentStyles } from '@agent-platform/design-tokens';
import { CONNECTOR_BRAND_COLORS } from './connector-brand-colors';

interface ConnectorLogoProps {
  name: string;
  className?: string;
}

function shade(hex: string, pct: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const adj = (v: number) => Math.max(0, Math.min(255, Math.round(v + (pct / 100) * 255)));
  return '#' + [r, g, b].map((v) => adj(v).toString(16).padStart(2, '0')).join('');
}

function isLightColor(hex: string): boolean {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Perceived luminance
  return r * 0.299 + g * 0.587 + b * 0.114 > 160;
}

function GradientTile({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  const dark = isLightColor(color);
  return (
    <div
      className={clsx(
        'flex items-center justify-center rounded-xl shrink-0 font-semibold',
        className,
      )}
      style={{
        background: `linear-gradient(135deg, ${color} 0%, ${shade(color, -12)} 100%)`,
        color: dark ? '#1c1b1a' : '#fff',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.06)',
      }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export function ConnectorLogo({ name, className }: ConnectorLogoProps) {
  const [failed, setFailed] = useState(false);

  if (!failed) {
    return (
      <div className={clsx('rounded-xl overflow-hidden shrink-0', className)}>
        <img
          src={`/icons/connectors/${name}.png`}
          alt={name}
          className="w-full h-full object-contain p-[12%]"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  // Fallback: brand color gradient if known, otherwise deterministic intent tile
  const brandColor = CONNECTOR_BRAND_COLORS[name];
  if (brandColor) {
    return <GradientTile name={name} color={brandColor} className={className} />;
  }
  const styles = getIntentStyles(connectorIntent(name));
  return (
    <div
      className={clsx(
        'flex items-center justify-center rounded-xl shrink-0 font-semibold text-sm',
        styles.bgSubtle,
        styles.text,
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

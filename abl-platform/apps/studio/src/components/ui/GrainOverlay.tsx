/**
 * GrainOverlay
 *
 * Renders a pointer-events-none absolutely-positioned grain texture overlay
 * using an inline SVG feTurbulence filter. Renders as a real SVG element —
 * NOT as a CSS background-image (SVG filters don't apply in that context).
 *
 * Usage:
 *   <div className="relative overflow-hidden">
 *     <GrainOverlay />
 *     ...content...
 *   </div>
 */

'use client';

import { useId } from 'react';

interface GrainOverlayProps {
  /** Grain opacity (0–1). Defaults to 0.08 — visible on light surfaces. */
  opacity?: number;
  /** CSS mix-blend-mode. 'multiply' works well on light backgrounds. */
  blendMode?: React.CSSProperties['mixBlendMode'];
  /** Base frequency for feTurbulence. Higher = finer grain. Defaults to 0.65. */
  baseFrequency?: number;
  /** Number of noise octaves. More = richer texture. Defaults to 4. */
  numOctaves?: number;
  /** Optional extra className on the overlay element. */
  className?: string;
}

export function GrainOverlay({
  opacity = 0.08,
  blendMode = 'multiply',
  baseFrequency = 0.65,
  numOctaves = 4,
  className = '',
}: GrainOverlayProps) {
  const id = useId().replace(/:/g, '');
  const filterId = `grain-${id}`;

  return (
    <svg
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      className={`pointer-events-none absolute inset-0 ${className}`}
      style={{ opacity, mixBlendMode: blendMode, zIndex: 0 }}
    >
      <defs>
        <filter id={filterId} x="0%" y="0%" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={baseFrequency}
            numOctaves={numOctaves}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      <rect width="100%" height="100%" filter={`url(#${filterId})`} />
    </svg>
  );
}

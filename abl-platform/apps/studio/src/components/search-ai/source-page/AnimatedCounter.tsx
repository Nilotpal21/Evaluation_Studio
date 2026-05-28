'use client';

/**
 * AnimatedCounter — CSS transition-based number animation
 *
 * Zero bundle cost — uses CSS `transition: all 0.3s` for smooth
 * number roll-up/down effect. No Framer Motion dependency.
 *
 * Decision D-9: CSS transitions sufficient for number roll.
 */

import { useEffect, useRef, useState } from 'react';

interface AnimatedCounterProps {
  value: number;
  /** Duration in ms for the transition. Default: 300 */
  duration?: number;
  /** Format the number (e.g., toLocaleString). Default: toLocaleString */
  format?: (n: number) => string;
}

const defaultFormat = (n: number) => n.toLocaleString();

export function AnimatedCounter({
  value,
  duration = 300,
  format = defaultFormat,
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const previousRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = previousRef.current;
    const to = value;
    previousRef.current = value;

    if (from === to) return;

    const startTime = performance.now();

    function animate(currentTime: number) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(from + (to - from) * eased);
      setDisplayValue(current);

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      }
    }

    frameRef.current = requestAnimationFrame(animate);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [value, duration]);

  return <span className="tabular-nums">{format(displayValue)}</span>;
}

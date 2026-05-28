/**
 * Canvas Animation Constants
 *
 * Shared timing tokens for workflow canvas animations.
 * Tailwind keyframes are registered in tailwind.config.js.
 * Framer-motion presets live in lib/animation.ts.
 */

// Easing
export const EXPO_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

// Durations (ms)
export const DURATION_FAST = 150;
export const DURATION_NORMAL = 250;
export const DURATION_SLOW = 350;

// CSS transition shorthand
export const TRANSITION_FAST = `${DURATION_FAST}ms ${EXPO_OUT}`;
export const TRANSITION_NORMAL = `${DURATION_NORMAL}ms ${EXPO_OUT}`;
export const TRANSITION_SLOW = `${DURATION_SLOW}ms ${EXPO_OUT}`;

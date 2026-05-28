'use client';

/**
 * SVG icon components used by SDK UI components.
 *
 * Each icon accepts standard HTML SVG attributes and defaults to 16x16.
 */

import React from 'react';

type IconProps = React.SVGProps<SVGSVGElement>;

const defaults: IconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
};

function icon(d: string, props: IconProps = {}): React.ReactElement {
  return React.createElement(
    'svg',
    { ...defaults, ...props },
    React.createElement('path', {
      d,
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}

export function SendIcon(props: IconProps): React.ReactElement {
  return icon('M1 8h14M8 1l7 7-7 7', props);
}

export function AttachIcon(props: IconProps): React.ReactElement {
  return icon(
    'M13.5 7.5l-5.25 5.25a3.18 3.18 0 0 1-4.5-4.5L9 3a2.12 2.12 0 0 1 3 3L6.75 11.25a1.06 1.06 0 0 1-1.5-1.5L10.5 4.5',
    props,
  );
}

export function ExpandIcon(props: IconProps): React.ReactElement {
  return icon('M4 6l4 4 4-4', props);
}

export function CollapseIcon(props: IconProps): React.ReactElement {
  return icon('M4 10l4-4 4 4', props);
}

export function ThoughtIcon(props: IconProps): React.ReactElement {
  return icon(
    'M8 1a5 5 0 0 1 5 5c0 2-1.5 3-2.5 4S9 11.5 9 13H7c0-1.5-.5-2-1.5-3S3 8 3 6a5 5 0 0 1 5-5zM7 15h2',
    props,
  );
}

export function ErrorIcon(props: IconProps): React.ReactElement {
  return icon('M8 1l7 14H1L8 1zM8 6v3M8 11.5v.5', props);
}

export function HandoffIcon(props: IconProps): React.ReactElement {
  return icon('M1 8h14M10 4l4 4-4 4', props);
}

export function TypingDot(_props: IconProps): React.ReactElement {
  return React.createElement('span', {
    style: {
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      backgroundColor: 'currentColor',
      display: 'inline-block',
    },
  });
}

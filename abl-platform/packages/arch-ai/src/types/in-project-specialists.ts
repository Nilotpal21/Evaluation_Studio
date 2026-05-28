import type { InProjectSpecialistId } from './constants.js';

export const IN_PROJECT_SPECIALIST_DISPLAY: Record<
  InProjectSpecialistId,
  { label: string; icon: string }
> = {
  'in-project-architect': { label: 'In-Project Architect', icon: 'network' },
  diagnostician: { label: 'Diagnostician', icon: 'stethoscope' },
  analyst: { label: 'Performance Analyst', icon: 'bar_chart' },
  observer: { label: 'Observer', icon: 'telescope' },
};

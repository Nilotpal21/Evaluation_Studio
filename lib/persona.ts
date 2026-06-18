'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { personas, type Persona } from './mock-data/tenant';
import { defaultProjectId } from './mock-data/projects';

interface PersonaState {
  activeProjectId: string;
  setActiveProject: (projectId: string) => void;
}

export const usePersona = create<PersonaState>()(
  persist(
    (set) => ({
      activeProjectId: defaultProjectId,
      setActiveProject: (projectId) => set({ activeProjectId: projectId }),
    }),
    {
      name: 'netomi-persona-state',
      partialize: (state) => ({ activeProjectId: state.activeProjectId }),
    },
  ),
);

export function useActivePersona(): Persona {
  return personas.processOwner;
}

export function useActiveProjectId(): string {
  return usePersona((s) => s.activeProjectId);
}

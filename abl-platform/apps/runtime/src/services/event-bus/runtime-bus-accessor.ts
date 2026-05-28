import type { EventBus } from './types.js';

let runtimeEventBus: EventBus | null = null;

export function setRuntimeEventBus(bus: EventBus | null): void {
  runtimeEventBus = bus;
}

export function getRuntimeEventBus(): EventBus | null {
  return runtimeEventBus;
}

/**
 * TypedEventEmitter - Type-safe event emitter
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventMap = Record<string, any>;

type Listener<T> = (data: T) => void;

export class TypedEventEmitter<Events extends EventMap> {
  private listeners = new Map<keyof Events, Set<Listener<unknown>>>();

  on<E extends keyof Events>(event: E, listener: Listener<Events[E]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as Listener<unknown>);

    return () => this.off(event, listener);
  }

  off<E extends keyof Events>(event: E, listener: Listener<Events[E]>): void {
    this.listeners.get(event)?.delete(listener as Listener<unknown>);
  }

  emit<E extends keyof Events>(event: E, data: Events[E]): void {
    this.listeners.get(event)?.forEach((listener) => {
      try {
        listener(data);
      } catch (error) {
        console.error('Event listener error:', error);
      }
    });
  }

  listenerCount<E extends keyof Events>(event: E): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: keyof Events): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

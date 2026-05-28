export interface HistoryEntry {
  role: string;
  content: string;
  timestamp: string;
}

export interface HistoryFormatOptions {
  maxMessages?: number;
  includeTimestamps?: boolean;
  includeRoles?: boolean;
}

export interface HistoryDeliveryStrategy {
  formatHistory(history: HistoryEntry[], options?: HistoryFormatOptions): unknown;
}

export class KoreHistoryStrategy implements HistoryDeliveryStrategy {
  formatHistory(history: HistoryEntry[], options?: HistoryFormatOptions): HistoryEntry[] {
    let entries = [...history];
    if (options?.maxMessages && entries.length > options.maxMessages) {
      entries = entries.slice(-options.maxMessages);
    }
    if (options?.includeTimestamps === false) {
      entries = entries.map(({ role, content }) => ({
        role,
        content,
        timestamp: '',
      }));
    }
    if (options?.includeRoles === false) {
      entries = entries.map(({ content, timestamp }) => ({
        role: '',
        content,
        timestamp,
      }));
    }
    return entries;
  }
}

export class GenericHistoryStrategy implements HistoryDeliveryStrategy {
  formatHistory(history: HistoryEntry[], options?: HistoryFormatOptions): string {
    let entries = [...history];
    if (options?.maxMessages && entries.length > options.maxMessages) {
      entries = entries.slice(-options.maxMessages);
    }
    return entries
      .map((entry) => {
        const parts: string[] = [];
        if (options?.includeTimestamps !== false && entry.timestamp) {
          parts.push(`[${entry.timestamp}]`);
        }
        if (options?.includeRoles !== false && entry.role) {
          parts.push(`${entry.role}:`);
        }
        parts.push(entry.content);
        return parts.join(' ');
      })
      .join('\n');
  }
}

const strategies = new Map<string, HistoryDeliveryStrategy>([['kore', new KoreHistoryStrategy()]]);
const genericStrategy = new GenericHistoryStrategy();

export function getHistoryStrategy(provider: string): HistoryDeliveryStrategy {
  return strategies.get(provider) ?? genericStrategy;
}

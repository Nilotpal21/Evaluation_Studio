import { format } from 'prettier';

export async function formatJson(data: unknown): Promise<string> {
  return format(JSON.stringify(data), { parser: 'json' });
}

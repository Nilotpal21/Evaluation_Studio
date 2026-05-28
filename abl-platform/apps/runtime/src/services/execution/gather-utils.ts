/**
 * Trivial-input heuristic for GATHER entity extraction.
 *
 * Returns true if the user message is too short or trivial to warrant
 * an LLM call for entity extraction. This prevents wasting ~1,500 tokens
 * and ~1s latency on greetings like "Hi" or acknowledgments like "ok".
 */
const TRIVIAL_PHRASES = new Set([
  'hi',
  'hello',
  'hey',
  'hola',
  'howdy',
  'ok',
  'okay',
  'k',
  'yes',
  'yeah',
  'yep',
  'yup',
  'ya',
  'no',
  'nah',
  'nope',
  'sure',
  'fine',
  'alright',
  'thanks',
  'thank you',
  'thx',
  'ty',
  'bye',
  'goodbye',
  'see you',
  'good morning',
  'good afternoon',
  'good evening',
  'hey there',
  'hi there',
  'hello there',
]);

export function shouldSkipExtraction(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return true;
  if (TRIVIAL_PHRASES.has(trimmed.toLowerCase())) return true;
  if (trimmed.length <= 2) return true;
  return false;
}

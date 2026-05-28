import { generateText, stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import type { A2AMessage as Message, A2ATextPart as TextPart } from './a2a-types';
import { log } from './logger';
import { resolveHostedAgentModels } from './model';
import { getAvailableSlots, bookSlot, cancelBooking, getBooking } from './appointment-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppointmentAgentInput {
  contextId: string;
  currentText: string;
  history: Message[];
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an appointment scheduling assistant. Help users book, check, and cancel appointments.

Conversation rules:
1. Guide the user step by step: ask for date → show available slots → ask for time → ask for name → ask for reason → confirm and book.
2. Always call check_availability before asking the user to choose a time slot.
3. Only call book_appointment when you have all four pieces: date, time, patient name, and reason.
4. For cancellations: ask for their confirmation ID, then call cancel_appointment.
5. For existing appointment lookups: call get_appointment with their confirmation ID.
6. After booking, show the full confirmation summary (ID, date, time, name, reason).
7. Be warm, concise, and conversational. One question at a time.
8. Today is ${new Date().toISOString().split('T')[0]}. Dates are in YYYY-MM-DD format.`;

// ---------------------------------------------------------------------------
// History conversion
// ---------------------------------------------------------------------------

function historyToMessages(history: Message[]): { role: 'user' | 'assistant'; content: string }[] {
  return history.flatMap((msg) => {
    const text = msg.parts
      .filter((p): p is TextPart => p.kind === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    if (!text) return [];
    return [
      { role: msg.role === 'agent' ? ('assistant' as const) : ('user' as const), content: text },
    ];
  });
}

// ---------------------------------------------------------------------------
// Shared tool definitions
// ---------------------------------------------------------------------------

function buildTools(contextId: string) {
  return {
    check_availability: tool({
      description: 'Check available appointment time slots for a given date.',
      inputSchema: z.object({
        date: z.string().describe('Date in YYYY-MM-DD format'),
      }),
      execute: async ({ date }) => {
        const slots = getAvailableSlots(date);
        return slots.length > 0
          ? { available: true, date, slots }
          : { available: false, date, slots: [], message: 'No slots available on this date.' };
      },
    }),

    book_appointment: tool({
      description: 'Book an appointment. Requires date, time, patient name, and reason.',
      inputSchema: z.object({
        date: z.string().describe('Date in YYYY-MM-DD format'),
        time: z.string().describe('Time slot in HH:MM format, e.g. "14:00"'),
        patient_name: z.string().describe('Full name of the patient'),
        reason: z.string().describe('Purpose or reason for the appointment'),
      }),
      execute: async ({ date, time, patient_name, reason }) => {
        const booking = bookSlot({ contextId, patientName: patient_name, date, time, reason });
        if (!booking) {
          return {
            success: false,
            error: `The ${time} slot on ${date} is no longer available. Please choose another time.`,
          };
        }
        return {
          success: true,
          confirmationId: booking.confirmationId,
          date: booking.date,
          time: booking.time,
          patientName: booking.patientName,
          reason: booking.reason,
        };
      },
    }),

    cancel_appointment: tool({
      description: 'Cancel an existing appointment using its confirmation ID.',
      inputSchema: z.object({
        confirmation_id: z.string().describe('Confirmation ID, e.g. APT-XXXXXXXX'),
      }),
      execute: async ({ confirmation_id }) => {
        const booking = cancelBooking(confirmation_id);
        if (!booking) {
          return { success: false, error: `No active appointment found for ${confirmation_id}.` };
        }
        return {
          success: true,
          message: `Appointment ${confirmation_id} has been cancelled.`,
          date: booking.date,
          time: booking.time,
          patientName: booking.patientName,
        };
      },
    }),

    get_appointment: tool({
      description: 'Look up an existing appointment by confirmation ID.',
      inputSchema: z.object({
        confirmation_id: z.string().describe('Confirmation ID to look up'),
      }),
      execute: async ({ confirmation_id }) => {
        const booking = getBooking(confirmation_id);
        if (!booking) {
          return { success: false, error: `No appointment found for ID ${confirmation_id}.` };
        }
        return {
          success: true,
          confirmationId: booking.confirmationId,
          date: booking.date,
          time: booking.time,
          patientName: booking.patientName,
          reason: booking.reason,
          status: booking.status,
        };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Sync execution (message/send)
// ---------------------------------------------------------------------------

export async function runAppointmentAgent(input: AppointmentAgentInput): Promise<string> {
  log.info('Appointment agent sync turn', {
    contextId: input.contextId,
    historyLength: input.history.length,
  });

  const modelChoices = resolveHostedAgentModels();
  const messages = [
    ...historyToMessages(input.history),
    { role: 'user' as const, content: input.currentText || '(empty message)' },
  ];
  const tools = buildTools(input.contextId);

  let lastError: unknown = null;
  for (const choice of modelChoices) {
    try {
      const result = await generateText({
        model: choice.model,
        system: SYSTEM_PROMPT,
        messages,
        tools,
        stopWhen: stepCountIs(6),
      });

      log.info('Appointment agent succeeded', {
        contextId: input.contextId,
        provider: choice.provider,
      });
      return result.text.trim() || 'How can I help you schedule an appointment?';
    } catch (error) {
      lastError = error;
      log.warn('Appointment agent model failed', {
        contextId: input.contextId,
        provider: choice.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Appointment agent failed — all models exhausted.');
}

// ---------------------------------------------------------------------------
// Streaming execution (message/stream) — returns an async iterable of chunks
// ---------------------------------------------------------------------------

export async function* streamAppointmentAgent(
  input: AppointmentAgentInput,
): AsyncGenerator<string, void, undefined> {
  log.info('Appointment agent streaming turn', {
    contextId: input.contextId,
    historyLength: input.history.length,
  });

  const modelChoices = resolveHostedAgentModels();
  const messages = [
    ...historyToMessages(input.history),
    { role: 'user' as const, content: input.currentText || '(empty message)' },
  ];
  const tools = buildTools(input.contextId);

  for (const choice of modelChoices) {
    try {
      const { textStream } = streamText({
        model: choice.model,
        system: SYSTEM_PROMPT,
        messages,
        tools,
        stopWhen: stepCountIs(6),
      });

      for await (const chunk of textStream) {
        yield chunk;
      }

      log.info('Appointment agent stream completed', {
        contextId: input.contextId,
        provider: choice.provider,
      });
      return;
    } catch (error) {
      log.warn('Appointment agent stream model failed, trying next', {
        contextId: input.contextId,
        provider: choice.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new Error('Appointment agent streaming failed — all models exhausted.');
}

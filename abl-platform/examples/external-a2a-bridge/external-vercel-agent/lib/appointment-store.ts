import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Booking {
  confirmationId: string;
  contextId: string;
  patientName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  reason: string;
  status: 'confirmed' | 'cancelled';
  bookedAt: string; // ISO timestamp
}

export interface StoredTask {
  id: string;
  contextId: string;
  state: 'working' | 'completed' | 'failed' | 'canceled';
  responseText?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// In-memory stores (per-process — resets on cold start; use Redis for prod)
// ---------------------------------------------------------------------------

const AVAILABLE_TIMES = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];

const bookings = new Map<string, Booking>();
const bookedSlots = new Set<string>(); // "YYYY-MM-DD|HH:MM"
const taskStore = new Map<string, StoredTask>();

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export function getAvailableSlots(date: string): string[] {
  return AVAILABLE_TIMES.filter((t) => !bookedSlots.has(`${date}|${t}`));
}

// ---------------------------------------------------------------------------
// Booking CRUD
// ---------------------------------------------------------------------------

export function bookSlot(params: {
  contextId: string;
  patientName: string;
  date: string;
  time: string;
  reason: string;
}): Booking | null {
  const slotKey = `${params.date}|${params.time}`;
  if (bookedSlots.has(slotKey)) return null;

  const booking: Booking = {
    confirmationId: `APT-${randomUUID().slice(0, 8).toUpperCase()}`,
    contextId: params.contextId,
    patientName: params.patientName,
    date: params.date,
    time: params.time,
    reason: params.reason,
    status: 'confirmed',
    bookedAt: new Date().toISOString(),
  };

  bookedSlots.add(slotKey);
  bookings.set(booking.confirmationId, booking);
  return booking;
}

export function cancelBooking(confirmationId: string): Booking | null {
  const booking = bookings.get(confirmationId);
  if (!booking || booking.status === 'cancelled') return null;
  booking.status = 'cancelled';
  bookedSlots.delete(`${booking.date}|${booking.time}`);
  return booking;
}

export function getBooking(confirmationId: string): Booking | null {
  return bookings.get(confirmationId) ?? null;
}

// ---------------------------------------------------------------------------
// Task store (for tasks/get and tasks/cancel)
// ---------------------------------------------------------------------------

export function storeTask(task: StoredTask): void {
  taskStore.set(task.id, task);
}

export function getStoredTask(taskId: string): StoredTask | null {
  return taskStore.get(taskId) ?? null;
}

export function updateTask(
  taskId: string,
  updates: Partial<Pick<StoredTask, 'state' | 'responseText'>>,
): void {
  const task = taskStore.get(taskId);
  if (!task) return;
  if (updates.state !== undefined) task.state = updates.state;
  if (updates.responseText !== undefined) task.responseText = updates.responseText;
}

import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  attendanceEvents,
  type AttendanceEventRow,
} from "@/lib/db/schema";

export type AttendanceType = "check_in" | "check_out";
export type AttendanceSource =
  | "manual"
  | "geofence"
  | "qr"
  | "manager_attest";

export interface AttendanceEventDto {
  id: string;
  employeeId: string;
  type: AttendanceType;
  occurredAt: Date;
  source: AttendanceSource;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  recordedByUserId: string;
  note: string | null;
  requiresReview: boolean;
}

function rowToDto(row: AttendanceEventRow): AttendanceEventDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    type: row.type as AttendanceType,
    occurredAt: row.occurredAt,
    source: row.source as AttendanceSource,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    accuracyM: row.accuracyM,
    recordedByUserId: row.recordedByUserId,
    note: row.note,
    requiresReview: row.requiresReview,
  };
}

export interface RecordEventInput {
  employeeId: string;
  type: AttendanceType;
  source: AttendanceSource;
  occurredAt?: Date;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  recordedByUserId: string;
  note?: string | null;
}

/**
 * Record a new attendance event. Enforces the obvious invariant:
 *   - check_in is only valid when the employee's last event is a check_out (or there is no prior event)
 *   - check_out is only valid when there is an open check_in
 *
 * If the employee tries to check_in twice (forgot to check out earlier), the
 * previous open check_in is flagged requires_review = true so the manager can
 * reconcile it. The new check_in still goes through.
 */
export async function recordAttendanceEvent(
  tenantId: string,
  input: RecordEventInput,
): Promise<AttendanceEventDto> {
  return withTenant(tenantId, async (tx) => {
    const lastRows = await tx
      .select()
      .from(attendanceEvents)
      .where(
        and(
          eq(attendanceEvents.tenantId, tenantId),
          eq(attendanceEvents.employeeId, input.employeeId),
        ),
      )
      .orderBy(desc(attendanceEvents.occurredAt))
      .limit(1);
    const last = lastRows[0];

    if (input.type === "check_in") {
      if (last && last.type === "check_in") {
        // Forgot-to-check-out: flag the previous open check_in.
        await tx
          .update(attendanceEvents)
          .set({ requiresReview: true })
          .where(eq(attendanceEvents.id, last.id));
      }
    } else {
      // check_out
      if (!last || last.type !== "check_in") {
        throw new AttendanceStateError(
          "لا يمكن تسجيل الانصراف بدون حضور سابق",
        );
      }
    }

    const [row] = await tx
      .insert(attendanceEvents)
      .values({
        tenantId,
        employeeId: input.employeeId,
        type: input.type,
        source: input.source,
        occurredAt: input.occurredAt ?? new Date(),
        latitude: input.latitude == null ? null : String(input.latitude),
        longitude: input.longitude == null ? null : String(input.longitude),
        accuracyM: input.accuracyM ?? null,
        recordedByUserId: input.recordedByUserId,
        note: input.note ?? null,
      })
      .returning();
    return rowToDto(row);
  });
}

export class AttendanceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceStateError";
  }
}

export async function listAttendanceEvents(
  tenantId: string,
  args: {
    employeeId?: string;
    fromDate: Date;
    toDate: Date;
  },
): Promise<AttendanceEventDto[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(attendanceEvents)
      .where(
        and(
          eq(attendanceEvents.tenantId, tenantId),
          args.employeeId
            ? eq(attendanceEvents.employeeId, args.employeeId)
            : undefined,
          gte(attendanceEvents.occurredAt, args.fromDate),
          lte(attendanceEvents.occurredAt, args.toDate),
        ),
      )
      .orderBy(asc(attendanceEvents.occurredAt));
    return rows.map(rowToDto);
  });
}

/** Return the latest event for each employee — used by the today-roster view. */
export async function listLatestEventsToday(
  tenantId: string,
): Promise<Record<string, AttendanceEventDto>> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const events = await listAttendanceEvents(tenantId, {
    fromDate: start,
    toDate: end,
  });
  // Walk in chronological order — the last write per employee wins.
  const latest: Record<string, AttendanceEventDto> = {};
  for (const e of events) latest[e.employeeId] = e;
  return latest;
}

export async function deleteAttendanceEvent(
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .delete(attendanceEvents)
      .where(
        and(
          eq(attendanceEvents.tenantId, tenantId),
          eq(attendanceEvents.id, id),
        ),
      );
  });
}

export interface UpdateEventInput {
  occurredAt?: Date;
  type?: AttendanceType;
  note?: string | null;
  requiresReview?: boolean;
}

export async function updateAttendanceEvent(
  tenantId: string,
  id: string,
  patch: UpdateEventInput,
): Promise<AttendanceEventDto | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .update(attendanceEvents)
      .set({
        ...(patch.occurredAt && { occurredAt: patch.occurredAt }),
        ...(patch.type && { type: patch.type }),
        ...(patch.note !== undefined && { note: patch.note }),
        ...(patch.requiresReview !== undefined && {
          requiresReview: patch.requiresReview,
        }),
      })
      .where(
        and(
          eq(attendanceEvents.tenantId, tenantId),
          eq(attendanceEvents.id, id),
        ),
      )
      .returning();
    return row ? rowToDto(row) : null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shift pairing & hour computation
// ─────────────────────────────────────────────────────────────────────────────

export interface Shift {
  /** ms since epoch — start of shift */
  start: Date;
  /** ms since epoch — end of shift, or null if still open */
  end: Date | null;
  hours: number;
  /** True if the shift was reconstructed from an unmatched check_in. */
  requiresReview: boolean;
}

/**
 * Pair check_in→check_out events into shifts in chronological order.
 * Unmatched check_ins (forgot-to-check-out) become open shifts flagged for review.
 * Stray check_outs (no preceding check_in) are silently dropped — they shouldn't
 * exist due to the invariant in recordAttendanceEvent.
 */
export function pairShifts(events: AttendanceEventDto[]): Shift[] {
  const sorted = [...events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  const out: Shift[] = [];
  let openIn: AttendanceEventDto | null = null;
  for (const e of sorted) {
    if (e.type === "check_in") {
      if (openIn) {
        out.push({
          start: openIn.occurredAt,
          end: null,
          hours: 0,
          requiresReview: true,
        });
      }
      openIn = e;
    } else {
      // check_out
      if (openIn) {
        const ms = e.occurredAt.getTime() - openIn.occurredAt.getTime();
        out.push({
          start: openIn.occurredAt,
          end: e.occurredAt,
          hours: ms > 0 ? ms / 3_600_000 : 0,
          requiresReview: openIn.requiresReview || e.requiresReview,
        });
        openIn = null;
      }
    }
  }
  if (openIn) {
    out.push({
      start: openIn.occurredAt,
      end: null,
      hours: 0,
      requiresReview: true,
    });
  }
  return out;
}

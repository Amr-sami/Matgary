import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  attendanceSettings,
  storeLocations,
  type AttendanceSettingsRow,
  type StoreLocationRow,
} from "@/lib/db/schema";

export interface AttendanceSettingsDto {
  workHoursPerDay: number;
  weekendDays: number[];
  overtimeMultiplier: number;
  graceMinutesLate: number;
}

export interface StoreLocationDto {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  geofenceRadiusM: number;
}

const DEFAULT_SETTINGS: AttendanceSettingsDto = {
  workHoursPerDay: 8,
  weekendDays: [5, 6],
  overtimeMultiplier: 1,
  graceMinutesLate: 0,
};

function rowToSettings(row: AttendanceSettingsRow): AttendanceSettingsDto {
  return {
    workHoursPerDay: Number(row.workHoursPerDay),
    weekendDays: row.weekendDays as number[],
    overtimeMultiplier: Number(row.overtimeMultiplier),
    graceMinutesLate: row.graceMinutesLate,
  };
}

export async function getAttendanceSettings(
  tenantId: string,
): Promise<AttendanceSettingsDto> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(attendanceSettings)
      .where(eq(attendanceSettings.tenantId, tenantId))
      .limit(1);
    return rows[0] ? rowToSettings(rows[0]) : { ...DEFAULT_SETTINGS };
  });
}

export async function upsertAttendanceSettings(
  tenantId: string,
  patch: Partial<AttendanceSettingsDto>,
): Promise<AttendanceSettingsDto> {
  return withTenant(tenantId, async (tx) => {
    const next: AttendanceSettingsDto = {
      ...DEFAULT_SETTINGS,
      ...(await tx
        .select()
        .from(attendanceSettings)
        .where(eq(attendanceSettings.tenantId, tenantId))
        .limit(1)
        .then((r) => (r[0] ? rowToSettings(r[0]) : DEFAULT_SETTINGS))),
      ...patch,
    };
    await tx
      .insert(attendanceSettings)
      .values({
        tenantId,
        workHoursPerDay: String(next.workHoursPerDay),
        weekendDays: next.weekendDays,
        overtimeMultiplier: String(next.overtimeMultiplier),
        graceMinutesLate: next.graceMinutesLate,
      })
      .onConflictDoUpdate({
        target: attendanceSettings.tenantId,
        set: {
          workHoursPerDay: String(next.workHoursPerDay),
          weekendDays: next.weekendDays,
          overtimeMultiplier: String(next.overtimeMultiplier),
          graceMinutesLate: next.graceMinutesLate,
          updatedAt: new Date(),
        },
      });
    return next;
  });
}

function rowToLocation(row: StoreLocationRow): StoreLocationDto {
  return {
    id: row.id,
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    geofenceRadiusM: row.geofenceRadiusM,
  };
}

export async function listStoreLocations(
  tenantId: string,
): Promise<StoreLocationDto[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(storeLocations)
      .where(eq(storeLocations.tenantId, tenantId))
      .orderBy(desc(storeLocations.createdAt));
    return rows.map(rowToLocation);
  });
}

export interface CreateStoreLocationInput {
  name: string;
  latitude: number;
  longitude: number;
  geofenceRadiusM?: number;
}

export async function createStoreLocation(
  tenantId: string,
  input: CreateStoreLocationInput,
): Promise<StoreLocationDto> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(storeLocations)
      .values({
        tenantId,
        name: input.name.trim(),
        latitude: String(input.latitude),
        longitude: String(input.longitude),
        geofenceRadiusM: input.geofenceRadiusM ?? 50,
      })
      .returning();
    return rowToLocation(row);
  });
}

export async function deleteStoreLocation(
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .delete(storeLocations)
      .where(
        and(eq(storeLocations.tenantId, tenantId), eq(storeLocations.id, id)),
      );
  });
}

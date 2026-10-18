// Digital collections L2 — request bodies of spec 07's routes (07 §4.5;
// 03 §B.17, 10 ARCH CHANGE REQUEST 4). Shape only: a zod failure is always
// 400 INVALID_REQUEST; semantic checks with their own codes live in the repos.

import { z } from "zod";
import {
  IGNORE_REASON_VALUES,
  INGEST_CHANNEL_VALUES,
  INGEST_PLATFORM_VALUES,
} from "@matgary/domain/collections/types";

export const INGEST_MAX_BYTES = 262_144;
export const INGEST_MAX_MESSAGES = 50;

/** ISO 8601 with `Z` or a `±hh:mm` offset (the iOS shortcut formats a local offset). */
const isoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/, "ISO 8601 with Z or ±hh:mm")
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid date");

/** An empty string means "absent" (a shortcut cannot omit a dictionary key). */
const optText = (max: number) =>
  z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v == null || v === "" ? null : v.slice(0, max)));

export const ingestMessageSchema = z.object({
  fp: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  channel: z.enum(INGEST_CHANNEL_VALUES),
  sourceApp: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => (v == null || v === "" ? null : v)),
  sender: optText(64),
  title: optText(500),
  subtitle: optText(500),
  body: z.string().min(1).max(8000),
  receivedAt: isoInstant,
  test: z.boolean().optional().default(false),
});

export const ingestBodySchema = z.object({
  v: z.literal(1),
  // The 51st message is a 413 (checked before zod), so this bound is a backstop.
  messages: z.array(ingestMessageSchema).min(1).max(INGEST_MAX_MESSAGES),
});

export const heartbeatSchema = z.object({
  v: z.literal(1),
  platform: z.enum(INGEST_PLATFORM_VALUES),
  appVersion: z.string().max(40).nullable().optional(),
  osVersion: z.string().max(40).nullable().optional(),
  listenerConnected: z.boolean().optional(),
  lastNotificationAt: isoInstant.nullable().optional(),
  lastUploadAt: isoInstant.nullable().optional(),
  queued: z.number().int().min(0).max(100_000).optional(),
  packagesInstalled: z.array(z.string().max(200)).max(50).optional(),
});

/** Device channels never include manual_paste / statement (§4.11). */
const deviceChannel = z.enum(["ios_sms", "ios_notification", "android_notification", "android_sms"]);

export const deviceCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    platform: z.enum(INGEST_PLATFORM_VALUES),
    channels: z.array(deviceChannel).min(1).max(4),
    accountIds: z.array(z.string().uuid()).max(50).optional(),
    branchId: z.string().uuid().nullable().optional(),
    consentVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
    consentAccepted: z.literal(true),
    appVersion: z.string().max(40).nullable().optional(),
    osVersion: z.string().max(40).nullable().optional(),
    replacesDeviceId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const revokeReasonSchema = z.enum(["owner", "replaced"]);

export const matchSchema = z.object({ collectionId: z.string().uuid() }).strict();

export const ignoreSchema = z
  .object({ reason: z.enum(IGNORE_REASON_VALUES), note: z.string().max(280).nullable().optional() })
  .strict();

export const pasteSchema = z
  .object({
    text: z.string().min(1).max(10_000),
    sender: z.string().max(64).nullable().optional(),
    accountId: z.string().uuid().nullable().optional(),
  })
  .strict();

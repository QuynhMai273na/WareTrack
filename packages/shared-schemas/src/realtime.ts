import { z } from 'zod';
import { IsoDateTime, Uuid } from './common';

/** Catalog event theo site (mục 17.4). */
export const RealtimeEventType = z.enum([
  'truck.arrived',
  'truck.dock_assigned',
  'truck.docked',
  'truck.status_changed',
  'truck.departed',
  'dock.status_changed',
  'slot.status_changed',
  'vehicle.status_changed',
  'vehicle.location_changed',
  'inventory.updated',
  'pallet.moved',
  'shipment.progress_updated',
  'forklift.status_changed',
  'forklift.task_updated',
  'task.status_changed',
  'exception.raised',
  'site.kpi_updated',
  'layout.published',
]);
export type RealtimeEventType = z.infer<typeof RealtimeEventType>;

/** Envelope chung v1 (mục 17.2). */
export const RealtimeEnvelope = z.object({
  eventId: Uuid,
  type: RealtimeEventType,
  v: z.number().int(),
  siteId: Uuid,
  siteSeq: z.number().int(),
  occurredAt: IsoDateTime,
  publishedAt: IsoDateTime,
  aggregate: z.object({ type: z.string(), id: z.string(), version: z.number().int() }),
  correlationId: z.string().nullable(),
  data: z.record(z.unknown()),
});
export type RealtimeEnvelope = z.infer<typeof RealtimeEnvelope>;

export const SiteJoinAck = z.union([
  z.object({ ok: z.literal(true), latestSeq: z.number().int() }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
export type SiteJoinAck = z.infer<typeof SiteJoinAck>;

export const EventsReplayResponse = z.object({
  events: z.array(RealtimeEnvelope),
  latestSeq: z.number().int(),
  truncated: z.boolean(),
});
export type EventsReplayResponse = z.infer<typeof EventsReplayResponse>;

export const SOCKET_PATH = '/ws';
export const SOCKET_NAMESPACE = '/rt';

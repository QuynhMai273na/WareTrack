import { z } from 'zod';
import { IsoDateTime, Uuid } from './common';

export const NotificationSeverity = z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL']);
export type NotificationSeverity = z.infer<typeof NotificationSeverity>;

/** In-app notification (FR-18.01). `link` là đường dẫn FE tương đối. */
export const NotificationDto = z.object({
  id: Uuid,
  siteId: Uuid.nullable(),
  siteCode: z.string().nullable(),
  category: z.string(),
  severity: NotificationSeverity,
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  readAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type NotificationDto = z.infer<typeof NotificationDto>;

export const NotificationList = z.object({ items: z.array(NotificationDto), unreadCount: z.number().int() });
export type NotificationList = z.infer<typeof NotificationList>;

/** Payload gửi riêng room user:{id} (mục 17.3). */
export const NotificationCreated = z.object({ notificationId: Uuid, category: z.string(), severity: NotificationSeverity, title: z.string(), link: z.string().nullable() });
export type NotificationCreated = z.infer<typeof NotificationCreated>;

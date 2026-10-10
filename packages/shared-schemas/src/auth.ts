import { z } from 'zod';
import { Uuid } from './common';

export const LoginRequest = z
  .object({
    username: z.string().min(1).max(100),
    password: z.string().min(1).max(200),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequest>;

export const UserSummary = z.object({
  id: Uuid,
  username: z.string(),
  fullName: z.string(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const SiteAccess = z.object({
  id: Uuid,
  code: z.string(),
  name: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});
export type SiteAccess = z.infer<typeof SiteAccess>;

export const LoginResponse = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  user: UserSummary,
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MeResponse = z.object({
  user: UserSummary,
  enterpriseRoles: z.array(z.string()),
  enterprisePermissions: z.array(z.string()),
  sites: z.array(SiteAccess),
  permissionVersion: z.number(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ChangePasswordRequest = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12).max(200),
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface Principal {
  userId: string;
  username: string;
  fullName: string;
  /** Site của request hiện tại (nếu route có :siteId). */
  siteId: string | null;
  /** Permission hiệu lực tại site hiện tại (hoặc cấp doanh nghiệp nếu không có site). */
  permissions: Set<string>;
  roles: string[];
}

export interface RequestContext {
  correlationId: string;
  ip: string | null;
  userAgent: string | null;
  principal: Principal | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const correlationId = incoming && incoming.length <= 64 ? incoming : `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  res.setHeader('X-Request-Id', correlationId);
  storage.run(
    { correlationId, ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null, principal: null },
    () => next(),
  );
}

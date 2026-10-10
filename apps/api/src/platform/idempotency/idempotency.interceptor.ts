import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '@waretrack/shared-schemas';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { from, Observable, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { IS_PUBLIC, SKIP_IDEMPOTENCY } from '../auth/decorators';
import { currentContext } from '../context/request-context';
import { DomainError } from '../errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Idempotency-Key cho POST/DELETE (mục 16.1, BR-05):
 * - thiếu key → 428; cùng key + body khác → 422; đang xử lý → 409;
 * - đã có kết quả → trả lại đúng response cũ, không chạy lại lệnh.
 * Lỗi nghiệp vụ không được lưu để client có thể thử lại sau khi tải lại dữ liệu.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const targets = [context.getHandler(), context.getClass()];
    const skip =
      this.reflector.getAllAndOverride<boolean>(SKIP_IDEMPOTENCY, targets) ||
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    if (skip || !['POST', 'DELETE'].includes(req.method)) return next.handle();

    const principal = currentContext()?.principal;
    if (!principal) return next.handle();
    const key = req.header('idempotency-key');
    if (!key || key.length > 100) {
      throw new DomainError(428, ErrorCode.IDEMPOTENCY_KEY_REQUIRED, 'Header Idempotency-Key is required');
    }
    const path = req.originalUrl.split('?')[0];
    const requestHash = createHash('sha256')
      .update(`${req.method} ${path} ${JSON.stringify(req.body ?? {})}`)
      .digest('hex');

    return from(this.claim(principal.userId, key, req.method, path, requestHash)).pipe(
      mergeMap((existing) => {
        if (existing) {
          res.status(existing.status);
          res.setHeader('Idempotent-Replayed', 'true');
          return of(existing.body);
        }
        return next.handle().pipe(
          mergeMap((body) =>
            from(
              this.prisma.idempotencyRecord.update({
                where: { userId_key: { userId: principal.userId, key } },
                data: { responseStatus: res.statusCode, responseBody: (body ?? null) as Prisma.InputJsonValue },
              }),
            ).pipe(mergeMap(() => of(body))),
          ),
          catchError((err) =>
            from(
              this.prisma.idempotencyRecord
                .delete({ where: { userId_key: { userId: principal.userId, key } } })
                .catch(() => undefined),
            ).pipe(
              mergeMap(() => {
                throw err;
              }),
            ),
          ),
        );
      }),
    );
  }

  private async claim(userId: string, key: string, method: string, path: string, requestHash: string) {
    try {
      await this.prisma.idempotencyRecord.create({
        data: { userId, key, method, path, requestHash, expiresAt: new Date(Date.now() + TTL_MS) },
      });
      return null;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      const existing = await this.prisma.idempotencyRecord.findUnique({ where: { userId_key: { userId, key } } });
      if (!existing) throw DomainError.conflict(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Request with this key is being processed');
      if (existing.requestHash !== requestHash) {
        throw DomainError.rule(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'Idempotency-Key was already used with a different request');
      }
      if (existing.responseStatus == null) {
        throw DomainError.conflict(ErrorCode.IDEMPOTENCY_IN_PROGRESS, 'Request with this key is being processed');
      }
      return { status: existing.responseStatus, body: existing.responseBody };
    }
  }
}

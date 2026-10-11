import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ErrorCode } from '@waretrack/shared-schemas';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { currentContext } from '../context/request-context';
import { mapDbError } from './db-error-map';
import { DomainError } from './domain-error';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
  errors?: Array<{ path: string; message: string }>;
}

const HTTP_CODE: Record<number, string> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  429: ErrorCode.RATE_LIMITED,
};

/** Mọi lỗi trả về theo RFC 9457 application/problem+json (mục 16.2). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') return;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const problem = this.toProblem(exception);
    problem.instance = req.originalUrl;
    problem.correlationId = currentContext()?.correlationId;
    if (problem.status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): Problem {
    if (exception instanceof DomainError) {
      return this.make(exception.status, exception.code, exception.message, exception.details);
    }
    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as ZodError;
      const problem = this.make(400, ErrorCode.VALIDATION_ERROR, 'Request validation failed');
      problem.errors = zodError.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      return problem;
    }
    const db = mapDbError(exception);
    if (db) return this.make(db.status, db.code, db.message, db.details);
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : ((body as { message?: string }).message ?? exception.message);
      const code = status === 400 && /JSON/i.test(String(message)) ? ErrorCode.MALFORMED_JSON : (HTTP_CODE[status] ?? `HTTP_${status}`);
      return this.make(status, code, Array.isArray(message) ? message.join('; ') : String(message));
    }
    return this.make(500, ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred');
  }

  private make(status: number, code: string, title: string, details?: Record<string, unknown>): Problem {
    return {
      type: `https://docs.waretrack.local/errors/${code}`,
      title,
      status,
      code,
      ...(details ? { details } : {}),
    };
  }
}

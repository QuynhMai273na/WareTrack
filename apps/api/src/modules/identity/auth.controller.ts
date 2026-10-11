import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ErrorCode, LoginRequest, type LoginResponse, type MeResponse } from '@waretrack/shared-schemas';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { CurrentUser, Public, SkipIdempotency } from '../../platform/auth/decorators';
import { env, webOrigins } from '../../platform/config/env';
import type { Principal } from '../../platform/context/request-context';
import { DomainError } from '../../platform/errors/domain-error';
import { AuthService, type IssuedTokens } from './auth.service';

class LoginDto extends createZodDto(LoginRequest) {}

const COOKIE = 'wt_refresh';
const COOKIE_PATH = '/api/v1/auth';

function setRefreshCookie(res: Response, tokens: IssuedTokens) {
  const environment = env();
  res.cookie(COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: environment.COOKIE_SECURE,
    sameSite: environment.COOKIE_SAMESITE,
    path: COOKIE_PATH,
    expires: tokens.refreshExpiresAt,
  });
}

/** Endpoint refresh dùng cookie → kiểm tra Origin thuộc allow-list (chống CSRF — mục 19.1). */
function assertOrigin(req: Request) {
  const origin = req.header('origin');
  if (origin && !webOrigins().includes(origin)) throw DomainError.forbidden('Origin not allowed');
}

@ApiTags('Auth')
@Controller('auth')
@SkipIdempotency()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    const { user, tokens } = await this.auth.login(body.username, body.password, { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null });
    setRefreshCookie(res, tokens);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user: { id: user.id, username: user.username, fullName: user.fullName } };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    assertOrigin(req);
    const raw = req.cookies?.[COOKIE] as string | undefined;
    try {
      const { user, tokens } = await this.auth.refresh(raw, { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null });
      setRefreshCookie(res, tokens);
      return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user: { id: user.id, username: user.username, fullName: user.fullName } };
    } catch (err) {
      if (err instanceof DomainError && err.status === 401) res.clearCookie(COOKIE, { path: COOKIE_PATH });
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertOrigin(req);
    await this.auth.logout(req.cookies?.[COOKIE] as string | undefined);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentUser() user: Principal, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(user.userId);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Get('me')
  async me(@CurrentUser() user: Principal): Promise<MeResponse> {
    if (!user) throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required');
    return this.auth.me(user.userId);
  }
}

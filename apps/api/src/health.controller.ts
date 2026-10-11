import { Controller, Get, HttpException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './platform/auth/decorators';
import { PrismaService } from './platform/prisma/prisma.service';

/** Health check cho Render / uptime monitor (#200, #201). */
@ApiTags('Health')
@Controller('health')
@Public()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Chế độ chạy cho màn hình đăng nhập: demo (hiện tài khoản mẫu) hay vận hành thật. */
  @Get('info')
  info() {
    const demoMode = ['true', 'scene'].includes(process.env.DEMO_DIRECTOR ?? '') || process.env.SEED_ON_EMPTY === 'true';
    return { mode: demoMode ? 'demo' : 'live' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'ok' };
    } catch {
      throw new HttpException({ status: 'unavailable', db: 'down' }, 503);
    }
  }
}

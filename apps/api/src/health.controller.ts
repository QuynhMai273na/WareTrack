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

  /**
   * Chế độ chạy: `mode` cho màn hình đăng nhập (demo hiện tài khoản mẫu / live), `motion` cho bản đồ 3D —
   * `auto` khi DemoDirector tự vận hành (xe nâng chạy vòng liên tục), `manual` khi mọi chuyển động đến từ thao tác người dùng.
   */
  @Get('info')
  info() {
    const directorMode = process.env.DEMO_DIRECTOR ?? '';
    const demoMode = ['true', 'scene'].includes(directorMode) || process.env.SEED_ON_EMPTY === 'true';
    return { mode: demoMode ? 'demo' : 'live', motion: directorMode === 'true' ? 'auto' : 'manual' };
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

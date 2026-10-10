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

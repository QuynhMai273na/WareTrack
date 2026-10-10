import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { Principal } from '../../platform/context/request-context';
import { NotificationsService } from './notifications.service';

class ReadAllDto extends createZodDto(z.object({ siteId: z.string().uuid().optional() }).strict()) {}

/** Thông báo của tôi (#193–#195) — chỉ đọc/ghi notification của chính user. */
@ApiTags('Notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission('notification.read')
  list(@CurrentUser() user: Principal, @Query('unread') unread?: string, @Query('siteId') siteId?: string) {
    return this.notifications.list(user.userId, { unread: unread === 'true', siteId });
  }

  @Post('read-all')
  @HttpCode(204)
  @RequirePermission('notification.read')
  async readAll(@CurrentUser() user: Principal, @Body() body: ReadAllDto) {
    await this.notifications.readAll(user.userId, body.siteId);
  }

  @Post(':notificationId/read')
  @HttpCode(204)
  @RequirePermission('notification.read')
  async read(@CurrentUser() user: Principal, @Param('notificationId') id: string) {
    await this.notifications.markRead(user.userId, id);
  }
}

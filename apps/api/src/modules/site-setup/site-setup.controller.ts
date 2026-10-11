import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateSiteRequest, SiteBlueprint, UpdateSiteRequest } from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { Principal } from '../../platform/context/request-context';
import { AccessService } from '../identity/access.service';
import { SiteSetupService } from './site-setup.service';

class CreateSiteDto extends createZodDto(CreateSiteRequest) {}
class UpdateSiteDto extends createZodDto(UpdateSiteRequest) {}
class BlueprintBodyDto extends createZodDto(z.object({ blueprint: SiteBlueprint }).strict()) {}

/** Thiết lập site cho vận hành thật: tạo/sửa site và soạn — xem trước — publish sơ đồ (UC-23). */
@ApiTags('Site setup')
@Controller()
export class SiteSetupController {
  constructor(
    private readonly setup: SiteSetupService,
    private readonly access: AccessService,
  ) {}

  /** Danh sách site cho khu quản trị — chỉ các site user được phép (admin: mọi site). */
  @Get('admin/sites')
  @RequirePermission('site.read')
  async list(@CurrentUser() user: Principal) {
    const userAccess = await this.access.getUserAccess(user.userId);
    const allowedSiteIds = userAccess ? await this.access.allowedSiteIds(userAccess) : [];
    return (await this.setup.listAdminSites()).filter((site) => allowedSiteIds.includes(site.id));
  }

  @Post('sites')
  @RequirePermission('site.manage')
  create(@Body() body: CreateSiteDto) {
    return this.setup.createSite(body);
  }

  @Patch('sites/:siteId')
  @RequirePermission('site.manage')
  update(@Param('siteId') siteId: string, @Body() body: UpdateSiteDto) {
    return this.setup.updateSite(siteId, body);
  }

  @Get('sites/:siteId/blueprint')
  @RequirePermission('layout.manage')
  blueprint(@Param('siteId') siteId: string) {
    return this.setup.blueprintState(siteId);
  }

  @Put('sites/:siteId/blueprint')
  @RequirePermission('layout.manage')
  saveDraft(@Param('siteId') siteId: string, @Body() body: BlueprintBodyDto) {
    return this.setup.saveDraft(siteId, body.blueprint);
  }

  @Post('sites/:siteId/blueprint/preview')
  @RequirePermission('layout.manage')
  @HttpCode(200)
  preview(@Param('siteId') siteId: string, @Body() body: BlueprintBodyDto) {
    return this.setup.preview(siteId, body.blueprint);
  }

  @Post('sites/:siteId/blueprint/publish')
  @RequirePermission('layout.manage')
  @HttpCode(200)
  publish(@Param('siteId') siteId: string, @Body() body: BlueprintBodyDto) {
    return this.setup.publish(siteId, body.blueprint);
  }
}

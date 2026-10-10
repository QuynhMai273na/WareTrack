import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BlockLocationRequest, UnblockLocationRequest } from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { Principal } from '../../platform/context/request-context';
import { AccessService } from '../identity/access.service';
import { SitesService } from './sites.service';

class BlockDto extends createZodDto(BlockLocationRequest) {}
class UnblockDto extends createZodDto(UnblockLocationRequest) {}
class SettingDto extends createZodDto(z.object({ value: z.unknown() }).strict()) {}

@ApiTags('Sites')
@Controller('sites')
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly access: AccessService,
  ) {}

  /** Site switcher: các site user được phép (mục 16.4.3 #18). */
  @Get()
  async list(@CurrentUser() user: Principal) {
    const access = await this.access.getUserAccess(user.userId);
    return this.sites.listSites(access ? await this.access.allowedSiteIds(access) : []);
  }

  @Get(':siteId')
  @RequirePermission('site.read')
  get(@Param('siteId') siteId: string) {
    return this.sites.getSite(siteId);
  }

  @Get(':siteId/settings')
  @RequirePermission('site.read')
  settings(@Param('siteId') siteId: string) {
    return this.sites.settings(siteId);
  }

  @Put(':siteId/settings/:key')
  @RequirePermission('site.settings.manage')
  putSetting(@Param('siteId') siteId: string, @Param('key') key: string, @Body() body: SettingDto) {
    return this.sites.putSetting(siteId, key, body.value);
  }

  @Get(':siteId/zones')
  @RequirePermission('site.read')
  zones(@Param('siteId') siteId: string) {
    return this.sites.listZones(siteId);
  }

  @Get(':siteId/locations')
  @RequirePermission('site.read')
  locations(@Param('siteId') siteId: string, @Query('zoneId') zoneId?: string, @Query('type') type?: string, @Query('q') q?: string) {
    return this.sites.listLocations(siteId, { zoneId, type, q });
  }

  /** Tra cứu location theo giá trị QR quét được (#36). Khai báo trước ":locationId". */
  @Get(':siteId/locations/resolve')
  @RequirePermission('site.read')
  resolve(@Param('siteId') siteId: string, @Query('qr') qr: string) {
    return this.sites.resolveQr(siteId, qr);
  }

  @Get(':siteId/locations/:locationId')
  @RequirePermission('site.read')
  location(@Param('siteId') siteId: string, @Param('locationId') locationId: string) {
    return this.sites.getLocation(siteId, locationId);
  }

  @Post(':siteId/locations/:locationId/block')
  @RequirePermission('location.block')
  @HttpCode(200)
  block(@Param('siteId') siteId: string, @Param('locationId') locationId: string, @Body() body: BlockDto) {
    return this.sites.block(siteId, locationId, body.reason);
  }

  @Post(':siteId/locations/:locationId/unblock')
  @RequirePermission('location.block')
  @HttpCode(200)
  unblock(@Param('siteId') siteId: string, @Param('locationId') locationId: string, @Body() body: UnblockDto) {
    return this.sites.unblock(siteId, locationId, body.reason);
  }

  @Get(':siteId/layout')
  @RequirePermission('dashboard.read')
  layout(@Param('siteId') siteId: string) {
    return this.sites.publishedLayout(siteId);
  }
}

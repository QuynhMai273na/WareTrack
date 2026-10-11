import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { Principal } from '../../platform/context/request-context';
import { AccessService } from '../identity/access.service';
import { DashboardService } from './dashboard.service';
import { KpiService } from './kpi.service';

@ApiTags('Dashboard')
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly kpis: KpiService,
    private readonly access: AccessService,
  ) {}

  @Get('sites/:siteId/snapshot')
  @RequirePermission('dashboard.read')
  snapshot(@Param('siteId') siteId: string) {
    return this.dashboard.snapshot(siteId);
  }

  @Get('sites/:siteId/kpis')
  @RequirePermission('dashboard.read')
  kpi(@Param('siteId') siteId: string) {
    return this.kpis.get(siteId);
  }

  @Get('sites/:siteId/events')
  @RequirePermission('dashboard.read')
  events(@Param('siteId') siteId: string, @Query('afterSeq') afterSeq = '0', @Query('limit') limit = '500') {
    return this.dashboard.events(siteId, Number(afterSeq) || 0, Number(limit) || 500);
  }

  @Get('search')
  async search(@CurrentUser() user: Principal, @Query('q') query = '') {
    const access = await this.access.getUserAccess(user.userId);
    return this.dashboard.search(query, access ? await this.access.allowedSiteIds(access) : []);
  }
}

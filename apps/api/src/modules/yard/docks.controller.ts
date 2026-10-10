import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../platform/auth/decorators';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { effectiveStatus } from '../sites/sites.service';
import { OccupancyService } from './occupancy.service';
import { VisitsService } from './visits.service';

/** Bảng Docks (video tab "Docks 4/6") — mục 16.4.6 #38. */
@ApiTags('Yard — Docks')
@Controller('sites/:siteId/docks')
export class DocksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly occupancy: OccupancyService,
    private readonly visits: VisitsService,
  ) {}

  @Get()
  @RequirePermission('yard.visit.read')
  async board(@Param('siteId') siteId: string) {
    const docks = await this.prisma.location.findMany({
      where: { siteId, locationType: 'DOCK', deletedAt: null },
      include: { dock: true },
      orderBy: { code: 'asc' },
    });
    const occ = await this.occupancy.activeByLocations(siteId, docks.map((d) => d.id));
    const visitIds = [...occ.values()].flat().filter((o) => o.occupantType === 'TRUCK_VISIT').map((o) => o.occupantId);
    const visits = new Map(
      (
        await this.prisma.truckVisit.findMany({ where: { id: { in: visitIds } }, include: { truck: { include: { carrier: true } }, driver: true } })
      ).map((v) => [v.id, v]),
    );
    return docks.map((d) => {
      const o = occ.get(d.id) ?? [];
      const current = o.find((x) => x.occupantType === 'TRUCK_VISIT');
      const visit = current ? visits.get(current.occupantId) : undefined;
      return {
        locationId: d.id,
        code: d.code,
        direction: d.dock?.direction ?? 'BOTH',
        doorNumber: d.dock?.doorNumber ?? null,
        effectiveStatus: effectiveStatus(d, o).status,
        blockedReason: d.blockedReason,
        visit: visit ? this.visits.toRow(visit, new Map([[d.id, d]])) : null,
        version: d.version,
      };
    });
  }
}

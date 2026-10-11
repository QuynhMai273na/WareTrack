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
    const occ = await this.occupancy.activeByLocations(siteId, docks.map((dock) => dock.id));
    const visitIds = [...occ.values()].flat().filter((occupancy) => occupancy.occupantType === 'TRUCK_VISIT').map((occupancy) => occupancy.occupantId);
    const visits = new Map(
      (
        await this.prisma.truckVisit.findMany({ where: { id: { in: visitIds } }, include: { truck: { include: { carrier: true } }, driver: true } })
      ).map((visit) => [visit.id, visit]),
    );
    return docks.map((dock) => {
      const occupancies = occ.get(dock.id) ?? [];
      const current = occupancies.find((occupancy) => occupancy.occupantType === 'TRUCK_VISIT');
      const visit = current ? visits.get(current.occupantId) : undefined;
      return {
        locationId: dock.id,
        code: dock.code,
        direction: dock.dock?.direction ?? 'BOTH',
        doorNumber: dock.dock?.doorNumber ?? null,
        effectiveStatus: effectiveStatus(dock, occupancies).status,
        blockedReason: dock.blockedReason,
        visit: visit ? this.visits.toRow(visit, new Map([[dock.id, dock]])) : null,
        version: dock.version,
      };
    });
  }
}

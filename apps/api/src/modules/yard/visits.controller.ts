import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  ArriveAtDockRequest,
  ArriveRequest,
  AssignDockRequest,
  CreateVisitRequest,
  GateOutRequest,
  ReasonRequest,
  VerifyRequest,
  VersionOnlyRequest,
  WalkInRequest,
} from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission } from '../../platform/auth/decorators';
import { VisitsService } from './visits.service';

class CreateVisitDto extends createZodDto(CreateVisitRequest) {}
class ArriveDto extends createZodDto(ArriveRequest) {}
class VerifyDto extends createZodDto(VerifyRequest) {}
class ReasonDto extends createZodDto(ReasonRequest) {}
class WalkInDto extends createZodDto(WalkInRequest) {}
class AssignDockDto extends createZodDto(AssignDockRequest) {}
class VersionDto extends createZodDto(VersionOnlyRequest) {}
class ArriveAtDockDto extends createZodDto(ArriveAtDockRequest) {}
class GateOutDto extends createZodDto(GateOutRequest) {}
class ForceExitDto extends createZodDto(z.object({ reason: z.string().min(5).max(300) }).strict()) {}

/** Truck visits, gate, dock operations (mục 16.4.9–16.4.11). */
@ApiTags('Yard — Visits & Gate')
@Controller('sites/:siteId')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get('visits')
  @RequirePermission('yard.visit.read')
  list(@Param('siteId') siteId: string, @Query('status') status?: string, @Query('direction') direction?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.visits.list(siteId, { status, direction, from, to });
  }

  @Post('visits')
  @RequirePermission('yard.appointment.manage')
  create(@Param('siteId') siteId: string, @Body() body: CreateVisitDto) {
    return this.visits.create(siteId, body);
  }

  @Post('visits/walk-in')
  @RequirePermission('yard.visit.create_walkin')
  walkIn(@Param('siteId') siteId: string, @Body() body: WalkInDto) {
    return this.visits.walkIn(siteId, body);
  }

  @Get('visits/:visitId')
  @RequirePermission('yard.visit.read')
  get(@Param('siteId') siteId: string, @Param('visitId') visitId: string) {
    return this.visits.get(siteId, visitId);
  }

  @Get('gate/lookup')
  @RequirePermission('yard.visit.gate_in')
  lookup(@Param('siteId') siteId: string, @Query('q') searchText: string) {
    return this.visits.lookup(siteId, searchText ?? '').then((visits) => ({ visits }));
  }

  @Post('visits/:visitId/arrive')
  @RequirePermission('yard.visit.gate_in')
  @HttpCode(200)
  arrive(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: ArriveDto) {
    return this.visits.arrive(siteId, visitId, body);
  }

  @Post('visits/:visitId/verify')
  @RequirePermission('yard.visit.gate_in')
  @HttpCode(200)
  verify(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: VerifyDto) {
    return this.visits.verify(siteId, visitId, body);
  }

  @Post('visits/:visitId/reject')
  @RequirePermission('yard.visit.reject')
  @HttpCode(200)
  reject(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: ReasonDto) {
    return this.visits.reject(siteId, visitId, body);
  }

  @Post('visits/:visitId/assign-dock')
  @RequirePermission('yard.dock.assign')
  @HttpCode(200)
  assignDock(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: AssignDockDto) {
    return this.visits.assignDock(siteId, visitId, body);
  }

  @Post('visits/:visitId/unassign-dock')
  @RequirePermission('yard.dock.assign')
  @HttpCode(200)
  unassignDock(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: VersionDto) {
    return this.visits.unassignDock(siteId, visitId, body);
  }

  @Post('visits/:visitId/arrive-at-dock')
  @RequirePermission('yard.visit.update')
  @HttpCode(200)
  arriveAtDock(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: ArriveAtDockDto) {
    return this.visits.arriveAtDock(siteId, visitId, body);
  }

  @Post('visits/:visitId/abort')
  @RequirePermission('yard.visit.abort')
  @HttpCode(200)
  abort(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: ReasonDto) {
    return this.visits.abort(siteId, visitId, body);
  }

  @Post('visits/:visitId/gate-out')
  @RequirePermission('yard.visit.gate_out')
  @HttpCode(200)
  gateOut(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: GateOutDto) {
    return this.visits.gateOut(siteId, visitId, body);
  }

  @Post('visits/:visitId/force-exit')
  @RequirePermission('yard.visit.force_exit')
  @HttpCode(200)
  forceExit(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: ForceExitDto) {
    return this.visits.forceExit(siteId, visitId, body.reason);
  }

  @Post('visits/:visitId/cancel')
  @RequirePermission('yard.appointment.manage')
  @HttpCode(200)
  cancel(@Param('siteId') siteId: string, @Param('visitId') visitId: string, @Body() body: ReasonDto) {
    return this.visits.cancel(siteId, visitId, body);
  }
}

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AllocateSlotRequest,
  ConfirmParkedRequest,
  CreateStayRequest,
  HoldRequest,
  InspectionRequest,
  MoveVehicleRequest,
  ReceiveVehicleRequest,
  ReleaseRequestBody,
  VehicleVersionRequest,
} from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { Principal } from '../../platform/context/request-context';
import { AccessService } from '../identity/access.service';
import { VehiclesService } from './vehicles.service';

class VehicleCreateDto extends createZodDto(CreateStayRequest) {}
class VehicleReceiveDto extends createZodDto(ReceiveVehicleRequest) {}
class VehicleInspectDto extends createZodDto(InspectionRequest) {}
class VehicleAllocateDto extends createZodDto(AllocateSlotRequest) {}
class VehicleParkedDto extends createZodDto(ConfirmParkedRequest) {}
class VehicleMoveDto extends createZodDto(MoveVehicleRequest) {}
class VehicleHoldDto extends createZodDto(HoldRequest) {}
class VehicleReleaseDto extends createZodDto(ReleaseRequestBody) {}
class VehicleVersionDto extends createZodDto(VehicleVersionRequest) {}
class VehicleCancelDto extends createZodDto(z.object({ reason: z.string().min(3).max(300), expectedVersion: z.number().int().min(0) }).strict()) {}

/** Vehicle Storage (UC-04 â†’ UC-07, #131â€“#148). */
@ApiTags('Vehicle Storage')
@Controller()
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly access: AccessService,
  ) {}

  @Get('sites/:siteId/vehicle-stays')
  @RequirePermission('vehicle.read')
  list(@Param('siteId') siteId: string, @Query('status') status?: string, @Query('q') query?: string) {
    return this.vehicles.list(siteId, { status, q: query });
  }

  @Post('sites/:siteId/vehicle-stays')
  @RequirePermission('vehicle.receive')
  create(@Param('siteId') siteId: string, @Body() body: VehicleCreateDto) {
    return this.vehicles.create(siteId, body);
  }

  @Get('sites/:siteId/vehicle-stays/:stayId')
  @RequirePermission('vehicle.read')
  get(@Param('siteId') siteId: string, @Param('stayId') id: string) {
    return this.vehicles.get(siteId, id);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/receive')
  @RequirePermission('vehicle.receive')
  receive(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleReceiveDto) {
    return this.vehicles.receive(siteId, id, body);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/inspections')
  @RequirePermission('vehicle.inspect')
  inspect(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleInspectDto) {
    return this.vehicles.inspect(siteId, id, body);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/allocate-slot')
  @RequirePermission('vehicle.slot.assign')
  allocate(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleAllocateDto) {
    return this.vehicles.allocateSlot(siteId, id, body.slotLocationId, body.expectedVersion);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/release-allocation')
  @RequirePermission('vehicle.slot.assign')
  releaseAllocation(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleVersionDto) {
    return this.vehicles.releaseAllocation(siteId, id, body.expectedVersion);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/confirm-parked')
  @RequirePermission('vehicle.move')
  parked(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleParkedDto) {
    return this.vehicles.confirmParked(siteId, id, body.scan.value, body.scan.method, body.expectedVersion);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/move')
  @RequirePermission('vehicle.slot.assign')
  move(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleMoveDto) {
    return this.vehicles.move(siteId, id, body.toLocationId, body.reason);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/hold')
  @RequirePermission('vehicle.hold.manage')
  hold(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleHoldDto) {
    return this.vehicles.setHold(siteId, id, true, body.reason, body.expectedVersion);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/release-hold')
  @RequirePermission('vehicle.hold.manage')
  releaseHold(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleHoldDto) {
    return this.vehicles.setHold(siteId, id, false, body.reason, body.expectedVersion);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/release-requests')
  @RequirePermission('vehicle.release.request')
  requestRelease(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleReleaseDto) {
    return this.vehicles.requestRelease(siteId, id, body);
  }

  @Post('sites/:siteId/release-requests/:requestId/approve')
  @RequirePermission('vehicle.release.approve')
  approve(@Param('siteId') siteId: string, @Param('requestId') id: string, @Body() body: VehicleVersionDto) {
    return this.vehicles.decideRelease(siteId, id, true, body.note, body.expectedVersion);
  }

  @Post('sites/:siteId/release-requests/:requestId/reject')
  @RequirePermission('vehicle.release.approve')
  reject(@Param('siteId') siteId: string, @Param('requestId') id: string, @Body() body: VehicleVersionDto) {
    return this.vehicles.decideRelease(siteId, id, false, body.note, body.expectedVersion);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/handover')
  @RequirePermission('vehicle.gate_out')
  handover(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleVersionDto) {
    return this.vehicles.handover(siteId, id, body.expectedVersion);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/gate-out')
  @RequirePermission('vehicle.gate_out')
  gateOut(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleVersionDto) {
    return this.vehicles.gateOut(siteId, id, body.expectedVersion);
  }

  @Post('sites/:siteId/vehicle-stays/:stayId/cancel')
  @RequirePermission('vehicle.receive')
  cancel(@Param('siteId') siteId: string, @Param('stayId') id: string, @Body() body: VehicleCancelDto) {
    return this.vehicles.cancel(siteId, id, body.reason, body.expectedVersion);
  }

  /** Lá»‹ch sá»­ theo VIN qua má»i site user Ä‘Æ°á»£c phÃ©p (AC-08). */
  @Get('vehicles/:vin/history')
  @RequirePermission('vehicle.read')
  async history(@CurrentUser() user: Principal, @Param('vin') vin: string) {
    const access = await this.access.getUserAccess(user.userId);
    return this.vehicles.history(vin, access ? await this.access.allowedSiteIds(access) : []);
  }
}

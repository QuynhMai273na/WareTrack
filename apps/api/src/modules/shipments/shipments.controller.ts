import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssignVisitRequest, DeliverRequest } from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { RequirePermission } from '../../platform/auth/decorators';
import { ShipmentsService } from './shipments.service';

class AssignVisitDto extends createZodDto(AssignVisitRequest) {}
class DeliverDto extends createZodDto(DeliverRequest) {}

/** Shipments (#144–#153). Tạo shipment đi qua đơn nhập/xuất. */
@ApiTags('Shipments')
@Controller('sites/:siteId/shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get()
  @RequirePermission('shipment.read')
  list(@Param('siteId') siteId: string, @Query('direction') direction?: string, @Query('status') status?: string, @Query('active') active?: string) {
    return this.shipments.list(siteId, { direction, status, active: active === 'true' });
  }

  @Get(':shipmentId')
  @RequirePermission('shipment.read')
  get(@Param('siteId') siteId: string, @Param('shipmentId') id: string) {
    return this.shipments.detail(siteId, id);
  }

  @Get(':shipmentId/tracking')
  @RequirePermission('shipment.read')
  async tracking(@Param('siteId') siteId: string, @Param('shipmentId') id: string) {
    const detail = await this.shipments.detail(siteId, id);
    return { shipment: { code: detail.code, direction: detail.direction, status: detail.status, destination: detail.destinationText }, visit: detail.visit, steps: detail.steps, progress: detail.progress, asOf: new Date().toISOString() };
  }

  @Patch(':shipmentId')
  @RequirePermission('shipment.manage')
  assignVisit(@Param('siteId') siteId: string, @Param('shipmentId') id: string, @Body() body: AssignVisitDto) {
    return this.shipments.assignVisit(siteId, id, body.truckVisitId, body.expectedVersion);
  }

  @Post(':shipmentId/deliver')
  @RequirePermission('shipment.deliver')
  @HttpCode(200)
  deliver(@Param('siteId') siteId: string, @Param('shipmentId') id: string, @Body() body: DeliverDto) {
    return this.shipments.deliver(siteId, id, body.deliveredAt, body.note, body.expectedVersion);
  }
}

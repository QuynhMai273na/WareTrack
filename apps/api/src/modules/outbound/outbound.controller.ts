import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AllocateRequest, CreateOutboundOrderRequest, DispatchRequest, LoadScanRequest, ShortPickRequest, UnloadScanRequest } from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission } from '../../platform/auth/decorators';
import { OutboundService } from './outbound.service';

class CreateOrderDto extends createZodDto(CreateOutboundOrderRequest) {}
class ConfirmDto extends createZodDto(z.object({ autoAllocate: z.boolean().default(true), expectedVersion: z.number().int() }).strict()) {}
class AllocateDto extends createZodDto(AllocateRequest) {}
class ReasonDto extends createZodDto(z.object({ reason: z.string().min(3).max(300) }).strict()) {}
class VersionDto extends createZodDto(z.object({ expectedVersion: z.number().int() }).strict()) {}
class LoadDto extends createZodDto(LoadScanRequest) {}
class UnloadDto extends createZodDto(UnloadScanRequest) {}
class DispatchDto extends createZodDto(DispatchRequest) {}
class ShortPickDto extends createZodDto(ShortPickRequest) {}

/** Outbound (#131–#143, #171). */
@ApiTags('Outbound')
@Controller('sites/:siteId')
export class OutboundController {
  constructor(private readonly outbound: OutboundService) {}

  @Get('outbound-orders')
  @RequirePermission('inventory.read')
  list(@Param('siteId') siteId: string) {
    return this.outbound.listOrders(siteId);
  }

  @Post('outbound-orders')
  @RequirePermission('outbound.order.manage')
  create(@Param('siteId') siteId: string, @Body() body: CreateOrderDto) {
    return this.outbound.createOrder(siteId, body);
  }

  @Get('outbound-orders/:orderId')
  @RequirePermission('inventory.read')
  get(@Param('siteId') siteId: string, @Param('orderId') id: string) {
    return this.outbound.getOrder(siteId, id);
  }

  @Post('outbound-orders/:orderId/confirm')
  @RequirePermission('outbound.order.manage')
  @HttpCode(200)
  confirm(@Param('siteId') siteId: string, @Param('orderId') id: string, @Body() body: ConfirmDto) {
    return this.outbound.confirm(siteId, id, body.expectedVersion, body.autoAllocate);
  }

  @Post('outbound-orders/:orderId/allocate')
  @RequirePermission('outbound.reserve')
  @HttpCode(200)
  allocate(@Param('siteId') siteId: string, @Param('orderId') id: string, @Body() body: AllocateDto) {
    return this.outbound.allocate(siteId, id, body.allOrNothing);
  }

  @Post('outbound-orders/:orderId/cancel')
  @RequirePermission('outbound.order.manage')
  @HttpCode(200)
  cancel(@Param('siteId') siteId: string, @Param('orderId') id: string, @Body() body: ReasonDto) {
    return this.outbound.cancel(siteId, id, body.reason);
  }

  @Post('tasks/:taskId/short-pick')
  @RequirePermission('outbound.pick')
  @HttpCode(200)
  async shortPick(@Param('siteId') siteId: string, @Param('taskId') id: string, @Body() body: ShortPickDto) {
    await this.outbound.shortPick(siteId, id, body.pickedQty, body.reason);
    return { ok: true };
  }

  @Post('shipments/:shipmentId/loading/start')
  @RequirePermission('outbound.load')
  @HttpCode(200)
  startLoading(@Param('siteId') siteId: string, @Param('shipmentId') id: string, @Body() body: VersionDto) {
    return this.outbound.startLoading(siteId, id, body.expectedVersion);
  }

  @Post('shipments/:shipmentId/load-scans')
  @RequirePermission('outbound.load')
  @HttpCode(200)
  load(@Param('siteId') siteId: string, @Param('shipmentId') id: string, @Body() body: LoadDto) {
    return this.outbound.loadScan(siteId, id, body.huScan.value, body.dockScan.value);
  }

  @Post('shipments/:shipmentId/unload-scans')
  @RequirePermission('outbound.load')
  @HttpCode(200)
  unload(@Param('siteId') siteId: string, @Param('shipmentId') id: string, @Body() body: UnloadDto) {
    return this.outbound.unloadScan(siteId, id, body.huScan.value, body.reason);
  }

  @Post('shipments/:shipmentId/dispatch')
  @RequirePermission('outbound.dispatch')
  @HttpCode(200)
  dispatch(@Param('siteId') siteId: string, @Param('shipmentId') id: string, @Body() body: DispatchDto) {
    return this.outbound.dispatch(siteId, id, body.sealNumber, body.expectedVersion);
  }
}

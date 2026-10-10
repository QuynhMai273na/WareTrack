import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CompleteReceiptRequest, CreateInboundOrderRequest, QcRequest, ReceiptLineRequest, StartReceiptRequest } from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission } from '../../platform/auth/decorators';
import { InboundService } from './inbound.service';

class CreateOrderDto extends createZodDto(CreateInboundOrderRequest) {}
class StartDto extends createZodDto(StartReceiptRequest) {}
class LineDto extends createZodDto(ReceiptLineRequest) {}
class CompleteDto extends createZodDto(CompleteReceiptRequest) {}
class ReasonDto extends createZodDto(z.object({ reason: z.string().min(3).max(300) }).strict()) {}
class NoteDto extends createZodDto(z.object({ note: z.string().max(300).optional() }).strict()) {}
class QcDto extends createZodDto(QcRequest) {}

/** Inbound (#117–#130). */
@ApiTags('Inbound')
@Controller('sites/:siteId')
export class InboundController {
  constructor(private readonly inbound: InboundService) {}

  @Get('inbound-orders')
  @RequirePermission('inventory.read')
  list(@Param('siteId') siteId: string) {
    return this.inbound.listOrders(siteId);
  }

  @Post('inbound-orders')
  @RequirePermission('inbound.order.manage')
  create(@Param('siteId') siteId: string, @Body() body: CreateOrderDto) {
    return this.inbound.createOrder(siteId, body);
  }

  @Get('inbound-orders/:orderId')
  @RequirePermission('inventory.read')
  get(@Param('siteId') siteId: string, @Param('orderId') id: string) {
    return this.inbound.getOrder(siteId, id);
  }

  @Post('receipts')
  @RequirePermission('inbound.receive')
  start(@Param('siteId') siteId: string, @Body() body: StartDto) {
    return this.inbound.startReceipt(siteId, body.inboundOrderId);
  }

  @Get('receipts/:receiptId')
  @RequirePermission('inventory.read')
  receipt(@Param('siteId') siteId: string, @Param('receiptId') id: string) {
    return this.inbound.getReceipt(siteId, id);
  }

  @Post('receipts/:receiptId/lines')
  @RequirePermission('inbound.receive')
  scan(@Param('siteId') siteId: string, @Param('receiptId') id: string, @Body() body: LineDto, @Headers('idempotency-key') key: string) {
    return this.inbound.scanLine(siteId, id, body, key);
  }

  @Post('receipts/:receiptId/lines/:lineId/void')
  @RequirePermission('inbound.receive')
  @HttpCode(200)
  void(@Param('siteId') siteId: string, @Param('receiptId') id: string, @Param('lineId') lineId: string, @Body() body: ReasonDto) {
    return this.inbound.voidLine(siteId, id, lineId, body.reason);
  }

  @Post('receipts/:receiptId/complete')
  @RequirePermission('inbound.receive')
  @HttpCode(200)
  complete(@Param('siteId') siteId: string, @Param('receiptId') id: string, @Body() body: CompleteDto) {
    return this.inbound.completeReceipt(siteId, id, body.closeShortReason);
  }

  @Post('receipts/:receiptId/discrepancies/:discId/approve')
  @RequirePermission('inbound.discrepancy.approve')
  @HttpCode(200)
  approve(@Param('siteId') siteId: string, @Param('receiptId') id: string, @Param('discId') discId: string, @Body() body: NoteDto) {
    return this.inbound.decideDiscrepancy(siteId, id, discId, true, body.note);
  }

  @Post('receipts/:receiptId/discrepancies/:discId/reject')
  @RequirePermission('inbound.discrepancy.approve')
  @HttpCode(200)
  reject(@Param('siteId') siteId: string, @Param('receiptId') id: string, @Param('discId') discId: string, @Body() body: NoteDto) {
    return this.inbound.decideDiscrepancy(siteId, id, discId, false, body.note);
  }

  @Get('qc-queue')
  @RequirePermission('inbound.qc')
  qcQueue(@Param('siteId') siteId: string) {
    return this.inbound.qcQueue(siteId);
  }

  @Post('qc-inspections')
  @RequirePermission('inbound.qc')
  qc(@Param('siteId') siteId: string, @Body() body: QcDto) {
    return this.inbound.recordQc(siteId, body);
  }
}

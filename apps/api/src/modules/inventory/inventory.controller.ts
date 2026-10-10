import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateAdjustmentRequest,
  CreateSkuRequest,
  CreateStockCountRequest,
  DecisionRequest,
  MovePalletRequest,
  RecordCountRequest,
  StatusChangeRequest,
} from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { Principal } from '../../platform/context/request-context';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService, TxRunner } from '../../platform/prisma/prisma.service';
import { InventoryQueryService } from './inventory-query.service';
import { PalletsService } from './pallets.service';
import { StockCountService } from './stock-count.service';
import { StockService } from './stock.service';

class CreateSkuDto extends createZodDto(CreateSkuRequest) {}
class UpdateSkuDto extends createZodDto(
  z.object({ name: z.string().min(2).max(200).optional(), lowStockThreshold: z.string().nullable().optional(), qcRequired: z.boolean().optional(), expectedVersion: z.number().int() }).strict(),
) {}
class StatusChangeDto extends createZodDto(StatusChangeRequest) {}
class CreateAdjustmentDto extends createZodDto(CreateAdjustmentRequest) {}
class DecisionDto extends createZodDto(DecisionRequest) {}
class ReverseDto extends createZodDto(z.object({ reason: z.string().min(5).max(300) }).strict()) {}
class MovePalletDto extends createZodDto(MovePalletRequest) {}
class CreateCountDto extends createZodDto(CreateStockCountRequest) {}
class RecordCountDto extends createZodDto(RecordCountRequest) {}
class CompleteCountDto extends createZodDto(z.object({ createAdjustments: z.boolean().default(true) }).strict()) {}
class CancelDto extends createZodDto(z.object({ reason: z.string().min(3).max(300) }).strict()) {}

/** SKU master (#90–93) — cấp doanh nghiệp. */
@ApiTags('Inventory — SKUs')
@Controller('skus')
export class SkusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly query: InventoryQueryService,
  ) {}

  @Get()
  async list(@Query('q') q?: string) {
    const rows = await this.prisma.sku.findMany({
      where: { deletedAt: null, ...(q ? { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}) },
      orderBy: { code: 'asc' },
      take: 500,
    });
    return rows.map((s) => this.query.skuDto(s));
  }

  @Post()
  @RequirePermission('master.sku.manage')
  create(@Body() body: CreateSkuDto) {
    return this.tx.run(async (tx) => {
      const s = await tx.sku.create({ data: { ...body, unitWeightKg: body.unitWeightKg ?? null, lowStockThreshold: body.lowStockThreshold ?? null } });
      await this.audit.record(tx, { siteId: null, action: 'SKU_CREATED', entityType: 'Sku', entityId: s.id, diff: { after: { code: s.code } } });
      return this.query.skuDto(s);
    });
  }

  @Get(':skuId')
  async get(@Param('skuId') id: string) {
    const s = await this.prisma.sku.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw DomainError.notFound('SKU');
    return this.query.skuDto(s);
  }

  @Patch(':skuId')
  @RequirePermission('master.sku.manage')
  update(@Param('skuId') id: string, @Body() body: UpdateSkuDto) {
    return this.tx.run(async (tx) => {
      const res = await tx.sku.updateMany({
        where: { id, version: body.expectedVersion, deletedAt: null },
        data: { ...(body.name ? { name: body.name } : {}), ...(body.lowStockThreshold !== undefined ? { lowStockThreshold: body.lowStockThreshold } : {}), ...(body.qcRequired !== undefined ? { qcRequired: body.qcRequired } : {}), version: { increment: 1 } },
      });
      if (res.count === 0) throw DomainError.concurrent();
      await this.audit.record(tx, { siteId: null, action: 'SKU_UPDATED', entityType: 'Sku', entityId: id, diff: { after: body as unknown as Record<string, unknown> } });
      return this.query.skuDto(await tx.sku.findUniqueOrThrow({ where: { id } }));
    });
  }
}

/** Tồn kho, ledger, điều chỉnh, pallet, kiểm kê (#94–#116). */
@ApiTags('Inventory')
@Controller('sites/:siteId')
export class InventoryController {
  constructor(
    private readonly query: InventoryQueryService,
    private readonly stock: StockService,
    private readonly pallets: PalletsService,
    private readonly counts: StockCountService,
  ) {}

  @Get('inventory/balances')
  @RequirePermission('inventory.read')
  balances(@Param('siteId') siteId: string, @Query('skuId') skuId?: string, @Query('locationId') locationId?: string, @Query('huId') huId?: string, @Query('status') status?: string, @Query('q') q?: string) {
    return this.query.balances(siteId, { skuId, locationId, huId, status, q });
  }

  @Get('inventory/availability')
  @RequirePermission('inventory.read')
  availability(@Param('siteId') siteId: string) {
    return this.query.availability(siteId);
  }

  @Get('inventory/transactions')
  @RequirePermission('inventory.read')
  transactions(@Param('siteId') siteId: string, @Query('skuId') skuId?: string, @Query('huId') huId?: string, @Query('type') type?: string) {
    return this.query.transactions(siteId, { skuId, huId, type });
  }

  @Post('inventory/transactions/:txId/reverse')
  @RequirePermission('inventory.reversal')
  async reverse(@Param('siteId') siteId: string, @Param('txId') txId: string, @Body() body: ReverseDto) {
    if (!/^\d+$/.test(txId)) throw DomainError.notFound('Inventory transaction');
    const t = await this.stock.reverse(siteId, BigInt(txId), body.reason);
    return { id: String(t.id), txType: t.txType };
  }

  @Post('inventory/status-changes')
  @RequirePermission('inventory.status.change')
  @HttpCode(200)
  statusChange(@Param('siteId') siteId: string, @Body() body: StatusChangeDto) {
    return this.stock.changeStatus(siteId, body);
  }

  @Get('inventory/adjustments')
  @RequirePermission('inventory.read')
  adjustments(@Param('siteId') siteId: string, @Query('status') status?: string) {
    return this.query.adjustments(siteId, status);
  }

  @Post('inventory/adjustments')
  @RequirePermission('inventory.adjust.request')
  async requestAdjustment(@Param('siteId') siteId: string, @Body() body: CreateAdjustmentDto) {
    const adj = await this.stock.requestAdjustment(siteId, body);
    return (await this.query.adjustments(siteId)).find((a) => a.id === adj.id);
  }

  @Post('inventory/adjustments/:adjId/approve')
  @RequirePermission('inventory.adjust.approve')
  @HttpCode(200)
  async approve(@Param('siteId') siteId: string, @Param('adjId') adjId: string, @Body() body: DecisionDto) {
    await this.stock.approveAdjustment(siteId, adjId, body);
    return (await this.query.adjustments(siteId)).find((a) => a.id === adjId);
  }

  @Post('inventory/adjustments/:adjId/reject')
  @RequirePermission('inventory.adjust.approve')
  @HttpCode(200)
  async reject(@Param('siteId') siteId: string, @Param('adjId') adjId: string, @Body() body: DecisionDto) {
    await this.stock.rejectAdjustment(siteId, adjId, body);
    return (await this.query.adjustments(siteId)).find((a) => a.id === adjId);
  }

  @Get('pallets')
  @RequirePermission('inventory.read')
  palletList(@Param('siteId') siteId: string, @Query('lifecycle') lifecycle?: string, @Query('q') q?: string) {
    return this.query.pallets(siteId, { lifecycle, q });
  }

  @Get('pallets/:huId')
  @RequirePermission('inventory.read')
  pallet(@Param('siteId') siteId: string, @Param('huId') huId: string) {
    return this.query.pallet(siteId, huId);
  }

  @Get('pallets/:huId/history')
  @RequirePermission('inventory.read')
  history(@Param('siteId') siteId: string, @Param('huId') huId: string) {
    return this.query.palletHistory(siteId, huId);
  }

  @Post('pallets/:huId/move')
  @RequirePermission('inventory.move')
  @HttpCode(200)
  async move(@Param('siteId') siteId: string, @Param('huId') huId: string, @Body() body: MovePalletDto, @CurrentUser() user: Principal) {
    await this.pallets.moveFromApi(siteId, huId, body, user.permissions.has('inventory.capacity.override'));
    return this.query.pallet(siteId, huId);
  }

  @Get('stock-counts')
  @RequirePermission('inventory.read')
  countList(@Param('siteId') siteId: string) {
    return this.counts.list(siteId);
  }

  @Post('stock-counts')
  @RequirePermission('inventory.count.manage')
  async createCount(@Param('siteId') siteId: string, @Body() body: CreateCountDto, @CurrentUser() user: Principal) {
    const id = await this.counts.create(siteId, body);
    return this.counts.get(siteId, id, user.permissions.has('inventory.count.manage'));
  }

  @Get('stock-counts/:countId')
  async count(@Param('siteId') siteId: string, @Param('countId') id: string, @CurrentUser() user: Principal) {
    if (!user.permissions.has('inventory.read') && !user.permissions.has('inventory.count.execute')) throw DomainError.forbidden();
    return this.counts.get(siteId, id, user.permissions.has('inventory.count.manage'));
  }

  @Post('stock-counts/:countId/start')
  @RequirePermission('inventory.count.manage')
  @HttpCode(200)
  async start(@Param('siteId') siteId: string, @Param('countId') id: string) {
    await this.counts.start(siteId, id);
    return this.counts.get(siteId, id, true);
  }

  @Put('stock-counts/:countId/lines/:lineId')
  @RequirePermission('inventory.count.execute')
  async recordLine(@Param('siteId') siteId: string, @Param('countId') id: string, @Param('lineId') lineId: string, @Body() body: RecordCountDto, @CurrentUser() user: Principal) {
    await this.counts.recordLine(siteId, id, lineId, body.countedQty);
    return this.counts.get(siteId, id, user.permissions.has('inventory.count.manage'));
  }

  @Post('stock-counts/:countId/close')
  @RequirePermission('inventory.count.manage')
  @HttpCode(200)
  async close(@Param('siteId') siteId: string, @Param('countId') id: string) {
    await this.counts.close(siteId, id);
    return this.counts.get(siteId, id, true);
  }

  @Post('stock-counts/:countId/complete')
  @RequirePermission('inventory.count.manage')
  @HttpCode(200)
  async complete(@Param('siteId') siteId: string, @Param('countId') id: string, @Body() body: CompleteCountDto) {
    const r = await this.counts.complete(siteId, id, body.createAdjustments);
    return { ...(await this.counts.get(siteId, id, true)), adjustmentsCreated: r.adjustments };
  }

  @Post('stock-counts/:countId/cancel')
  @RequirePermission('inventory.count.manage')
  @HttpCode(200)
  async cancel(@Param('siteId') siteId: string, @Param('countId') id: string, @Body() body: CancelDto) {
    await this.counts.cancel(siteId, id, body.reason);
    return this.counts.get(siteId, id, true);
  }
}

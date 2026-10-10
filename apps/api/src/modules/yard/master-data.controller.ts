import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TruckType } from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { RequirePermission } from '../../platform/auth/decorators';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { PrismaService, TxRunner } from '../../platform/prisma/prisma.service';

class CreateTruckDto extends createZodDto(
  z.object({ plateNumber: z.string().min(2).max(20), carrierId: z.string().uuid().optional(), truckType: TruckType }).strict(),
) {}
class CreateDriverDto extends createZodDto(
  z
    .object({ fullName: z.string().min(2).max(120), licenseNumber: z.string().max(40).optional(), phone: z.string().max(30).optional(), carrierId: z.string().uuid().optional() })
    .strict(),
) {}

/**
 * Master data cấp doanh nghiệp: partner, truck, driver (mục 16.4.8).
 * Đọc: mọi user đã đăng nhập. Ghi: permission có ở ít nhất một site (AccessGuard.permissionsAnySite).
 */
@ApiTags('Master data')
@Controller()
export class MasterDataController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly codes: CodeGenerator,
  ) {}

  @Get('partners')
  async partners(@Query('type') type?: string, @Query('q') q?: string) {
    const rows = await this.prisma.partner.findMany({
      where: {
        deletedAt: null,
        ...(type ? { partnerTypes: { has: type } } : {}),
        ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
    return { items: rows.map((p) => ({ id: p.id, code: p.code, name: p.name, partnerTypes: p.partnerTypes })), nextCursor: null };
  }

  @Get('trucks')
  async trucks(@Query('plate') plate?: string) {
    const rows = await this.prisma.truck.findMany({
      where: { deletedAt: null, ...(plate ? { plateNumber: { contains: plate.replace(/[\s.-]/g, ''), mode: 'insensitive' as const } } : {}) },
      include: { carrier: true },
      orderBy: { code: 'asc' },
      take: 200,
    });
    return {
      items: rows.map((t) => ({
        id: t.id,
        code: t.code,
        plateNumber: t.plateNumber,
        truckType: t.truckType,
        carrier: t.carrier ? { id: t.carrier.id, code: t.carrier.code, name: t.carrier.name } : null,
      })),
      nextCursor: null,
    };
  }

  @Post('trucks')
  @RequirePermission('master.partner.manage')
  createTruck(@Body() body: CreateTruckDto) {
    return this.tx.run(async (tx) => {
      const truck = await tx.truck.create({
        data: { code: await this.codes.prefixed(tx, 'TRK'), plateNumber: body.plateNumber.replace(/[\s.-]/g, '').toUpperCase(), truckType: body.truckType, carrierId: body.carrierId ?? null },
      });
      await this.audit.record(tx, { siteId: null, action: 'TRUCK_CREATED', entityType: 'Truck', entityId: truck.id, diff: { after: { code: truck.code, plate: truck.plateNumber } } });
      return truck;
    });
  }

  @Get('drivers')
  async drivers(@Query('q') q?: string) {
    const rows = await this.prisma.driver.findMany({
      where: { deletedAt: null, ...(q ? { fullName: { contains: q, mode: 'insensitive' as const } } : {}) },
      orderBy: { fullName: 'asc' },
      take: 200,
    });
    return { items: rows.map((d) => ({ id: d.id, fullName: d.fullName, licenseNumber: d.licenseNumber, phone: d.phone })), nextCursor: null };
  }

  @Post('drivers')
  @RequirePermission('master.partner.manage')
  createDriver(@Body() body: CreateDriverDto) {
    return this.tx.run(async (tx) => {
      const driver = await tx.driver.create({ data: { fullName: body.fullName, licenseNumber: body.licenseNumber ?? null, phone: body.phone ?? null, carrierId: body.carrierId ?? null } });
      await this.audit.record(tx, { siteId: null, action: 'DRIVER_CREATED', entityType: 'Driver', entityId: driver.id });
      return driver;
    });
  }
}

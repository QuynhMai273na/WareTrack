import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Partner } from '@prisma/client';
import { CreatePartnerRequest, ErrorCode, type PartnerDto, TruckType, UpdatePartnerRequest } from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { RequirePermission } from '../../platform/auth/decorators';
import { CodeGenerator } from '../../platform/codes/code-generator';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService, TxRunner } from '../../platform/prisma/prisma.service';

class CreateTruckDto extends createZodDto(
  z.object({ plateNumber: z.string().min(2).max(20), carrierId: z.string().uuid().optional(), truckType: TruckType }).strict(),
) {}
class CreateDriverDto extends createZodDto(
  z
    .object({ fullName: z.string().min(2).max(120), licenseNumber: z.string().max(40).optional(), phone: z.string().max(30).optional(), carrierId: z.string().uuid().optional() })
    .strict(),
) {}

class CreatePartnerDto extends createZodDto(CreatePartnerRequest) {}
class UpdatePartnerDto extends createZodDto(UpdatePartnerRequest) {}

function toPartnerDto(partner: Partner): PartnerDto {
  const contact = (partner.contact ?? {}) as { email?: string | null; phone?: string | null };
  return { id: partner.id, code: partner.code, name: partner.name, partnerTypes: partner.partnerTypes, contactEmail: contact.email ?? null, contactPhone: contact.phone ?? null };
}

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
    return { items: rows.map(toPartnerDto), nextCursor: null };
  }

  @Post('partners')
  @RequirePermission('master.partner.manage')
  createPartner(@Body() body: CreatePartnerDto) {
    return this.tx.run(async (tx) => {
      if (await tx.partner.findFirst({ where: { code: body.code, deletedAt: null } })) throw DomainError.rule(ErrorCode.CODE_ALREADY_EXISTS, `Partner ${body.code} already exists`);
      const partner = await tx.partner.create({
        data: { code: body.code, name: body.name, partnerTypes: body.partnerTypes, contact: { email: body.contactEmail ?? null, phone: body.contactPhone ?? null } },
      });
      await this.audit.record(tx, { siteId: null, action: 'PARTNER_CREATED', entityType: 'Partner', entityId: partner.id, diff: { after: { code: partner.code, name: partner.name } } });
      return toPartnerDto(partner);
    });
  }

  @Patch('partners/:partnerId')
  @RequirePermission('master.partner.manage')
  updatePartner(@Param('partnerId') partnerId: string, @Body() body: UpdatePartnerDto) {
    return this.tx.run(async (tx) => {
      const before = await tx.partner.findFirst({ where: { id: partnerId, deletedAt: null } });
      if (!before) throw DomainError.notFound('Partner');
      const previousContact = (before.contact ?? {}) as { email?: string | null; phone?: string | null };
      const partner = await tx.partner.update({
        where: { id: partnerId },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.partnerTypes ? { partnerTypes: body.partnerTypes } : {}),
          contact: {
            email: body.contactEmail !== undefined ? body.contactEmail : (previousContact.email ?? null),
            phone: body.contactPhone !== undefined ? body.contactPhone : (previousContact.phone ?? null),
          },
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        siteId: null,
        action: 'PARTNER_UPDATED',
        entityType: 'Partner',
        entityId: partner.id,
        diff: { before: { name: before.name, types: before.partnerTypes }, after: { name: partner.name, types: partner.partnerTypes } },
      });
      return toPartnerDto(partner);
    });
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

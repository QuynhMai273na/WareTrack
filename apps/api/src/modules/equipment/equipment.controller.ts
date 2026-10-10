import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission, requirePrincipal } from '../../platform/auth/decorators';
import { DomainError } from '../../platform/errors/domain-error';
import { AccessService } from '../identity/access.service';
import { EquipmentService, type EquipmentTelemetry } from './equipment.service';

class EquipmentStatusDto extends createZodDto(
  z.object({ toStatus: z.enum(['AVAILABLE', 'CHARGING', 'MAINTENANCE', 'OFFLINE']), reason: z.string().max(200).optional(), expectedVersion: z.number().int().min(0) }).strict(),
) {}
class TelemetryDto extends createZodDto(
  z.object({ batteryPct: z.number().int().min(0).max(100).optional(), speedKmh: z.number().min(0).max(40).optional(), observedAt: z.string().datetime({ offset: true }).optional() }).strict(),
) {}

@ApiTags('Equipment')
@Controller('sites/:siteId/equipment')
export class EquipmentController {
  constructor(
    private readonly equipment: EquipmentService,
    private readonly access: AccessService,
  ) {}

  /** Bảng Forklifts (video tab "Forklifts 2/5") — #154. */
  @Get()
  @RequirePermission('equipment.read')
  async list(@Param('siteId') siteId: string) {
    const rows = await this.equipment.list(siteId);
    const ops = new Map((await this.equipment.operators(rows.map((r) => r.currentOperatorId))).map((u) => [u.id, u.fullName]));
    return rows.map((e) => ({ ...this.toDetail(e), operator: e.currentOperatorId ? (ops.get(e.currentOperatorId) ?? null) : null }));
  }

  @Get(':equipmentId')
  @RequirePermission('equipment.read')
  async get(@Param('siteId') siteId: string, @Param('equipmentId') id: string) {
    return this.toDetail(await this.equipment.get(siteId, id));
  }

  /** #158 — MAINTENANCE cần thêm `equipment.manage` (mục 9.7). */
  @Post(':equipmentId/status')
  @HttpCode(200)
  @RequirePermission('equipment.status.update')
  async status(@Param('siteId') siteId: string, @Param('equipmentId') id: string, @Body() body: EquipmentStatusDto) {
    if (body.toStatus === 'MAINTENANCE') {
      const access = await this.access.getUserAccess(requirePrincipal().userId);
      if (!access || !(await this.access.permissionsAt(access, siteId)).has('equipment.manage')) throw DomainError.forbidden('Maintenance requires equipment.manage');
    }
    return this.toDetail(await this.equipment.changeStatus(siteId, id, body.toStatus, body.reason, body.expectedVersion));
  }

  /** #159 */
  @Post(':equipmentId/telemetry')
  @HttpCode(200)
  @RequirePermission('equipment.status.update')
  async telemetry(@Param('siteId') siteId: string, @Param('equipmentId') id: string, @Body() body: TelemetryDto) {
    return this.toDetail(await this.equipment.recordTelemetry(siteId, id, body));
  }

  private toDetail(e: Awaited<ReturnType<EquipmentService['get']>>) {
    const t = (e.telemetry as EquipmentTelemetry | null) ?? {};
    return {
      ...this.equipment.toSnapshot(e),
      chargerLocationId: e.chargerLocationId,
      speedKmh: t.speedKmh ?? null,
      movesToday: t.movesToday ?? 0,
    };
  }
}

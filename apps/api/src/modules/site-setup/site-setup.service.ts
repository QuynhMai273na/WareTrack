import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { BlueprintState, CreateSiteRequest, PublishBlueprintResult, PublishedLayout, SiteBlueprint, UpdateSiteRequest } from '@waretrack/shared-schemas';
import { ErrorCode, SiteBlueprint as SiteBlueprintSchema } from '@waretrack/shared-schemas';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../platform/audit/audit.service';
import { currentContext } from '../../platform/context/request-context';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService, type Tx, TxRunner } from '../../platform/prisma/prisma.service';
import { AccessService } from '../identity/access.service';
import { compileBlueprint, defaultBlueprint } from './blueprint-compiler';
import type { SiteLayoutSpec } from './layout/layout-spec';
import { NETWORK_CELL } from './layout/site-builder';
import { layoutObjectRows, SiteLayoutWriter } from './site-layout-writer';

const DRAFT_KEY = 'layout.blueprint';
const PUBLISHED_KEY = 'layout.blueprint.published';
/** Số cột của lưới site trên bản đồ mạng lưới chung. */
const NETWORK_COLUMNS = 3;

/** Độ dài mặt nhà (m) để kiểm tra vị trí dock nằm trên tường. */
function faceLength(building: SiteBlueprint['buildings'][number], face: 'S' | 'E' | 'N' | 'W') {
  return face === 'S' || face === 'N' ? building.width : building.depth;
}

/**
 * Thiết lập site cho vận hành thật (thay cho seed demo): tạo site, đặt lên bản đồ mạng lưới,
 * soạn — xem trước — publish bản thiết kế sơ đồ. Bản nháp lưu trong site_setting, chỉ publish mới đổi layout thật.
 */
@Injectable()
export class SiteSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly writer: SiteLayoutWriter,
  ) {}

  async listAdminSites() {
    const sites = await this.prisma.site.findMany({ where: { deletedAt: null }, orderBy: { code: 'asc' } });
    const layouts = await this.prisma.layoutVersion.findMany({ where: { status: 'PUBLISHED', siteId: { in: sites.map((site) => site.id) } } });
    const locationCounts = await this.prisma.location.groupBy({ by: ['siteId'], where: { deletedAt: null }, _count: { _all: true } });
    return sites.map((site) => ({
      id: site.id,
      code: site.code,
      name: site.name,
      siteType: site.siteType,
      addressLine: site.addressLine,
      timezone: site.timezone,
      operationalStatus: site.operationalStatus,
      map: { x: site.mapX, z: site.mapZ },
      publishedVersionNo: layouts.find((layout) => layout.siteId === site.id)?.versionNo ?? null,
      locationCount: locationCounts.find((count) => count.siteId === site.id)?._count._all ?? 0,
      version: site.version,
    }));
  }

  async createSite(body: CreateSiteRequest) {
    const duplicate = await this.prisma.site.findFirst({ where: { code: body.code, deletedAt: null } });
    if (duplicate) throw DomainError.rule(ErrorCode.CODE_ALREADY_EXISTS, `Site ${body.code} already exists`);
    const mapPosition = await this.nextMapPosition();
    const blueprint = defaultBlueprint(body.code, body.name);
    const site = await this.tx.run(async (tx) => {
      const createdSite = await tx.site.create({
        data: { code: body.code, name: body.name, siteType: body.siteType, addressLine: body.addressLine ?? null, timezone: body.timezone, mapX: mapPosition.x, mapZ: mapPosition.z },
      });
      // Site mới có ngay sơ đồ mặc định để xuất hiện trên bản đồ; admin chỉnh rồi publish lại
      await this.writer.publish(tx, createdSite, compileBlueprint(body.name, blueprint), this.actorId());
      await this.saveSetting(tx, createdSite.id, DRAFT_KEY, blueprint);
      await this.saveSetting(tx, createdSite.id, PUBLISHED_KEY, blueprint);
      await this.audit.record(tx, { siteId: createdSite.id, action: 'SITE_CREATED', entityType: 'Site', entityId: createdSite.id, diff: { after: { code: createdSite.code, name: createdSite.name } } });
      return createdSite;
    });
    this.access.invalidateSites();
    return (await this.listAdminSites()).find((adminSite) => adminSite.id === site.id)!;
  }

  async updateSite(siteId: string, body: UpdateSiteRequest) {
    await this.tx.run(async (tx) => {
      const before = await tx.site.findFirst({ where: { id: siteId, deletedAt: null } });
      if (!before) throw DomainError.notFound('Site');
      const after = await tx.site.update({ where: { id: siteId }, data: { ...body, version: { increment: 1 } } });
      await this.audit.record(tx, { siteId, action: 'SITE_UPDATED', entityType: 'Site', entityId: siteId, diff: { before: { name: before.name, status: before.operationalStatus }, after: { name: after.name, status: after.operationalStatus } } });
    });
    return (await this.listAdminSites()).find((adminSite) => adminSite.id === siteId)!;
  }

  async blueprintState(siteId: string): Promise<BlueprintState> {
    const site = await this.requireSite(siteId);
    const settings = await this.prisma.siteSetting.findMany({ where: { siteId, key: { in: [DRAFT_KEY, PUBLISHED_KEY] } } });
    const draft = settings.find((setting) => setting.key === DRAFT_KEY)?.value as SiteBlueprint | undefined;
    const published = settings.find((setting) => setting.key === PUBLISHED_KEY)?.value as SiteBlueprint | undefined;
    const layout = await this.prisma.layoutVersion.findFirst({ where: { siteId, status: 'PUBLISHED' } });
    const blueprint = SiteBlueprintSchema.parse(draft ?? published ?? defaultBlueprint(site.code, site.name));
    return {
      blueprint,
      hasUnpublishedChanges: !published || JSON.stringify(SiteBlueprintSchema.parse(published)) !== JSON.stringify(blueprint),
      publishedVersionNo: layout?.versionNo ?? null,
      publishedAt: layout?.publishedAt?.toISOString() ?? null,
      isTemplate: !draft && !published,
    };
  }

  async saveDraft(siteId: string, blueprint: SiteBlueprint): Promise<BlueprintState> {
    const site = await this.requireSite(siteId);
    this.compileChecked(site.name, blueprint);
    await this.tx.run((tx) => this.saveSetting(tx, siteId, DRAFT_KEY, blueprint));
    return this.blueprintState(siteId);
  }

  /** Xem trước 3D: biên dịch nhưng không ghi DB; location đã có giữ id thật để pallet hiện tại vẫn vẽ đúng chỗ. */
  async preview(siteId: string, blueprint: SiteBlueprint): Promise<PublishedLayout> {
    const site = await this.requireSite(siteId);
    const spec = this.compileChecked(site.name, blueprint);
    const existingLocations = await this.prisma.location.findMany({ where: { siteId, deletedAt: null }, select: { id: true, code: true } });
    const existingZones = await this.prisma.zone.findMany({ where: { siteId }, select: { id: true, code: true } });
    const locationIds = new Map(existingLocations.map((location) => [location.code, location.id]));
    const zoneIds = new Map(existingZones.map((zone) => [zone.code, zone.id]));
    for (const location of spec.locations) if (!locationIds.has(location.code)) locationIds.set(location.code, uuidv7());
    for (const zone of spec.zones) if (!zoneIds.has(zone.code)) zoneIds.set(zone.code, uuidv7());
    const previewVersionId = uuidv7();
    return {
      versionId: previewVersionId,
      versionNo: 0,
      modelUrl: null,
      bounds: spec.bounds,
      objects: layoutObjectRows(previewVersionId, spec, zoneIds, locationIds).map((row) => ({
        id: uuidv7(),
        targetType: row.targetType,
        targetId: row.targetId ?? null,
        meshRef: row.meshRef ?? null,
        posX: row.posX,
        posY: row.posY ?? 0,
        posZ: row.posZ,
        rotY: row.rotY ?? 0,
        sizeX: row.sizeX ?? 1,
        sizeY: row.sizeY ?? 1,
        sizeZ: row.sizeZ ?? 1,
        props: (row.props as Record<string, unknown> | null) ?? null,
      })),
    };
  }

  async publish(siteId: string, blueprint: SiteBlueprint): Promise<PublishBlueprintResult> {
    const site = await this.requireSite(siteId);
    const spec = this.compileChecked(site.name, blueprint);
    return this.tx.run(async (tx) => {
      const result = await this.writer.publish(tx, site, spec, this.actorId());
      await this.saveSetting(tx, siteId, DRAFT_KEY, blueprint);
      await this.saveSetting(tx, siteId, PUBLISHED_KEY, blueprint);
      await this.audit.record(tx, { siteId, action: 'LAYOUT_PUBLISHED', entityType: 'Site', entityId: siteId, diff: { after: { ...result } } });
      return result;
    });
  }

  private compileChecked(siteName: string, blueprint: SiteBlueprint): SiteLayoutSpec {
    for (const dock of blueprint.docks) {
      const building = blueprint.buildings.find((candidate) => candidate.code === dock.buildingCode);
      if (building && dock.offset > faceLength(building, dock.face) - 2) {
        throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `Dock ${dock.label} is beyond the ${dock.face} wall of ${building.code} (max ${faceLength(building, dock.face) - 2} m)`);
      }
    }
    const spec = compileBlueprint(siteName, blueprint);
    const codes = spec.locations.map((location) => location.code);
    const duplicates = [...new Set(codes.filter((code, index) => codes.indexOf(code) !== index))];
    if (duplicates.length) throw DomainError.rule(ErrorCode.VALIDATION_ERROR, `Duplicate location codes: ${duplicates.join(', ')}`);
    return spec;
  }

  private async requireSite(siteId: string) {
    const site = await this.prisma.site.findFirst({ where: { id: siteId, deletedAt: null } });
    if (!site) throw DomainError.notFound('Site');
    return site;
  }

  private async saveSetting(tx: Tx, siteId: string, key: string, value: unknown) {
    const json = value as Prisma.InputJsonValue;
    await tx.siteSetting.upsert({ where: { siteId_key: { siteId, key } }, create: { siteId, key, value: json }, update: { value: json } });
  }

  /** Ô trống đầu tiên trên lưới bản đồ mạng lưới (3 cột, mỗi ô 300 × 260 m). */
  private async nextMapPosition() {
    const sites = await this.prisma.site.findMany({ where: { deletedAt: null }, select: { mapX: true, mapZ: true } });
    const taken = new Set(sites.map((site) => `${Math.round(site.mapX / NETWORK_CELL.w)}:${Math.round(site.mapZ / NETWORK_CELL.d)}`));
    for (let cellIndex = 0; ; cellIndex++) {
      const column = cellIndex % NETWORK_COLUMNS;
      const row = Math.floor(cellIndex / NETWORK_COLUMNS);
      if (!taken.has(`${column}:${row}`)) return { x: column * NETWORK_CELL.w, z: row * NETWORK_CELL.d };
    }
  }

  private actorId() {
    return currentContext()?.principal?.userId ?? null;
  }
}

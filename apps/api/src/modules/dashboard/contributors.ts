import { Injectable } from '@nestjs/common';
import type { KpiDto, SiteSnapshot } from '@waretrack/shared-schemas';
import type { Tx } from '../../platform/prisma/prisma.service';

export type SnapshotPart = Partial<Pick<SiteSnapshot, 'pallets' | 'vehicles' | 'activeShipments' | 'slots'>>;
export type SnapshotContributor = (tx: Tx, siteId: string) => Promise<SnapshotPart>;
export type KpiContributor = (siteId: string, ctx: { todayStart: Date; now: Date }) => Promise<KpiDto[]>;

/**
 * Registry để module nghiệp vụ (Inventory, Shipments, Vehicle Storage…) góp dữ liệu vào snapshot/KPI
 * qua query port của chính chúng; Dashboard chỉ đọc, không ghi (mục 13.2 Dashboard).
 */
@Injectable()
export class DashboardContributors {
  readonly snapshot: SnapshotContributor[] = [];
  readonly kpis: KpiContributor[] = [];

  addSnapshot(contributor: SnapshotContributor) {
    this.snapshot.push(contributor);
  }

  addKpis(contributor: KpiContributor) {
    this.kpis.push(contributor);
  }
}

import { Injectable } from '@nestjs/common';
import type { SnapshotPallet } from '@waretrack/shared-schemas';
import { OutboxService } from '../../platform/outbox/outbox.service';
import type { Tx } from '../../platform/prisma/prisma.service';
import type { BalanceChange } from './ledger.service';

/** Phát inventory.updated / pallet.moved — state-carrying để client patch cache (mục 17.4 #10, #11). */
@Injectable()
export class InventoryEvents {
  constructor(private readonly outbox: OutboxService) {}

  async inventoryUpdated(tx: Tx, siteId: string, changes: BalanceChange[], txIds: bigint[]) {
    if (changes.length === 0) return;
    const skus = new Map((await tx.sku.findMany({ where: { id: { in: [...new Set(changes.map((c) => c.skuId))] } } })).map((s) => [s.id, s.code]));
    await this.outbox.publish(tx, {
      siteId,
      type: 'inventory.updated',
      aggregateType: 'Inventory',
      aggregateId: siteId,
      aggregateVersion: Math.max(...changes.map((c) => c.balanceVersion)),
      data: { changes: changes.map((c) => ({ ...c, skuCode: skus.get(c.skuId) ?? null })), txIds: txIds.map(String) },
    });
  }

  async palletMoved(tx: Tx, siteId: string, huId: string, fromLocationId: string | null, toLocationId: string | null) {
    const pallet = await this.palletSnapshot(tx, huId);
    if (!pallet) return;
    await this.outbox.publish(tx, {
      siteId,
      type: 'pallet.moved',
      aggregateType: 'HandlingUnit',
      aggregateId: huId,
      aggregateVersion: pallet.version,
      data: { pallet, fromLocationId, toLocationId },
    });
  }

  /** Dạng pallet trong snapshot: nhãn = SKU chính, stockStatus của balance lớn nhất. */
  async palletSnapshot(tx: Tx, huId: string): Promise<SnapshotPallet | null> {
    const hu = await tx.handlingUnit.findUnique({ where: { id: huId } });
    if (!hu) return null;
    const balances = await tx.inventoryBalance.findMany({ where: { handlingUnitId: huId, qtyOnHand: { gt: 0 } }, orderBy: { qtyOnHand: 'desc' } });
    const sku = balances[0] ? await tx.sku.findUnique({ where: { id: balances[0].skuId } }) : null;
    return {
      id: hu.id,
      code: hu.code,
      label: sku?.name ?? 'Empty pallet',
      lifecycle: hu.lifecycle,
      stockStatus: balances[0]?.stockStatus ?? null,
      position: hu.locationId ? { locationId: hu.locationId, source: hu.positionSource ?? 'CONFIRMED_MANUAL', confirmedAt: (hu.positionConfirmedAt ?? hu.updatedAt).toISOString() } : null,
      version: hu.version,
    };
  }
}

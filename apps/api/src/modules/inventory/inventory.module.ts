import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module';
import { InventoryController, SkusController } from './inventory.controller';
import { InventoryEvents } from './inventory-events.service';
import { InventoryQueryService } from './inventory-query.service';
import { LedgerService } from './ledger.service';
import { PalletsService } from './pallets.service';
import { ReservationService } from './reservation.service';
import { StockCountService } from './stock-count.service';
import { StockService } from './stock.service';

/** Inventory — chủ sở hữu duy nhất của số lượng tồn (mục 13.2). */
@Module({
  imports: [SitesModule],
  controllers: [SkusController, InventoryController],
  providers: [LedgerService, InventoryEvents, PalletsService, StockService, ReservationService, StockCountService, InventoryQueryService],
  exports: [LedgerService, PalletsService, ReservationService, InventoryQueryService, InventoryEvents],
})
export class InventoryModule {}

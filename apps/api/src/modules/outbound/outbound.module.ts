import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { SitesModule } from '../sites/sites.module';
import { YardModule } from '../yard/yard.module';
import { OutboundController } from './outbound.controller';
import { OutboundService } from './outbound.service';

@Module({
  imports: [InventoryModule, ShipmentsModule, YardModule, SitesModule],
  controllers: [OutboundController],
  providers: [OutboundService],
})
export class OutboundModule {}

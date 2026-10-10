import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { SitesModule } from '../sites/sites.module';
import { YardModule } from '../yard/yard.module';
import { InboundController } from './inbound.controller';
import { InboundService } from './inbound.service';

@Module({
  imports: [InventoryModule, ShipmentsModule, YardModule, SitesModule],
  controllers: [InboundController],
  providers: [InboundService],
})
export class InboundModule {}

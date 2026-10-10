import { Global, Module } from '@nestjs/common';
import { EquipmentModule } from '../equipment/equipment.module';
import { DashboardContributors } from './contributors';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { KpiService } from './kpi.service';

@Global()
@Module({
  imports: [EquipmentModule],
  controllers: [DashboardController],
  providers: [DashboardContributors, KpiService, DashboardService],
  exports: [DashboardContributors],
})
export class DashboardModule {}

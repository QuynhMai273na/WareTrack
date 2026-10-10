import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module';
import { DocksController } from './docks.controller';
import { MasterDataController } from './master-data.controller';
import { VisitsController } from './visits.controller';
import { VisitsService } from './visits.service';
import { YardScheduler } from './yard.scheduler';

@Module({
  imports: [SitesModule],
  controllers: [VisitsController, DocksController, MasterDataController],
  providers: [VisitsService, YardScheduler],
  exports: [VisitsService],
})
export class YardModule {}

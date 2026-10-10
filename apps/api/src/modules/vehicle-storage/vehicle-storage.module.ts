import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

/** Vehicle Storage: xe ô tô lưu bãi (mục 13.2). Occupancy, Movement, Tasks, Exceptions, Dashboard là module global. */
@Module({
  imports: [SitesModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
})
export class VehicleStorageModule {}

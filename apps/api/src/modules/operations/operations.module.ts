import { Global, Module } from '@nestjs/common';
import { EquipmentModule } from '../equipment/equipment.module';
import { SitesModule } from '../sites/sites.module';
import { ExceptionsService } from './exceptions.service';
import { OperationsController } from './operations.controller';
import { TasksService } from './tasks.service';

/** Operations: task, exception (movement ở MovementModule). Global để module nguồn đăng ký handler. */
@Global()
@Module({
  imports: [SitesModule, EquipmentModule],
  controllers: [OperationsController],
  providers: [TasksService, ExceptionsService],
  exports: [TasksService, ExceptionsService],
})
export class OperationsModule {}

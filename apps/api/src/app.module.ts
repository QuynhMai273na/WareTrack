import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ZodValidationPipe } from 'nestjs-zod';
import { HealthController } from './health.controller';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { EquipmentModule } from './modules/equipment/equipment.module';
import { IdentityModule } from './modules/identity/identity.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MovementModule } from './modules/operations/movement.service';
import { OperationsModule } from './modules/operations/operations.module';
import { ShipmentsModule } from './modules/shipments/shipments.module';
import { InboundModule } from './modules/inbound/inbound.module';
import { OutboundModule } from './modules/outbound/outbound.module';
import { VehicleStorageModule } from './modules/vehicle-storage/vehicle-storage.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DemoModule } from './demo/demo.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { SitesModule } from './modules/sites/sites.module';
import { SiteSetupModule } from './modules/site-setup/site-setup.module';
import { OccupancyModule } from './modules/yard/occupancy.service';
import { YardModule } from './modules/yard/yard.module';
import { requestContextMiddleware } from './platform/context/request-context';
import { ProblemFilter } from './platform/errors/problem.filter';
import { IdempotencyInterceptor } from './platform/idempotency/idempotency.interceptor';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PlatformModule,
    IdentityModule,
    OccupancyModule,
    SitesModule,
    SiteSetupModule,
    YardModule,
    MovementModule,
    InventoryModule,
    EquipmentModule,
    OperationsModule,
    ShipmentsModule,
    InboundModule,
    OutboundModule,
    VehicleStorageModule,
    NotificationsModule,
    DemoModule,
    DashboardModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestContextMiddleware).forRoutes('*');
  }
}

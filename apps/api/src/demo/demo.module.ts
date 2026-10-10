import { Module } from '@nestjs/common';
import { EquipmentModule } from '../modules/equipment/equipment.module';
import { DemoDirector } from './demo-director';

/** Điều phối dữ liệu demo theo video (DEC-51) — chỉ hoạt động khi DEMO_DIRECTOR=true. */
@Module({ imports: [EquipmentModule], providers: [DemoDirector], exports: [DemoDirector] })
export class DemoModule {}

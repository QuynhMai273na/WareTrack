import { Module } from '@nestjs/common';
import { SiteLayoutWriter } from './site-layout-writer';
import { SiteSetupController } from './site-setup.controller';
import { SiteSetupService } from './site-setup.service';

@Module({
  controllers: [SiteSetupController],
  providers: [SiteSetupService, SiteLayoutWriter],
})
export class SiteSetupModule {}

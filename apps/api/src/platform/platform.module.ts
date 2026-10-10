import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { LocationLockPort } from './locks/location-lock';
import { PublishedEventBus, UserChannel } from './outbox/event-bus';
import { OutboxRelayService } from './outbox/outbox-relay.service';
import { OutboxService } from './outbox/outbox.service';
import { PrismaService, TxRunner } from './prisma/prisma.service';
import { CodeGenerator } from './codes/code-generator';

/** Shared kernel — không phụ thuộc module nghiệp vụ nào (mục 12.4). */
@Global()
@Module({
  providers: [PrismaService, TxRunner, OutboxService, PublishedEventBus, UserChannel, OutboxRelayService, AuditService, LocationLockPort, CodeGenerator],
  exports: [PrismaService, TxRunner, OutboxService, PublishedEventBus, UserChannel, AuditService, LocationLockPort, CodeGenerator],
})
export class PlatformModule {}

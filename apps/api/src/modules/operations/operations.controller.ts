import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssignTaskRequest, ConfirmDestinationRequest, ConfirmSourceRequest, TaskReasonRequest, TaskVersionRequest } from '@waretrack/shared-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { Principal } from '../../platform/context/request-context';
import { ExceptionsService } from './exceptions.service';
import { TasksService } from './tasks.service';

class AssignDto extends createZodDto(AssignTaskRequest) {}
class VersionDto extends createZodDto(TaskVersionRequest) {}
class SourceDto extends createZodDto(ConfirmSourceRequest) {}
class DestinationDto extends createZodDto(ConfirmDestinationRequest) {}
class ReasonDto extends createZodDto(TaskReasonRequest) {}
class CreateExceptionDto extends createZodDto(
  z
    .object({
      caseType: z.string().min(3).max(40),
      severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
      subjectType: z.string().max(40).optional(),
      subjectId: z.string().uuid().optional(),
      description: z.string().min(5).max(1000),
    })
    .strict(),
) {}
class ResolveDto extends createZodDto(z.object({ resolutionCode: z.string().min(2).max(40), note: z.string().max(500).optional(), expectedVersion: z.number().int() }).strict()) {}
class ExceptionVersionDto extends createZodDto(z.object({ expectedVersion: z.number().int(), note: z.string().max(500).optional() }).strict()) {}

/** Task & exception (#164–#182). */
@ApiTags('Operations')
@Controller('sites/:siteId')
export class OperationsController {
  constructor(
    private readonly tasks: TasksService,
    private readonly exceptions: ExceptionsService,
  ) {}

  @Get('tasks')
  @RequirePermission('task.read')
  list(@Param('siteId') siteId: string, @CurrentUser() user: Principal, @Query('status') status?: string, @Query('type') type?: string, @Query('assigneeId') assigneeId?: string, @Query('sourceId') sourceId?: string) {
    return this.tasks.list(siteId, { status, type, assigneeId: assigneeId === 'me' ? user.userId : assigneeId, sourceId });
  }

  /** Danh sách người có thể nhận task tại site (hộp thoại giao việc). */
  @Get('task-assignees')
  @RequirePermission('task.assign')
  assignees(@Param('siteId') siteId: string) {
    return this.tasks.assignees(siteId);
  }

  @Get('tasks/:taskId')
  @RequirePermission('task.read')
  get(@Param('siteId') siteId: string, @Param('taskId') id: string) {
    return this.tasks.get(siteId, id);
  }

  @Post('tasks/:taskId/assign')
  @RequirePermission('task.assign')
  @HttpCode(200)
  async assign(@Param('siteId') siteId: string, @Param('taskId') id: string, @Body() body: AssignDto) {
    await this.tasks.assign(siteId, id, body);
    return this.tasks.get(siteId, id);
  }

  @Post('tasks/:taskId/start')
  @RequirePermission('task.execute')
  @HttpCode(200)
  async start(@Param('siteId') siteId: string, @Param('taskId') id: string, @Body() body: VersionDto) {
    await this.tasks.start(siteId, id, body.expectedVersion);
    return this.tasks.get(siteId, id);
  }

  @Post('tasks/:taskId/confirm-source')
  @RequirePermission('task.execute')
  @HttpCode(200)
  async confirmSource(@Param('siteId') siteId: string, @Param('taskId') id: string, @Body() body: SourceDto) {
    await this.tasks.confirmSource(siteId, id, body);
    return this.tasks.get(siteId, id);
  }

  @Post('tasks/:taskId/confirm-destination')
  @RequirePermission('task.execute')
  @HttpCode(200)
  async confirmDestination(@Param('siteId') siteId: string, @Param('taskId') id: string, @Body() body: DestinationDto) {
    await this.tasks.confirmDestination(siteId, id, body);
    return this.tasks.get(siteId, id);
  }

  @Post('tasks/:taskId/block')
  @RequirePermission('task.execute')
  @HttpCode(200)
  async block(@Param('siteId') siteId: string, @Param('taskId') id: string, @Body() body: ReasonDto) {
    await this.tasks.block(siteId, id, body.reason);
    return this.tasks.get(siteId, id);
  }

  @Post('tasks/:taskId/unblock')
  @RequirePermission('task.assign')
  @HttpCode(200)
  async unblock(@Param('siteId') siteId: string, @Param('taskId') id: string) {
    await this.tasks.unblock(siteId, id);
    return this.tasks.get(siteId, id);
  }

  @Post('tasks/:taskId/cancel')
  @RequirePermission('task.cancel')
  @HttpCode(200)
  async cancel(@Param('siteId') siteId: string, @Param('taskId') id: string, @Body() body: ReasonDto) {
    await this.tasks.cancel(siteId, id, body.reason);
    return this.tasks.get(siteId, id);
  }

  @Get('exceptions')
  @RequirePermission('exception.read')
  exceptionList(@Param('siteId') siteId: string, @Query('status') status?: string) {
    return this.exceptions.list(siteId, status);
  }

  @Post('exceptions')
  @RequirePermission('exception.create')
  async createException(@Param('siteId') siteId: string, @Body() body: CreateExceptionDto) {
    const created = await this.exceptions.create(siteId, body);
    return (await this.exceptions.list(siteId)).find((exceptionCase) => exceptionCase.id === created.id);
  }

  @Post('exceptions/:caseId/assign')
  @RequirePermission('exception.resolve')
  @HttpCode(200)
  async assignException(@Param('siteId') siteId: string, @Param('caseId') id: string, @Body() body: ExceptionVersionDto) {
    await this.exceptions.transition(siteId, id, 'IN_REVIEW', body);
    return (await this.exceptions.list(siteId)).find((exceptionCase) => exceptionCase.id === id);
  }

  @Post('exceptions/:caseId/resolve')
  @RequirePermission('exception.resolve')
  @HttpCode(200)
  async resolve(@Param('siteId') siteId: string, @Param('caseId') id: string, @Body() body: ResolveDto) {
    await this.exceptions.transition(siteId, id, 'RESOLVED', body);
    return (await this.exceptions.list(siteId)).find((exceptionCase) => exceptionCase.id === id);
  }

  @Post('exceptions/:caseId/reject')
  @RequirePermission('exception.resolve')
  @HttpCode(200)
  async rejectException(@Param('siteId') siteId: string, @Param('caseId') id: string, @Body() body: ExceptionVersionDto) {
    await this.exceptions.transition(siteId, id, 'REJECTED', body);
    return (await this.exceptions.list(siteId)).find((exceptionCase) => exceptionCase.id === id);
  }
}

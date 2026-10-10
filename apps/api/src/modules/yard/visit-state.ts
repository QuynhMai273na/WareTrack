import type { TruckVisitStatus } from '@prisma/client';
import { DomainError } from '../../platform/errors/domain-error';

/** Bảng transition cho phép của Truck Visit (mục 9.1). Mọi thứ khác là forbidden. */
export const VISIT_TRANSITIONS: Record<TruckVisitStatus, TruckVisitStatus[]> = {
  SCHEDULED: ['AT_GATE', 'CANCELLED', 'NO_SHOW'],
  AT_GATE: ['WAITING', 'DOCK_ASSIGNED', 'REJECTED', 'EXITED'],
  WAITING: ['DOCK_ASSIGNED', 'READY_TO_LEAVE', 'EXITED'],
  DOCK_ASSIGNED: ['WAITING', 'DOCK_ASSIGNED', 'AT_DOCK', 'READY_TO_LEAVE', 'EXITED'],
  AT_DOCK: ['HANDLING', 'READY_TO_LEAVE', 'EXITED'],
  HANDLING: ['READY_TO_LEAVE', 'EXITED'],
  READY_TO_LEAVE: ['EXITED'],
  EXITED: [],
  REJECTED: [],
  NO_SHOW: [],
  CANCELLED: [],
};

/** Trạng thái "on site" (BR-32) — dùng cho force exit và KPI. */
export const ON_SITE: TruckVisitStatus[] = ['AT_GATE', 'WAITING', 'DOCK_ASSIGNED', 'AT_DOCK', 'HANDLING', 'READY_TO_LEAVE'];

export function assertTransition(from: TruckVisitStatus, to: TruckVisitStatus, opts: { forceExit?: boolean } = {}) {
  // EXITED trực tiếp từ trạng thái khác READY_TO_LEAVE chỉ hợp lệ với force exit khẩn cấp (UC-02 E3)
  if (to === 'EXITED' && from !== 'READY_TO_LEAVE' && !opts.forceExit) {
    throw DomainError.invalidTransition('TruckVisit', from, to);
  }
  if (!VISIT_TRANSITIONS[from].includes(to)) throw DomainError.invalidTransition('TruckVisit', from, to);
}

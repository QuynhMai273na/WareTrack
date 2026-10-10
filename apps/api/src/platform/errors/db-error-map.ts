import { Prisma } from '@prisma/client';
import { ErrorCode } from '@waretrack/shared-schemas';
import { DomainError } from './domain-error';

/** Ánh xạ tên index/constraint PostgreSQL → lỗi nghiệp vụ (mục 16.2 — "Ánh xạ lỗi DB"). */
const CONSTRAINT_MAP: Array<[string, () => DomainError]> = [
  ['ux_occupancy_single_location_active', () => DomainError.conflict(ErrorCode.LOCATION_OCCUPIED, 'Location is already occupied or reserved')],
  ['ux_occupancy_occupant_active', () => DomainError.conflict(ErrorCode.OCCUPANT_ALREADY_PLACED, 'Object already has a confirmed position')],
  ['ux_occupancy_occupant_reserved', () => DomainError.conflict(ErrorCode.OCCUPANT_ALREADY_PLACED, 'Object already has a reserved destination')],
  ['ux_truck_visit_active', () => DomainError.conflict(ErrorCode.VISIT_ALREADY_ACTIVE, 'This truck already has an active visit')],
  ['ux_vehicle_stay_active', () => DomainError.conflict('VEHICLE_ALREADY_IN_STORAGE', 'This VIN already has an active storage stay (BR-14)')],
  ['ux_user_site_role_active', () => DomainError.conflict(ErrorCode.CODE_ALREADY_EXISTS, 'Role already granted')],
  ['ux_truck_plate', () => DomainError.conflict(ErrorCode.CODE_ALREADY_EXISTS, 'Plate number already exists')],
  ['user_username_key', () => DomainError.conflict(ErrorCode.USER_ALREADY_EXISTS, 'Username already exists')],
  ['user_email_key', () => DomainError.conflict(ErrorCode.USER_ALREADY_EXISTS, 'Email already exists')],
  ['ck_location_capacity_positive', () => DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Capacity must be positive')],
];

/**
 * Với partial unique index, Prisma P2002 thường chỉ trả model + cột (meta.target) thay vì tên index.
 * Khóa: "Model:cột1,cột2".
 */
const TARGET_MAP: Record<string, () => DomainError> = {
  'TruckVisit:truck_id': () => DomainError.conflict(ErrorCode.VISIT_ALREADY_ACTIVE, 'This truck already has an active visit'),
  'LocationOccupancy:location_id': () => DomainError.conflict(ErrorCode.LOCATION_OCCUPIED, 'Location is already occupied or reserved'),
  'LocationOccupancy:occupant_type,occupant_id': () => DomainError.conflict(ErrorCode.OCCUPANT_ALREADY_PLACED, 'Object already has an active position'),
  'VehicleStay:vehicle_id': () => DomainError.conflict('VEHICLE_ALREADY_IN_STORAGE', 'This VIN already has an active storage stay (BR-14)'),
  'ReleaseRequest:vehicle_stay_id': () => DomainError.conflict(ErrorCode.CODE_ALREADY_EXISTS, 'A release request is already open for this vehicle'),
  'User:username': () => DomainError.conflict(ErrorCode.USER_ALREADY_EXISTS, 'Username already exists'),
  'User:email': () => DomainError.conflict(ErrorCode.USER_ALREADY_EXISTS, 'Email already exists'),
};

const RETRYABLE_PG = new Set(['40001', '40P01']);

function describe(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return `${err.message} ${JSON.stringify(err.meta ?? {})}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function isRetryableDbError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2034') return true;
    const pgCode = (err.meta as { code?: string } | undefined)?.code;
    if (pgCode && RETRYABLE_PG.has(pgCode)) return true;
  }
  const text = describe(err);
  return /40P01|40001|deadlock detected|could not serialize/i.test(text);
}

/** Trả về DomainError tương ứng, hoặc null nếu không phải lỗi DB đã biết. */
export function mapDbError(err: unknown): DomainError | null {
  const isPrisma =
    err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientUnknownRequestError;
  if (!isPrisma) return null;
  const text = describe(err);
  for (const [name, make] of CONSTRAINT_MAP) {
    if (text.includes(name)) return make();
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const meta = (err.meta ?? {}) as { modelName?: string; target?: string | string[] };
    const target = Array.isArray(meta.target) ? meta.target.join(',') : (meta.target ?? '');
    const byTarget = TARGET_MAP[`${meta.modelName}:${target}`];
    if (byTarget) return byTarget();
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return DomainError.conflict(ErrorCode.CODE_ALREADY_EXISTS, 'A record with the same unique value already exists');
    if (err.code === 'P2025') return DomainError.notFound();
    if (err.code === 'P2034') return DomainError.concurrent();
  }
  if (/23505/.test(text)) return DomainError.conflict(ErrorCode.CODE_ALREADY_EXISTS, 'Unique constraint violated');
  if (/23514/.test(text)) return DomainError.rule(ErrorCode.VALIDATION_ERROR, 'Business constraint violated');
  if (isRetryableDbError(err)) return DomainError.concurrent();
  return null;
}

import type { Tx } from '../../platform/prisma/prisma.service';

export interface ActiveOccupancy {
  id: string;
  locationId: string;
  kind: 'RESERVED' | 'OCCUPIED';
  occupantType: string;
  occupantId: string;
  unitsUsed: number;
}

/**
 * Port đọc occupancy (do Yard sở hữu và cài đặt). Sites chỉ phụ thuộc interface này,
 * nên hướng phụ thuộc vẫn là Yard → Sites (mục 12.4, inversion of control).
 */
export interface OccupancyReader {
  activeByLocations(siteId: string, locationIds?: string[], tx?: Tx): Promise<Map<string, ActiveOccupancy[]>>;
}

export const OCCUPANCY_READER = Symbol('OCCUPANCY_READER');

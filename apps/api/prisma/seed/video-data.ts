/**
 * Số liệu demo theo video tham chiếu (DEC-51): tên site, xe tải, tài xế, xe nâng, SKU, tồn kho, KPI.
 * Trạng thái "đang diễn ra" (đơn xuất đang xếp, đơn nhập đang dỡ…) do DemoDirector dựng qua API thật lúc khởi động.
 */
import type { DockDirection, EquipmentStatus, SiteType, TruckType, TruckVisitStatus, VisitDirection } from '@prisma/client';
import type { SiteLayoutSpec } from './layout';
import { eastport, northgate, riverside, southfield, westgate } from './video-sites';

export interface SiteSeed {
  code: string;
  name: string;
  siteType: SiteType;
  address: string;
  layout: SiteLayoutSpec;
  /** Gốc tọa độ của site trên bản đồ mạng lưới chung (ô lưới 300 × 260 m). */
  map?: { x: number; z: number };
}

export const VIDEO_SITES: SiteSeed[] = [
  // Bản đồ chung 3 × 2 ô: WH-01 | WH-02 | WH-03 / WH-04 | WH-05
  { code: 'WH-01', name: 'Riverside Hub', siteType: 'DEPOT', address: '12 Riverside Dr, Newark NJ', layout: riverside(), map: { x: 0, z: 0 } },
  { code: 'WH-02', name: 'Northgate DC', siteType: 'DISTRIBUTION_CENTER', address: '480 Northgate Blvd, Newark NJ', layout: northgate(), map: { x: 300, z: 0 } },
  { code: 'WH-03', name: 'Eastport Cold Chain', siteType: 'COLD_STORE', address: '7 Harbor Way, Elizabeth NJ', layout: eastport(), map: { x: 600, z: 0 } },
  { code: 'WH-04', name: 'Southfield Cross-Dock', siteType: 'CROSS_DOCK', address: '2200 Southfield Ave, Linden NJ', layout: southfield(), map: { x: 0, z: 260 } },
  { code: 'WH-05', name: 'Westgate Robotics Hub', siteType: 'AUTOMATED_DC', address: '300 Westgate Rd, Kearny NJ', layout: westgate(), map: { x: 300, z: 260 } },
];

export const CARRIERS = [
  { code: 'WTF', name: 'WareTrack Freight' },
  { code: 'BLP', name: 'Bluepeak Foods' },
  { code: 'NDL', name: 'Nordline Logistics' },
  { code: 'CGV', name: 'Cargoviva' },
  { code: 'MRL', name: 'Marlin Line' },
];

export const PARTNERS = [
  { code: 'OAK', name: 'Oakridge Market', types: ['CUSTOMER'] },
  { code: 'HAR', name: 'Harbor & Co.', types: ['CUSTOMER'] },
  { code: 'SUN', name: 'Sunvale Grocers', types: ['CUSTOMER'] },
  { code: 'HAL', name: 'Halcyon Retail', types: ['CUSTOMER'] },
  { code: 'HLX', name: 'Helix Retail', types: ['CUSTOMER'] },
  { code: 'NWS', name: 'Northwind Supply', types: ['SUPPLIER'] },
  { code: 'BRL', name: 'Brightline Electronics', types: ['SUPPLIER'] },
];

export interface VisitSeed {
  site: string;
  truck: string;
  carrier: string;
  type: TruckType;
  direction: VisitDirection;
  status: TruckVisitStatus;
  dock?: string;
  /** Phút trước khi tới cổng (on-site) — dùng cho KPI "+N trong 1 giờ". */
  arrivedMinAgo?: number;
  etaMin?: number;
  driver: string;
  plate: string;
}

/** Xe tải theo video tại thời điểm mở màn (09:40). */
export const VISITS: VisitSeed[] = [
  // WH-01: TRK-2051 đang xếp hàng ở Bay 1; TRK-2287 Bluepeak đang tới (3 phút)
  { site: 'WH-01', truck: 'TRK-2051', carrier: 'WTF', type: 'BOX', direction: 'OUTBOUND', status: 'HANDLING', dock: 'Bay 1', arrivedMinAgo: 52, driver: 'Marco Silva', plate: 'WTF-2051' },
  { site: 'WH-01', truck: 'TRK-2287', carrier: 'BLP', type: 'BOX', direction: 'INBOUND', status: 'SCHEDULED', dock: 'Bay 2', etaMin: 3, driver: 'Priya Shah', plate: 'BLP-2287' },
  // WH-02
  { site: 'WH-02', truck: 'TRK-2127', carrier: 'BLP', type: 'BOX', direction: 'OUTBOUND', status: 'HANDLING', dock: 'Bay 3', arrivedMinAgo: 75, driver: 'Dana Kim', plate: 'BLP-2127' },
  { site: 'WH-02', truck: 'TRK-2104', carrier: 'NDL', type: 'BOX', direction: 'INBOUND', status: 'HANDLING', dock: 'Bay 1', arrivedMinAgo: 34, driver: 'Omar Haddad', plate: 'NDL-2104' },
  { site: 'WH-02', truck: 'TRK-2658', carrier: 'CGV', type: 'BOX', direction: 'INBOUND', status: 'DOCK_ASSIGNED', dock: 'Bay 2', arrivedMinAgo: 6, driver: 'Ivy Brooks', plate: 'CGV-2658' },
  { site: 'WH-02', truck: 'TRK-2526', carrier: 'WTF', type: 'BOX', direction: 'OUTBOUND', status: 'SCHEDULED', dock: 'Bay 4', etaMin: 2, driver: 'Ken Watanabe', plate: 'WTF-2526' },
  { site: 'WH-02', truck: 'TRK-2690', carrier: 'NDL', type: 'BOX', direction: 'INBOUND', status: 'SCHEDULED', etaMin: 28, driver: 'Lena Ortiz', plate: 'NDL-2690' },
  // WH-03 (kho lạnh — xe Bluepeak)
  { site: 'WH-03', truck: 'TRK-2148', carrier: 'BLP', type: 'REEFER', direction: 'INBOUND', status: 'HANDLING', dock: 'Bay 2', arrivedMinAgo: 70, driver: 'Mia Torres', plate: 'BLP-2148' },
  { site: 'WH-03', truck: 'TRK-2471', carrier: 'BLP', type: 'REEFER', direction: 'INBOUND', status: 'HANDLING', dock: 'Bay 1', arrivedMinAgo: 64, driver: 'Leo Grant', plate: 'BLP-2471' },
  { site: 'WH-03', truck: 'TRK-2603', carrier: 'BLP', type: 'REEFER', direction: 'INBOUND', status: 'DOCK_ASSIGNED', dock: 'Bay 3', arrivedMinAgo: 3, driver: 'Alex Walsh', plate: 'HUL-7099' },
  { site: 'WH-03', truck: 'TRK-2650', carrier: 'BLP', type: 'REEFER', direction: 'INBOUND', status: 'SCHEDULED', etaMin: 32, driver: 'Nina Park', plate: 'BLP-2650' },
  // WH-04 cross-dock
  { site: 'WH-04', truck: 'TRK-2205', carrier: 'WTF', type: 'BOX', direction: 'INBOUND', status: 'HANDLING', dock: 'In 1', arrivedMinAgo: 48, driver: 'Sam Chen', plate: 'ZBY-5648' },
  { site: 'WH-04', truck: 'TRK-2229', carrier: 'NDL', type: 'BOX', direction: 'OUTBOUND', status: 'HANDLING', dock: 'Out 2', arrivedMinAgo: 41, driver: 'Noah Tanaka', plate: 'CRX-5820' },
  { site: 'WH-04', truck: 'TRK-2307', carrier: 'NDL', type: 'BOX', direction: 'INBOUND', status: 'SCHEDULED', dock: 'In 3', etaMin: 1, driver: 'Ada Larsen', plate: 'EKT-2697' },
  { site: 'WH-04', truck: 'TRK-2481', carrier: 'CGV', type: 'BOX', direction: 'INBOUND', status: 'SCHEDULED', dock: 'In 2', etaMin: 3, driver: 'Alex Haddad', plate: 'WKH-3157' },
  // WH-05
  { site: 'WH-05', truck: 'TRK-2339', carrier: 'CGV', type: 'BOX', direction: 'OUTBOUND', status: 'HANDLING', dock: 'Bay 1', arrivedMinAgo: 38, driver: 'Rosa Diaz', plate: 'CGV-2339' },
  { site: 'WH-05', truck: 'TRK-2574', carrier: 'NDL', type: 'BOX', direction: 'OUTBOUND', status: 'HANDLING', dock: 'Bay 2', arrivedMinAgo: 22, driver: 'Theo Clark', plate: 'NDL-2574' },
  { site: 'WH-05', truck: 'TRK-2372', carrier: 'WTF', type: 'BOX', direction: 'INBOUND', status: 'DOCK_ASSIGNED', dock: 'Bay 3', arrivedMinAgo: 4, driver: 'Luis Walsh', plate: 'TTC-2870' },
  { site: 'WH-05', truck: 'TRK-2412', carrier: 'NDL', type: 'BOX', direction: 'INBOUND', status: 'AT_GATE', dock: 'Bay 4', arrivedMinAgo: 1, driver: 'Eva Novak', plate: 'NDL-2412' },
  { site: 'WH-05', truck: 'TRK-2420', carrier: 'CGV', type: 'BOX', direction: 'INBOUND', status: 'SCHEDULED', etaMin: 18, driver: 'Hugo Lane', plate: 'CGV-2420' },
  { site: 'WH-05', truck: 'TRK-2433', carrier: 'BLP', type: 'BOX', direction: 'OUTBOUND', status: 'SCHEDULED', etaMin: 44, driver: 'Kira Moss', plate: 'BLP-2433' },
  // WH-04 thêm 1 xe ngoài cửa sổ hiển thị (inbound count)
  { site: 'WH-04', truck: 'TRK-2512', carrier: 'WTF', type: 'BOX', direction: 'OUTBOUND', status: 'SCHEDULED', etaMin: 52, driver: 'Owen Fry', plate: 'WTF-2512' },
];

export interface EquipmentSeed {
  site: string;
  code: string;
  model: string;
  status: EquipmentStatus;
  battery: number;
  task?: string;
  charger: string;
  moves: number;
  speed?: number;
  operator: string;
}

export const EQUIPMENT: EquipmentSeed[] = [
  { site: 'WH-01', code: 'FL-01', model: 'Toyota 8FBE18', status: 'BUSY', battery: 75, task: 'Loading TRK-2051 at Bay 1', charger: 'C1', moves: 28, speed: 5.3, operator: 'forklift' },
  { site: 'WH-01', code: 'FL-02', model: 'Toyota 8FBE18', status: 'AVAILABLE', battery: 72, charger: 'C2', moves: 17, operator: 'op.lnguyen' },
  { site: 'WH-02', code: 'FL-03', model: 'Linde E20', status: 'BUSY', battery: 78, task: 'Loading TRK-2127 at Bay 3', charger: 'C1', moves: 31, speed: 4.1, operator: 'op.jbrooks' },
  { site: 'WH-02', code: 'FL-04', model: 'Linde E20', status: 'BUSY', battery: 66, task: 'Unloading TRK-2104 at Bay 1', charger: 'C2', moves: 19, speed: 3.8, operator: 'op.mkhan' },
  { site: 'WH-02', code: 'FL-05', model: 'Linde E20', status: 'CHARGING', battery: 41, charger: 'C3', moves: 40, operator: 'op.ptran' },
  { site: 'WH-02', code: 'FL-06', model: 'Linde E20', status: 'AVAILABLE', battery: 90, charger: 'C4', moves: 8, operator: 'op.rgomez' },
  { site: 'WH-03', code: 'FL-07', model: 'Crown FC 5200', status: 'BUSY', battery: 79, task: 'Unloading TRK-2148 at Bay 2', charger: 'C1', moves: 22, speed: 3.6, operator: 'op.dwhite' },
  { site: 'WH-03', code: 'FL-08', model: 'Crown FC 5200', status: 'AVAILABLE', battery: 88, charger: 'C2', moves: 9, operator: 'op.tbaker' },
  { site: 'WH-03', code: 'FL-09', model: 'Crown FC 5200', status: 'CHARGING', battery: 37, charger: 'C3', moves: 26, operator: 'op.sreid' },
  { site: 'WH-04', code: 'FL-10', model: 'Jungheinrich EFG 216', status: 'BUSY', battery: 84, task: 'Unloading TRK-2205 at In 1', charger: 'C1', moves: 39, speed: 3.3, operator: 'op.zreyes' },
  { site: 'WH-04', code: 'FL-11', model: 'Jungheinrich EFG 216', status: 'BUSY', battery: 82, task: 'Loading TRK-2229 at Out 2', charger: 'C2', moves: 27, speed: 2.8, operator: 'op.bholt' },
  { site: 'WH-04', code: 'FL-12', model: 'Toyota 8FBE18', status: 'CHARGING', battery: 88, charger: 'C3', moves: 24, operator: 'op.zlarsen' },
  { site: 'WH-04', code: 'FL-13', model: 'Toyota 8FBE18', status: 'CHARGING', battery: 94, charger: 'C4', moves: 15, operator: 'op.ecole' },
  { site: 'WH-04', code: 'FL-14', model: 'Jungheinrich EFG 216', status: 'AVAILABLE', battery: 76, charger: 'C5', moves: 11, operator: 'op.ifox' },
  { site: 'WH-05', code: 'FL-15', model: 'Toyota 8FBE18', status: 'BUSY', battery: 95, task: 'Loading TRK-2339 at Bay 1', charger: 'C1', moves: 34, speed: 4.5, operator: 'op.imoreau' },
  { site: 'WH-05', code: 'FL-16', model: 'Toyota 8FBE18', status: 'CHARGING', battery: 58, charger: 'C2', moves: 21, operator: 'op.awells' },
  { site: 'WH-05', code: 'FL-17', model: 'Toyota 8FBE18', status: 'CHARGING', battery: 63, charger: 'C3', moves: 18, operator: 'op.cpark' },
];

/** Người lái xe nâng (role FORKLIFT_OPERATOR) — tên theo video: Zoe Reyes, Zoe Larsen, Ines Moreau… */
export const OPERATORS: Array<{ username: string; fullName: string; site: string }> = [
  { username: 'op.lnguyen', fullName: 'Linh Nguyen', site: 'WH-01' },
  { username: 'op.jbrooks', fullName: 'Jamal Brooks', site: 'WH-02' },
  { username: 'op.mkhan', fullName: 'Mira Khan', site: 'WH-02' },
  { username: 'op.ptran', fullName: 'Phuc Tran', site: 'WH-02' },
  { username: 'op.rgomez', fullName: 'Rafa Gomez', site: 'WH-02' },
  { username: 'op.dwhite', fullName: 'Dylan White', site: 'WH-03' },
  { username: 'op.tbaker', fullName: 'Tess Baker', site: 'WH-03' },
  { username: 'op.sreid', fullName: 'Sol Reid', site: 'WH-03' },
  { username: 'op.zreyes', fullName: 'Zoe Reyes', site: 'WH-04' },
  { username: 'op.bholt', fullName: 'Ben Holt', site: 'WH-04' },
  { username: 'op.zlarsen', fullName: 'Zoe Larsen', site: 'WH-04' },
  { username: 'op.ecole', fullName: 'Eli Cole', site: 'WH-04' },
  { username: 'op.ifox', fullName: 'Iris Fox', site: 'WH-04' },
  { username: 'op.imoreau', fullName: 'Ines Moreau', site: 'WH-05' },
  { username: 'op.awells', fullName: 'Ana Wells', site: 'WH-05' },
  { username: 'op.cpark', fullName: 'Chris Park', site: 'WH-05' },
];

export interface SkuSeed {
  code: string;
  name: string;
  category: string;
  perPallet: number;
  lot?: boolean;
  expiryDays?: number;
  lowStock?: number;
  weight: number;
}

/** SKU theo video (Cardboard Box, Plastic Container, Safety Helmet, Packing Tape, LED Panel, …) + hàng lấp đầy kho. */
export const SKUS: SkuSeed[] = [
  { code: 'PKG-BOX-M', name: 'Cardboard Box (M)', category: 'Packaging', perPallet: 200, lowStock: 1200, weight: 0.3 },
  { code: 'PKG-CONT-PL', name: 'Plastic Container', category: 'Packaging', perPallet: 100, lowStock: 150, weight: 1.1 },
  { code: 'PPE-HLM-Y', name: 'Safety Helmet', category: 'PPE', perPallet: 130, lowStock: 250, weight: 0.4 },
  { code: 'PKG-TAPE', name: 'Packing Tape', category: 'Packaging', perPallet: 400, lowStock: 500, weight: 0.2 },
  { code: 'ELE-LED-6060', name: 'LED Panel 60×60', category: 'Electronics', perPallet: 48, lot: true, lowStock: 100, weight: 4.2 },
  { code: 'FUR-CHAIR', name: 'Office Chair', category: 'Furniture', perPallet: 12, lowStock: 50, weight: 14 },
  { code: 'PPE-GLV-NIT', name: 'Nitrile Gloves', category: 'PPE', perPallet: 120, lot: true, expiryDays: 540, lowStock: 1000, weight: 0.5 },
  { code: 'FRZ-PEAS-10', name: 'Frozen Peas 10 kg', category: 'Frozen', perPallet: 80, lot: true, expiryDays: 270, lowStock: 200, weight: 10 },
  { code: 'BEV-WATER-24', name: 'Spring Water 24-pack', category: 'Beverages', perPallet: 60, lot: true, expiryDays: 365, lowStock: 200, weight: 9 },
  // Hàng lấp đầy (không hiển thị trên panel site)
  { code: 'GEN-RETAIL', name: 'Retail Goods (Assorted)', category: 'General', perPallet: 40, weight: 8 },
  { code: 'PKG-FILM', name: 'Stretch Film Roll', category: 'Packaging', perPallet: 60, weight: 2.5 },
  { code: 'OFF-PAPER', name: 'Copy Paper A4 (box)', category: 'Office', perPallet: 50, weight: 12 },
  { code: 'FRZ-BERRY', name: 'Frozen Berries 5 kg', category: 'Frozen', perPallet: 96, lot: true, expiryDays: 300, weight: 5 },
  { code: 'BEV-JUICE', name: 'Orange Juice 12-pack', category: 'Beverages', perPallet: 70, lot: true, expiryDays: 120, weight: 7 },
  { code: 'ELE-CABLE', name: 'Ethernet Cable (box)', category: 'Electronics', perPallet: 80, weight: 3 },
];

export interface SiteInventorySeed {
  /** Tổng pallet tồn (KPI "Stock on hand") lúc mở màn, sau khi DemoDirector dựng xong. */
  pallets: number;
  /** Số lượng đơn vị của các SKU hiển thị trên panel site (theo đúng thứ tự video). */
  featured: Array<[string, number]>;
  filler: string[];
  putawaysToday: number;
  outboundToday: number;
  onTime: { pct30: number; pctPrev: number; samples: number };
}

export const SITE_INVENTORY: Record<string, SiteInventorySeed> = {
  'WH-01': { pallets: 1412, featured: [['PKG-BOX-M', 1906], ['PKG-CONT-PL', 297], ['PPE-HLM-Y', 212], ['PKG-TAPE', 4448]], filler: ['GEN-RETAIL', 'PKG-FILM', 'OFF-PAPER'], putawaysToday: 15, outboundToday: 23, onTime: { pct30: 96.6, pctPrev: 96.2, samples: 500 } },
  'WH-02': { pallets: 3310, featured: [['ELE-LED-6060', 1787], ['FUR-CHAIR', 174], ['PKG-BOX-M', 993], ['PPE-GLV-NIT', 5793]], filler: ['GEN-RETAIL', 'ELE-CABLE', 'OFF-PAPER'], putawaysToday: 35, outboundToday: 21, onTime: { pct30: 98.2, pctPrev: 97.8, samples: 500 } },
  'WH-03': { pallets: 990, featured: [['FRZ-PEAS-10', 334], ['BEV-WATER-24', 364], ['PPE-GLV-NIT', 495], ['PKG-CONT-PL', 208]], filler: ['FRZ-BERRY', 'BEV-JUICE'], putawaysToday: 20, outboundToday: 31, onTime: { pct30: 96.0, pctPrev: 95.6, samples: 500 } },
  'WH-04': { pallets: 610, featured: [['BEV-WATER-24', 288], ['PKG-TAPE', 1922], ['ELE-LED-6060', 73], ['PPE-HLM-Y', 320]], filler: ['GEN-RETAIL', 'PKG-FILM'], putawaysToday: 20, outboundToday: 29, onTime: { pct30: 96.2, pctPrev: 95.8, samples: 500 } },
  'WH-05': { pallets: 1730, featured: [['ELE-LED-6060', 934], ['PKG-BOX-M', 1817], ['PPE-GLV-NIT', 865], ['PPE-HLM-Y', 908]], filler: ['GEN-RETAIL', 'ELE-CABLE', 'OFF-PAPER'], putawaysToday: 25, outboundToday: 33, onTime: { pct30: 95.9, pctPrev: 95.5, samples: 1000 } },
};

/** Pallet nhìn thấy ngoài trời (staging, yard slot, rack) — mã, SKU, vị trí; PAL-1026 = Safety Helmet ở Yard slot S01 như video. */
export const OUTDOOR_PALLETS: Record<string, Array<{ loc: string; sku: string; qty: number; n?: number; code?: string; lot?: string; receivedAt?: string; lifecycle?: 'IN_STOCK' | 'STAGED' }>> = {
  'WH-01': [
    { loc: 'S01', sku: 'PPE-HLM-Y', qty: 82, code: 'PAL-1026', lot: 'L2501-870', receivedAt: '2026-04-19T16:29:00-04:00', lifecycle: 'STAGED' },
    { loc: 'S01', sku: 'PKG-BOX-M', qty: 200 },
    { loc: 'S02', sku: 'PKG-BOX-M', qty: 200, n: 2 },
    { loc: 'S03', sku: 'PKG-BOX-M', qty: 200 },
    { loc: 'S04', sku: 'PKG-TAPE', qty: 400, n: 2 },
    { loc: 'S05', sku: 'PKG-TAPE', qty: 400 },
    { loc: 'S06', sku: 'GEN-RETAIL', qty: 40 },
    { loc: 'S07', sku: 'GEN-RETAIL', qty: 40 },
    { loc: 'R-01', sku: 'PKG-BOX-M', qty: 200, n: 5 },
    { loc: 'Y01', sku: 'PKG-CONT-PL', qty: 100, n: 2 },
    { loc: 'Y02', sku: 'PKG-CONT-PL', qty: 97, n: 1 },
    { loc: 'Y03', sku: 'PKG-FILM', qty: 60, n: 1 },
  ],
  'WH-02': [
    { loc: 'S20', sku: 'GEN-RETAIL', qty: 40, n: 2 },
    { loc: 'S21', sku: 'PPE-GLV-NIT', qty: 120, n: 1 },
    { loc: 'R-01', sku: 'FUR-CHAIR', qty: 12, n: 4 },
    { loc: 'R-02', sku: 'PKG-BOX-M', qty: 200, n: 3 },
    { loc: 'Y01', sku: 'PPE-GLV-NIT', qty: 120, n: 3 },
  ],
  'WH-03': [
    { loc: 'Y01', sku: 'PKG-CONT-PL', qty: 104, n: 1 },
    { loc: 'Y02', sku: 'BEV-WATER-24', qty: 60, n: 1 },
    { loc: 'R-01', sku: 'BEV-JUICE', qty: 70, n: 4 },
  ],
  'WH-04': [
    { loc: 'S20', sku: 'PKG-TAPE', qty: 400, n: 1 },
    { loc: 'S21', sku: 'PPE-HLM-Y', qty: 130, n: 1 },
  ],
  'WH-05': [],
};

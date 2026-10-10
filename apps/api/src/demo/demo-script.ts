/**
 * Kịch bản dựng cảnh theo video tham chiếu (DEC-51): trạng thái "đang diễn ra" lúc mở màn của từng site.
 * Mã shipment (#SHP-784xx), khách hàng, điểm đến, tiến độ xếp/dỡ lấy đúng theo khung hình video.
 */
export interface OutboundScene {
  truck: string;
  shipment: number;
  customer: string;
  destination: string;
  pallets: number;
  /** Số pallet đã pick ra staging (mặc định = pallets). */
  picked?: number;
  loaded: number;
  /** Bắt đầu xếp lên xe (cần xe đã ở dock và đủ pick). */
  startLoading: boolean;
  dispatchInMin: number;
}

export interface InboundScene {
  truck: string;
  shipment: number;
  partner: string;
  pallets: number;
  received: number;
  startReceipt: boolean;
}

export interface SiteScene {
  code: string;
  /** SKU dùng cho đơn xuất/nhập của kịch bản (pallet nguyên, không làm đổi số liệu SKU hiển thị). */
  sku: string;
  stagingSlots: string[];
  /** Pallet nhận xong đặt về đâu: kho trong nhà hay làn staging (cross-dock). */
  putaway: 'indoor' | 'staging';
  indoorPrefix: string;
  /** Chỉ nhận / chỉ xuất / cả hai — cho xe mới sinh thêm. */
  flow: 'inbound' | 'outbound' | 'both';
  /** ETA (phút) của xe đang tới lúc mở màn. */
  etas: Record<string, number>;
  outbound: OutboundScene[];
  inbound: InboundScene[];
  /** Xe nâng gắn với xe tải lúc mở màn. */
  forklifts: Record<string, string>;
}

export const DEMO_SCENES: SiteScene[] = [
  {
    code: 'WH-01',
    sku: 'GEN-RETAIL',
    stagingSlots: ['S10', 'S11', 'S12'],
    putaway: 'indoor',
    indoorPrefix: 'A-',
    flow: 'both',
    etas: { 'TRK-2287': 3 },
    outbound: [{ truck: 'TRK-2051', shipment: 78442, customer: 'Oakridge Market', destination: 'Philadelphia, PA', pallets: 6, loaded: 2, startLoading: true, dispatchInMin: 21 }],
    inbound: [{ truck: 'TRK-2287', shipment: 78443, partner: 'Northwind Supply', pallets: 7, received: 0, startReceipt: false }],
    forklifts: { 'TRK-2051': 'FL-01', 'TRK-2287': 'FL-02' },
  },
  {
    code: 'WH-02',
    sku: 'GEN-RETAIL',
    stagingSlots: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08'],
    putaway: 'indoor',
    indoorPrefix: 'A-',
    flow: 'both',
    etas: { 'TRK-2526': 2, 'TRK-2690': 28 },
    outbound: [
      { truck: 'TRK-2127', shipment: 78445, customer: 'Helix Retail', destination: 'Hartford, CT', pallets: 7, loaded: 4, startLoading: true, dispatchInMin: 19 },
      { truck: 'TRK-2526', shipment: 78447, customer: 'Oakridge Market', destination: 'Trenton, NJ', pallets: 4, picked: 2, loaded: 0, startLoading: false, dispatchInMin: 40 },
    ],
    inbound: [
      { truck: 'TRK-2104', shipment: 78444, partner: 'Brightline Electronics', pallets: 5, received: 1, startReceipt: true },
      { truck: 'TRK-2658', shipment: 78446, partner: 'Northwind Supply', pallets: 6, received: 0, startReceipt: false },
    ],
    forklifts: { 'TRK-2127': 'FL-03', 'TRK-2104': 'FL-04' },
  },
  {
    code: 'WH-03',
    sku: 'FRZ-BERRY',
    stagingSlots: [],
    putaway: 'indoor',
    indoorPrefix: 'C-',
    flow: 'inbound',
    etas: { 'TRK-2650': 32 },
    outbound: [],
    inbound: [
      { truck: 'TRK-2148', shipment: 78448, partner: 'Harbor & Co.', pallets: 4, received: 3, startReceipt: true },
      { truck: 'TRK-2471', shipment: 78449, partner: 'Sunvale Grocers', pallets: 4, received: 0, startReceipt: true },
      { truck: 'TRK-2603', shipment: 78472, partner: 'Harbor & Co.', pallets: 8, received: 0, startReceipt: false },
    ],
    forklifts: { 'TRK-2148': 'FL-07', 'TRK-2471': 'FL-08' },
  },
  {
    code: 'WH-04',
    sku: 'GEN-RETAIL',
    stagingSlots: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09'],
    putaway: 'staging',
    indoorPrefix: 'X-',
    flow: 'both',
    etas: { 'TRK-2307': 1, 'TRK-2481': 3, 'TRK-2512': 52 },
    outbound: [
      { truck: 'TRK-2229', shipment: 78452, customer: 'Harbor & Co.', destination: 'Providence, RI', pallets: 6, loaded: 3, startLoading: true, dispatchInMin: 18 },
      { truck: 'TRK-2512', shipment: 78453, customer: 'Oakridge Market', destination: 'Edison, NJ', pallets: 3, loaded: 0, startLoading: false, dispatchInMin: 70 },
    ],
    inbound: [
      { truck: 'TRK-2205', shipment: 78450, partner: 'Oakridge Market', pallets: 6, received: 2, startReceipt: true },
      { truck: 'TRK-2307', shipment: 78456, partner: 'Sunvale Grocers', pallets: 4, received: 0, startReceipt: false },
      { truck: 'TRK-2481', shipment: 78466, partner: 'Halcyon Retail', pallets: 5, received: 0, startReceipt: false },
    ],
    forklifts: { 'TRK-2205': 'FL-10', 'TRK-2229': 'FL-11' },
  },
  {
    code: 'WH-05',
    sku: 'GEN-RETAIL',
    stagingSlots: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08'],
    putaway: 'indoor',
    indoorPrefix: 'R-',
    flow: 'both',
    etas: { 'TRK-2420': 18, 'TRK-2433': 44 },
    outbound: [
      { truck: 'TRK-2339', shipment: 78458, customer: 'Halcyon Retail', destination: 'Stamford, CT', pallets: 5, loaded: 1, startLoading: true, dispatchInMin: 21 },
      { truck: 'TRK-2574', shipment: 78459, customer: 'Oakridge Market', destination: 'Newark, NJ', pallets: 4, loaded: 0, startLoading: true, dispatchInMin: 25 },
    ],
    inbound: [
      { truck: 'TRK-2372', shipment: 78460, partner: 'Sunvale Grocers', pallets: 6, received: 0, startReceipt: false },
      { truck: 'TRK-2412', shipment: 78461, partner: 'Northwind Supply', pallets: 5, received: 0, startReceipt: false },
    ],
    forklifts: { 'TRK-2339': 'FL-15' },
  },
];

export const DEMO_PASSWORD = 'WareTrack@2026';

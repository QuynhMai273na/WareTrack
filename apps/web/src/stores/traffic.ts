import { create } from 'zustand';

/**
 * Animation State của xe đang chạy giữa hai site trên bản đồ chung (chỉ để vẽ, BR-30):
 * mã xe → site đích. Site đích ẩn xe "đang tới" cùng mã cho tới khi xe chạy tới nơi, tránh vẽ hai chiếc.
 */
interface TrafficState {
  inTransit: Record<string, string>;
  beginTransit: (truckCode: string, destinationSiteId: string) => void;
  endTransit: (truckCode: string) => void;
}

export const useTraffic = create<TrafficState>((set) => ({
  inTransit: {},
  beginTransit: (truckCode, destinationSiteId) => set((state) => ({ inTransit: { ...state.inTransit, [truckCode]: destinationSiteId } })),
  endTransit: (truckCode) =>
    set((state) => {
      const { [truckCode]: _finished, ...rest } = state.inTransit;
      return { inTransit: rest };
    }),
}));

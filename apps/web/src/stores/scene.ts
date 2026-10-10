import { create } from 'zustand';

export type SelectableType = 'truck' | 'forklift' | 'dock' | 'slot' | 'pallet' | 'vehicle' | 'location' | 'charger';

export interface Selection {
  siteId: string;
  type: SelectableType;
  id: string;
}

export type CameraCommand = 'zoomIn' | 'zoomOut' | 'rotate' | 'reset' | 'home' | 'network';

/**
 * Visualization State (mục 18.4): chỉ chứa ID và trạng thái hiển thị — không có dữ liệu nghiệp vụ.
 * Reset khi đổi site.
 */
interface SceneState {
  siteId: string | null;
  selection: Selection | null;
  hover: Selection | null;
  mode: '3d' | '2d';
  cameraCommand: { cmd: CameraCommand; n: number } | null;
  focusRequest: number;
  setSite: (siteId: string) => void;
  select: (sel: Selection | null) => void;
  setHover: (sel: Selection | null) => void;
  setMode: (mode: '3d' | '2d') => void;
  camera: (cmd: CameraCommand) => void;
}

export const useScene = create<SceneState>((set) => ({
  siteId: null,
  selection: null,
  hover: null,
  mode: '3d',
  cameraCommand: null,
  focusRequest: 0,
  setSite: (siteId) => set((s) => (s.siteId === siteId ? s : { siteId, selection: null, hover: null })),
  select: (selection) => set((s) => ({ selection, focusRequest: s.focusRequest + 1 })),
  setHover: (hover) => set({ hover }),
  setMode: (mode) => set({ mode }),
  camera: (cmd) => set((s) => ({ cameraCommand: { cmd, n: (s.cameraCommand?.n ?? 0) + 1 } })),
}));

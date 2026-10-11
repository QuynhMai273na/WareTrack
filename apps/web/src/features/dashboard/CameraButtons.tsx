import { Home, Minus, Plus, RotateCcw, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useScene } from '@/stores/scene';

/** Nút camera như video: zoom +/−, xoay, reset, home (FR-12.03) + chuyển 2D/3D (FR-12.07). */
export function CameraButtons() {
  const { t } = useTranslation();
  const camera = useScene((state) => state.camera);
  const mode = useScene((state) => state.mode);
  const setMode = useScene((state) => state.setMode);
  const btn = 'flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100';
  return (
    <div className="pointer-events-auto flex flex-col items-center gap-2">
      {mode === '3d' ? (
        <div className="card flex flex-col p-1">
          <button className={btn} onClick={() => camera('zoomIn')} aria-label="Zoom in">
            <Plus size={16} />
          </button>
          <button className={btn} onClick={() => camera('zoomOut')} aria-label="Zoom out">
            <Minus size={16} />
          </button>
          <button className={btn} onClick={() => camera('rotate')} aria-label="Rotate">
            <RotateCcw size={16} />
          </button>
          <button className={btn} onClick={() => camera('reset')} aria-label="Reset view">
            <RotateCw size={16} />
          </button>
          <button className={btn} onClick={() => camera('home')} aria-label="Home">
            <Home size={16} />
          </button>
        </div>
      ) : null}
      <div className="card flex flex-col p-1 text-xs font-semibold">
        {(['3d', '2d'] as const).map((viewMode) => (
          <button key={viewMode} className={cn('rounded-md px-2 py-1.5', mode === viewMode ? 'bg-brand text-white' : 'text-muted hover:bg-slate-100')} onClick={() => setMode(viewMode)}>
            {viewMode === '3d' ? t('common.view3d') : t('common.view2d')}
          </button>
        ))}
      </div>
    </div>
  );
}

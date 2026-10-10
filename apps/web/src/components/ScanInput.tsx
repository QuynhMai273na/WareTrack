import { Camera, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

/**
 * Ô nhập mã quét (DEC-54): nhận chuỗi từ máy quét HID (gõ như bàn phím), nhập tay,
 * hoặc camera trình duyệt qua Barcode Detection API khi trình duyệt hỗ trợ.
 */
export function ScanInput({ value, onChange, placeholder, onCameraScan }: { value: string; onChange: (v: string) => void; placeholder?: string; onCameraScan?: () => void }) {
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const supported = typeof window !== 'undefined' && !!window.BarcodeDetector;

  useEffect(() => {
    if (!scanning || !window.BarcodeDetector) return;
    let stream: MediaStream | null = null;
    let stop = false;
    const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13'] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
        while (!stop && video.current) {
          const codes = await detector.detect(video.current).catch(() => []);
          if (codes[0]?.rawValue) {
            onChange(codes[0].rawValue);
            onCameraScan?.();
            setScanning(false);
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setScanning(false);
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning, onChange, onCameraScan]);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        {supported ? (
          <Button type="button" variant="outline" size="icon" onClick={() => setScanning((s) => !s)} aria-label="Camera">
            {scanning ? <X size={16} /> : <Camera size={16} />}
          </Button>
        ) : null}
      </div>
      {scanning ? <video ref={video} className="aspect-video w-full rounded-lg bg-black object-cover" muted playsInline /> : null}
    </div>
  );
}

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTime(iso: string | null | undefined, timeZone?: string) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(iso));
}

/** Ngày + giờ (cho mốc cách xa hôm nay: lịch sử, ngày nhận xe…). */
export function formatDateTime(iso: string | null | undefined, timeZone?: string) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(iso));
}

export function minutesFromNow(iso: string | null | undefined) {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
}

export function relativeMinutes(iso: string | null | undefined) {
  const m = minutesFromNow(iso);
  if (m === null) return '—';
  if (Math.abs(m) < 1) return 'now';
  return m > 0 ? `${m} min` : `${-m} min ago`;
}

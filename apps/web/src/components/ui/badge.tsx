import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'bg-slate-100 text-slate-600',
      ok: 'bg-ok-soft text-ok',
      warn: 'bg-warn-soft text-warn',
      bad: 'bg-bad-soft text-bad',
      info: 'bg-info-soft text-brand',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** Màu trạng thái luôn kèm chữ (không chỉ dựa màu — NFR-10). */
export function toneFor(status: string): BadgeTone {
  switch (status) {
    case 'HANDLING':
    case 'BUSY':
    case 'ASSIGNED':
    case 'OCCUPIED':
    case 'AT_DOCK':
      return 'ok';
    case 'DOCK_ASSIGNED':
    case 'AT_GATE':
    case 'RESERVED':
    case 'SCHEDULED':
    case 'WAITING':
      return 'info';
    case 'CHARGING':
    case 'READY_TO_LEAVE':
      return 'warn';
    case 'REJECTED':
    case 'BLOCKED':
    case 'OUT_OF_SERVICE':
    case 'MAINTENANCE':
    case 'NO_SHOW':
      return 'bad';
    default:
      return 'neutral';
  }
}

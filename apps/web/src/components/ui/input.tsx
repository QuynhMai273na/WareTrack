import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-9 w-full rounded-lg border border-line bg-white px-3 text-sm outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:opacity-60',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1 block text-xs font-medium text-muted', className)} {...props} />;
}

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn('h-9 w-full rounded-lg border border-line bg-white px-2.5 text-sm outline-none focus:border-brand', className)} {...props} />
));
Select.displayName = 'Select';

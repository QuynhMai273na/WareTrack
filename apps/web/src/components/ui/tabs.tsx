import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn('rounded-md px-2.5 py-1 text-xs font-medium text-muted transition data-[state=active]:bg-white data-[state=active]:text-ink data-[state=active]:shadow-sm', className)}
      {...props}
    />
  );
}

export const TabsContent = TabsPrimitive.Content;

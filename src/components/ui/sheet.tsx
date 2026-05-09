import * as React from 'react';
import { cn } from '@/lib/utils';

const Sheet = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('fixed inset-0 z-50', className)} {...props} />
  )
);
Sheet.displayName = 'Sheet';

const SheetOverlay = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('fixed inset-0 z-50 bg-black/80', className)} {...props} />
  )
);
SheetOverlay.displayName = 'SheetOverlay';

const SheetContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <Sheet>
      <SheetOverlay />
      <div ref={ref} className={cn('fixed z-50 flex h-full w-3/4 flex-col bg-background p-6 shadow-lg transition-transform sm:w-full sm:max-w-sm', className)} {...props}>
        {children}
      </div>
    </Sheet>
  )
);
SheetContent.displayName = 'SheetContent';

const SheetHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-2 text-center sm:text-left', className)} {...props} />
  )
);
SheetHeader.displayName = 'SheetHeader';

const SheetTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={cn('text-lg font-semibold', className)} {...props} />
  )
);
SheetTitle.displayName = 'SheetTitle';

export { Sheet, SheetOverlay, SheetContent, SheetHeader, SheetTitle };
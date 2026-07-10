import * as React from 'react';
import { cn } from '@/lib/utils';

type BadgeVariant = 'default' | 'outline' | 'secondary' | 'destructive';

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

const variantClass: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary text-primary-foreground',
  outline: 'bg-transparent',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  destructive: 'border-transparent bg-destructive text-destructive-foreground',
};

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        variantClass[variant],
        className,
      )}
      {...props}
    />
  )
);
Badge.displayName = 'Badge';

export { Badge };
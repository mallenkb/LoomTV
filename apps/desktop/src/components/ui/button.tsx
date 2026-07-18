import * as React from 'react';
import { cn } from '@/lib/utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  size?: 'default' | 'sm' | 'lg' | 'icon';
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    return (
      <button
        className={cn(
          'inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
          {
            'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)] hover:bg-[var(--loom-accent-hover)]': variant === 'default',
            'loom-destructive-button bg-red-500/15 text-red-100 hover:bg-red-500/25': variant === 'destructive',
            'border border-[var(--loom-border)] bg-[var(--loom-surface-2)] text-[var(--loom-text)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]': variant === 'outline',
            'bg-[var(--loom-surface-2)] text-[var(--loom-text)] hover:bg-[var(--loom-surface-3)]': variant === 'secondary',
            'text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)]': variant === 'ghost',
            'text-[var(--loom-accent)] underline-offset-4 hover:underline': variant === 'link',
            'h-10 px-4 py-2': size === 'default',
            'h-9 px-3': size === 'sm',
            'h-11 px-8': size === 'lg',
            'h-10 w-10': size === 'icon',
          },
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button };

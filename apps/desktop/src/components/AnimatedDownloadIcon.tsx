import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import type { HTMLAttributes, MouseEvent } from 'react';
import type { Variants } from 'motion/react';
import { motion, useAnimation } from 'motion/react';

import { cn } from '@/lib/utils';

export interface DownloadIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface DownloadIconProps extends HTMLAttributes<HTMLDivElement> {
  isDownloading?: boolean;
  size?: number;
}

const ARROW_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: {
    y: 2,
    transition: {
      type: 'spring',
      stiffness: 200,
      damping: 10,
      mass: 1,
    },
  },
};

const AnimatedDownloadIcon = forwardRef<DownloadIconHandle, DownloadIconProps>(
  ({ onMouseEnter, onMouseLeave, className, isDownloading = false, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;

      return {
        startAnimation: () => controls.start('animate'),
        stopAnimation: () => controls.start('normal'),
      };
    }, [controls]);

    const handleMouseEnter = useCallback((event: MouseEvent<HTMLDivElement>) => {
      if (isControlledRef.current) {
        onMouseEnter?.(event);
      } else if (!isDownloading) {
        void controls.start('animate');
      }
    }, [controls, isDownloading, onMouseEnter]);

    const handleMouseLeave = useCallback((event: MouseEvent<HTMLDivElement>) => {
      if (isControlledRef.current) {
        onMouseLeave?.(event);
      } else if (!isDownloading) {
        void controls.start('normal');
      }
    }, [controls, isDownloading, onMouseLeave]);

    return (
      <div
        className={cn('inline-flex shrink-0 items-center justify-center', className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <svg
          aria-hidden="true"
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <motion.g
            animate={isDownloading ? {
              y: [0, 2, 0],
              transition: { duration: 0.8, ease: 'easeInOut', repeat: Infinity },
            } : controls}
            initial="normal"
            variants={ARROW_VARIANTS}
          >
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </motion.g>
        </svg>
      </div>
    );
  },
);

AnimatedDownloadIcon.displayName = 'AnimatedDownloadIcon';

export default AnimatedDownloadIcon;

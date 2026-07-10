import { motion } from 'motion/react';
import LoomLogo from '@/components/LoomLogo';
import LoomPlayMark from '@/components/LoomPlayMark';
import { AppLoaderStyle } from '@/lib/theme';

type LoomLoaderProps = {
  style?: AppLoaderStyle;
  className?: string;
  markClassName?: string;
  color?: string;
};

export default function LoomLoader({
  style = 'play-mark',
  className = '',
  markClassName = '',
  color = 'currentColor',
}: LoomLoaderProps) {
  return (
    <motion.div
      className={`grid place-items-center ${className}`}
      initial={{ opacity: 0, scale: 0.82 }}
      animate={{
        opacity: [0.65, 1, 0.65],
        scale: [0.92, 1.08, 0.92],
      }}
      transition={{ duration: 1.25, ease: 'easeInOut', repeat: Infinity }}
    >
      <motion.div
        animate={{ x: [0, 2, 0] }}
        transition={{ duration: 1.25, ease: 'easeInOut', repeat: Infinity }}
      >
        {style === 'horizontal-logo' ? (
          <LoomLogo className={markClassName || 'h-8 w-auto'} accent={color} />
        ) : (
          <LoomPlayMark className={markClassName || 'h-9 w-9'} color={color} />
        )}
      </motion.div>
    </motion.div>
  );
}

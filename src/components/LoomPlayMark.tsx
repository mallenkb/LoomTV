import React from 'react';
import LoomLogo from '@/components/LoomLogo';

export default function LoomPlayMark({
  className = '',
  color = 'currentColor',
}: {
  className?: string;
  color?: string;
}) {
  void color;

  return <LoomLogo className={className} />;
}

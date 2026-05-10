import React from 'react';

const logoUrl = new URL('../assets/loomtv-logo.png', import.meta.url).href;

export default function LoomLogo({ className = '', accent }: { className?: string; accent?: string }) {
  void accent;

  return (
    <img
      src={logoUrl}
      alt=""
      className={className}
      draggable={false}
      aria-hidden="true"
    />
  );
}

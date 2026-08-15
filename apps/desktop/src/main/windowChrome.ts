export type WindowChromeOptions = {
  frame: true;
  titleBarStyle?: 'hidden' | 'hiddenInset';
  titleBarOverlay?: {
    color: string;
    symbolColor: string;
    height: number;
  };
  trafficLightPosition?: { x: number; y: number };
};

export function windowChromeOptions(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform === 'darwin') {
    return {
      frame: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
    };
  }
  return {
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1f1f1f',
      symbolColor: '#f2f2f2',
      height: 30,
    },
  };
}

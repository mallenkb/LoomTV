export type WindowChromeOptions = {
  frame: true;
  titleBarStyle?: 'hiddenInset';
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
  return { frame: true };
}

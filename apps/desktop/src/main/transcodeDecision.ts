import { probeMediaFile } from './mediaProbeFile.ts';
import type { TranscodeOptions } from './mediaTypes.ts';
import {
  browserPlaybackPlanForMetadata,
} from './transcodeDecisionCore.ts';
export type { BrowserPlaybackPlan } from './transcodeDecisionCore.ts';

function isHdrMetadata(metadata?: { colorTransfer?: string; colorPrimaries?: string; pixelFormat?: string }): boolean {
  const transfer = String(metadata?.colorTransfer || '').toLowerCase();
  const primaries = String(metadata?.colorPrimaries || '').toLowerCase();
  const pixelFormat = String(metadata?.pixelFormat || '').toLowerCase();
  return transfer.includes('smpte2084')
    || transfer.includes('arib-std-b67')
    || transfer.includes('hlg')
    || (primaries.includes('bt2020') && /10|12/.test(pixelFormat));
}

export function browserPlaybackPlan(filePath: string, options: TranscodeOptions = {}) {
  const probe = probeMediaFile(filePath);
  if (options.toneMap === undefined && isHdrMetadata(probe.localMetadata)) options.toneMap = true;
  return browserPlaybackPlanForMetadata(filePath, probe.localMetadata, options);
}

export function needsBrowserTranscoding(filePath: string): boolean {
  return browserPlaybackPlan(filePath).mode !== 'direct';
}

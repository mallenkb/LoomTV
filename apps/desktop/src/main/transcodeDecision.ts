import path from 'node:path';
import { probeMediaFile } from './mediaProbeFile.ts';
import type { TranscodeOptions } from './mediaTypes.ts';
import {
  browserPlaybackPlanForMetadata,
  transcodeFirstExtensions,
} from './transcodeDecisionCore.ts';
export type { BrowserPlaybackMode, BrowserPlaybackPlan } from './transcodeDecisionCore.ts';
export { browserPlaybackPlanForMetadata } from './transcodeDecisionCore.ts';

export function needsTranscoding(filePath: string): boolean {
  return transcodeFirstExtensions.has(path.extname(filePath).toLowerCase());
}

export function browserPlaybackPlan(filePath: string, options: TranscodeOptions = {}) {
  const probe = probeMediaFile(filePath);
  return browserPlaybackPlanForMetadata(filePath, probe.localMetadata, options);
}

export function needsBrowserTranscoding(filePath: string): boolean {
  return browserPlaybackPlan(filePath).mode !== 'direct';
}

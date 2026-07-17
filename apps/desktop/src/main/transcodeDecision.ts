import { probeMediaFile } from './mediaProbeFile.ts';
import type { TranscodeOptions } from './mediaTypes.ts';
import {
  browserPlaybackPlanForMetadata,
} from './transcodeDecisionCore.ts';
export type { BrowserPlaybackPlan } from './transcodeDecisionCore.ts';

export function browserPlaybackPlan(filePath: string, options: TranscodeOptions = {}) {
  const probe = probeMediaFile(filePath);
  return browserPlaybackPlanForMetadata(filePath, probe.localMetadata, options);
}

export function needsBrowserTranscoding(filePath: string): boolean {
  return browserPlaybackPlan(filePath).mode !== 'direct';
}

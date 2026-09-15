import path from 'node:path';
import { isVideoFilePath } from '@loom-media-server/media-core';

const SUBTITLE_EXTS = ['.vtt', '.srt', '.ass', '.ssa'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

export function isMacSidecarFile(fileName: string): boolean {
  return fileName.startsWith('._') || fileName === '.DS_Store';
}

export function isVideoFileName(fileName: string): boolean {
  return !isMacSidecarFile(fileName) && isVideoFilePath(fileName);
}

export function isSubtitleFileName(fileName: string): boolean {
  return !isMacSidecarFile(fileName) && SUBTITLE_EXTS.includes(path.extname(fileName).toLowerCase());
}

export function isImageFileName(fileName: string): boolean {
  return !isMacSidecarFile(fileName) && IMAGE_EXTS.includes(path.extname(fileName).toLowerCase());
}

export function normalizedArtworkBaseName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Match language/variant suffixes without matching another episode's number. */
export function subtitleAssociationKeys(subtitle: string): string[] {
  const stem = path.basename(subtitle, path.extname(subtitle)).toLowerCase();
  const keys = [stem];
  for (let index = 1; index < stem.length; index++) {
    if (['.', ' ', '_', '-', '[', '('].includes(stem[index])) keys.push(stem.slice(0, index));
  }
  return keys;
}

export function subtitleMatchesVideo(subtitle: string, video: string): boolean {
  const stem = (name: string) => path.basename(name, path.extname(name)).toLowerCase();
  const base = stem(video);
  const candidate = stem(subtitle);
  if (!candidate.startsWith(base)) return false;
  const suffix = candidate.slice(base.length);
  return suffix === '' || ['.', ' ', '_', '-', '[', '('].includes(suffix[0]);
}

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

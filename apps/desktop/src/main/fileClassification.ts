import path from 'node:path';

const VIDEO_EXTS = ['.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v', '.wmv', '.flv', '.mpg', '.mpeg', '.m2ts', '.3gp', '.ts'];
const SUBTITLE_EXTS = ['.vtt', '.srt', '.ass', '.ssa'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

export function isMacSidecarFile(fileName: string): boolean {
  return fileName.startsWith('._') || fileName === '.DS_Store';
}

export function isVideoFileName(fileName: string): boolean {
  return !isMacSidecarFile(fileName) && VIDEO_EXTS.includes(path.extname(fileName).toLowerCase());
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

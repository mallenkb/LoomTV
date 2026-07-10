import path from 'node:path';

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/mp4',
    '.m4v': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
    '.ts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
  };
  return map[ext] || 'video/mp4';
}

export function getSubtitleMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.vtt') return 'text/vtt; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

export function getImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
  };
  return map[ext] || 'application/octet-stream';
}

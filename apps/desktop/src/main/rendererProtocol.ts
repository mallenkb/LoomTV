import path from 'node:path';

export const PACKAGED_RENDERER_ORIGIN = 'loomtv://app';
export const PACKAGED_RENDERER_URL = `${PACKAGED_RENDERER_ORIGIN}/index.html`;

export function isPackagedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'loomtv:' && url.hostname === 'app' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

export function packagedRendererAssetPath(value: string, root: string): string | null {
  if (!isPackagedRendererUrl(value)) return null;
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    if (pathname.includes('\\') || pathname.includes('\0')) return null;
    const relative = pathname.slice(1);
    if (!relative || relative.split('/').some((part) => part === '..' || part === '.')) return null;
    const resolvedRoot = path.resolve(root);
    const filePath = path.resolve(resolvedRoot, relative);
    return filePath.startsWith(`${resolvedRoot}${path.sep}`) ? filePath : null;
  } catch { return null; }
}

import { z } from 'zod';
import { safeFetch } from './safeFetch.ts';

const textField = z.union([z.string(), z.array(z.string())]).optional();
const fileSchema = z.object({
  name: z.string(), format: z.string().optional(), source: z.string().optional(),
  size: z.union([z.string(), z.number()]).optional(), private: z.union([z.boolean(), z.string()]).optional(),
}).passthrough();
const metadataSchema = z.object({
  files: z.array(fileSchema).default([]),
  is_dark: z.boolean().optional(),
  metadata: z.object({ title: textField, description: textField, licenseurl: textField, access_restricted: textField }).passthrough().optional(),
}).passthrough();

function text(value: string | readonly string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : value?.find(entry => entry.trim())?.trim() || '';
}

function videoPriority(file: z.output<typeof fileSchema>): number {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in provider filenames.
  if (!file.name || file.name.length > 4096 || file.name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\u0000-\u001f]/.test(file.name)) return -1;
  const name = file.name.toLowerCase();
  if (file.private === true || file.private === 'true' || /(?:^|[_. -])(sample|trailer|preview|thumb)(?:[_. -]|$)/i.test(name)) return -1;
  if (Number(file.size) === 0) return -1;
  if (/\.mp4$/.test(name)) return /512kb|lowres/.test(name) ? 70 : 100;
  if (/\.m4v$/.test(name)) return 95;
  if (/\.webm$/.test(name)) return 90;
  if (/\.og[gv]$/.test(name)) return 80;
  if (/\.(mkv|mov|avi|mpg|mpeg|flv|ts)$/.test(name)) return 60;
  return -1;
}

export async function resolveArchivePlaybackSource(identifier: string, signal?: AbortSignal): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(identifier)) throw new Error('Invalid Archive.org item.');
  const response = await safeFetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
    signal, headers: { Accept: 'application/json' },
  }, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024, retries: 0, maxRedirects: 2 });
  if (!response.ok) throw new Error(`Archive.org returned ${response.status}.`);
  const parsed = metadataSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Archive.org returned an unreadable media record.');
  const metadata = parsed.data;
  if (metadata.is_dark || text(metadata.metadata?.access_restricted) === 'true') throw new Error('Archive.org restricts access to this item.');
  const files = metadata.files.filter(file => videoPriority(file) >= 0);
  files.sort((a, b) => videoPriority(b) - videoPriority(a) || Number(b.size || 0) - Number(a.size || 0));
  const selected = files[0];
  if (!selected) throw new Error('Archive.org no longer lists a playable video file for this item.');
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${selected.name.split('/').map(encodeURIComponent).join('/')}`;
}

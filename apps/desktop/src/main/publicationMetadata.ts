import type { FileHandle } from 'node:fs/promises';
import { publicationEntries, publicationEntry, type ArchiveEntry } from './publicationArchive.ts';

const MAX_XML_BYTES = 1024 * 1024;
const MAX_METADATA_TEXT = 2048;

type PublicationMetadata = {
  title?: string;
  creator?: string;
  collection?: string;
  track?: number;
};

function localName(name: string): string {
  const separator = name.lastIndexOf(':');
  return (separator >= 0 ? name.slice(separator + 1) : name).toLowerCase();
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'nbsp') return '\u00a0';

    const codePoint = normalized.startsWith('#x')
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return match;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

function cleanXmlText(value: string): string | undefined {
  const text = decodeXmlEntities(value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\?[^>]*\?>/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_METADATA_TEXT);
  return text || undefined;
}

function maskXmlNoise(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[^>]*\?>/g, (token) => token.replace(/[^\r\n]/g, ' '));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findOpenTag(xml: string, names: readonly string[], start = 0): { name: string; tag: string; index: number } | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const scanXml = maskXmlNoise(xml);
  const tagPattern = /<([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\/?\s*>/g;
  tagPattern.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(scanXml))) {
    if (wanted.has(localName(match[1]))) {
      return { name: match[1], tag: xml.slice(match.index, match.index + match[0].length), index: match.index };
    }
  }
  return undefined;
}

function findElementText(xml: string, names: readonly string[]): string | undefined {
  const opening = findOpenTag(xml, names);
  if (!opening) return undefined;
  if (/\/\s*>$/.test(opening.tag)) return undefined;

  const scanXml = maskXmlNoise(xml);
  const elementPattern = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\/?\s*>/g;
  elementPattern.lastIndex = opening.index + opening.tag.length;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = elementPattern.exec(scanXml))) {
    const token = match[0];
    const closing = token.startsWith('</');
    const selfClosing = /\/\s*>$/.test(token);
    if (closing) {
      if (localName(match[1]) === localName(opening.name) && depth === 1) {
        return cleanXmlText(xml.slice(opening.index + opening.tag.length, match.index));
      }
      if (depth > 1) depth -= 1;
    } else if (!selfClosing) {
      depth += 1;
    }
  }
  return undefined;
}

function attributeValue(tag: string, attributeName: string): string | undefined {
  const pattern = new RegExp(`\\b${escapeRegExp(attributeName)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  return pattern.exec(tag)?.[2];
}

function normalizeArchivePath(value: string): string | undefined {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return undefined;
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return undefined;
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : undefined;
}

function findArchiveEntry(entries: readonly ArchiveEntry[], name: string): ArchiveEntry | undefined {
  const normalized = normalizeArchivePath(name)?.toLowerCase();
  if (!normalized) return undefined;
  return entries.find((entry) => normalizeArchivePath(entry.name)?.toLowerCase() === normalized);
}

async function readXmlEntry(file: FileHandle, entries: readonly ArchiveEntry[], name: string): Promise<string | undefined> {
  const entry = findArchiveEntry(entries, name);
  if (!entry || entry.size > MAX_XML_BYTES) return undefined;
  const bytes = await publicationEntry(file, entry);
  if (bytes.length > MAX_XML_BYTES) return undefined;
  return decodeXmlBytes(bytes);
}

function decodeXmlBytes(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const content = bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2));
    const swapped = Buffer.allocUnsafe(content.length);
    for (let index = 0; index < content.length; index += 2) {
      swapped[index] = content[index + 1];
      swapped[index + 1] = content[index];
    }
    return swapped.toString('utf16le');
  }
  return bytes.toString('utf8');
}

function epubMetadata(opfXml: string): PublicationMetadata {
  const title = findElementText(opfXml, ['title']);
  const creator = findElementText(opfXml, ['creator']);
  return {
    ...(title ? { title } : {}),
    ...(creator ? { creator } : {}),
  };
}

function findEpubRootfilePath(containerXml: string): string | undefined {
  let start = 0;
  let fallback: string | undefined;
  while (true) {
    const rootfile = findOpenTag(containerXml, ['rootfile'], start);
    if (!rootfile) return fallback;
    const fullPath = attributeValue(rootfile.tag, 'full-path');
    const mediaType = attributeValue(rootfile.tag, 'media-type')?.toLowerCase();
    if (fullPath && !fallback && /\.opf$/i.test(fullPath)) fallback = fullPath;
    if (fullPath && (mediaType === 'application/oebps-package+xml' || /\.opf$/i.test(fullPath))) return fullPath;
    start = rootfile.index + rootfile.tag.length;
  }
}

function comicInfoMetadata(xml: string): PublicationMetadata {
  const title = findElementText(xml, ['title']);
  const creator = findElementText(xml, ['writer']);
  const collection = findElementText(xml, ['series']);
  const numberText = findElementText(xml, ['number']);
  const parsedTrack = numberText ? Number.parseFloat(numberText) : Number.NaN;
  const track = Number.isFinite(parsedTrack) ? parsedTrack : undefined;
  return {
    ...(title ? { title } : {}),
    ...(creator ? { creator } : {}),
    ...(collection ? { collection } : {}),
    ...(track === undefined ? {} : { track }),
  };
}

export async function readPublicationMetadata(file: FileHandle, extension: string): Promise<PublicationMetadata> {
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension !== '.epub' && normalizedExtension !== '.cbz') return {};

  try {
    const entries = await publicationEntries(file);
    if (normalizedExtension === '.cbz') {
      const comicInfo = entries.find((entry) => {
        const name = normalizeArchivePath(entry.name)?.toLowerCase() || '';
        return name === 'comicinfo.xml' || name.endsWith('/comicinfo.xml');
      });
      if (!comicInfo || comicInfo.size > MAX_XML_BYTES) return {};
      return comicInfoMetadata(decodeXmlBytes(await publicationEntry(file, comicInfo)));
    }

    const containerXml = await readXmlEntry(file, entries, 'META-INF/container.xml');
    if (!containerXml) return {};
    const rootfilePath = findEpubRootfilePath(containerXml);
    if (!rootfilePath) return {};
    const opfPath = normalizeArchivePath(rootfilePath);
    if (!opfPath) return {};
    const opfXml = await readXmlEntry(file, entries, opfPath);
    if (!opfXml) return {};
    return epubMetadata(opfXml);
  } catch {
    return {};
  }
}

export function appendQueryToHlsPlaylist(content: string, queryString: string): string {
  if (!queryString) return content;

  return content
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      if (/^[a-z]+:\/\//i.test(trimmed)) return line;
      const separator = trimmed.includes('?') ? '&' : '?';
      return `${line}${separator}${queryString}`;
    })
    .join('\n');
}

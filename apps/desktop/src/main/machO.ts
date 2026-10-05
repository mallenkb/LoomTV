const MACH_O_CPU_TYPES: Record<number, string> = { 0x0100000c: 'arm64', 0x01000007: 'x64' };

/**
 * CPU architectures in a Mach-O or universal binary header. Reading the header
 * replaces a synchronous `file` child process on the Electron main thread.
 */
export function machOArchitectures(header: Buffer): string[] | null {
  if (header.length < 8) return null;
  if (header.readUInt32LE(0) === 0xfeedfacf || header.readUInt32LE(0) === 0xfeedface) {
    const arch = MACH_O_CPU_TYPES[header.readInt32LE(4)];
    return arch ? [arch] : [];
  }
  const fatMagic = header.readUInt32BE(0);
  if (fatMagic !== 0xcafebabe && fatMagic !== 0xcafebabf) return null;
  const entrySize = fatMagic === 0xcafebabf ? 32 : 20;
  const count = header.readUInt32BE(4);
  // Java class files share 0xcafebabe; their "count" is a large version number.
  if (count === 0 || count > 16) return null;
  const architectures: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * entrySize;
    if (offset + 4 > header.length) break;
    const arch = MACH_O_CPU_TYPES[header.readInt32BE(offset)];
    if (arch) architectures.push(arch);
  }
  return architectures;
}

import type { FileHandle } from 'node:fs/promises';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(inflateRaw);

export type ArchiveEntry = { name: string; offset: number; compressed: number; size: number; method: number };
async function read(file: FileHandle, offset: number, length: number) {
  const bytes=Buffer.alloc(length);
  const result=await file.read(bytes,0,length,offset);
  if (result.bytesRead!==length) throw new Error('The publication archive is incomplete.');
  return bytes;
}

/** Read ZIP entries without extracting files to disk. ZIP64/encrypted archives are rejected. */
export async function publicationEntries(file: FileHandle): Promise<ArchiveEntry[]> {
  const stat=await file.stat();
  if (stat.size>1024*1024*1024 || stat.size<22) throw new Error('This publication exceeds the archive limits.');
  const tail=await read(file,Math.max(0,stat.size-65557),Math.min(stat.size,65557));
  let end=-1;
  for(let index=tail.length-22;index>=0;index--) {
    if(tail.readUInt32LE(index)===0x06054b50 && index+22+tail.readUInt16LE(index+20)===tail.length) { end=index;break; }
  }
  if(end<0) throw new Error('This publication is not a supported ZIP archive.');
  const count=tail.readUInt16LE(end+10),size=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
  if(tail.readUInt16LE(end+4)!==0 || tail.readUInt16LE(end+6)!==0 || count>10000 || size>16*1024*1024 || offset+size>stat.size) throw new Error('This publication exceeds the archive limits.');
  const directory=await read(file,offset,size);
  const entries: ArchiveEntry[]=[]; const names=new Set<string>(); let cursor=0,total=0;
  for(let index=0;index<count;index++) {
    if(cursor+46>directory.length || directory.readUInt32LE(cursor)!==0x02014b50) throw new Error('Invalid archive directory.');
    const flags=directory.readUInt16LE(cursor+8),method=directory.readUInt16LE(cursor+10);
    const compressed=directory.readUInt32LE(cursor+20),expanded=directory.readUInt32LE(cursor+24);
    const nameLength=directory.readUInt16LE(cursor+28),extra=directory.readUInt16LE(cursor+30),comment=directory.readUInt16LE(cursor+32);
    const entryOffset=directory.readUInt32LE(cursor+42);
    if(cursor+46+nameLength+extra+comment>directory.length) throw new Error('Invalid archive entry.');
    const name=directory.subarray(cursor+46,cursor+46+nameLength).toString('utf8'); cursor+=46+nameLength+extra+comment;
    if(name.endsWith('/')) continue;
    total+=expanded;
    if(flags&1 || ![0,8].includes(method) || expanded>32*1024*1024 || compressed>32*1024*1024 || total>512*1024*1024 || entryOffset+30+compressed>stat.size || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || name.includes('\0') || names.has(name)) throw new Error('This publication contains an unsupported archive entry.');
    names.add(name);entries.push({name,offset:entryOffset,compressed,size:expanded,method});
  }
  return entries;
}

export async function publicationEntry(file: FileHandle, entry: ArchiveEntry): Promise<Buffer> {
  const header=await read(file,entry.offset,30);
  if(header.readUInt32LE(0)!==0x04034b50 || header.readUInt16LE(6)&1 || header.readUInt16LE(8)!==entry.method) throw new Error('Invalid archive entry header.');
  const start=entry.offset+30+header.readUInt16LE(26)+header.readUInt16LE(28);
  const localName=await read(file,entry.offset+30,header.readUInt16LE(26));
  if(localName.toString('utf8')!==entry.name || (!(header.readUInt16LE(6)&8) && (header.readUInt32LE(18)!==entry.compressed || header.readUInt32LE(22)!==entry.size))) throw new Error('The archive entry does not match its directory.');
  if(start+entry.compressed>(await file.stat()).size) throw new Error('The archive entry is incomplete.');
  const compressed=await read(file,start,entry.compressed);
  const bytes=entry.method===0 ? compressed : await inflate(compressed,{maxOutputLength:32*1024*1024});
  if(bytes.length!==entry.size) throw new Error('The publication entry size is invalid.');
  return bytes;
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inventoryIdentity } from './importInventory.ts';

export type FileTransfer = {
  from: string;
  to: string;
  sourceIdentity: string;
  sourceStamp: string;
  staging: string;
  publishedIdentity?: string;
  digest?: string;
  phase: 'planned' | 'copied' | 'published' | 'moved';
};

export function fileStamp(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only ordinary files can be moved by cleanup.');
  return `${inventoryIdentity(file)}:${stat.size}:${stat.mtimeMs}`;
}

function digest(file: string): string {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count: number;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

export function planFileTransfer(from: string, to: string): FileTransfer {
  return { from, to, sourceIdentity: inventoryIdentity(from) || '', sourceStamp: fileStamp(from), staging: path.join(path.dirname(to), `.loom-transfer-${randomUUID()}`), phase: 'planned' };
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** Each state is saved before the next destructive step. Link never overwrites. */
export function resumeFileTransfer(transfer: FileTransfer, persist: () => void): void {
  fs.mkdirSync(path.dirname(transfer.to), { recursive: true });
  const source = inventoryIdentity(transfer.from);
  const destination = inventoryIdentity(transfer.to);
  if (transfer.phase === 'moved') {
    if (destination !== transfer.publishedIdentity) throw new Error('The moved file is missing or has been replaced.');
    if (inventoryIdentity(transfer.staging) === transfer.publishedIdentity) fs.unlinkSync(transfer.staging);
    return;
  }
  if (!source) {
    if (destination && destination === transfer.publishedIdentity) {
      transfer.phase = 'moved';
      persist();
      if (inventoryIdentity(transfer.staging) === transfer.publishedIdentity) fs.unlinkSync(transfer.staging);
      return;
    }
    throw new Error('The transfer source is missing. Its recovery record has been kept.');
  }
  if (source !== transfer.sourceIdentity || fileStamp(transfer.from) !== transfer.sourceStamp) throw new Error('The source changed after it was recorded.');
  if (destination && destination !== transfer.publishedIdentity) throw new Error('The destination is occupied.');
  const sameDrive = fs.statSync(transfer.from).dev === fs.statSync(path.dirname(transfer.to)).dev;
  if (transfer.phase === 'planned') {
    if (sameDrive) {
      transfer.publishedIdentity = transfer.sourceIdentity;
    } else {
      // An interrupted unverified copy is disposable, but only at our unique staging path.
      if (fs.existsSync(transfer.staging)) fs.unlinkSync(transfer.staging);
      fs.copyFileSync(transfer.from, transfer.staging, fs.constants.COPYFILE_EXCL);
      const descriptor = fs.openSync(transfer.staging, 'r+');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      const sourceDigest = digest(transfer.from);
      if (fileStamp(transfer.from) !== transfer.sourceStamp || digest(transfer.staging) !== sourceDigest) throw new Error('The cross-drive copy did not verify. The source was kept.');
      transfer.digest = sourceDigest;
      transfer.publishedIdentity = inventoryIdentity(transfer.staging) || '';
    }
    transfer.phase = 'copied';
    persist();
  }
  if (!inventoryIdentity(transfer.to)) {
    fs.linkSync(sameDrive ? transfer.from : transfer.staging, transfer.to);
  }
  if (inventoryIdentity(transfer.to) !== transfer.publishedIdentity) throw new Error('The transfer destination changed.');
  syncDirectory(path.dirname(transfer.to));
  transfer.phase = 'published';
  persist();
  if (fileStamp(transfer.from) !== transfer.sourceStamp) throw new Error('The source changed during the move. Both copies were kept.');
  if (transfer.digest && (digest(transfer.to) !== transfer.digest || digest(transfer.from) !== transfer.digest)) throw new Error('Copy verification failed. Both copies were kept.');
  fs.unlinkSync(transfer.from);
  syncDirectory(path.dirname(transfer.from));
  transfer.phase = 'moved';
  persist();
  if (inventoryIdentity(transfer.staging) === transfer.publishedIdentity) fs.unlinkSync(transfer.staging);
}

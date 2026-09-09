import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getMediaLibraryDatabase } from './database.ts';
import { requireOwner, getDesktopActiveProfileState } from './profileService.ts';
import { findFFprobe } from './mediaBinaries.ts';
import { publicationEntries, publicationEntry } from './publicationArchive.ts';
import { readPublicationMetadata } from './publicationMetadata.ts';
import { MEDIA_LIBRARY_KINDS, type MediaLibraryKind, type MediaLibrariesApi, type MediaLibraryItem, type MediaLibraryRoot } from '../shared/mediaLibraries.ts';

const execFileAsync = promisify(execFile);
const audioExtensions = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.alac', '.wma'];
const extensions: Record<MediaLibraryKind, Set<string>> = {
  music: new Set(audioExtensions), audiobooks: new Set([...audioExtensions, '.m4b']),
  books: new Set(['.epub', '.pdf']), comics: new Set(['.cbz', '.pdf']),
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
type Root = { id: string; path: string; name: string; scannedAt: number | null; message: string | null; count: number };
type StoredItem = MediaLibraryItem & { size: number; modifiedAt: number };
type Job = { cancelled: boolean; discovered: number };

export function createMediaLibrariesService(chooseFolder: () => Promise<string | null>): MediaLibrariesApi & { response: (request: Request) => Promise<Response> } {
  const jobs = new Map<string, Job>();
  const database = () => getMediaLibraryDatabase();
  const session = () => `${requireOwner().id}:${getDesktopActiveProfileState().selectionRevision}`;
  const checkSession = (expected: string) => { if (session() !== expected) throw new Error('The active profile changed.'); };
  const checkKind = (kind: MediaLibraryKind) => { if (!MEDIA_LIBRARY_KINDS.includes(kind)) throw new Error('Unknown media library.'); };
  const roots = (kind: MediaLibraryKind): MediaLibraryRoot[] => {
    checkKind(kind); requireOwner();
    const rows = database().prepare(`SELECT r.id,r.path,r.name,r.scanned_at AS scannedAt,r.message,
      (SELECT count(*) FROM ${kind}_items i WHERE i.root_id=r.id) AS count FROM ${kind}_roots r ORDER BY r.name COLLATE NOCASE`).all() as Root[];
    return rows.map((root) => ({ ...root, scanning: jobs.has(root.id), discovered: jobs.get(root.id)?.discovered ?? root.count }));
  };
  const item = (kind: MediaLibraryKind, id: string) => database().prepare(`SELECT i.*,r.path AS rootPath
    FROM ${kind}_items i JOIN ${kind}_roots r ON r.id=i.root_id WHERE i.id=?`).get(id) as
    { rootPath: string; relative_path: string; extension: string; size: number; modified_at: number } | undefined;

  async function scan(kind: MediaLibraryKind, root: Root, job: Job) {
    const found: StoredItem[] = [];
    let directories=0;
    const guard = () => {
      if (job.cancelled) throw new Error('Scan cancelled. The previous catalog was kept.');
      if (found.length >= 100_000) throw new Error('Add smaller folders. This library exceeds the scan limit.');
    };
    async function walk(folder: string, depth: number) {
      guard();
      if (++directories>50_000) throw new Error('Add smaller folders. This library has too many directories.');
      if (depth > 64) throw new Error('The folder structure is too deep.');
      const resolved = await fs.realpath(folder);
      if (resolved !== root.path && !inside(root.path, resolved)) throw new Error('A folder points outside this library.');
      for await (const entry of await fs.opendir(folder)) {
        guard();
        if (entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
        const extension = path.extname(entry.name).toLowerCase();
        if (!entry.isFile() || !extensions[kind].has(extension)) continue;
        const stat = await fs.lstat(file);
        if (!stat.isFile()) continue;
        const relativePath = path.relative(root.path, file).split(path.sep).join('/');
        const record: StoredItem = { id: hash(`${kind}\0${root.id}\0${relativePath}`), rootId: root.id,
          title: path.basename(entry.name, extension), relativePath, extension, creator: '',
          collection: path.basename(folder), track: 0, duration: 0, chapters: [], position: 0,
          completed: false, size: stat.size, modifiedAt: stat.mtimeMs };
        if (kind === 'music' || kind === 'audiobooks') {
          const probe = findFFprobe();
          if (!probe) throw new Error('FFprobe is required to scan audio metadata.');
          const real = await fs.realpath(file);
          if (!inside(root.path, real)) throw new Error('An audio file points outside this library.');
          const { stdout } = await execFileAsync(probe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_chapters', '-of', 'json', real], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
          const metadata = JSON.parse(stdout);
          const tags = Object.fromEntries(Object.entries(metadata.format?.tags ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
          record.title = tags.title || record.title;
          record.creator = tags.album_artist || tags.artist || tags.author || '';
          record.collection = tags.album || record.collection;
          if (kind === 'music') {
            record.track = Number.parseInt(tags.track || '0', 10) || 0;
            record.disc = Number.parseInt(tags.disc || '1', 10) || 1;
          }
          record.duration = Math.max(0, Number(metadata.format?.duration) || 0);
          record.chapters = (metadata.chapters ?? []).slice(0, 5000).map((chapter: { start_time?: string; tags?: { title?: string } }, index: number) => ({ title: chapter.tags?.title || `Chapter ${index + 1}`, start: Math.max(0, Number(chapter.start_time) || 0) }));
        }
        if (extension === '.epub' || extension === '.cbz') {
          const real = await fs.realpath(file);
          if (!inside(root.path, real)) throw new Error('A publication points outside this library.');
          const publication = await fs.open(real, 'r');
          try { Object.assign(record, await readPublicationMetadata(publication, extension)); }
          finally { await publication.close(); }
        }
        found.push(record); job.discovered = found.length;
      }
    }
    try {
      if (await fs.realpath(root.path) !== root.path) throw new Error('The library location changed. Add it again.');
      await walk(root.path, 0); guard(); await fs.access(root.path);
      database().transaction(() => {
        if (!database().prepare(`SELECT id FROM ${kind}_roots WHERE id=?`).get(root.id)) return;
        const upsert = database().prepare(`INSERT INTO ${kind}_items(id,root_id,relative_path,title,extension,creator,collection,track,disc,duration,chapters_json,size,modified_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,creator=excluded.creator,collection=excluded.collection,
          track=excluded.track,disc=excluded.disc,duration=excluded.duration,chapters_json=excluded.chapters_json,size=excluded.size,modified_at=excluded.modified_at`);
        const remaining = new Set(found.map((record) => record.id));
        for (const record of found) upsert.run(record.id,root.id,record.relativePath,record.title,record.extension,record.creator,record.collection,record.track,record.disc || 0,record.duration,JSON.stringify(record.chapters),record.size,record.modifiedAt);
        const old = database().prepare(`SELECT id FROM ${kind}_items WHERE root_id=?`).all(root.id) as Array<{ id: string }>;
        const remove = database().prepare(`DELETE FROM ${kind}_items WHERE id=?`);
        for (const record of old) if (!remaining.has(record.id)) remove.run(record.id);
        database().prepare(`UPDATE ${kind}_roots SET scanned_at=?,message=NULL WHERE id=?`).run(Date.now(),root.id);
      })();
    } catch (error) {
      database().prepare(`UPDATE ${kind}_roots SET message=? WHERE id=?`).run(error instanceof Error ? error.message : 'Scan failed. The previous catalog was kept.',root.id);
    } finally { jobs.delete(root.id); }
  }

  return {
    roots: async (kind) => roots(kind),
    async add(kind, folderPath) {
      checkKind(kind); const expected = session();
      const selected = folderPath || await chooseFolder(); checkSession(expected);
      if (!selected) return null;
      const folder = await fs.realpath(selected);
      if (!(await fs.stat(folder)).isDirectory()) throw new Error('Choose a folder.');
      checkSession(expected);
      database().prepare(`INSERT OR IGNORE INTO ${kind}_roots(id,path,name) VALUES(?,?,?)`).run(randomUUID(),folder,path.basename(folder) || folder);
      return roots(kind).find((root) => root.path === folder) ?? null;
    },
    async remove(kind, rootId) {
      checkKind(kind); requireOwner();
      if (jobs.has(rootId)) throw new Error('Cancel the scan before removing this folder.');
      database().prepare(`DELETE FROM ${kind}_roots WHERE id=?`).run(rootId);
    },
    async scan(kind, rootId) {
      const root = roots(kind).find((entry) => entry.id === rootId);
      if (!root) throw new Error('Library folder not found.');
      if (jobs.size) throw new Error('Wait for the current media scan to finish.');
      const job = { cancelled: false, discovered: 0 }; jobs.set(rootId,job);
      void scan(kind,root,job);
    },
    async cancel(kind, rootId) { roots(kind); const job = jobs.get(rootId); if (job) job.cancelled = true; },
    async browse(kind, request) {
      checkKind(kind); const owner = requireOwner();
      const query = `%${(request.query || '').replace(/[\\%_]/g, '\\$&')}%`;
      const root = request.rootId || null;
      const where = `(? IS NULL OR i.root_id=?) AND (i.title LIKE ? ESCAPE '\\' OR i.creator LIKE ? ESCAPE '\\' OR i.collection LIKE ? ESCAPE '\\')${request.inProgress ? ' AND p.position>0 AND p.completed=0' : ''}`;
      const rows = database().prepare(`SELECT i.id,i.root_id AS rootId,i.relative_path AS relativePath,i.title,i.extension,i.creator,i.collection,i.track,i.disc,i.duration,
        i.chapters_json AS chaptersJson,coalesce(p.position,0) AS position,coalesce(p.completed,0) AS completed
        FROM ${kind}_items i LEFT JOIN ${kind}_progress p ON p.item_id=i.id AND p.profile_id=? WHERE ${where}
        ORDER BY i.collection COLLATE NOCASE,i.disc,i.track,i.title COLLATE NOCASE,i.id LIMIT 80 OFFSET ?`).all(owner.id,root,root,query,query,query,request.offset || 0) as Array<MediaLibraryItem & { chaptersJson: string }>;
      const total = (database().prepare(`SELECT count(*) AS n FROM ${kind}_items i LEFT JOIN ${kind}_progress p ON p.item_id=i.id AND p.profile_id=? WHERE ${where}`).get(owner.id,root,root,query,query,query) as { n: number }).n;
      return { items: rows.map(({ chaptersJson,...record }) => ({ ...record,completed: Boolean(record.completed),chapters: JSON.parse(chaptersJson) })),total,offset: request.offset || 0,pageSize: 80 };
    },
    async open(kind, id) {
      checkKind(kind); const expected = session();
      if (!item(kind,id)) throw new Error('Media item not found.');
      return `loomtv://media-libraries/${kind}/${id}?session=${encodeURIComponent(expected)}`;
    },
    async publication(kind,id) {
      checkKind(kind); const expected=session();
      const record=item(kind,id);
      if (!record || !['.epub','.cbz'].includes(record.extension)) throw new Error('This item is not an EPUB or comic archive.');
      const real=await fs.realpath(path.join(record.rootPath,...record.relative_path.split('/')));
      if(!inside(record.rootPath,real)) throw new Error('Publication outside library.');
      const file=await fs.open(real,'r');
      try {
        const entries=await publicationEntries(file);checkSession(expected);
        return {entries:entries.map((entry,index)=>({name:entry.name,url:`loomtv://media-libraries/${kind}/${id}/archive/${index}?session=${encodeURIComponent(expected)}`}))};
      } finally { await file.close(); }
    },
    async progress(kind,id,position,completed) {
      checkKind(kind); const owner = requireOwner();
      if (!item(kind,id)) throw new Error('Media item not found.');
      database().prepare(`INSERT INTO ${kind}_progress(profile_id,item_id,position,completed,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(profile_id,item_id) DO UPDATE SET position=excluded.position,completed=excluded.completed,updated_at=excluded.updated_at`).run(owner.id,id,position,Number(completed),Date.now());
    },
    async response(request) {
      try {
        const url = new URL(request.url); const expected = url.searchParams.get('session') || ''; checkSession(expected);
        const match = /^\/(music|audiobooks|books|comics)\/([a-f0-9]{64})(?:\/archive\/(\d+))?$/.exec(url.pathname);
        if (!match || !['GET','HEAD'].includes(request.method)) return new Response(null,{ status:404 });
        const record = item(match[1] as MediaLibraryKind,match[2]);
        if (!record) return new Response(null,{ status:404 });
        const real = await fs.realpath(path.join(record.rootPath,...record.relative_path.split('/')));
        if (!inside(record.rootPath,real)) throw new Error('Media outside library.');
        const file = await fs.open(real,'r');
        let streaming = false;
        try {
          const stat = await file.stat(); checkSession(expected);
          if(!item(match[1] as MediaLibraryKind,match[2])) return new Response(null,{status:404});
          const currentPath = await fs.realpath(path.join(record.rootPath,...record.relative_path.split('/')));
          const currentStat = await fs.stat(currentPath);
          if (!stat.isFile() || !inside(record.rootPath,currentPath) || currentStat.ino !== stat.ino || currentStat.dev !== stat.dev) throw new Error('Media changed while opening.');
          if(match[3]!==undefined) {
            if(!['.epub','.cbz'].includes(record.extension)) return new Response(null,{status:404});
            const entries=await publicationEntries(file),entry=entries[Number(match[3])];
            if(!entry) return new Response(null,{status:404});
            const types: Record<string,string>={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.xml':'application/xml','.opf':'application/xml','.ncx':'application/xml','.xhtml':'application/xhtml+xml','.html':'text/html','.css':'text/css'};
            const headers={'Content-Type':types[path.extname(entry.name).toLowerCase()] || 'application/octet-stream','Content-Length':String(entry.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"};
            if(request.method==='HEAD') return new Response(null,{headers});
            const data=await publicationEntry(file,entry);checkSession(expected);
            return new Response(new Uint8Array(data),{headers});
          }
          const types: Record<string,string> = { '.mp3':'audio/mpeg','.flac':'audio/flac','.m4a':'audio/mp4','.m4b':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.opus':'audio/ogg','.wav':'audio/wav','.pdf':'application/pdf','.epub':'application/epub+zip','.cbz':'application/vnd.comicbook+zip' };
          const headers = new Headers({ 'Content-Type':types[record.extension] || 'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' });
          let start=0,end=stat.size-1,status=200;
          const range=request.headers.get('range');
          if (range) {
            const parsed=/^bytes=(\d*)-(\d*)$/.exec(range);
            if (!parsed || (!parsed[1] && !parsed[2])) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${stat.size}`}});
            if (!parsed[1]) start=Math.max(0,stat.size-Number(parsed[2]));
            else { start=Number(parsed[1]); end=parsed[2] ? Math.min(Number(parsed[2]),end) : end; }
            status=206;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start>=stat.size) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${stat.size}`}});
            headers.set('Content-Range',`bytes ${start}-${end}/${stat.size}`);
          }
          const length=Math.max(0,end-start+1); headers.set('Content-Length',String(length));
          if (request.method==='HEAD' || length===0) return new Response(null,{status,headers});
          let cursor = start;
          let closed = false;
          const close = async () => { if (!closed) { closed=true; await file.close(); } };
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                checkSession(expected);
                if(!item(match[1] as MediaLibraryKind,match[2])) throw new Error('The media item was removed.');
                if (cursor>end) { controller.close(); await close(); return; }
                const chunk=Buffer.alloc(Math.min(256*1024,end-cursor+1));
                const result=await file.read(chunk,0,chunk.length,cursor);
                if (!result.bytesRead) { controller.close(); await close(); return; }
                cursor+=result.bytesRead;
                controller.enqueue(new Uint8Array(chunk.subarray(0,result.bytesRead)));
              } catch (error) { controller.error(error); await close(); }
            },
            cancel: close,
          });
          streaming=true;
          return new Response(body,{status,headers});
        } finally { if (!streaming) await file.close(); }
      } catch { return new Response(null,{status:403}); }
    },
  };
}

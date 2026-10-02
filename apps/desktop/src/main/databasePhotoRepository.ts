import type BetterSqlite3 from 'better-sqlite3';
import type { PhotoBrowseRequest } from '../shared/photoLibrary.ts';

export type PhotoRootRecord = { id: string; path: string; name: string; state: 'available' | 'unavailable'; scannedAt: number | null; message: string | null; count: number };
export type PhotoRecord = { id: string; rootId: string; relativePath: string; parent: string; name: string; size: number; modifiedAt: number };
export type PhotoDirectory = { relativePath: string; parent: string; name: string };
export type PhotoBrowseRow = { id: string; rootId: string; kind: 'folder' | 'photo'; name: string; relativePath: string; modifiedAt: number; coverId: string | null };

export function createPhotoRepository(db: BetterSqlite3.Database) {
  const roots = () => db.prepare(`SELECT r.id, r.path, r.name, r.state, r.scanned_at AS scannedAt, r.message,
    (SELECT count(*) FROM photo_items p WHERE p.root_id=r.id) AS count FROM photo_roots r ORDER BY r.name COLLATE NOCASE`).all() as PhotoRootRecord[];
  return {
    roots,
    root: (id: string) => roots().find((root) => root.id === id),
    add(id: string, folder: string, name: string) {
      db.prepare('INSERT OR IGNORE INTO photo_roots(id,path,name) VALUES(?,?,?)').run(id, folder, name);
      const root = roots().find((entry) => entry.path === folder);
      if (!root) throw new Error('The photo folder could not be saved.');
      return root;
    },
    remove(id: string) { db.prepare('DELETE FROM photo_roots WHERE id=?').run(id); },
    markUnavailable(id: string, message: string) {
      db.prepare("UPDATE photo_roots SET state='unavailable',message=? WHERE id=?").run(message, id);
    },
    commitScan(rootId: string, photos: PhotoRecord[], directories: PhotoDirectory[]) {
      db.transaction(() => {
        if (!db.prepare('SELECT id FROM photo_roots WHERE id=?').get(rootId)) return;
        db.prepare('DELETE FROM photo_items WHERE root_id=?').run(rootId);
        db.prepare('DELETE FROM photo_directories WHERE root_id=?').run(rootId);
        const insertPhoto = db.prepare('INSERT INTO photo_items(id,root_id,relative_path,parent,name,size,modified_at) VALUES(?,?,?,?,?,?,?)');
        const insertDirectory = db.prepare('INSERT INTO photo_directories(root_id,relative_path,parent,name) VALUES(?,?,?,?)');
        for (const photo of photos) insertPhoto.run(photo.id, rootId, photo.relativePath, photo.parent, photo.name, photo.size, photo.modifiedAt);
        for (const folder of directories) insertDirectory.run(rootId, folder.relativePath, folder.parent, folder.name);
        db.prepare("UPDATE photo_roots SET state='available',message=NULL,scanned_at=? WHERE id=?").run(Date.now(), rootId);
      })();
    },
    photo(id: string) {
      return db.prepare('SELECT id,root_id AS rootId,relative_path AS relativePath,parent,name,size,modified_at AS modifiedAt FROM photo_items WHERE id=?').get(id) as PhotoRecord | undefined;
    },
    browse(request: PhotoBrowseRequest) {
      const offset = request.offset || 0;
      const rootId = request.rootId || null;
      if (request.folder === null) {
        const rows = db.prepare(`SELECT id,root_id AS rootId,'photo' AS kind,name,relative_path AS relativePath,
          modified_at AS modifiedAt,id AS coverId FROM photo_items
          WHERE (? IS NULL OR root_id=?) ORDER BY modifiedAt DESC,name COLLATE NOCASE,id LIMIT 80 OFFSET ?`)
          .all(rootId, rootId, offset);
        const total = (db.prepare('SELECT count(*) AS total FROM photo_items WHERE (? IS NULL OR root_id=?)').get(rootId, rootId) as { total: number }).total;
        return { rows: rows as PhotoBrowseRow[], total, offset, pageSize: 80 };
      }

      const folder = request.folder;
      const rows = db.prepare(`SELECT id,root_id AS rootId,'photo' AS kind,name,relative_path AS relativePath,
        modified_at AS modifiedAt,id AS coverId FROM photo_items WHERE root_id=? AND parent=?
        UNION ALL
        SELECT root_id || ':' || relative_path AS id,root_id AS rootId,'folder' AS kind,name,relative_path AS relativePath,
          0 AS modifiedAt,
          (SELECT p.id FROM photo_items p
            WHERE p.root_id=d.root_id AND instr(p.parent || '/', d.relative_path || '/')=1
            ORDER BY p.modified_at DESC,p.name COLLATE NOCASE LIMIT 1) AS coverId
        FROM photo_directories d WHERE d.root_id=? AND d.parent=?
        ORDER BY kind, name COLLATE NOCASE, modifiedAt DESC, id LIMIT 80 OFFSET ?`)
        .all(rootId, folder, rootId, folder, offset);
      const total = (db.prepare(`SELECT count(*) AS total FROM (
        SELECT id FROM photo_items WHERE root_id=? AND parent=?
        UNION ALL SELECT relative_path FROM photo_directories WHERE root_id=? AND parent=?
      )`).get(rootId, folder, rootId, folder) as { total: number }).total;
      return { rows: rows as PhotoBrowseRow[], total, offset, pageSize: 80 };
    },
  };
}

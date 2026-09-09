export const MEDIA_LIBRARY_KINDS = ['music', 'audiobooks', 'books', 'comics'] as const;
export type MediaLibraryKind = typeof MEDIA_LIBRARY_KINDS[number];
export type MediaLibraryRoot = { id: string; name: string; path: string; count: number; scanning: boolean; discovered: number; message: string | null; scannedAt: number | null };
export type MediaLibraryItem = {
  id: string; rootId: string; title: string; relativePath: string; extension: string;
  creator: string; collection: string; track: number; duration: number;
  disc?: number;
  chapters: Array<{ title: string; start: number }>;
  position: number; completed: boolean;
};
export type MediaLibraryPage = { items: MediaLibraryItem[]; total: number; offset: number; pageSize: number };
export type MediaLibrariesApi = {
  roots: (kind: MediaLibraryKind) => Promise<MediaLibraryRoot[]>;
  add: (kind: MediaLibraryKind, folderPath?: string) => Promise<MediaLibraryRoot | null>;
  remove: (kind: MediaLibraryKind, rootId: string) => Promise<void>;
  scan: (kind: MediaLibraryKind, rootId: string) => Promise<void>;
  cancel: (kind: MediaLibraryKind, rootId: string) => Promise<void>;
  browse: (kind: MediaLibraryKind, request: { query?: string; offset?: number; rootId?: string; inProgress?: boolean }) => Promise<MediaLibraryPage>;
  open: (kind: MediaLibraryKind, itemId: string) => Promise<string>;
  publication: (kind: MediaLibraryKind, itemId: string) => Promise<{ entries: Array<{ name: string; url: string }> }>;
  progress: (kind: MediaLibraryKind, itemId: string, position: number, completed: boolean) => Promise<void>;
};

export type PhotoRoot = {
  id: string;
  name: string;
  path: string;
  state: 'available' | 'unavailable';
  scannedAt: number | null;
  count: number;
  scanning: boolean;
  discovered: number;
  message: string | null;
};

export type PhotoBrowseRequest = {
  rootId?: string;
  /** null shows all descendants; a string browses one directory. */
  folder: string | null;
  offset?: number;
};

export type PhotoEntry = {
  id: string;
  rootId: string;
  kind: 'folder' | 'photo';
  name: string;
  relativePath: string;
  modifiedAt: number;
  imageUrl: string | null;
};

export type PhotoPage = {
  entries: PhotoEntry[];
  total: number;
  offset: number;
  pageSize: number;
};

export type PhotoLibraryApi = {
  roots: () => Promise<PhotoRoot[]>;
  add: (folderPath?: string) => Promise<PhotoRoot | null>;
  remove: (rootId: string) => Promise<void>;
  scan: (rootId: string) => Promise<void>;
  cancel: (rootId: string) => Promise<void>;
  browse: (request: PhotoBrowseRequest) => Promise<PhotoPage>;
  read: (photoId: string) => Promise<string>;
};

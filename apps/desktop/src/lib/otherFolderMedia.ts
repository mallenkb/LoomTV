type FolderBackedMedia = {
  filePath?: string;
  episodeFiles?: readonly { filePath?: string }[];
};

function normalizePath(value?: string): string {
  return (value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isInsideFolder(filePath: string | undefined, folders: readonly string[]): boolean {
  const normalizedFilePath = normalizePath(filePath);
  if (!normalizedFilePath) return false;

  return folders.some((folder) => {
    const normalizedFolder = normalizePath(folder);
    return normalizedFolder !== '' && (
      normalizedFilePath === normalizedFolder
      || normalizedFilePath.startsWith(`${normalizedFolder}/`)
    );
  });
}

export function excludeOtherFolderMedia<T extends FolderBackedMedia>(
  items: readonly T[],
  otherFolders: readonly string[],
): T[] {
  if (otherFolders.length === 0) return [...items];

  return items.filter((item) => {
    if (isInsideFolder(item.filePath, otherFolders)) return false;
    return !item.episodeFiles?.some((episode) => isInsideFolder(episode.filePath, otherFolders));
  });
}

export function isCategoryVisible(
  folderKey: string | null,
  isRemoteLibrary: boolean,
  folders: readonly unknown[] | undefined,
): boolean {
  return isRemoteLibrary || !folderKey || Boolean(folders?.some((folder) => (
    typeof folder === 'string' && folder.trim().length > 0
  )));
}

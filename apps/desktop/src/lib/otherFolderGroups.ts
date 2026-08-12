import type { OtherFolderGroup } from '@/shared/desktopProtocol';

export type OtherFolderGroups = Record<string, OtherFolderGroup>;

export function normalizeOtherFolderGroups(value: OtherFolderGroups | undefined): OtherFolderGroups {
  return Object.fromEntries(Object.entries(value || {}).flatMap(([id, group]) => {
    const name = group?.name?.trim();
    const folders = Array.from(new Set((group?.folders || []).filter((folder) => typeof folder === 'string' && folder.trim())));
    return name ? [[id, { name, icon: group.icon || 'folder', folders }]] : [];
  }));
}

export function otherFolderGroupForFolder(groups: OtherFolderGroups, folder: string): string {
  return Object.entries(groups).find(([, group]) => group.folders.includes(folder))?.[0] || '';
}

function availableGroupId(groups: OtherFolderGroups, name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  let id = base;
  let suffix = 2;
  while (groups[id]) id = `${base}-${suffix++}`;
  return id;
}

export function createOtherFolderGroup(
  current: OtherFolderGroups,
  name: string,
  icon: string,
): { groups: OtherFolderGroups; groupId: string } {
  const trimmedName = name.trim();
  const groupId = availableGroupId(current, trimmedName);
  return {
    groups: { ...current, [groupId]: { name: trimmedName, icon: icon || 'folder', folders: [] } },
    groupId,
  };
}

export function assignOtherFolderToGroup(
  current: OtherFolderGroups,
  previousFolder: string,
  nextFolder: string,
  options: { groupId?: string; newGroupName?: string; icon: string },
): { groups: OtherFolderGroups; groupId: string } {
  const groups = Object.fromEntries(Object.entries(current).map(([id, group]) => [id, {
    ...group,
    folders: group.folders.filter((folder) => folder !== previousFolder && folder !== nextFolder),
  }]));
  const newGroupName = options.newGroupName?.trim() || '';
  const groupId = newGroupName ? availableGroupId(groups, newGroupName) : options.groupId || '';

  if (groupId) {
    const existing = groups[groupId];
    groups[groupId] = {
      name: newGroupName || existing?.name || 'Others',
      icon: options.icon || existing?.icon || 'folder',
      folders: [...(existing?.folders || []), nextFolder],
    };
  }

  return {
    groups,
    groupId,
  };
}

export type SidebarNavItemId = string;

export type SidebarOrderItem = {
  id: SidebarNavItemId;
  label: string;
};


export const DEFAULT_SIDEBAR_NAV_ORDER: SidebarNavItemId[] = [
  'anime',
  'tv',
  'movies',
  'discover',
  'my-list',
  'divider',
];

export const SIDEBAR_NAV_LABELS: Record<string, string> = {
  anime: 'Anime',
  tv: 'TV Shows',
  movies: 'Movies',
  discover: 'Discover',
  'my-list': 'My List',
  divider: 'Library divider',
};

function uniqueSidebarIds(values: unknown): SidebarNavItemId[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

/**
 * Preserve saved dynamic IDs, then add any built-in destinations introduced by
 * a newer Loom version. When the caller provides the items available now,
 * stale playlist and add-on IDs are hidden without being erased from storage.
 */
export function normalizeSidebarNavOrder(
  order?: unknown,
  availableIds?: readonly SidebarNavItemId[],
): SidebarNavItemId[] {
  const savedOrder = uniqueSidebarIds(order);
  if (!availableIds) {
    return normalizeSidebarNavOrder(savedOrder, [...DEFAULT_SIDEBAR_NAV_ORDER, ...savedOrder]);
  }

  const availableOrder = uniqueSidebarIds(availableIds);
  const available = new Set(availableOrder);
  const normalized = savedOrder.filter((item) => available.has(item));
  const builtInIds = new Set(DEFAULT_SIDEBAR_NAV_ORDER);

  // Insert newly introduced built-ins beside the existing built-ins that they
  // belong to. This keeps an older saved order readable when, for example, a
  // new divider or media destination is added later.
  for (const id of DEFAULT_SIDEBAR_NAV_ORDER) {
    if (!available.has(id) || normalized.includes(id)) continue;
    const defaultIndex = DEFAULT_SIDEBAR_NAV_ORDER.indexOf(id);
    const nextExistingBuiltIn = DEFAULT_SIDEBAR_NAV_ORDER
      .slice(defaultIndex + 1)
      .find((candidate) => normalized.includes(candidate));
    const insertionIndex = nextExistingBuiltIn ? normalized.indexOf(nextExistingBuiltIn) : normalized.length;
    normalized.splice(insertionIndex, 0, id);
  }

  return [
    ...normalized,
    ...availableOrder.filter((item) => !builtInIds.has(item) && !normalized.includes(item)),
  ];
}

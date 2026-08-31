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
  divider: 'Divider',
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
 * a newer LoomTV version. When the caller provides the items available now,
 * stale playlist and add-on IDs are hidden without being erased from storage.
 */
export function normalizeSidebarNavOrder(
  order?: unknown,
  availableIds?: readonly SidebarNavItemId[],
): SidebarNavItemId[] {
  const savedOrder = uniqueSidebarIds(order);
  if (!availableIds) {
    return [
      ...savedOrder,
      ...DEFAULT_SIDEBAR_NAV_ORDER.filter((item) => !savedOrder.includes(item)),
    ];
  }

  const availableOrder = uniqueSidebarIds(availableIds);
  const available = new Set(availableOrder);
  return [
    ...savedOrder.filter((item) => available.has(item)),
    ...availableOrder.filter((item) => !savedOrder.includes(item)),
  ];
}

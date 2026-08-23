export type TvScreen = 'connect' | 'trust' | 'approval' | 'profiles' | 'library' | 'detail' | 'player';
export type Direction = 'left' | 'right' | 'up' | 'down';

export type FocusGrid = ReadonlyArray<ReadonlyArray<string>>;

export function moveFocus(grid: FocusGrid, current: string, direction: Direction): string {
  const row = grid.findIndex((entries) => entries.includes(current));
  if (row < 0) return grid[0]?.[0] || current;
  const column = grid[row].indexOf(current);
  if (direction === 'left') return grid[row][Math.max(0, column - 1)] || current;
  if (direction === 'right') return grid[row][Math.min(grid[row].length - 1, column + 1)] || current;
  const nextRow = direction === 'up' ? Math.max(0, row - 1) : Math.min(grid.length - 1, row + 1);
  return grid[nextRow][Math.min(column, grid[nextRow].length - 1)] || current;
}

export function backDestination(screen: TvScreen): TvScreen | 'exit' {
  if (screen === 'player') return 'detail';
  if (screen === 'detail') return 'library';
  if (screen === 'library') return 'profiles';
  if (screen === 'profiles' || screen === 'approval' || screen === 'trust') return 'connect';
  return 'exit';
}

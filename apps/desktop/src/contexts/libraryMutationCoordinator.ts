export type LibraryMutationDomain = 'catalog' | 'settings';
export type LibraryMutationToken = Readonly<{ domain: LibraryMutationDomain; generation: number }>;

export function createLibraryMutationCoordinator() {
  const generations: Record<LibraryMutationDomain, number> = { catalog: 0, settings: 0 };
  return {
    begin(domain: LibraryMutationDomain): LibraryMutationToken {
      generations[domain] += 1;
      return { domain, generation: generations[domain] };
    },
    isCurrent(token?: LibraryMutationToken): boolean {
      return token === undefined || generations[token.domain] === token.generation;
    },
  };
}

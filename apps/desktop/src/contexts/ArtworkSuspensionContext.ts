import { createContext, useContext } from 'react';

export const ArtworkSuspensionContext = createContext(false);

export function useArtworkSuspended(): boolean {
  return useContext(ArtworkSuspensionContext);
}

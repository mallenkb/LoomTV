import { createContext } from 'react';

// Scope suspension to the library behind playback, never the player's artwork.
export const ArtworkSuspendedContext = createContext(false);

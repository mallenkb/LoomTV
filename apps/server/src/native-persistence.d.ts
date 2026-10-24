import type { DatabaseSync } from 'node:sqlite';
export const CANONICAL_STATE_FILENAME: string;
export const CANONICAL_SCHEMA_VERSION: number;
export const CANONICAL_MIGRATION_FORMAT: string;
export function initializeCanonicalSchema(database: DatabaseSync): void;
export function registerNativeVideoFunctions(database: DatabaseSync): void;
export function profileAllowsCanonicalMedia(
  database: DatabaseSync,
  profileId: string,
  mediaId: string,
  locator?: string,
): boolean;
export type CanonicalSourceProjection = { sourceIds: string[]; available: boolean };
export type CanonicalMediaAccess = ((mediaId: string, locator?: string) => boolean) & {
  projectSources(mediaId: string, sourceIds: readonly string[]): CanonicalSourceProjection;
};
export function createCanonicalMediaAccess(database: DatabaseSync, profileId: string): CanonicalMediaAccess;

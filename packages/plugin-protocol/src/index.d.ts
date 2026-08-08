export const PLUGIN_MANIFEST_VERSION: 1;
export const PLUGIN_MANIFEST_SCHEMA_ID: 'https://loomtv.app/schemas/plugin-manifest.v1.schema.json';
export const LOOM_PLUGIN_API_VERSION: '1.0.0';
export const SUPPORTED_PLUGIN_CAPABILITIES: readonly [
  'metadata.catalog',
  'subtitle.provider',
  'playback.provider',
];
export const APPROVED_PLAYBACK_PROVIDER_HOOKS: readonly ['resolve-source', 'list-variants'];

export type PluginCapabilityType = (typeof SUPPORTED_PLUGIN_CAPABILITIES)[number];
export type ApprovedPlaybackProviderHook = (typeof APPROVED_PLAYBACK_PROVIDER_HOOKS)[number];

export interface MetadataCatalogCapability {
  type: 'metadata.catalog';
  apiVersion: 1;
}

export interface SubtitleProviderCapability {
  type: 'subtitle.provider';
  apiVersion: 1;
}

export interface PlaybackProviderCapability {
  type: 'playback.provider';
  apiVersion: 1;
  hooks: readonly ApprovedPlaybackProviderHook[];
}

export type LoomPluginCapability =
  | MetadataCatalogCapability
  | SubtitleProviderCapability
  | PlaybackProviderCapability;

export interface LoomPluginManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  loomApi: {
    range: string;
  };
  description?: string;
  author?: string;
  homepage?: string;
  capabilities: readonly LoomPluginCapability[];
}

export interface PluginManifestValidationIssue {
  path: string;
  code: string;
  message: string;
}

export class PluginManifestValidationError extends Error {
  readonly name: 'PluginManifestValidationError';
  readonly code: 'PLUGIN_MANIFEST_INVALID';
  readonly issues: readonly PluginManifestValidationIssue[];
}

export interface PluginManifestValidationOptions {
  loomApiVersion?: string;
  checkCompatibility?: boolean;
}

export function isLoomApiRangeCompatible(
  range: string,
  loomApiVersion?: string,
): boolean;

export function validatePluginManifest(
  input: unknown,
  options?: PluginManifestValidationOptions,
): LoomPluginManifest;

export function installPluginManifest(
  input: unknown,
  options?: PluginManifestValidationOptions,
): LoomPluginManifest;

export function loadPluginManifest(
  input: unknown,
  options?: PluginManifestValidationOptions,
): LoomPluginManifest;

export * from './stremio-adapter';
export * from './downstream';
export * from './identity';
export * from './marketplace';
export * from './runtime-lifecycle';
export * from './signed-bytes';

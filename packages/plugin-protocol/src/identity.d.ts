export const PLUGIN_ITEM_IDENTITY_VERSION: 1;
export const PLUGIN_ITEM_IDENTITY_KIND: 'plugin-item-identity';
export const PLUGIN_CATALOG_MEMBERSHIP_KIND: 'catalog-membership';
export const PLUGIN_CATALOG_RESULT_KIND: 'plugin-catalog-result';
export const PLUGIN_ITEM_KEY_PREFIX: 'loom-plugin:item:v1';
export const LEGACY_STREMIO_ITEM_KEY_PREFIX: 'loomtv-stremio-item-v1';

export interface PluginIdentityIssue {
  path: string;
  code: string;
  message: string;
}

export class PluginIdentityError extends Error {
  readonly name: 'PluginIdentityError';
  readonly code: 'PLUGIN_IDENTITY_INVALID';
  readonly issues: readonly PluginIdentityIssue[];
}

export interface PluginItemIdentity {
  wireVersion: 1;
  kind: 'plugin-item-identity';
  addonId: string;
  type: string;
  providerId: string;
}

export interface PluginCatalogMembership {
  wireVersion: 1;
  kind: 'catalog-membership';
  catalogType: string;
  catalogId: string;
}

export interface PluginCatalogItem {
  identity: PluginItemIdentity;
  membership: PluginCatalogMembership;
  itemKey: string;
  title: string;
  description?: string;
  releaseInfo?: string;
  released?: string;
  rating?: number;
  runtime?: string;
  year?: number;
  genres?: readonly string[];
  artworkRef?: string;
}

export interface PluginCatalogResult {
  wireVersion: 1;
  kind: 'plugin-catalog-result';
  addonId: string;
  catalogType: string;
  catalogId: string;
  revision: number;
  items: readonly PluginCatalogItem[];
}

export interface LegacyCatalogItemIdentityMigration {
  migrationVersion: 1;
  legacyKey: string;
  canonicalKey: string;
  identity: PluginItemIdentity;
  membership: PluginCatalogMembership;
}

export function createPluginItemIdentity(input: {
  addonId: string;
  type: string;
  providerId: string;
}): PluginItemIdentity;

export function parseWirePluginItemIdentity(input: unknown): PluginItemIdentity;
export function parseWireCatalogMembership(input: unknown): PluginCatalogMembership;
export function parseWireCatalogResult(input: unknown): PluginCatalogResult;
export function canonicalPluginItemKey(input: PluginItemIdentity | {
  addonId: string;
  type: string;
  providerId: string;
}): string;
export function migrateLegacyCatalogItemIdentity(input: {
  pluginId: string;
  catalogType: string;
  catalogId: string;
  itemId: string;
}): LegacyCatalogItemIdentityMigration;

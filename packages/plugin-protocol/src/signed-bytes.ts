export declare const PLUGIN_SIGNING_PROTOCOL_VERSION: 1;
export declare const PLUGIN_SIGNING_DOMAINS: Readonly<{
  marketplaceIndex: 'marketplace-index';
  catalog: 'catalog';
  update: 'update';
}>;

export interface PluginSigningIssue {
  path: string;
  code: string;
  message: string;
}

export declare class PluginSigningError extends Error {
  readonly name: 'PluginSigningError';
  readonly code: 'PLUGIN_SIGNING_DATA_INVALID';
  readonly issues: readonly PluginSigningIssue[];
}

export declare const PLUGIN_SIGNING_TEST_VECTORS: readonly Readonly<{
  name: string;
  domain: 'catalog' | null;
  payload: Readonly<{ a: number; b: string }> | null;
  publicKeyHex?: string;
  publicKeyBase64Url?: string;
  messageHex?: string;
  signatureHex?: string;
  signatureBase64Url?: string;
  canonicalJson?: string;
  signedBytesHex?: string;
}>[];

export declare function canonicalizeJcs(value: unknown): string;
export declare function domainSeparatedSignedBytes(domain: 'marketplace-index' | 'catalog' | 'update', payload: unknown): Uint8Array;
export declare function encodeBase64Url(bytes: Uint8Array): string;
export declare function decodeBase64Url(value: string, path?: string): Uint8Array;
export declare function decodeEd25519Signature(value: string, path?: string): Uint8Array;
export declare function decodeEd25519PublicKey(value: string, path?: string): Uint8Array;
export declare function hexToBytes(value: string, path?: string): Uint8Array;
export declare function bytesToHex(value: Uint8Array, path?: string): string;

import { MEDIA_PROTOCOL_SCHEMES } from '../shared/mediaProtocol.ts';

export function rendererConnectSources(isDevServer: boolean): string[] {
  const sources = [
    "'self'",
    'file:',
    'http://127.0.0.1:*',
    'http://localhost:*',
    'https:',
    // These registered Electron protocols carry local and remote media. The
    // second entry is a legacy alias for cached URLs.
    ...MEDIA_PROTOCOL_SCHEMES.map((scheme) => `${scheme}:`),
  ];

  if (isDevServer) {
    sources.push('ws://localhost:*', 'ws://127.0.0.1:*');
  }

  return sources;
}

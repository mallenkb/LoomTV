import { MEDIA_PROTOCOL_SCHEMES } from '../shared/mediaProtocol.ts';

export { MEDIA_PROTOCOL_SCHEMES };

export const mediaSchemePrivileges = {
  secure: true,
  standard: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true,
} as const;

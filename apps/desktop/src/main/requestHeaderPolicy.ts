import { session } from 'electron';

type RequestHeaders = Record<string, string>;
type RequestHeaderRule = (
  details: Electron.OnBeforeSendHeadersListenerDetails,
  headers: RequestHeaders,
) => void;

const rules: RequestHeaderRule[] = [];
let listenerInstalled = false;

/**
 * Electron uses only the last onBeforeSendHeaders listener registered on a
 * session. Keep one listener and compose each feature's header rules here.
 */
export function registerDefaultSessionRequestHeaderRule(rule: RequestHeaderRule): void {
  rules.push(rule);
  if (listenerInstalled) return;
  listenerInstalled = true;

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const applyRule of rules) applyRule(details, requestHeaders);
    callback({ requestHeaders });
  });
}

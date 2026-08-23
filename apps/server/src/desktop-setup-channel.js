import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * The trusted local channel the desktop app uses to authorize first-owner
 * creation without asking anybody to copy a secret.
 *
 * The desktop main process mints a random token for the run, keeps it in
 * memory, and attaches it to requests from its own window at the network layer.
 * The page never sees it, so it is not in a form, a URL, a log, or browser
 * storage. A request only counts as trusted when it also arrives on the
 * loopback interface, which a LAN or reverse-proxy client cannot forge.
 */

export const DESKTOP_SETUP_HEADER = 'x-loomtv-desktop-setup';
const MIN_TOKEN_BYTES = 32;

function digest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (address === 'localhost' || address === '::1' || address === '::ffff:127.0.0.1') return true;
  if (isIP(address) === 4) return address.split('.').map(Number)[0] === 127;
  return false;
}

export function createDesktopSetupChannel({ token, clientAddress } = {}) {
  const configured = typeof token === 'string' && Buffer.byteLength(token.trim()) >= MIN_TOKEN_BYTES
    ? token.trim()
    : null;
  if (token !== undefined && token !== null && token !== '' && !configured) {
    throw Object.assign(new Error(`The desktop setup token must contain at least ${MIN_TOKEN_BYTES} bytes.`), {
      code: 'desktop_setup_token_invalid',
    });
  }
  const addressOf = typeof clientAddress === 'function'
    ? clientAddress
    : (req) => req?.socket?.remoteAddress || '';

  return {
    get enabled() {
      return Boolean(configured);
    },
    /** True only for a loopback request carrying this run's desktop token. */
    isTrustedRequest(req) {
      if (!configured || !req) return false;
      const presented = Array.isArray(req.headers?.[DESKTOP_SETUP_HEADER])
        ? ''
        : String(req.headers?.[DESKTOP_SETUP_HEADER] || '');
      if (!presented) return false;
      if (!isLoopbackAddress(addressOf(req))) return false;
      return timingSafeEqual(digest(configured), digest(presented));
    },
  };
}

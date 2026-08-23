import { createHeadlessAdminService } from './admin-service.js';
import { createHeadlessClientState, normalizeHeadlessClientState } from './client-state.js';
import { createCanonicalStateStore } from './canonical-state-store.js';
import { createPairingService } from './pairing-service.js';
import { createRemotePolicyService } from './remote-policy.js';

/**
 * Construct the stateful services once for either standalone or desktop-hosted use.
 * Legacy route handlers receive these services as adapters and never construct a
 * second account, catalog, profile, or progress store.
 */
export function createCanonicalPersistence(options) {
  if (!options?.dataDir) throw new Error('Canonical persistence requires a data directory.');
  if (!options.bootstrapSecurity) throw new Error('Canonical persistence requires bootstrap security.');

  const store = createCanonicalStateStore({ dataDir: options.dataDir });
  let accountsAndCatalog;
  const pairing = createPairingService({
    store,
    getAccount: (accountId) => accountsAndCatalog?.getPrincipalById(accountId),
    getCertificateFingerprint: options.getCertificateFingerprint,
    clock: options.clock,
  });
  const profiles = createHeadlessClientState({
    store,
    validateAccount: async (accountId) => Boolean(await accountsAndCatalog?.getPrincipalById(accountId)),
  });
  accountsAndCatalog = createHeadlessAdminService({
    dataDir: options.dataDir,
    mediaDir: options.mediaDir,
    version: options.version,
    baseUrl: options.baseUrl,
    getRuntimeHealth: options.getRuntimeHealth,
    getSessions: options.getSessions,
    getClientState: () => profiles.exportState(),
    replaceClientState: (snapshot) => profiles.importState(snapshot),
    replaceAllState: ({ adminState, clientState }) => store.replaceAllState({
      adminState,
      clientState: normalizeHeadlessClientState(clientState),
    }),
    onCanonicalRestore: () => profiles.revokeAllAccess(),
    stateStore: store,
    pairingService: pairing,
    clientAddress: options.clientAddress,
    onPlaybackSessionsRevoked: options.onPlaybackSessionsRevoked,
    onPlaybackSessionsRevokedForItem: options.onPlaybackSessionsRevokedForItem,
    onAuthenticationSessionRevoked: options.onAuthenticationSessionRevoked,
    onAllPlaybackSessionsRevoked: options.onAllPlaybackSessionsRevoked,
    bootstrapSecurity: options.bootstrapSecurity,
    requireBootstrapSecret: options.requireBootstrapSecret,
  });
  const remote = createRemotePolicyService({
    store,
    proxyPolicy: options.proxyPolicy,
    getAccount: (accountId) => accountsAndCatalog?.getPrincipalById(accountId),
    getAdminService: () => accountsAndCatalog,
    getClientState: () => profiles,
    clock: options.clock,
  });

  let started = false;
  let stopPromise;

  async function stopServices() {
    const failures = [];
    for (const close of [
      () => accountsAndCatalog.stop?.(),
      () => profiles.close?.(),
      () => store.stop(),
    ]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Canonical persistence did not close cleanly.');
  }

  return {
    accounts: accountsAndCatalog,
    catalog: accountsAndCatalog,
    policy: accountsAndCatalog,
    profiles,
    progress: profiles,
    pairing,
    remote,
    store,

    async start() {
      if (started) return;
      if (stopPromise) throw Object.assign(new Error('Canonical persistence is closed.'), { code: 'persistence_closed' });
      try {
        await store.start();
        await profiles.ready();
        await accountsAndCatalog.isOwnerConfigured();
        started = true;
      } catch (error) {
        await stopServices().catch(() => undefined);
        throw error;
      }
    },

    async exportProfileState() {
      return profiles.exportState();
    },

    async replaceProfileState(snapshot) {
      return profiles.importState(snapshot);
    },

    async stop() {
      if (!stopPromise) stopPromise = stopServices();
      return stopPromise;
    },
  };
}

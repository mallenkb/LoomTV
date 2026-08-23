import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Copy, ExternalLink, Key, RefreshCw, ShieldCheck, Wifi } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import SharedListHighlight from '@/components/SharedListHighlight';
import PinDigitInput from '@/components/profiles/PinDigitInput';
import { desktopApi } from '@/lib/desktopApi';
import { useUnifiedDesktopServer } from '@/lib/unifiedServer';
import type {
  LocalNetworkPeer,
  LocalNetworkStatus,
  SharedLibrarySection,
  SharedLibrarySnapshot,
} from './Settings.types';

type NetworkSettingsSectionProps = {
  localNetworkStatus: LocalNetworkStatus | null;
  isNetworkSharingOn: boolean;
  isTogglingNetworkSharing: boolean;
  requireApproval: boolean;
  setRequireApproval: (enabled: boolean) => void;
  currentNetworkName: string;
  networkStatusMessage: string;
  setLocalNetworkSharing: (enabled: boolean) => void;
  copyNetworkValue: (value?: string | null) => void;
  revokePairedDevice: (deviceId: string) => void;
  discoveredPeers: LocalNetworkPeer[];
  isScanningPeers: boolean;
  scanForPeers: () => void;
  remoteLibraryAddress: string;
  setRemoteLibraryAddress: (value: string) => void;
  setRemoteLibraryFingerprint: (value: string) => void;
  remoteShareCode: string;
  setRemoteShareCode: (value: string) => void;
  showManualNetworkAddress: boolean;
  setShowManualNetworkAddress: React.Dispatch<React.SetStateAction<boolean>>;
  connectRemoteLibrary: () => void;
  isConnectingRemoteLibrary: boolean;
  remoteLibraryStatus: string;
  sharedLibrarySnapshot: SharedLibrarySnapshot | null;
  sharedLibrarySections: SharedLibrarySection[];
  disconnectRemoteLibrary: () => void;
};

export default function NetworkSettingsSection({
  localNetworkStatus,
  isNetworkSharingOn,
  isTogglingNetworkSharing,
  requireApproval,
  setRequireApproval,
  currentNetworkName,
  networkStatusMessage,
  setLocalNetworkSharing,
  copyNetworkValue,
  revokePairedDevice,
  discoveredPeers,
  isScanningPeers,
  scanForPeers,
  remoteLibraryAddress,
  setRemoteLibraryAddress,
  setRemoteLibraryFingerprint,
  remoteShareCode,
  setRemoteShareCode,
  showManualNetworkAddress,
  setShowManualNetworkAddress,
  connectRemoteLibrary,
  isConnectingRemoteLibrary,
  remoteLibraryStatus,
  sharedLibrarySnapshot,
  sharedLibrarySections,
  disconnectRemoteLibrary,
}: NetworkSettingsSectionProps) {
  const [showAdvancedSharing, setShowAdvancedSharing] = useState(false);
  const { server: unifiedServer, refresh: refreshUnifiedServer } = useUnifiedDesktopServer();
  const [isOpeningAdmin, setIsOpeningAdmin] = useState(false);
  const [adminMessage, setAdminMessage] = useState('');

  const openServerAdmin = async () => {
    setIsOpeningAdmin(true);
    setAdminMessage('');
    try {
      const opened = await desktopApi.openUnifiedDesktopAdmin();
      if (!opened) {
        setAdminMessage('Server administration is unavailable right now.');
        await refreshUnifiedServer();
      }
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Server administration could not be opened.');
    } finally {
      setIsOpeningAdmin(false);
    }
  };

  return (
    <>
      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <Wifi className="h-4 w-4 text-[var(--loom-accent)]" />
            Local Network Sharing
          </CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Watch this library on LoomTV mobile over your home network. Nearby LoomTV devices connect automatically by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="settings-network-card flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--loom-surface-2)] p-4">
            <div>
              <p className="text-sm font-semibold text-white">
                {isTogglingNetworkSharing ? 'Updating sharing...' : isNetworkSharingOn ? 'Sharing is on' : 'Sharing is off'}
              </p>
              <p className="text-xs text-[var(--loom-muted)]">
                {isTogglingNetworkSharing
                  ? 'Preparing automatic local connection.'
                  : isNetworkSharingOn
                  ? requireApproval ? 'New devices wait for your approval.' : 'Nearby LoomTV devices connect automatically.'
                  : 'Turn on to connect nearby LoomTV devices.'}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => setLocalNetworkSharing(!isNetworkSharingOn)}
              disabled={isTogglingNetworkSharing}
              variant={isNetworkSharingOn ? 'outline' : 'default'}
              className={`gap-2 ${isNetworkSharingOn ? 'settings-destructive-button border-red-500/25 bg-red-500/10 text-red-100 hover:border-red-400/40 hover:bg-red-500/20 hover:text-red-50' : ''}`}
            >
              {isTogglingNetworkSharing ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Wifi className="h-4 w-4" />
              )}
              {isTogglingNetworkSharing ? 'Updating...' : isNetworkSharingOn ? 'Turn Off' : 'Turn On'}
            </Button>
          </div>

          <AnimatePresence initial={false}>
            {isNetworkSharingOn && (
              <motion.div
                className="space-y-5"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="settings-network-card flex items-center justify-between gap-4 rounded-lg bg-[var(--loom-surface-2)] p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white">Require approval for new devices</p>
                    <p className="text-xs text-[var(--loom-muted)]">Optional. Off keeps local connection automatic.</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={requireApproval}
                    onClick={() => setRequireApproval(!requireApproval)}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${requireApproval ? 'bg-[var(--loom-accent)]' : 'bg-[var(--loom-surface-3)]'}`}
                  >
                    <span className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${requireApproval ? 'translate-x-6' : 'translate-x-1'}`} />
                    <span className="sr-only">Require approval for new devices</span>
                  </button>
                </div>

                <div className="settings-network-card rounded-xl bg-[var(--loom-accent)]/10 p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
                    <CheckCircle2 className="h-4 w-4 text-[var(--loom-accent)]" />
                    Connect a phone or tablet
                  </div>
                  <div className="grid gap-3 md:grid-cols-[1.3fr_.7fr]">
                    <div className="settings-network-card rounded-lg bg-[var(--loom-bg)] p-3">
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Desktop address</p>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate text-base font-semibold text-white">
                          {localNetworkStatus?.baseUrl || 'Waiting for network address'}
                        </code>
                        <button
                          type="button"
                          onClick={() => copyNetworkValue(localNetworkStatus?.baseUrl)}
                          disabled={!localNetworkStatus?.baseUrl}
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:opacity-35"
                          aria-label="Copy desktop address"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <div className="settings-network-card rounded-lg bg-[var(--loom-bg)] p-3">
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">One-time pairing PIN</p>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate text-sm font-bold text-white">
                          {localNetworkStatus?.token || 'Waiting for pairing PIN'}
                        </code>
                        <button
                          type="button"
                          onClick={() => copyNetworkValue(localNetworkStatus?.token)}
                          disabled={!localNetworkStatus?.token}
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:opacity-35"
                          aria-label="Copy share code"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-[var(--loom-muted)]">
                    {requireApproval
                      ? 'New devices ask for approval. The PIN remains available as a manual fallback.'
                      : 'Discovered LoomTV devices connect automatically. The PIN remains available as a manual fallback.'}
                  </p>
                </div>

                {!localNetworkStatus?.addresses?.length && (
                  <p className="text-xs text-[var(--loom-faint)]">
                    Connect this device to Wi-Fi or Ethernet to make it visible to other devices.
                  </p>
                )}

                <div className="settings-panel-soft rounded-lg p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">
                    {(localNetworkStatus?.pairedDevices?.length || 0) === 1 ? 'Connected Device' : 'Connected Devices'}
                  </p>
                  {(localNetworkStatus?.pairedDevices?.length || 0) === 0 ? (
                    <p className="text-xs text-[var(--loom-faint)]">No connected devices.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {localNetworkStatus?.pairedDevices?.map((device) => {
                        const lastSeenLabel = new Date(device.lastSeenAt).toLocaleString();
                        return (
                          <li key={device.id} className="settings-network-card flex items-center justify-between rounded-md bg-[var(--loom-surface-2)] px-2 py-1.5">
                            <div className="min-w-0">
                              <p className="truncate text-xs font-semibold text-white">{device.name}</p>
                              <p className="truncate text-[10px] text-[var(--loom-faint)]">
                                {device.lastAddress ? `Connected · ${device.lastAddress}` : `Last seen ${lastSeenLabel}`}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => revokePairedDevice(device.id)}
                              className="settings-destructive-text ml-3 shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors hover:bg-red-500/10"
                            >
                              Revoke
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setShowAdvancedSharing((current) => !current)}
                  className="rounded-md text-xs font-medium text-[var(--loom-accent)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--loom-surface)]"
                >
                  {showAdvancedSharing ? 'Hide advanced details' : 'Advanced: library URL and addresses'}
                </button>

                {showAdvancedSharing && (
                  <div className="space-y-3">
                    <div className="settings-panel-soft rounded-lg p-3">
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Network Library URL</p>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate text-sm text-white">
                          {localNetworkStatus?.libraryUrl || 'Turn on sharing to expose the network library'}
                        </code>
                        <button
                          type="button"
                          onClick={() => copyNetworkValue(localNetworkStatus?.libraryUrl)}
                          disabled={!localNetworkStatus?.libraryUrl}
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-white disabled:opacity-35"
                          aria-label="Copy network library URL"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    {localNetworkStatus?.addresses?.length ? (
                      <p className="text-xs text-[var(--loom-faint)]">
                        Network: {currentNetworkName} · Visible addresses: {localNetworkStatus.addresses.join(', ')}
                      </p>
                    ) : null}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {networkStatusMessage && <p className="text-sm text-[var(--loom-muted)]">{networkStatusMessage}</p>}
        </CardContent>
      </Card>

      {unifiedServer.enabled && (
        <Card className="settings-panel">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <ShieldCheck className="h-4 w-4 text-[var(--loom-accent)]" />
              Server Administration
            </CardTitle>
            <CardDescription className="text-[var(--loom-muted)]">
              Manage accounts and libraries for the LoomTV server running on this computer. It opens as a separate page in your browser.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {unifiedServer.ready ? (
              <div className="settings-network-card flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--loom-surface-2)] p-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">
                    {unifiedServer.ownerConfigured ? 'Server is running' : 'Server is running · no administrator yet'}
                  </p>
                  <p className="truncate text-xs text-[var(--loom-muted)]">
                    {unifiedServer.adminUrl ? `Opens ${unifiedServer.adminUrl}` : 'Opens the admin page in your browser.'}
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={() => void openServerAdmin()}
                  disabled={isOpeningAdmin}
                  className="gap-2"
                >
                  {isOpeningAdmin ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                  {isOpeningAdmin ? 'Opening...' : 'Open Admin Page'}
                </Button>
              </div>
            ) : (
              <div
                role={unifiedServer.error ? 'alert' : 'status'}
                className="settings-network-card rounded-lg bg-[var(--loom-surface-2)] p-4"
              >
                <p className={`text-sm font-semibold ${unifiedServer.error ? 'text-red-200' : 'text-white'}`}>
                  {unifiedServer.error ? 'The LoomTV server did not start' : 'Starting the LoomTV server...'}
                </p>
                {unifiedServer.error && (
                  <p className="mt-1 text-xs leading-5 text-[var(--loom-muted)]">{unifiedServer.error}</p>
                )}
              </div>
            )}
            {adminMessage && <p role="alert" className="text-sm text-red-200">{adminMessage}</p>}
          </CardContent>
        </Card>
      )}

      <Card className="settings-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-white">
            <Key className="h-4 w-4 text-[var(--loom-accent)]" />
            Connect to Shared Library
          </CardTitle>
          <CardDescription className="text-[var(--loom-muted)]">
            Find another Loom host on this network, enter its 6-digit pairing PIN, and browse without copying files.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="settings-network-card flex items-center gap-3 rounded-lg bg-[var(--loom-surface-2)] p-3">
            <span className="settings-status-available grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-500/12">
              <Wifi className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Current Network</p>
              <p className="truncate text-sm font-semibold text-white">{currentNetworkName}</p>
            </div>
          </div>

          <div className="settings-network-card rounded-lg bg-[var(--loom-surface-2)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--loom-faint)]">Devices on this network</p>
              <button
                type="button"
                onClick={scanForPeers}
                disabled={isScanningPeers}
                className="text-xs font-medium text-[var(--loom-accent)] hover:underline disabled:opacity-50"
              >
                {isScanningPeers ? 'Scanning...' : 'Rescan'}
              </button>
            </div>
            {discoveredPeers.length === 0 ? (
              <p className="text-xs text-[var(--loom-faint)]">
                {isScanningPeers ? 'Looking for LoomTV devices...' : 'No other LoomTV devices found. Make sure sharing is on over there.'}
              </p>
            ) : (
              <SharedListHighlight activeId={remoteLibraryAddress} className="loom-shared-highlight-list space-y-1">
                {discoveredPeers.map((peer) => {
                  const peerBaseUrl = `https://${peer.host}:${peer.port}`;
                  const isSelected = remoteLibraryAddress === peerBaseUrl;
                  return (
                    <button
                      key={peer.deviceId}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        setRemoteLibraryAddress(peerBaseUrl);
                        setRemoteLibraryFingerprint(peer.certFingerprint);
                        setShowManualNetworkAddress(true);
                      }}
                      data-shared-highlight-item
                      data-shared-highlight-id={peerBaseUrl}
                      className={`relative z-10 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--loom-accent)] ${isSelected ? 'text-[var(--loom-active-text)]' : 'text-[var(--loom-muted)] hover:text-white'}`}
                    >
                      <span className="truncate font-medium">{peer.deviceName}</span>
                      <span className="ml-3 shrink-0 text-[var(--loom-faint)]">{peer.host}:{peer.port}</span>
                    </button>
                  );
                })}
              </SharedListHighlight>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--loom-muted)]">Pairing PIN</span>
              <PinDigitInput
                value={remoteShareCode}
                onChange={setRemoteShareCode}
                length={6}
                label="Six-digit pairing PIN"
                digitLabel="Pairing PIN digit"
                className="gap-1.5"
                inputClassName="h-10 w-10 rounded-lg bg-[var(--loom-bg)] text-base"
              />
            </div>
            <Button
              type="button"
              onClick={connectRemoteLibrary}
              disabled={isConnectingRemoteLibrary || !/^\d{6}$/.test(remoteShareCode)}
              className="ml-auto gap-2 px-5"
            >
              <Wifi className="h-4 w-4" />
              {isConnectingRemoteLibrary ? 'Connecting...' : 'Connect'}
            </Button>
          </div>

          <button
            type="button"
            onClick={() => setShowManualNetworkAddress((current) => !current)}
            className="rounded-md text-xs font-medium text-[var(--loom-accent)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--loom-surface)]"
          >
            {showManualNetworkAddress ? 'Hide manual address' : 'Advanced: enter address manually'}
          </button>

          {showManualNetworkAddress && (
            <input
              type="text"
              value={remoteLibraryAddress}
              onChange={(event) => {
                setRemoteLibraryAddress(event.target.value);
                setRemoteLibraryFingerprint('');
              }}
              placeholder="https://192.168.1.50:3848"
              className="h-10 w-full min-w-0 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 text-sm text-white outline-none transition-colors placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]"
            />
          )}
          {remoteLibraryStatus && <p className="text-sm text-[var(--loom-muted)]">{remoteLibraryStatus}</p>}
        </CardContent>
      </Card>

      {sharedLibrarySnapshot && (
        <Card className="settings-panel">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="text-white">Shared Library</CardTitle>
                <CardDescription className="text-[var(--loom-muted)]">
                  Connected to {sharedLibrarySnapshot.hostDeviceName || sharedLibrarySnapshot.baseUrl} · auto-refreshing
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={disconnectRemoteLibrary}
                className="shrink-0"
              >
                Disconnect
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-3">
              {sharedLibrarySections.map((section) => (
                <div key={section.title} className="settings-panel-soft rounded-lg p-3">
                  <p className="text-sm font-semibold text-white">{section.title}</p>
                  <p className="mb-3 text-xs text-[var(--loom-muted)]">{section.items.length} item{section.items.length === 1 ? '' : 's'}</p>
                  <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                    {section.items.length === 0 ? (
                      <p className="text-xs text-[var(--loom-faint)]">Nothing shared here yet.</p>
                    ) : (
                      section.items.map((item, index) => (
                        <p key={`${section.title}-${item.title || index}`} className="truncate text-xs text-[var(--loom-muted)]">
                          {item.title || 'Untitled'}{item.year ? ` (${item.year})` : ''}
                        </p>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

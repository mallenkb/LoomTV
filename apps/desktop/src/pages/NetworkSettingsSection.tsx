import { Copy, ExternalLink, RefreshCw, Wifi } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SettingsDisclosure, SettingsGroup, SettingsNote, SettingsPageHeader, SettingsRow, SettingsSwitch } from '@/components/settings/SettingsLayout';
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

  const pairedDevices = localNetworkStatus?.pairedDevices || [];
  const copyButton = (value: string | null | undefined, label: string) => (
    <button
      type="button"
      onClick={() => copyNetworkValue(value)}
      disabled={!value}
      className="loom-control-button grid h-9 w-9 shrink-0 place-items-center rounded-[var(--loom-control-radius)] text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)] disabled:opacity-35"
      aria-label={label}
      title={label}
    >
      <Copy className="h-4 w-4" />
    </button>
  );

  return (
    <div>
      <SettingsPageHeader title="Devices and network" description="Share this library with phones and other computers on your network, or connect to another Loom." />
      <SettingsGroup title="Share this library">
        <SettingsRow
          title="Local network sharing"
          description={isTogglingNetworkSharing
            ? 'Updating sharing…'
            : isNetworkSharingOn
              ? 'Loom on your phone, tablet, or another computer can play this library over your home network.'
              : 'Turn on to watch this library from other Loom devices at home.'}
        >
          {isTogglingNetworkSharing ? <RefreshCw className="h-4 w-4 animate-spin text-[var(--loom-muted)]" aria-hidden="true" /> : null}
          <SettingsSwitch label="Local network sharing" checked={isNetworkSharingOn} disabled={isTogglingNetworkSharing} onChange={setLocalNetworkSharing} />
        </SettingsRow>

        {isNetworkSharingOn ? (
          <>
            <SettingsRow title="Require approval for new devices" description={requireApproval ? 'New devices wait until you approve them.' : 'Nearby Loom devices connect automatically.'}>
              <SettingsSwitch label="Require approval for new devices" checked={requireApproval} onChange={setRequireApproval} />
            </SettingsRow>
            {localNetworkStatus?.addresses?.length ? (
              <SettingsRow title="Connect a device" description="Enter this address and PIN in Loom on the other device if it is not found automatically.">
                <span className="flex items-center gap-1 rounded-lg bg-[var(--loom-bg)] py-1 pl-3 pr-1">
                  <code className="max-w-56 truncate text-sm text-[var(--loom-text)]">{localNetworkStatus?.baseUrl || 'Waiting…'}</code>
                  {copyButton(localNetworkStatus?.baseUrl, 'Copy desktop address')}
                </span>
                <span className="flex items-center gap-1 rounded-lg bg-[var(--loom-bg)] py-1 pl-3 pr-1">
                  <span className="text-xs text-[var(--loom-muted)]">PIN</span>
                  <code className="text-sm font-semibold tracking-wider text-[var(--loom-text)]">{localNetworkStatus?.token || '······'}</code>
                  {copyButton(localNetworkStatus?.token, 'Copy pairing PIN')}
                </span>
              </SettingsRow>
            ) : (
              <SettingsNote tone="warning">Connect this computer to Wi-Fi or Ethernet so other devices can find it.</SettingsNote>
            )}
            {pairedDevices.length ? (
              <SettingsDisclosure title="Connected devices" summary={pairedDevices.length.toLocaleString()}>
                <ul className="divide-y divide-[var(--loom-settings-divider)]">
                  {pairedDevices.map((device) => (
                    <li key={device.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-[var(--loom-text)]">{device.name}</p>
                        <p className="truncate text-xs text-[var(--loom-muted)]">
                          {device.lastAddress ? `Connected · ${device.lastAddress}` : `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
                        </p>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => revokePairedDevice(device.id)} className="settings-destructive-text hover:bg-red-500/10">
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              </SettingsDisclosure>
            ) : null}
            {localNetworkStatus?.libraryUrl ? (
              <SettingsDisclosure title="Technical details" description="Library URL and network addresses.">
                <div className="space-y-2 text-xs text-[var(--loom-muted)]">
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate text-[var(--loom-text)]">{localNetworkStatus.libraryUrl}</code>
                    {copyButton(localNetworkStatus.libraryUrl, 'Copy network library URL')}
                  </div>
                  {localNetworkStatus.addresses?.length ? <p>Network: {currentNetworkName} · Addresses: {localNetworkStatus.addresses.join(', ')}</p> : null}
                </div>
              </SettingsDisclosure>
            ) : null}
          </>
        ) : null}
        {networkStatusMessage ? <SettingsNote role="status">{networkStatusMessage}</SettingsNote> : null}
      </SettingsGroup>

      {unifiedServer.enabled ? (
        <SettingsGroup title="Media server">
          {unifiedServer.ready ? (
            <SettingsRow
              title={unifiedServer.ownerConfigured ? 'Server is running' : 'Server is running with no administrator yet'}
              description="Manage accounts and libraries in your browser."
            >
              <Button type="button" variant="outline" size="sm" onClick={() => void openServerAdmin()} disabled={isOpeningAdmin} className="gap-1.5">
                {isOpeningAdmin ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                {isOpeningAdmin ? 'Opening…' : 'Open admin page'}
              </Button>
            </SettingsRow>
          ) : (
            <SettingsNote role={unifiedServer.error ? 'alert' : 'status'} tone={unifiedServer.error ? 'error' : 'muted'}>
              {unifiedServer.error ? `The Loom Media Server did not start. ${unifiedServer.error}` : 'Starting the Loom Media Server…'}
            </SettingsNote>
          )}
          {adminMessage ? <SettingsNote role="alert" tone="error">{adminMessage}</SettingsNote> : null}
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Watch another library">
        {sharedLibrarySnapshot ? (
          <SettingsRow
            title={`Connected to ${sharedLibrarySnapshot.hostDeviceName || sharedLibrarySnapshot.baseUrl}`}
            description={sharedLibrarySections.map((section) => `${section.items.length.toLocaleString()} ${section.title.toLowerCase()}`).join(' · ')}
          >
            <Button type="button" variant="outline" size="sm" onClick={disconnectRemoteLibrary}>Disconnect</Button>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow
              title="Nearby devices"
              description={isScanningPeers ? 'Looking for Loom devices…' : discoveredPeers.length ? `On ${currentNetworkName}. Pick one, then enter its PIN.` : `No other Loom devices found on ${currentNetworkName}. Turn on sharing on the other device.`}
            >
              <Button type="button" variant="outline" size="sm" onClick={scanForPeers} disabled={isScanningPeers} className="gap-1.5">
                <RefreshCw className={`h-3.5 w-3.5 ${isScanningPeers ? 'animate-spin' : ''}`} aria-hidden="true" />
                Rescan
              </Button>
            </SettingsRow>
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
                  className={`settings-row settings-row-button flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-[var(--loom-surface-3)]/50 ${isSelected ? 'bg-[var(--loom-active-bg)]' : ''}`}
                >
                  <Wifi className={`h-4 w-4 shrink-0 ${isSelected ? 'text-[var(--loom-accent)]' : 'text-[var(--loom-muted)]'}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--loom-text)]">{peer.deviceName}</span>
                  <span className="shrink-0 text-xs text-[var(--loom-faint)]">{peer.host}:{peer.port}</span>
                </button>
              );
            })}
            {showManualNetworkAddress ? (
              <SettingsRow title="Address">
                <input
                  type="text"
                  value={remoteLibraryAddress}
                  onChange={(event) => {
                    setRemoteLibraryAddress(event.target.value);
                    setRemoteLibraryFingerprint('');
                  }}
                  placeholder="https://192.168.1.50:3848"
                  aria-label="Library address"
                  className="h-9 w-72 min-w-0 rounded-lg border border-[var(--loom-control-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none placeholder:text-[var(--loom-faint)] focus:border-[var(--loom-accent)]"
                />
              </SettingsRow>
            ) : null}
            <SettingsRow title="Pairing PIN" description="Shown in Settings › Network on the other device.">
              <PinDigitInput
                value={remoteShareCode}
                onChange={setRemoteShareCode}
                length={6}
                label="Six-digit pairing PIN"
                digitLabel="Pairing PIN digit"
                className="gap-1.5"
                inputClassName="h-9 w-9 rounded-lg bg-[var(--loom-bg)] text-base"
              />
              <Button
                type="button"
                size="sm"
                onClick={connectRemoteLibrary}
                disabled={isConnectingRemoteLibrary || !/^\d{6}$/.test(remoteShareCode)}
              >
                {isConnectingRemoteLibrary ? 'Connecting…' : 'Connect'}
              </Button>
            </SettingsRow>
            {!showManualNetworkAddress ? (
              <button
                type="button"
                onClick={() => setShowManualNetworkAddress(true)}
                className="settings-row settings-row-button block w-full px-4 py-2.5 text-left text-xs text-[var(--loom-muted)] transition-colors hover:bg-[var(--loom-surface-3)]/40 hover:text-[var(--loom-text)]"
              >
                Enter an address manually
              </button>
            ) : null}
          </>
        )}
        {remoteLibraryStatus ? <SettingsNote role="status">{remoteLibraryStatus}</SettingsNote> : null}
      </SettingsGroup>
    </div>
  );
}

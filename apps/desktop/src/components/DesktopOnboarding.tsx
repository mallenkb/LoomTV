import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Check, Clapperboard, Laptop2, LayoutGrid, Library, Loader2, RefreshCw, Server, Wifi } from 'lucide-react';
import LoomBrandLockup from './LoomBrandLockup';
import PinDigitInput from './profiles/PinDigitInput';
import { Button } from './ui/button';
import { desktopApi, type LocalNetworkPeer } from '@/lib/desktopApi';
import {
  applyTheme,
  DEFAULT_THEME_SETTINGS,
  type AppHomeStyle,
  readCachedTheme,
  writeCachedTheme,
} from '@/lib/theme';

type OnboardingChoice = 'choose' | 'connect';

export default function DesktopOnboarding({
  onHostReady,
  onRemoteReady,
  initialMessage = '',
  initialStep,
}: {
  onHostReady: () => void;
  onRemoteReady: () => void;
  initialMessage?: string;
  initialStep?: OnboardingChoice;
}) {
  const [step, setStep] = useState<OnboardingChoice>(initialStep ?? (initialMessage ? 'connect' : 'choose'));
  const [peers, setPeers] = useState<LocalNetworkPeer[]>([]);
  const [address, setAddress] = useState('');
  const [pin, setPin] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [message, setMessage] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [homeStyle, setHomeStyle] = useState<AppHomeStyle>(() => readCachedTheme()?.homeStyle ?? DEFAULT_THEME_SETTINGS.homeStyle);

  const chooseHomeStyle = (nextHomeStyle: AppHomeStyle) => {
    const nextTheme = {
      ...(readCachedTheme() ?? DEFAULT_THEME_SETTINGS),
      homeStyle: nextHomeStyle,
      ...(nextHomeStyle === 'modern' ? { mode: 'dark' as const } : {}),
    };
    setHomeStyle(nextHomeStyle);
    writeCachedTheme(nextTheme);
    applyTheme(nextTheme);
  };

  const scan = useCallback(async () => {
    setIsScanning(true);
    setMessage('');
    try {
      const found = await desktopApi.discoverLocalNetworkPeers(3000);
      setPeers(found);
      // Graceful degradation: if discovery turns up nothing (e.g. mDNS blocked
      // on the network), surface the manual entry so the user isn't stuck.
      if (found.length === 0) setShowManual(true);
    } catch {
      setPeers([]);
      setShowManual(true);
      setMessage('Automatic discovery is unavailable. Enter the host address below.');
    } finally {
      setIsScanning(false);
    }
  }, []);

  useEffect(() => {
    if (step === 'connect') void scan();
  }, [scan, step]);

  const connect = async () => {
    if (isConnecting || !/^\d{6}$/.test(pin)) return;
    setIsConnecting(true);
    setMessage('');
    try {
      const selectedPeer = peers.find((peer) => `https://${peer.host}:${peer.port}` === address.trim());
      const connection = await desktopApi.connectToLocalNetworkLibrary(
        address,
        pin,
        selectedPeer?.certFingerprint,
      );
      desktopApi.activateRemoteLibrary(connection);
      onRemoteReady();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not connect to that LoomTV host.');
    } finally {
      setIsConnecting(false);
    }
  };

  // Shared content width — the main page defines it and the connect page inherits the same value.
  const contentWidth = 'w-full max-w-[760px]';

  return (
    <div className="fixed inset-0 overflow-y-auto bg-[var(--loom-bg)] text-[var(--loom-text)]">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 py-10">
        <header className="flex min-h-10 items-center">
          {step === 'connect' && (
            <div className={`mx-auto ${contentWidth}`}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setStep('choose'); setMessage(''); }}
                className="gap-2"
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
            </div>
          )}
        </header>

        {step === 'choose' ? (
          <main className={`mx-auto flex ${contentWidth} flex-1 flex-col py-12 lg:py-16`}>
            <div className="flex flex-col items-center text-center">
              <LoomBrandLockup className="mb-4 h-20 w-[108px]" />
              <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">Set up LoomTV</h1>
              <p className="mt-2 max-w-md text-sm leading-6 text-[var(--loom-muted)]">Choose how LoomTV looks, then tell us where your library lives.</p>
            </div>

            <section className="mt-8">
              <h2 className="text-sm font-semibold text-[var(--loom-text)]">Choose your style</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="LoomTV style">
                {([
                  { id: 'default', label: 'Default', description: 'The familiar LoomTV library layout.', Icon: LayoutGrid },
                  { id: 'modern', label: 'Modern', description: 'A cinematic hero with floating navigation.', Icon: Clapperboard },
                ] as const).map(({ id, label, description, Icon }) => {
                  const selected = homeStyle === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => chooseHomeStyle(id)}
                      className={`flex min-h-24 items-start gap-3 rounded-2xl border p-4 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--loom-focus-ring)] ${
                        selected
                          ? 'border-[var(--loom-active-border)] bg-[var(--loom-active-bg)]'
                          : 'border-[var(--loom-border)] bg-[var(--loom-surface)] hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-surface-2)]'
                      }`}
                    >
                      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${selected ? 'bg-[var(--loom-active-bg-strong)] text-[var(--loom-active-text)]' : 'bg-[var(--loom-surface-3)] text-[var(--loom-muted)]'}`}>
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-3 text-sm font-semibold text-[var(--loom-text)]">
                          {label}
                          {selected && <Check className="h-4 w-4 shrink-0 stroke-[2.5] text-[var(--loom-accent)]" aria-hidden="true" />}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-[var(--loom-muted)]">{description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="mt-8">
              <h2 className="text-sm font-semibold text-[var(--loom-text)]">Where is your library?</h2>
              <div className="mt-3 grid w-full gap-4 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => { desktopApi.useThisComputerAsHost(); onHostReady(); }}
                  className="group rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-4 text-left transition hover:border-[var(--loom-accent)] hover:bg-[var(--loom-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
                >
                  <span className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-[var(--loom-accent)]"><Server className="h-5 w-5" /></span>
                  <span className="flex items-center justify-between gap-3 text-lg font-semibold">Start fresh <ArrowRight className="h-4 w-4 text-[var(--loom-muted)] transition-transform group-hover:translate-x-1 group-hover:text-[var(--loom-accent)]" /></span>
                  <span className="mt-2 block text-sm leading-6 text-[var(--loom-muted)]">Create a library on this computer.</span>
                </button>
                <button
                  type="button"
                  onClick={() => setStep('connect')}
                  className="group rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-4 text-left transition hover:border-[var(--loom-accent)] hover:bg-[var(--loom-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
                >
                  <span className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-[var(--loom-surface-3)] text-[var(--loom-accent)]"><Library className="h-5 w-5" /></span>
                  <span className="flex items-center justify-between gap-3 text-lg font-semibold">Connect to a host <ArrowRight className="h-4 w-4 text-[var(--loom-muted)] transition-transform group-hover:translate-x-1 group-hover:text-[var(--loom-accent)]" /></span>
                  <span className="mt-2 block text-sm leading-6 text-[var(--loom-muted)]">Find and connect to a host on your network.</span>
                </button>
              </div>
            </section>
          </main>
        ) : (
          <main className={`mx-auto flex ${contentWidth} flex-1 flex-col py-12 lg:py-16`}>
            <div className="mb-6 flex flex-col items-center text-center">
              <LoomBrandLockup className="mb-4 h-20 w-[108px]" />
              <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">Connect to a host</h1>
              <p className="mt-2 max-w-md text-sm leading-6 text-[var(--loom-muted)]">Pick your LoomTV host below, then enter the 6-digit PIN it shows under Settings → Network.</p>
            </div>

            <section className="overflow-hidden rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] shadow-2xl shadow-black/20">
              <div className="flex items-center justify-between gap-4 border-b border-[var(--loom-border)] px-5 py-4 sm:px-6">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold">Hosts on this network</h2>
                  <p className="mt-0.5 truncate text-sm text-[var(--loom-muted)]">
                    {isScanning ? 'Looking for hosts…' : peers.length ? 'Select the one you want to connect to.' : 'Make sure Local Network Sharing is on over there.'}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void scan()} disabled={isScanning} className="shrink-0 gap-2">
                  {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {isScanning ? 'Scanning' : 'Rescan'}
                </Button>
              </div>

              <div className="grid gap-2 px-5 py-4 sm:px-6">
                {isScanning && peers.length === 0 ? (
                  <div className="flex items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--loom-border)] bg-[var(--loom-bg)] py-9 text-sm text-[var(--loom-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Looking for LoomTV hosts…
                  </div>
                ) : peers.length ? peers.map((peer) => {
                  const peerAddress = `https://${peer.host}:${peer.port}`;
                  const selected = address === peerAddress;
                  return (
                    <div key={peer.deviceId}>
                      <button
                        type="button"
                        onClick={() => { setAddress(peerAddress); setMessage(''); }}
                        aria-pressed={selected}
                        className={`flex min-h-16 w-full items-center gap-3 rounded-xl border px-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${selected ? 'border-[var(--loom-accent)] bg-[var(--loom-active-bg)]' : 'border-[var(--loom-border)] bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-2)]'}`}
                      >
                        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${selected ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-[var(--loom-surface-3)] text-[var(--loom-muted)]'}`}><Laptop2 className="h-5 w-5" /></span>
                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{peer.deviceName}</span><span className="block truncate text-xs text-[var(--loom-muted)]">{peer.host}:{peer.port}</span></span>
                        {selected && <Check className="h-5 w-5 shrink-0 stroke-[2.5] text-[var(--loom-accent)]" aria-hidden="true" />}
                      </button>
                      {selected && (
                        <PairBar
                          hostLabel={peer.deviceName}
                          pin={pin}
                          setPin={setPin}
                          onConnect={() => void connect()}
                          isConnecting={isConnecting}
                          autoFocusPin
                        />
                      )}
                    </div>
                  );
                }) : (
                  <div className="rounded-xl border border-dashed border-[var(--loom-border)] bg-[var(--loom-bg)] px-4 py-8 text-center text-sm text-[var(--loom-muted)]">
                    No hosts found automatically. Enter the address manually below.
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--loom-border)] px-5 py-4 sm:px-6">
                <button
                  type="button"
                  onClick={() => setShowManual((current) => !current)}
                  className="rounded text-sm font-medium text-[var(--loom-accent)] outline-none transition hover:underline focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
                >
                  {showManual ? 'Hide manual address' : "Can't find your host? Enter its address manually"}
                </button>

                {showManual && (
                  <div className="mt-4 space-y-4">
                    <label className="grid min-w-0 gap-2 text-xs font-semibold text-[var(--loom-muted)]">
                      Host IP address and port
                      <input
                        value={address}
                        onChange={(event) => setAddress(event.target.value)}
                        placeholder="192.168.1.50:3848"
                        autoCapitalize="none"
                        spellCheck={false}
                        className="h-12 w-full min-w-0 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-bg)] px-4 text-sm text-[var(--loom-text)] outline-none transition placeholder:text-[var(--loom-muted)]/60 focus:border-[var(--loom-accent)] focus:ring-1 focus:ring-[var(--loom-accent)]"
                      />
                    </label>
                    {address.trim() && !peers.some((peer) => `https://${peer.host}:${peer.port}` === address.trim()) && (
                      <PairBar
                        hostLabel={address}
                        pin={pin}
                        setPin={setPin}
                        onConnect={() => void connect()}
                        isConnecting={isConnecting}
                      />
                    )}
                  </div>
                )}

                {initialMessage && <p role="status" className="mt-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-4 py-3 text-sm leading-5 text-[var(--loom-muted)]">{initialMessage}</p>}
                {message && (
                  <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm leading-5 text-red-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{message}</span>
                  </p>
                )}
              </div>
            </section>
          </main>
        )}
      </div>
    </div>
  );
}

/**
 * Contextual pairing bar shown under a selected host (or a manually entered
 * address): the 6-digit PIN prompt and the Connect action, so pairing reads as
 * "pick a host → type the PIN it shows → connect" rather than a form.
 */
function PairBar({
  hostLabel,
  pin,
  setPin,
  onConnect,
  isConnecting,
  autoFocusPin = false,
}: {
  hostLabel: string;
  pin: string;
  setPin: (value: string) => void;
  onConnect: () => void;
  isConnecting: boolean;
  autoFocusPin?: boolean;
}) {
  const ready = /^\d{6}$/.test(pin);
  return (
    <div className="mt-2 rounded-xl border border-[var(--loom-accent)]/40 bg-[var(--loom-bg)] p-4">
      <p className="text-xs font-semibold text-[var(--loom-muted)]">
        Enter the 6-digit PIN shown on <span className="text-[var(--loom-text)]">{hostLabel}</span>
      </p>
      <div
        className="mt-2 flex flex-col gap-3 sm:flex-row"
        onKeyDown={(event) => { if (event.key === 'Enter' && ready) onConnect(); }}
      >
        <PinDigitInput
          value={pin}
          onChange={setPin}
          length={6}
          label="Six-digit pairing PIN"
          digitLabel="Pairing PIN digit"
          autoFocus={autoFocusPin}
          className="min-w-0 gap-1.5"
          inputClassName="h-10 w-10 rounded-lg bg-[var(--loom-surface)] text-base"
        />
        <Button
          size="lg"
          onClick={onConnect}
          disabled={isConnecting || !ready}
          className="h-12 flex-1 gap-2 rounded-xl font-semibold"
        >
          {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
          {isConnecting ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}

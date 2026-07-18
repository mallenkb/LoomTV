import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Laptop2, Library, Loader2, RefreshCw, Server, Wifi } from 'lucide-react';
import LoomBrandLockup from './LoomBrandLockup';
import { Button } from './ui/button';
import { desktopApi, type LocalNetworkPeer } from '@/lib/desktopApi';

type OnboardingChoice = 'choose' | 'connect';

export default function DesktopOnboarding({
  onHostReady,
  onRemoteReady,
}: {
  onHostReady: () => void;
  onRemoteReady: () => void;
}) {
  const [step, setStep] = useState<OnboardingChoice>('choose');
  const [peers, setPeers] = useState<LocalNetworkPeer[]>([]);
  const [address, setAddress] = useState('');
  const [pin, setPin] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [message, setMessage] = useState('');

  const scan = useCallback(async () => {
    setIsScanning(true);
    setMessage('');
    try {
      setPeers(await desktopApi.discoverLocalNetworkPeers(3000));
    } catch {
      setPeers([]);
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
      const connection = await desktopApi.connectToLocalNetworkLibrary(address, pin);
      desktopApi.activateRemoteLibrary(connection);
      onRemoteReady();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not connect to that LoomTV host.');
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="fixed inset-0 overflow-y-auto bg-[var(--loom-bg)] text-[var(--loom-text)]">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 py-10">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <LoomBrandLockup className="h-12 w-16" />
            <div>
              <p className="text-sm font-semibold">LoomTV</p>
              <p className="text-xs text-[var(--loom-muted)]">Desktop setup</p>
            </div>
          </div>
          {step === 'connect' && (
            <Button variant="ghost" onClick={() => { setStep('choose'); setMessage(''); }} className="gap-2">
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          )}
        </header>

        {step === 'choose' ? (
          <main className="flex flex-1 flex-col justify-center py-14">
            <div className="mb-10 max-w-2xl">
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-[var(--loom-accent)]">Welcome to LoomTV</p>
              <h1 className="text-[clamp(34px,5vw,64px)] font-bold leading-[1.05]">Where is your library?</h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-[var(--loom-muted)]">
                Set up this computer as a new host, or connect it to a LoomTV host that already has your library and profiles.
              </p>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <button
                type="button"
                onClick={() => { desktopApi.useThisComputerAsHost(); onHostReady(); }}
                className="group min-h-56 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-7 text-left transition hover:border-[var(--loom-accent)] hover:bg-[var(--loom-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              >
                <span className="mb-8 grid h-12 w-12 place-items-center rounded-xl bg-[var(--loom-surface-3)] text-[var(--loom-accent)]"><Server className="h-6 w-6" /></span>
                <span className="flex items-center justify-between gap-4 text-xl font-semibold">Start fresh <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" /></span>
                <span className="mt-3 block text-sm leading-6 text-[var(--loom-muted)]">Create a new local library on this computer and add your media folders.</span>
              </button>
              <button
                type="button"
                onClick={() => setStep('connect')}
                className="group min-h-56 rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-7 text-left transition hover:border-[var(--loom-accent)] hover:bg-[var(--loom-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)]"
              >
                <span className="mb-8 grid h-12 w-12 place-items-center rounded-xl bg-[var(--loom-surface-3)] text-[var(--loom-accent)]"><Library className="h-6 w-6" /></span>
                <span className="flex items-center justify-between gap-4 text-xl font-semibold">Connect to an existing host <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" /></span>
                <span className="mt-3 block text-sm leading-6 text-[var(--loom-muted)]">Use the library, profiles, watch progress, and preferences already stored on another LoomTV computer.</span>
              </button>
            </div>
          </main>
        ) : (
          <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center py-12">
            <div className="mb-8">
              <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-[var(--loom-accent)]">Existing host</p>
              <h1 className="text-4xl font-bold">Connect this laptop</h1>
              <p className="mt-3 text-sm leading-6 text-[var(--loom-muted)]">On the host, turn on Local Network Sharing and keep Settings → Network open to see the current 6-digit PIN.</p>
            </div>

            <section className="rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] p-6">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-semibold">Hosts on this network</h2>
                  <p className="text-xs text-[var(--loom-muted)]">Select a discovered host or enter its address manually.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void scan()} disabled={isScanning} className="gap-2">
                  {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {isScanning ? 'Scanning' : 'Rescan'}
                </Button>
              </div>

              <div className="mb-6 grid gap-2">
                {peers.length ? peers.map((peer) => {
                  const peerAddress = `http://${peer.host}:${peer.port}`;
                  const selected = address === peerAddress;
                  return (
                    <button
                      key={peer.deviceId}
                      type="button"
                      onClick={() => setAddress(peerAddress)}
                      className={`flex min-h-14 items-center gap-3 rounded-xl border px-4 text-left transition ${selected ? 'border-[var(--loom-accent)] bg-[var(--loom-active-bg)]' : 'border-[var(--loom-border)] bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-2)]'}`}
                    >
                      <Laptop2 className={`h-5 w-5 ${selected ? 'text-[var(--loom-accent)]' : 'text-[var(--loom-muted)]'}`} />
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{peer.deviceName}</span><span className="block truncate text-xs text-[var(--loom-muted)]">{peer.host}:{peer.port}</span></span>
                    </button>
                  );
                }) : (
                  <div className="rounded-xl border border-dashed border-[var(--loom-border)] px-4 py-5 text-center text-sm text-[var(--loom-muted)]">
                    {isScanning ? 'Looking for LoomTV hosts…' : 'No host was found automatically.'}
                  </div>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-[1fr_190px]">
                <label className="grid gap-2 text-xs font-medium text-[var(--loom-muted)]">
                  Host IP address and port
                  <input
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="192.168.1.50:3847"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="h-11 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 text-sm text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]"
                  />
                </label>
                <label className="grid gap-2 text-xs font-medium text-[var(--loom-muted)]">
                  Pairing PIN
                  <input
                    value={pin}
                    onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={(event) => { if (event.key === 'Enter') void connect(); }}
                    placeholder="000000"
                    inputMode="numeric"
                    maxLength={6}
                    className="h-11 rounded-lg border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 text-center text-sm font-semibold tracking-[0.3em] text-[var(--loom-text)] outline-none focus:border-[var(--loom-accent)]"
                  />
                </label>
              </div>

              {message && <p role="alert" className="mt-4 rounded-lg bg-[var(--loom-surface-2)] px-3 py-2 text-sm text-[var(--loom-muted)]">{message}</p>}

              <Button
                size="lg"
                onClick={() => void connect()}
                disabled={isConnecting || !address.trim() || !/^\d{6}$/.test(pin)}
                className="mt-6 w-full gap-2"
              >
                {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
                {isConnecting ? 'Connecting to host…' : 'Connect and choose a profile'}
              </Button>
            </section>
          </main>
        )}
      </div>
    </div>
  );
}

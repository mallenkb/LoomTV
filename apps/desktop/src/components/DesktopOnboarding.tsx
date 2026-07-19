import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Check, Laptop2, Library, Loader2, RefreshCw, Server, Wifi } from 'lucide-react';
import LoomBrandLockup from './LoomBrandLockup';
import { Button } from './ui/button';
import { desktopApi, type LocalNetworkPeer } from '@/lib/desktopApi';

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
        <header className="relative flex min-h-10 items-center">
          {step === 'connect' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setStep('choose'); setMessage(''); }}
              className="gap-2"
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
          )}
        </header>

        {step === 'choose' ? (
          <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col py-12 lg:py-16">
            <div className="flex flex-col items-center text-center">
              <LoomBrandLockup className="mb-6 h-10 w-[54px]" />
              <h1 className="text-[clamp(32px,4.5vw,52px)] font-bold leading-[1.08] tracking-tight">Where is your library?</h1>
              <p className="mt-4 max-w-md text-base leading-7 text-[var(--loom-muted)]">
                Host a new library on this computer, or connect to one already on your network.
              </p>
            </div>
            <div className="mt-12 grid w-full gap-4 sm:grid-cols-2">
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
          </main>
        ) : (
          <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col py-12 lg:py-16">
            <div className="mb-8 flex flex-col items-center text-center">
              <LoomBrandLockup className="mb-6 h-10 w-[54px]" />
              <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">Connect to a host</h1>
              <p className="mt-3 max-w-md text-sm leading-6 text-[var(--loom-muted)]">On the host, turn on Local Network Sharing, then find the 6-digit PIN in Settings → Network.</p>
            </div>

            <section className="overflow-hidden rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)] shadow-2xl shadow-black/20">
              <div className="flex items-start justify-between gap-4 border-b border-[var(--loom-border)] px-5 py-5 sm:px-6">
                <div>
                  <h2 className="text-base font-semibold">Hosts on this network</h2>
                  <p className="mt-1 text-sm text-[var(--loom-muted)]">Choose a discovered host or enter its address manually.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void scan()} disabled={isScanning} className="shrink-0 gap-2">
                  {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {isScanning ? 'Scanning' : 'Rescan'}
                </Button>
              </div>

              <div className="grid gap-2 px-5 py-4 sm:px-6">
                {peers.length ? peers.map((peer) => {
                  const peerAddress = `http://${peer.host}:${peer.port}`;
                  const selected = address === peerAddress;
                  return (
                    <button
                      key={peer.deviceId}
                      type="button"
                      onClick={() => setAddress(peerAddress)}
                      aria-pressed={selected}
                      className={`flex min-h-16 items-center gap-3 rounded-xl border px-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--loom-accent)] ${selected ? 'border-[var(--loom-accent)] bg-[var(--loom-active-bg)]' : 'border-[var(--loom-border)] bg-[var(--loom-bg)] hover:bg-[var(--loom-surface-2)]'}`}
                    >
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${selected ? 'bg-[var(--loom-accent)] text-[var(--loom-accent-foreground)]' : 'bg-[var(--loom-surface-3)] text-[var(--loom-muted)]'}`}><Laptop2 className="h-5 w-5" /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{peer.deviceName}</span><span className="block truncate text-xs text-[var(--loom-muted)]">{peer.host}:{peer.port}</span></span>
                      {selected && <Check className="h-5 w-5 shrink-0 stroke-[2.5] text-[var(--loom-accent)]" aria-hidden="true" />}
                    </button>
                  );
                }) : (
                  <div className="rounded-xl border border-dashed border-[var(--loom-border)] bg-[var(--loom-bg)] px-4 py-5 text-center text-sm text-[var(--loom-muted)]">
                    {isScanning ? 'Looking for LoomTV hosts…' : 'No host was found automatically.'}
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--loom-border)] px-5 py-5 sm:px-6">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9.5rem]">
                  <label className="grid min-w-0 gap-2 text-xs font-semibold text-[var(--loom-muted)]">
                    Host IP address and port
                    <input
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                      placeholder="192.168.1.50:3847"
                      autoCapitalize="none"
                      spellCheck={false}
                      className="h-12 w-full min-w-0 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-bg)] px-4 text-sm text-[var(--loom-text)] outline-none transition placeholder:text-[var(--loom-muted)]/60 focus:border-[var(--loom-accent)] focus:ring-1 focus:ring-[var(--loom-accent)]"
                    />
                  </label>
                  <label className="grid min-w-0 gap-2 text-xs font-semibold text-[var(--loom-muted)]">
                    Pairing PIN
                    <input
                      value={pin}
                      onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      onKeyDown={(event) => { if (event.key === 'Enter') void connect(); }}
                      placeholder="000000"
                      inputMode="numeric"
                      maxLength={6}
                      className="h-12 w-full min-w-0 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-bg)] px-3 text-center text-base font-semibold tracking-[0.2em] text-[var(--loom-text)] outline-none transition placeholder:text-[var(--loom-muted)]/45 focus:border-[var(--loom-accent)] focus:ring-1 focus:ring-[var(--loom-accent)]"
                    />
                  </label>
                </div>

                {initialMessage && <p role="status" className="mt-4 rounded-xl border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-4 py-3 text-sm leading-5 text-[var(--loom-muted)]">{initialMessage}</p>}
                {message && (
                  <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm leading-5 text-red-200">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{message}</span>
                  </p>
                )}

                <Button
                  size="lg"
                  onClick={() => void connect()}
                  disabled={isConnecting || !address.trim() || !/^\d{6}$/.test(pin)}
                  className="mt-5 h-12 w-full gap-2 rounded-xl font-semibold"
                >
                  {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
                  {isConnecting ? 'Connecting to host…' : 'Connect and choose a profile'}
                </Button>
              </div>
            </section>
          </main>
        )}
      </div>
    </div>
  );
}

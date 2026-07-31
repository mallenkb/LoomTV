import { useMemo, useState } from 'react';
import { Bookmark, Lock, Users } from 'lucide-react';
import { useProfiles } from '@/contexts/ProfileContext';
import { useLibrary, type MediaItem } from '@/contexts/LibraryContext';
import ProfileAvatar from '@/components/profiles/ProfileAvatar';
import PinDigitInput from '@/components/profiles/PinDigitInput';
import MediaPosterCard from '@/components/MediaPosterCard';
import MediaRail from '@/components/MediaRail';
import { mediaMetaLine } from '@/components/MediaPosterCard.helpers';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function ProfilesSettingsSection() {
  const {
    activeProfile,
    activeState,
    changeProfilePin,
    lockProfile,
    openGate,
    setAutomaticSignIn,
    lists,
  } = useProfiles();
  const { state: libraryState } = useLibrary();
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [showRemovePinConfirm, setShowRemovePinConfirm] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const savedItems = useMemo(() => {
    const byId = new Map([...libraryState.movies, ...libraryState.tvShows, ...libraryState.animeShows].map((item) => [item.id, item]));
    const seen = new Set<string>();
    return lists
      .filter((entry) => entry.kind === 'watchlist' || entry.kind === 'favorite')
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((entry) => {
        if (seen.has(entry.mediaId)) return false;
        seen.add(entry.mediaId);
        return true;
      })
      .map((entry) => byId.get(entry.mediaId))
      .filter((item): item is MediaItem => Boolean(item));
  }, [libraryState.animeShows, libraryState.movies, libraryState.tvShows, lists]);
  const favoriteItems = useMemo(() => {
    const byId = new Map([...libraryState.movies, ...libraryState.tvShows, ...libraryState.animeShows].map((item) => [item.id, item]));
    return lists
      .filter((entry) => entry.kind === 'favorite')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((entry) => byId.get(entry.mediaId))
      .filter((item): item is MediaItem => Boolean(item));
  }, [libraryState.animeShows, libraryState.movies, libraryState.tvShows, lists]);
  if (!activeProfile) return null;

  const handleLock = async () => {
    if (!activeProfile.hasPin && !activeProfile.isGuest) {
      setShowPinSetup(true);
      return;
    }
    await lockProfile();
  };

  const savePinAndLock = async () => {
    if (!/^\d{4}$/.test(pin) || pinBusy) return;
    setPinBusy(true);
    setPinError('');
    try {
      await changeProfilePin(activeProfile.id, pin);
      setPin('');
      setShowPinSetup(false);
      await lockProfile();
    } catch (error) {
      setPinError(error instanceof Error ? error.message : 'The PIN could not be saved.');
    } finally {
      setPinBusy(false);
    }
  };

  const removePin = async () => {
    if (pinBusy) return;
    setPinBusy(true);
    setPinError('');
    try {
      await changeProfilePin(activeProfile.id, null);
      setShowRemovePinConfirm(false);
    } catch (error) {
      setPinError(error instanceof Error ? error.message : 'The PIN could not be removed.');
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <section className="space-y-5 rounded-2xl border border-[var(--loom-panel-border)] bg-[var(--loom-panel)] p-6">
      <div className="flex items-center gap-4">
        <ProfileAvatar name={activeProfile.name} avatarKey={activeProfile.avatarKey} colorKey={activeProfile.colorKey} className="h-16 w-16 rounded-full" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold">{activeProfile.name}</h2>
          <p className="text-sm capitalize text-[var(--loom-muted)]">{activeProfile.type} profile</p>
        </div>
        <button type="button" onClick={() => openGate()} className="flex items-center gap-2 rounded-lg bg-[var(--loom-surface-2)] px-4 py-2 text-sm font-medium hover:bg-[var(--loom-surface-3)]">
          <Users className="h-4 w-4" /> {activeProfile.type === 'owner' ? 'Switch or manage' : 'Switch profile'}
        </button>
        <button type="button" onClick={() => void handleLock()} className="flex items-center gap-2 rounded-lg border border-[var(--loom-surface-3)] px-4 py-2 text-sm text-[var(--loom-muted)] hover:text-[var(--loom-text)]">
          <Lock className="h-4 w-4" /> Lock
        </button>
        {activeProfile.hasPin && !activeProfile.isGuest && (
          <button type="button" onClick={() => setShowRemovePinConfirm(true)} className="rounded-lg border border-[var(--loom-surface-3)] px-4 py-2 text-sm text-[var(--loom-muted)] hover:text-[var(--loom-text)]">
            Remove PIN
          </button>
        )}
      </div>

      {!activeProfile.hasPin && !activeProfile.isGuest && (
        <label className="flex items-center justify-between gap-3 border-t border-[var(--loom-surface-3)] pt-5 text-sm">
          Automatically sign in as {activeProfile.name} on this device
          <input type="checkbox" checked={activeState.automaticSignIn} onChange={(event) => void setAutomaticSignIn(event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />
        </label>
      )}

      <section className="space-y-5 border-t border-[var(--loom-surface-3)] pt-5">
        <div className="flex items-start gap-3">
          <Bookmark className="mt-0.5 h-4 w-4 shrink-0 text-[var(--loom-accent)]" />
          <div>
            <h3 className="text-sm font-semibold">Saved titles</h3>
            <p className="mt-1 text-xs text-[var(--loom-muted)]">Bookmarks and favorites belong to {activeProfile.name} and are only shown for this profile.</p>
          </div>
        </div>
        {savedItems.length > 0 ? (
          <MediaRail title="My List" variant="modern">
            {savedItems.slice(0, 24).map((item) => (
              <MediaPosterCard key={item.id} item={item} from="/settings" variant="home" metaLine={mediaMetaLine(item)} />
            ))}
          </MediaRail>
        ) : (
          <p className="rounded-xl border border-dashed border-[var(--loom-surface-3)] px-4 py-5 text-center text-sm text-[var(--loom-muted)]">
            No saved titles yet. Use the bookmark button on a movie or show to add one.
          </p>
        )}
        {favoriteItems.length > 0 && (
          <MediaRail title="Favorites" variant="modern">
            {favoriteItems.slice(0, 24).map((item) => (
              <MediaPosterCard key={item.id} item={item} from="/settings" variant="home" metaLine={mediaMetaLine(item)} />
            ))}
          </MediaRail>
        )}
      </section>

      <Dialog
        open={showPinSetup}
        onOpenChange={(open) => {
          if (pinBusy) return;
          setShowPinSetup(open);
          if (!open) {
            setPin('');
            setPinError('');
          }
        }}
        contentClassName="max-w-md border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set a profile PIN</DialogTitle>
            <p className="text-sm text-[var(--loom-muted)]">Enter four digits to protect {activeProfile.name}. Automatic sign-in will be turned off.</p>
          </DialogHeader>
          <form className="mt-6 space-y-5" onSubmit={(event) => { event.preventDefault(); void savePinAndLock(); }}>
            <div className="flex flex-col gap-1.5 text-sm">
              Four-digit PIN
              <PinDigitInput
                value={pin}
                onChange={(value) => { setPin(value); setPinError(''); }}
                autoFocus
                disabled={pinBusy}
              />
            </div>
            {pinError && <p role="alert" className="text-sm text-red-400">{pinError}</p>}
            <div className="flex justify-end gap-3">
              <button type="button" disabled={pinBusy} onClick={() => { setShowPinSetup(false); setPin(''); setPinError(''); }} className="rounded-lg border border-[var(--loom-surface-3)] px-4 py-2.5 text-sm text-[var(--loom-muted)] hover:text-[var(--loom-text)]">
                Cancel
              </button>
              <button type="submit" disabled={pin.length !== 4 || pinBusy} className="rounded-lg bg-[var(--loom-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--loom-accent-foreground)] disabled:opacity-40">
                Save PIN &amp; Lock
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showRemovePinConfirm}
        onOpenChange={(open) => {
          if (pinBusy) return;
          setShowRemovePinConfirm(open);
          if (!open) setPinError('');
        }}
        contentClassName="max-w-md border-[var(--loom-panel-border)] bg-[var(--loom-panel)] text-[var(--loom-text)]"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove profile PIN?</DialogTitle>
            <p className="text-sm text-[var(--loom-muted)]">{activeProfile.name} will no longer require a PIN to enter on this device.</p>
          </DialogHeader>
          {pinError && <p role="alert" className="mt-4 text-sm text-red-400">{pinError}</p>}
          <div className="mt-6 flex justify-end gap-3">
            <button type="button" disabled={pinBusy} onClick={() => setShowRemovePinConfirm(false)} className="rounded-lg border border-[var(--loom-surface-3)] px-4 py-2.5 text-sm text-[var(--loom-muted)] hover:text-[var(--loom-text)]">
              Cancel
            </button>
            <button type="button" disabled={pinBusy} onClick={() => void removePin()} className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">
              Remove PIN
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

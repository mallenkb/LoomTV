import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ImagePlus, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { cn } from '@/lib/utils';
import { useProfiles } from '@/contexts/ProfileContext';
import { desktopApi, type ProfileSummary } from '@/lib/desktopApi';
import ProfileAvatar, { PROFILE_AVATAR_KEYS, PROFILE_COLOR_KEYS, PROFILE_COLOR_PRESETS } from './ProfileAvatar';
import PinDigitInput from './PinDigitInput';
import LoomLogo from '@/components/LoomLogo';
import { useModalLayer } from '@/components/ui/dialog';

type GateMode = 'select' | 'edit';
type EditorTarget = ProfileSummary | 'new';
type EditorOrigin = 'gate' | 'source';

/**
 * Full-window profile gate: the Who's Watching picker, its in-place Edit
 * profiles mode, and the focused profile detail editor. It is the startup
 * surface and becomes an overlay when opened from an active profile.
 */
export default function ProfileGate({ initialSetup = null }: { initialSetup?: 'host' | 'remote' | null }) {
  const { activeProfile, canCreateProfiles, canManageProfiles, clearGateIntent, closeGate, gateIntent, importProfile, profiles, reorderProfiles, resetOwnerProfile, selectProfile } = useProfiles();
  const [mode, setMode] = useState<GateMode>('select');
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [editorOrigin, setEditorOrigin] = useState<EditorOrigin>('gate');
  const [setupMode, setSetupMode] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const initialRoutedRef = useRef(false);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);
  const [pinTarget, setPinTarget] = useState<ProfileSummary | null>(null);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const focusRestoreId = useRef<string | null>(null);
  const gateRef = useRef<HTMLDivElement | null>(null);
  const canManage = canManageProfiles;

  const closeAndReturn = useCallback(() => {
    const destination = returnTo;
    const current = `${location.pathname}${location.search}${location.hash}`;
    closeGate();
    if (destination && destination !== current) {
      navigate(destination, { replace: true });
    }
  }, [closeGate, returnTo, location.hash, location.pathname, location.search, navigate]);

  const closeEditor = useCallback(() => {
    setEditorTarget(null);
    setSetupMode(false);
    if (editorOrigin === 'source') closeAndReturn();
  }, [closeAndReturn, editorOrigin]);

  const handleGateEscape = useCallback(() => {
    if (pinTarget) setPinTarget(null);
    else if (editorTarget) closeEditor();
    else if (mode === 'edit') setMode('select');
    else if (activeProfile) closeAndReturn();
  }, [activeProfile, closeAndReturn, closeEditor, editorTarget, mode, pinTarget]);

  useModalLayer({
    contentRef: gateRef,
    onEscape: handleGateEscape,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLSelectElement) return;
      const controls = [...document.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        .filter((button) => button.offsetParent !== null);
      if (controls.length === 0) return;
      const current = activeElement instanceof HTMLButtonElement ? activeElement : controls[0];
      // Read every rect exactly once up front; interleaving layout reads with
      // the direction/scoring passes below would force repeated reflows.
      const centers = controls.map((button) => {
        const rect = button.getBoundingClientRect();
        return { button, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      const origin = centers.find((entry) => entry.button === current) ?? centers[0];
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      let next: HTMLButtonElement | null = null;
      let bestScore = Infinity;
      for (const entry of centers) {
        if (entry.button === current) continue;
        const dx = entry.x - origin.x;
        const dy = entry.y - origin.y;
        const inDirection = event.key === 'ArrowLeft' ? dx < -4
          : event.key === 'ArrowRight' ? dx > 4
            : event.key === 'ArrowUp' ? dy < -4
              : dy > 4;
        if (!inDirection) continue;
        const score = horizontal ? Math.abs(dx) + Math.abs(dy) * 2 : Math.abs(dy) + Math.abs(dx) * 2;
        if (score < bestScore) {
          bestScore = score;
          next = entry.button;
        }
      }
      if (next) {
        event.preventDefault();
        next.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeProfile, closeAndReturn, closeEditor, editorTarget, mode, pinTarget]);

  // Sidebar and Settings can deep-link into the exact profile flow without
  // making the user repeat their selection inside the full-screen gate.
  useEffect(() => {
    if (!gateIntent) return;
    if (gateIntent.mode === 'edit' && (canManage || (gateIntent.editProfileId === 'new' && canCreateProfiles))) {
      setReturnTo(gateIntent.returnTo ?? null);
      setMode('edit');
      if (gateIntent.editProfileId === 'new') {
        setEditorOrigin('source');
        setEditorTarget('new');
      } else if (gateIntent.editProfileId) {
        const target = profiles.find((profile) => profile.id === gateIntent.editProfileId);
        if (target) {
          setEditorOrigin('source');
          setEditorTarget(target);
        }
      }
    } else if (gateIntent.mode === 'select') {
      setReturnTo(gateIntent.returnTo ?? null);
      setMode('select');
      const target = profiles.find((profile) => profile.id === gateIntent.profileId);
      if (target?.hasPin) setPinTarget(target);
    }
    clearGateIntent();
  }, [gateIntent, canCreateProfiles, canManage, profiles, clearGateIntent]);

  useEffect(() => {
    if (gateIntent) return;
    setReturnTo(null);
  }, [gateIntent]);

  const handleSelect = useCallback(async (profile: ProfileSummary) => {
    focusRestoreId.current = profile.id;
    setBusyProfileId(profile.id);
    try {
      if (profile.hasPin) {
        setPinTarget(profile);
        return;
      }
      await selectProfile(profile.id);
    } finally {
      setBusyProfileId(null);
    }
  }, [selectProfile]);

  useEffect(() => {
    if (editorTarget || pinTarget || !focusRestoreId.current) return;
    const profileId = focusRestoreId.current;
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-profile-id="${CSS.escape(profileId)}"]`)?.focus());
  }, [editorTarget, pinTarget]);

  // First run after onboarding: a fresh host starts with only the auto-created
  // Owner, so send the user straight into setting up that first profile
  // (Disney+/Netflix style). Connecting to an existing host keeps the default
  // "Who's watching?" picker, which already offers both choosing an existing
  // profile and adding a new one.
  useEffect(() => {
    if (initialRoutedRef.current) return;
    initialRoutedRef.current = true;
    if (initialSetup !== 'host' || activeProfile) return;
    const owner = profiles.find((profile) => profile.type === 'owner');
    if (owner) {
      setEditorOrigin('gate');
      setSetupMode(true);
      setEditorTarget(owner);
    }
  }, [initialSetup, activeProfile, profiles]);

  return (
    <div
      ref={gateRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-gate-title"
      aria-describedby="profile-gate-description"
      tabIndex={-1}
      data-modal-layer="profile-gate"
      className="loom-no-drag fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[var(--loom-bg)] text-[var(--loom-text)]"
    >
      <h1 id="profile-gate-title" className="sr-only">Profile selection</h1>
      <p id="profile-gate-description" className="sr-only">Choose or manage the profile that is watching on this device.</p>
      {!editorTarget && <header className="flex min-h-28 items-center justify-between px-6 pb-6 pt-14">
        {mode === 'select' && activeProfile && !editorTarget && !pinTarget ? (
          <button
            type="button"
            onClick={closeAndReturn}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--loom-border)] px-4 py-2 text-sm font-medium text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        ) : mode === 'edit' && !pinTarget ? (
          <button
            type="button"
            onClick={returnTo ? closeAndReturn : () => setMode('select')}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--loom-border)] px-4 py-2 text-sm font-medium text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        ) : <span />}
        {!editorTarget && !pinTarget && (
          <div className="flex items-center gap-3">
            {mode === 'select' && canManage && (
              <button
                type="button"
                onClick={() => setMode('edit')}
                className="rounded-lg border border-[var(--loom-surface-3)] px-5 py-2 text-sm font-medium text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-text)] hover:text-[var(--loom-text)]"
              >
                Edit Profiles
              </button>
            )}
            {mode === 'edit' && (
              <button type="button" onClick={() => setMode('select')} className="rounded-lg bg-[var(--loom-accent)] px-5 py-2 text-sm font-bold uppercase tracking-wide text-[var(--loom-accent-foreground)] hover:opacity-90">
                Done
              </button>
            )}
          </div>
        )}
      </header>}

      {pinTarget ? (
        <ProfilePinPad
          profile={pinTarget}
          onBack={() => setPinTarget(null)}
          onSubmit={async (pin) => {
            await selectProfile(pinTarget.id, pin);
            setPinTarget(null);
          }}
          onResetOwner={pinTarget.type === 'owner' ? resetOwnerProfile : undefined}
        />
      ) : editorTarget ? (
        <ProfileDetailEditor
          target={editorTarget}
          setupMode={setupMode}
          onClose={closeEditor}
        />
      ) : (
        <main className="flex flex-1 flex-col items-center justify-center px-8 pb-[8vh]">
          <LoomLogo className="mb-8 h-9 w-auto" />
          <h1 className="mb-2 text-center text-[clamp(26px,3.2vw,40px)] font-bold">
            {mode === 'select' ? "Who's watching?" : 'Edit profiles'}
          </h1>
          {mode === 'edit' && (
            <p className="mb-8 text-center text-sm text-[var(--loom-muted)]">Select a profile to edit</p>
          )}
          {mode === 'select' && <div className="mb-8" />}
          <div className="flex max-w-[900px] flex-wrap items-start justify-center gap-[clamp(16px,3vw,44px)]">
            {profiles.filter((profile) => !profile.isGuest).map((profile, index, permanentProfiles) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                active={profile.id === activeProfile?.id}
                editMode={mode === 'edit'}
                busy={busyProfileId === profile.id}
                onClick={() => {
                  focusRestoreId.current = profile.id;
                  if (mode === 'edit') {
                    setEditorOrigin('gate');
                    setEditorTarget(profile);
                  }
                  else void handleSelect(profile);
                }}
                move={mode === 'edit' && canManage ? {
                  canMoveBack: index > 0,
                  canMoveForward: index < permanentProfiles.length - 1,
                  onMoveBack: () => void reorderProfiles([
                    ...permanentProfiles.slice(0, index - 1).map((item) => item.id),
                    profile.id,
                    permanentProfiles[index - 1].id,
                    ...permanentProfiles.slice(index + 1).map((item) => item.id),
                  ]),
                  onMoveForward: () => void reorderProfiles([
                    ...permanentProfiles.slice(0, index).map((item) => item.id),
                    permanentProfiles[index + 1].id,
                    profile.id,
                    ...permanentProfiles.slice(index + 2).map((item) => item.id),
                  ]),
                } : undefined}
              />
            ))}
            {mode === 'select' && canCreateProfiles && <AddProfileCard onClick={() => { setEditorOrigin('gate'); setEditorTarget('new'); }} />}
            {mode === 'edit' && canManage && <AddProfileCard onClick={() => { setEditorOrigin('gate'); setEditorTarget('new'); }} />}
          </div>
          {mode === 'edit' && canManage && (
            <button
              type="button"
              onClick={() => void importProfile().then((result) => setTransferMessage(
                result.ok
                  ? `Imported ${result.profile?.name || 'profile'} · ${result.importedProgress || 0} progress entries · ${result.importedLists || 0} list entries`
                  : result.error || null,
              ))}
              className="mt-8 rounded-lg border border-[var(--loom-surface-3)] px-5 py-2.5 text-sm font-medium text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-text)] hover:text-[var(--loom-text)]"
            >
              Import Profile
            </button>
          )}
          {transferMessage && <p className="mt-3 text-center text-xs text-[var(--loom-muted)]">{transferMessage}</p>}
        </main>
      )}
    </div>
  );
}

function ProfileCard({
  profile,
  active,
  editMode,
  busy,
  onClick,
  move,
}: {
  profile: ProfileSummary;
  active: boolean;
  editMode: boolean;
  busy: boolean;
  onClick: () => void;
  move?: {
    canMoveBack: boolean;
    canMoveForward: boolean;
    onMoveBack: () => void;
    onMoveForward: () => void;
  };
}) {
  return (
    <div className="flex w-[clamp(112px,12vw,200px)] flex-col items-center">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-current={active ? 'true' : undefined}
        data-profile-id={profile.id}
        className="group flex w-full flex-col items-center gap-3 rounded-xl p-2 outline-none disabled:opacity-60"
      >
        <span
          className={cn(
            'relative block aspect-square w-[clamp(88px,10vw,176px)] rounded-full border-4 transition-transform duration-150',
            active ? 'border-[var(--loom-accent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--loom-accent)_35%,transparent)]' : 'border-transparent',
            'group-hover:scale-105 group-hover:border-[var(--loom-accent)] group-focus-visible:scale-105 group-focus-visible:border-[var(--loom-accent)]',
          )}
        >
          <ProfileAvatar name={profile.name} avatarKey={profile.avatarKey} colorKey={profile.colorKey} className="rounded-full" />
          {editMode && (
            <span className="absolute bottom-0 right-0 grid h-[clamp(30px,2.8vw,42px)] w-[clamp(30px,2.8vw,42px)] place-items-center rounded-full bg-[var(--loom-text)] text-[var(--loom-bg)] shadow-lg">
              <Pencil className="h-[45%] w-[45%]" />
            </span>
          )}
        </span>
        <span className="flex max-w-full flex-col items-center gap-1">
          <span className="max-w-full truncate text-base font-medium text-[var(--loom-muted)] transition-colors group-hover:text-[var(--loom-text)] group-focus-visible:text-[var(--loom-text)]">
            {profile.name}
          </span>
          <span className="flex min-h-5 flex-wrap items-center justify-center gap-1">
            {active && !editMode && (
              <span className="rounded-full bg-[var(--loom-accent)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[var(--loom-accent-foreground)]">
                Current
              </span>
            )}
            {profile.type === 'kid' && (
              <span className="rounded-full bg-[var(--loom-surface-3)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[var(--loom-muted)]">
                Kids
              </span>
            )}
            {profile.hasPin && <Lock className="h-3.5 w-3.5 text-[var(--loom-muted)]" aria-label="PIN protected" />}
          </span>
        </span>
      </button>
      {move && (
        <div className="mt-1 flex gap-1">
          <button type="button" aria-label={`Move ${profile.name} left`} disabled={!move.canMoveBack} onClick={move.onMoveBack} className="rounded-full p-1 text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)] disabled:opacity-25">
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label={`Move ${profile.name} right`} disabled={!move.canMoveForward} onClick={move.onMoveForward} className="rounded-full p-1 text-[var(--loom-muted)] hover:bg-[var(--loom-surface-3)] hover:text-[var(--loom-text)] disabled:opacity-25">
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function ProfilePinPad({
  profile,
  onBack,
  onSubmit,
  onResetOwner,
}: {
  profile: ProfileSummary;
  onBack: () => void;
  onSubmit: (pin: string) => Promise<void>;
  onResetOwner?: (confirmation: string) => Promise<void>;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState('');

  const submit = useCallback(async (value: string) => {
    if (value.length !== 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch {
      setPin('');
      setError('That PIN could not be accepted.');
    } finally {
      setBusy(false);
    }
  }, [busy, onSubmit]);

  const append = useCallback((digit: string) => {
    const next = `${pin}${digit}`.slice(0, 4);
    setError(null);
    setPin(next);
    if (next.length === 4) void submit(next);
  }, [pin, submit]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (busy || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        append(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        setError(null);
        setPin((value) => value.slice(0, -1));
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [append, busy]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-8 pb-[8vh]">
      <ProfileAvatar name={profile.name} avatarKey={profile.avatarKey} colorKey={profile.colorKey} className="mb-5 h-28 w-28 rounded-full" />
      <h1 className="text-3xl font-bold">Enter PIN</h1>
      <p className="mt-2 text-sm text-[var(--loom-muted)]">Unlock {profile.name}</p>
      <div className="my-6 flex gap-3" aria-label={`${pin.length} of 4 digits entered`}>
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className={`h-3 w-3 rounded-full ${index < pin.length ? 'bg-[var(--loom-text)]' : 'bg-[var(--loom-surface-3)]'}`} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {'123456789'.split('').map((digit) => (
          <button key={digit} type="button" onClick={() => append(digit)} disabled={busy} className="h-14 w-14 rounded-full bg-[var(--loom-surface-2)] text-xl font-semibold hover:bg-[var(--loom-surface-3)] focus-visible:ring-4 focus-visible:ring-[var(--loom-accent)]">
            {digit}
          </button>
        ))}
        <button type="button" onClick={onBack} className="h-14 w-14 rounded-full text-xs text-[var(--loom-muted)]">Back</button>
        <button type="button" onClick={() => append('0')} disabled={busy} className="h-14 w-14 rounded-full bg-[var(--loom-surface-2)] text-xl font-semibold hover:bg-[var(--loom-surface-3)] focus-visible:ring-4 focus-visible:ring-[var(--loom-accent)]">0</button>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setPin((value) => value.slice(0, -1));
          }}
          className="h-14 w-14 rounded-full text-xs text-[var(--loom-muted)]"
        >
          Delete
        </button>
      </div>
      {error && (
        <p role="alert" aria-live="assertive" aria-atomic="true" className="mt-5 text-sm text-red-400">
          {error}
        </p>
      )}
      {onResetOwner && (
        <div className="mt-6 flex max-w-sm flex-col items-center gap-2 text-center">
          <button type="button" onClick={() => setShowReset((value) => !value)} className="text-xs text-[var(--loom-muted)] hover:text-[var(--loom-text)]">Forgot Owner PIN?</button>
          {showReset && (
            <>
              <p className="text-xs text-[var(--loom-muted)]">This deletes the Owner’s viewing history and personal settings. Shared media and other profiles remain.</p>
              <input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} placeholder="Type RESET" className="w-full rounded-lg border border-red-900 bg-[var(--loom-surface-2)] px-3 py-2 text-sm" />
              <button type="button" disabled={resetConfirmation !== 'RESET'} onClick={() => void onResetOwner(resetConfirmation)} className="rounded-lg bg-red-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">Reset Owner profile</button>
            </>
          )}
        </div>
      )}
    </main>
  );
}

function AddProfileCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-[clamp(112px,12vw,200px)] flex-col items-center gap-3 rounded-xl p-2 outline-none"
    >
      <span className="grid aspect-square w-[clamp(88px,10vw,176px)] place-items-center rounded-full bg-[var(--loom-surface-2)] ring-0 ring-[var(--loom-accent)] transition-transform duration-150 group-hover:scale-105 group-hover:ring-4 group-focus-visible:scale-105 group-focus-visible:ring-4">
        <Plus className="h-[38%] w-[38%] text-[var(--loom-muted)] transition-colors group-hover:text-[var(--loom-text)]" />
      </span>
      <span className="text-base font-medium text-[var(--loom-muted)] transition-colors group-hover:text-[var(--loom-text)]">
        Add profile
      </span>
    </button>
  );
}

function ProfileDetailEditor({ target, onClose, setupMode = false }: { target: EditorTarget; onClose: () => void; setupMode?: boolean }) {
  const {
    activeProfile,
    activeState,
    changeProfilePin,
    createProfile,
    deleteProfile,
    exportProfile,
    getRestrictions,
    resetOwnerProfile,
    saveRestrictions,
    selectProfile,
    setAutomaticSignIn,
    updateProfile,
  } = useProfiles();
  const isNew = target === 'new';
  const isRemoteCreate = isNew && desktopApi.isRemoteLibraryMode();
  const existing = isNew ? null : target;
  const [name, setName] = useState(existing?.name || '');
  const [avatarKey, setAvatarKey] = useState(existing?.avatarKey || PROFILE_AVATAR_KEYS[0]);
  const [colorKey, setColorKey] = useState(existing?.colorKey || PROFILE_COLOR_KEYS[0]);
  const [isKid, setIsKid] = useState(existing?.type === 'kid');
  const [pin, setPin] = useState('');
  const [removePin, setRemovePin] = useState(false);
  const [country, setCountry] = useState<'US' | 'GB' | 'CA' | 'AU'>('US');
  const [maximumAge, setMaximumAge] = useState<number | null>(existing?.type === 'kid' ? 13 : null);
  const [allowUnrated, setAllowUnrated] = useState(false);
  const [allowedFolders, setAllowedFolders] = useState<string[]>([]);
  const [folderOptions, setFolderOptions] = useState<string[]>([]);
  const [ownerResetConfirmation, setOwnerResetConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const isOwner = existing?.type === 'owner';

  const chooseCustomAvatar = async () => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setError(null);
    try {
      const selected = await desktopApi.chooseProfileAvatar();
      if (selected) setAvatarKey(selected);
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : 'The profile image could not be selected.');
    } finally {
      setAvatarBusy(false);
    }
  };

  useEffect(() => {
    if (!existing) return;
    void getRestrictions(existing.id).then((restrictions) => {
      setCountry(restrictions.country);
      setMaximumAge(restrictions.maximumAge);
      setAllowUnrated(restrictions.allowUnrated);
      setAllowedFolders(restrictions.allowedFolders);
    });
  }, [existing, getRestrictions]);

  // Library folders are only needed by the Kids library-access picker, so this
  // (potentially large, network-backed in remote mode) library fetch is
  // deferred until a profile is actually marked as a Kids profile.
  const foldersLoadedRef = useRef(false);
  useEffect(() => {
    if (!isKid || foldersLoadedRef.current) return;
    foldersLoadedRef.current = true;
    void desktopApi.getLibrary().then((library) => setFolderOptions(library.libraryFolders || []));
  }, [isKid]);

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    let createdProfileId: string | null = null;
    try {
      if (isKid && maximumAge === null) throw new Error('Choose a maximum age for this Kids profile.');
      if (pin && !/^\d{4}$/.test(pin)) throw new Error('A profile PIN must contain exactly four digits.');
      let savedProfile = existing;
      if (isNew) {
        savedProfile = await createProfile({ name, avatarKey, colorKey, type: isKid ? 'kid' : 'standard' });
        createdProfileId = savedProfile.id;
      } else if (existing) {
        await updateProfile(existing.id, {
          name,
          avatarKey,
          colorKey,
          ...(isOwner ? {} : { type: isKid ? 'kid' as const : 'standard' as const }),
        });
      }
      if (savedProfile && isKid) {
        await saveRestrictions(savedProfile.id, { country, maximumAge, allowUnrated, allowedFolders });
      }
      if (savedProfile && (pin || removePin)) {
        await changeProfilePin(savedProfile.id, removePin ? null : pin);
      }
      // First-run setup: drop the user straight into the app on this profile
      // instead of returning them to the picker for a redundant tap.
      if (setupMode && savedProfile && !savedProfile.hasPin && !pin) {
        await selectProfile(savedProfile.id);
      }
      onClose();
    } catch (saveError) {
      if (createdProfileId) {
        try { await deleteProfile(createdProfileId); } catch { /* Preserve the original save error. */ }
      }
      setError(saveError instanceof Error ? saveError.message : 'The profile could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProfile(existing.id);
      onClose();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'The profile could not be deleted.');
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  };

  const saveDisabled = busy || !name.trim() || Boolean(pin && pin.length !== 4) || (isKid && maximumAge === null);

  return (
    <>
      <header className="flex min-h-28 items-center justify-between px-6 pb-6 pt-14">
        {setupMode ? <span /> : (
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--loom-border)] px-4 py-2 text-sm font-medium text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)] disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saveDisabled}
          className="rounded-lg bg-[var(--loom-accent)] px-5 py-2 text-sm font-semibold text-[var(--loom-accent-foreground)] transition-colors hover:bg-[var(--loom-accent-hover)] disabled:opacity-40"
        >
          {busy ? 'Saving…' : setupMode ? 'Save and continue' : 'Save'}
        </button>
      </header>

      <main className="flex flex-1 items-center justify-center px-8 pb-[6vh]">
      <div className="flex w-full max-w-[720px] flex-col-reverse items-center gap-10 md:flex-row md:items-start md:justify-between">
        <div className="flex w-full max-w-[360px] flex-col gap-5">
          <h1 className="text-2xl font-bold">{setupMode ? 'Set up your profile' : isNew ? 'Add profile' : 'Edit profile'}</h1>
          {setupMode && <p className="-mt-2 text-sm text-[var(--loom-muted)]">Name it and pick a look. You can change this anytime in Settings.</p>}

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">Profile name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={30}
              autoFocus
              placeholder="Name"
              className="rounded-lg border border-[var(--loom-surface-3)] bg-[var(--loom-surface-2)] px-3 py-2.5 text-base text-[var(--loom-text)] outline-none transition-colors focus:border-[var(--loom-accent)]"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">Avatar</span>
            <div className="grid grid-cols-4 gap-2">
              {PROFILE_AVATAR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAvatarKey(key)}
                  aria-pressed={avatarKey === key}
                  className={cn(
                    'aspect-square overflow-hidden rounded-full transition-transform hover:scale-105 hover:ring-2 hover:ring-[var(--loom-active-border)]',
                    avatarKey === key && 'ring-2 ring-[var(--loom-accent)] hover:ring-[var(--loom-accent)]',
                  )}
                >
                  <ProfileAvatar name={name || 'A'} avatarKey={key} colorKey={colorKey} />
                </button>
              ))}
            </div>
            {!isRemoteCreate && <button
              type="button"
              onClick={() => void chooseCustomAvatar()}
              disabled={avatarBusy}
              aria-pressed={avatarKey.startsWith('data:image/')}
              className={cn(
                'mt-2 flex items-center justify-center gap-2 rounded-lg border border-[var(--loom-border)] px-3 py-2.5 text-sm text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-active-border)] hover:bg-[var(--loom-active-bg)] hover:text-[var(--loom-text)] disabled:opacity-50',
                avatarKey.startsWith('data:image/') && 'border-[var(--loom-accent)] text-[var(--loom-text)]',
              )}
            >
              <ImagePlus className="h-4 w-4" />
              {avatarBusy ? 'Opening…' : avatarKey.startsWith('data:image/') ? 'Change uploaded image' : 'Upload your own image'}
            </button>}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">Color</span>
            <div className="flex flex-wrap gap-2">
              {PROFILE_COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setColorKey(key)}
                  aria-label={`${key} color`}
                  aria-pressed={colorKey === key}
                  className={cn(
                    'grid h-8 w-8 place-items-center rounded-full transition-transform hover:scale-110 hover:ring-2 hover:ring-[var(--loom-active-border)]',
                    colorKey === key && 'ring-2 ring-[var(--loom-text)] ring-offset-2 ring-offset-[var(--loom-bg)] hover:ring-[var(--loom-text)]',
                  )}
                  style={{ backgroundColor: PROFILE_COLOR_PRESETS[key] }}
                >
                  {colorKey === key && <Check className="h-4 w-4 text-white" />}
                </button>
              ))}
            </div>
          </div>

          {!isOwner && !isRemoteCreate && (
            <label className="flex items-center justify-between rounded-lg border border-[var(--loom-surface-3)] px-3 py-2.5">
              <span className="flex flex-col">
                <span className="text-sm font-medium">Kids profile</span>
                <span className="text-xs text-[var(--loom-muted)]">Only content within the selected maturity level is available.</span>
              </span>
              <input type="checkbox" checked={isKid} onChange={(event) => setIsKid(event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />
            </label>
          )}

          {isKid && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--loom-surface-3)] p-3">
              <label className="flex flex-col gap-1 text-xs text-[var(--loom-muted)]">
                Rating country
                <select value={country} onChange={(event) => setCountry(event.target.value as typeof country)} className="rounded-md bg-[var(--loom-surface-2)] p-2 text-sm text-[var(--loom-text)]">
                  <option value="US">United States</option>
                  <option value="GB">United Kingdom</option>
                  <option value="CA">Canada</option>
                  <option value="AU">Australia</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--loom-muted)]">
                Maximum age
                <select value={maximumAge ?? ''} onChange={(event) => setMaximumAge(event.target.value ? Number(event.target.value) : null)} className="rounded-md bg-[var(--loom-surface-2)] p-2 text-sm text-[var(--loom-text)]">
                  <option value="" disabled>Choose</option>
                  {[0, 7, 8, 12, 13, 14, 15, 16, 17, 18].map((age) => <option key={age} value={age}>{age === 0 ? 'All ages' : `${age} and under`}</option>)}
                </select>
              </label>
              <label className="col-span-2 flex items-center justify-between text-sm">
                Allow unrated content
                <input type="checkbox" checked={allowUnrated} onChange={(event) => setAllowUnrated(event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />
              </label>
              {folderOptions.length > 0 && (
                <div className="col-span-2 border-t border-[var(--loom-surface-3)] pt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">Library access</p>
                  <label className="mb-2 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={allowedFolders.length === 0} onChange={() => setAllowedFolders([])} className="accent-[var(--loom-accent)]" />
                    All library folders
                  </label>
                  <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
                    {folderOptions.map((folder) => {
                      const checked = allowedFolders.length === 0 || allowedFolders.includes(folder);
                      return (
                        <label key={folder} className="flex items-center gap-2 text-xs text-[var(--loom-muted)]">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setAllowedFolders((current) => {
                              const explicit = current.length === 0 ? [...folderOptions] : current;
                              return checked ? explicit.filter((item) => item !== folder) : [...explicit, folder];
                            })}
                            className="accent-[var(--loom-accent)]"
                          />
                          <span className="truncate" title={folder}>{folder}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {!isRemoteCreate && !setupMode && <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--loom-muted)]">{existing?.hasPin ? 'Change PIN' : 'Profile PIN'}</span>
            <PinDigitInput
              value={pin}
              onChange={(value) => { setPin(value); setRemovePin(false); }}
              label={existing?.hasPin ? 'Change four-digit profile PIN' : 'Optional four-digit profile PIN'}
            />
            <span className="text-xs text-[var(--loom-muted)]">
              {existing?.hasPin ? 'Leave all four boxes empty to keep the current PIN.' : 'Optional'}
            </span>
            {existing?.hasPin && (
              <button type="button" onClick={() => { setRemovePin(true); setPin(''); }} className="self-start text-xs text-[var(--loom-muted)] hover:text-red-400">
                {removePin ? 'PIN will be removed when saved' : 'Remove PIN'}
              </button>
            )}
          </div>}

          {existing && existing.id === activeProfile?.id && !existing.hasPin && !existing.isGuest && (
            <label className="flex items-center justify-between rounded-lg border border-[var(--loom-surface-3)] px-3 py-2.5">
              <span className="text-sm">Automatically sign in on this device</span>
              <input type="checkbox" checked={activeState.automaticSignIn} onChange={(event) => void setAutomaticSignIn(event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />
            </label>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          {existing && !existing.isGuest && !setupMode && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void exportProfile(existing.id).then((result) => setTransferMessage(
                result.ok ? `Exported to ${result.path || 'the selected file'}` : result.error || null,
              ))}
              className="self-start text-xs font-medium text-[var(--loom-muted)] hover:text-[var(--loom-text)]"
            >
              Export Profile
            </button>
          )}
          {transferMessage && <p className="text-xs text-[var(--loom-muted)]">{transferMessage}</p>}

          {existing && !isOwner && (
            <div className="mt-4 border-t border-[var(--loom-surface-3)] pt-4">
              {confirmingDelete ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-[var(--loom-muted)]">
                    Deleting {existing.name} permanently removes their watch history and playback preferences. The shared library is not affected.
                  </p>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={busy}
                      className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      Delete permanently
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      className="rounded-lg px-4 py-2 text-sm text-[var(--loom-muted)] hover:text-[var(--loom-text)]"
                    >
                      Keep profile
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="flex items-center gap-2 text-sm text-[var(--loom-muted)] transition-colors hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" /> Delete profile
                </button>
              )}
            </div>
          )}

          {isOwner && existing && existing.hasPin && (
            <div className="mt-4 border-t border-[var(--loom-surface-3)] pt-4">
              <p className="mb-2 text-xs text-[var(--loom-muted)]">Forgotten PIN recovery deletes only the Owner’s personal data. Your library, server settings, paired devices, and other profiles remain.</p>
              <input value={ownerResetConfirmation} onChange={(event) => setOwnerResetConfirmation(event.target.value)} placeholder="Type RESET" className="mb-2 w-full rounded-lg border border-red-900 bg-[var(--loom-surface-2)] px-3 py-2 text-sm" />
              <button type="button" disabled={ownerResetConfirmation !== 'RESET' || busy} onClick={() => void resetOwnerProfile(ownerResetConfirmation).then(onClose)} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">Reset Owner profile</button>
            </div>
          )}
        </div>

        <div className="relative w-[clamp(140px,22vw,240px)] shrink-0">
          <div className="aspect-square overflow-hidden rounded-full">
            <ProfileAvatar name={name || 'A'} avatarKey={avatarKey} colorKey={colorKey} />
          </div>
        </div>
      </div>
      </main>
    </>
  );
}

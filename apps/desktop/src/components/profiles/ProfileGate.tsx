import React, { useCallback, useEffect, useState } from 'react';
import { Check, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import LoomLogo from '@/components/LoomLogo';
import { cn } from '@/lib/utils';
import { useProfiles } from '@/contexts/ProfileContext';
import type { ProfileSummary } from '@/lib/desktopApi';
import ProfileAvatar, { PROFILE_AVATAR_KEYS, PROFILE_COLOR_KEYS, PROFILE_COLOR_PRESETS } from './ProfileAvatar';

type GateMode = 'select' | 'edit';
type EditorTarget = ProfileSummary | 'new';

/**
 * Full-window profile gate: the Who's Watching picker, its in-place Edit
 * profiles mode, and the focused profile detail editor. Rendered instead of
 * the app shell, never over it.
 */
export default function ProfileGate() {
  const { profiles, selectProfile } = useProfiles();
  const [mode, setMode] = useState<GateMode>('select');
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editorTarget) setEditorTarget(null);
      else if (mode === 'edit') setMode('select');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editorTarget, mode]);

  const handleSelect = useCallback(async (profile: ProfileSummary) => {
    setBusyProfileId(profile.id);
    try {
      await selectProfile(profile.id);
    } finally {
      setBusyProfileId(null);
    }
  }, [selectProfile]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[var(--loom-bg)] text-[var(--loom-text)]">
      <header className="flex items-center justify-between p-6">
        <LoomLogo className="h-8 w-auto" />
        {!editorTarget && (mode === 'select' ? (
          <button
            type="button"
            onClick={() => setMode('edit')}
            className="rounded-lg border border-[var(--loom-surface-3)] px-4 py-2 text-sm font-medium text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-text)] hover:text-[var(--loom-text)]"
          >
            Edit Profiles
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setMode('select')}
            className="rounded-lg bg-[var(--loom-accent)] px-5 py-2 text-sm font-bold uppercase tracking-wide text-[var(--loom-accent-foreground)] transition-opacity hover:opacity-90"
          >
            Done
          </button>
        ))}
      </header>

      {editorTarget ? (
        <ProfileDetailEditor
          target={editorTarget}
          onClose={() => setEditorTarget(null)}
        />
      ) : (
        <main className="flex flex-1 flex-col items-center justify-center px-8 pb-[8vh]">
          <h1 className="mb-2 text-center text-[clamp(26px,3.2vw,40px)] font-bold">
            {mode === 'select' ? "Who's watching?" : 'Edit profiles'}
          </h1>
          {mode === 'edit' && (
            <p className="mb-8 text-center text-sm text-[var(--loom-muted)]">Select a profile to edit</p>
          )}
          {mode === 'select' && <div className="mb-8" />}
          <div className="flex max-w-[900px] flex-wrap items-start justify-center gap-[clamp(16px,3vw,44px)]">
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                editMode={mode === 'edit'}
                busy={busyProfileId === profile.id}
                onClick={() => {
                  if (mode === 'edit') setEditorTarget(profile);
                  else void handleSelect(profile);
                }}
              />
            ))}
            <AddProfileCard onClick={() => setEditorTarget('new')} />
          </div>
        </main>
      )}
    </div>
  );
}

function ProfileCard({
  profile,
  editMode,
  busy,
  onClick,
}: {
  profile: ProfileSummary;
  editMode: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="group flex w-[clamp(112px,12vw,200px)] flex-col items-center gap-3 rounded-xl p-2 outline-none disabled:opacity-60"
    >
      <span
        className={cn(
          'relative block aspect-square w-[clamp(88px,10vw,176px)] rounded-full transition-transform duration-150',
          'ring-0 ring-[var(--loom-accent)] group-hover:scale-105 group-hover:ring-4 group-focus-visible:scale-105 group-focus-visible:ring-4',
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
        {profile.type === 'kid' && (
          <span className="rounded bg-[var(--loom-surface-3)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[var(--loom-muted)]">
            Kids
          </span>
        )}
        {profile.hasPin && <Lock className="h-3.5 w-3.5 text-[var(--loom-muted)]" aria-label="PIN protected" />}
      </span>
    </button>
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

function ProfileDetailEditor({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const { createProfile, updateProfile, deleteProfile } = useProfiles();
  const isNew = target === 'new';
  const existing = isNew ? null : target;
  const [name, setName] = useState(existing?.name || '');
  const [avatarKey, setAvatarKey] = useState(existing?.avatarKey || PROFILE_AVATAR_KEYS[0]);
  const [colorKey, setColorKey] = useState(existing?.colorKey || PROFILE_COLOR_KEYS[0]);
  const [isKid, setIsKid] = useState(existing?.type === 'kid');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOwner = existing?.type === 'owner';

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await createProfile({ name, avatarKey, colorKey, type: isKid ? 'kid' : 'standard' });
      } else if (existing) {
        await updateProfile(existing.id, {
          name,
          avatarKey,
          colorKey,
          ...(isOwner ? {} : { type: isKid ? 'kid' as const : 'standard' as const }),
        });
      }
      onClose();
    } catch (saveError) {
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

  return (
    <main className="flex flex-1 items-center justify-center px-8 pb-[6vh]">
      <div className="flex w-full max-w-[720px] flex-col-reverse items-center gap-10 md:flex-row md:items-start md:justify-between">
        <div className="flex w-full max-w-[360px] flex-col gap-5">
          <h1 className="text-2xl font-bold">{isNew ? 'Add profile' : 'Edit profile'}</h1>

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
                    'aspect-square overflow-hidden rounded-full transition-transform hover:scale-105',
                    avatarKey === key && 'ring-2 ring-[var(--loom-accent)]',
                  )}
                >
                  <ProfileAvatar name={name || 'A'} avatarKey={key} colorKey={colorKey} />
                </button>
              ))}
            </div>
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
                    'grid h-8 w-8 place-items-center rounded-full transition-transform hover:scale-110',
                    colorKey === key && 'ring-2 ring-[var(--loom-text)] ring-offset-2 ring-offset-[var(--loom-bg)]',
                  )}
                  style={{ background: `linear-gradient(135deg, ${PROFILE_COLOR_PRESETS[key][0]}, ${PROFILE_COLOR_PRESETS[key][1]})` }}
                >
                  {colorKey === key && <Check className="h-4 w-4 text-white" />}
                </button>
              ))}
            </div>
          </div>

          {!isOwner && (
            <label className="flex items-center justify-between rounded-lg border border-[var(--loom-surface-3)] px-3 py-2.5">
              <span className="flex flex-col">
                <span className="text-sm font-medium">Kids profile</span>
                <span className="text-xs text-[var(--loom-muted)]">Content restrictions arrive in a later update.</span>
              </span>
              <input type="checkbox" checked={isKid} onChange={(event) => setIsKid(event.target.checked)} className="h-4 w-4 accent-[var(--loom-accent)]" />
            </label>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy || !name.trim()}
              className="rounded-lg bg-[var(--loom-accent)] px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-[var(--loom-accent-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border border-[var(--loom-surface-3)] px-6 py-2.5 text-sm font-medium text-[var(--loom-muted)] transition-colors hover:border-[var(--loom-text)] hover:text-[var(--loom-text)]"
            >
              Cancel
            </button>
          </div>

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
        </div>

        <div className="relative w-[clamp(140px,22vw,240px)] shrink-0">
          <div className="aspect-square overflow-hidden rounded-full">
            <ProfileAvatar name={name || 'A'} avatarKey={avatarKey} colorKey={colorKey} />
          </div>
        </div>
      </div>
    </main>
  );
}

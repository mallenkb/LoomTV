import { useState } from 'react';
import { Lock, Plus } from 'lucide-react';
import { useConfirm } from '@/components/ConfirmProvider';
import { useToast } from '@/components/ToastProvider';
import { useProfiles } from '@/contexts/ProfileContext';
import ProfileAvatar from '@/components/profiles/ProfileAvatar';
import PinDigitInput from '@/components/profiles/PinDigitInput';
import { Button } from '@/components/ui/button';
import { SettingsDialog, SettingsDialogMessage } from '@/components/settings/SettingsDialog';
import { SettingsBadge, SettingsGroup, SettingsPageHeader, SettingsRow, SettingsSwitch } from '@/components/settings/SettingsLayout';

const TYPE_LABELS: Record<string, string> = { owner: 'Owner', standard: 'Standard', kid: 'Kids' };

export default function ProfilesSettingsSection() {
  const {
    activeProfile,
    activeState,
    profiles,
    canCreateProfiles,
    canManageProfiles,
    changeProfilePin,
    lockProfile,
    openGate,
    selectProfile,
    setAutomaticSignIn,
  } = useProfiles();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  if (!activeProfile) return null;
  const people = profiles.filter((profile) => !profile.isGuest);
  const canUsePin = !activeProfile.isGuest;

  const switchTo = (profileId: string, hasPin: boolean, name: string) => {
    if (hasPin) {
      openGate({ mode: 'select', profileId, returnTo: '/settings' });
      return;
    }
    void selectProfile(profileId).then(() => showToast({ title: `Switched to ${name}`, tone: 'success' })).catch(() => undefined);
  };

  const lockNow = async () => {
    if (!activeProfile.hasPin && canUsePin) {
      setShowPinSetup(true);
      return;
    }
    await lockProfile();
  };

  const savePin = async (thenLock: boolean) => {
    if (!/^\d{4}$/.test(pin) || pinBusy) return;
    setPinBusy(true);
    setPinError('');
    try {
      await changeProfilePin(activeProfile.id, pin);
      setPin('');
      setShowPinSetup(false);
      if (thenLock) await lockProfile();
    } catch (error) {
      setPinError(error instanceof Error ? error.message : 'The PIN could not be saved.');
    } finally {
      setPinBusy(false);
    }
  };

  const removePin = async () => {
    const ok = await confirm({
      title: 'Remove profile PIN?',
      description: `${activeProfile.name} will no longer need a PIN on this device.`,
      confirmLabel: 'Remove PIN',
      destructive: true,
    });
    if (!ok) return;
    try {
      await changeProfilePin(activeProfile.id, null);
      showToast({ title: 'PIN removed', tone: 'success' });
    } catch (error) {
      showToast({ title: 'The PIN could not be removed.', description: error instanceof Error ? error.message : undefined, tone: 'error' });
    }
  };

  return (
    <div>
      <SettingsPageHeader title="Profiles" description="Who uses Loom on this device and their sign-in settings." />

      <SettingsGroup title="This profile">
        <div className="settings-row flex flex-wrap items-center gap-4 px-4 py-4">
          <ProfileAvatar name={activeProfile.name} avatarKey={activeProfile.avatarKey} colorKey={activeProfile.colorKey} className="h-12 w-12 rounded-full" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-[var(--loom-text)]">{activeProfile.name}</p>
            <p className="text-xs text-[var(--loom-muted)]">{TYPE_LABELS[activeProfile.type] || activeProfile.type} profile · {activeProfile.hasPin ? 'PIN on' : 'No PIN'}</p>
          </div>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void lockNow()}>
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            Lock
          </Button>
        </div>
        {canUsePin ? (
          <SettingsRow title="Profile PIN" description={activeProfile.hasPin ? 'A four-digit PIN is needed to open this profile.' : 'Protect this profile with a four-digit PIN.'}>
            {activeProfile.hasPin ? (
              <>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowPinSetup(true)}>Change</Button>
                <Button type="button" variant="outline" size="sm" className="settings-destructive-text" onClick={() => void removePin()}>Remove</Button>
              </>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => setShowPinSetup(true)}>Set PIN</Button>
            )}
          </SettingsRow>
        ) : null}
        {!activeProfile.hasPin && canUsePin ? (
          <SettingsRow title="Sign in automatically" description={`Open Loom as ${activeProfile.name} on this device without choosing a profile.`}>
            <SettingsSwitch label="Sign in automatically" checked={activeState.automaticSignIn} onChange={(enabled) => void setAutomaticSignIn(enabled)} />
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title="Everyone"
        action={canCreateProfiles ? (
          <Button type="button" size="sm" className="gap-1.5" onClick={() => openGate({ mode: 'edit', editProfileId: 'new', returnTo: '/settings' })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add profile
          </Button>
        ) : undefined}
      >
        {people.map((profile) => {
          const active = profile.id === activeProfile.id;
          return (
            <SettingsRow
              key={profile.id}
              icon={<ProfileAvatar name={profile.name} avatarKey={profile.avatarKey} colorKey={profile.colorKey} className="h-9 w-9 rounded-full" />}
              title={(
                <span className="flex flex-wrap items-center gap-2">
                  {profile.name}
                  {active ? <SettingsBadge tone="ok">Current</SettingsBadge> : null}
                </span>
              )}
              description={`${TYPE_LABELS[profile.type] || profile.type} · ${profile.hasPin ? 'PIN on' : 'No PIN'}`}
            >
              {!active ? <Button type="button" variant="outline" size="sm" onClick={() => switchTo(profile.id, profile.hasPin, profile.name)}>Switch</Button> : null}
              {canManageProfiles ? <Button type="button" variant="outline" size="sm" onClick={() => openGate({ mode: 'edit', editProfileId: profile.id, returnTo: '/settings' })}>Edit</Button> : null}
            </SettingsRow>
          );
        })}
      </SettingsGroup>

      <SettingsDialog
        open={showPinSetup}
        onClose={() => { setShowPinSetup(false); setPin(''); setPinError(''); }}
        busy={pinBusy}
        size="sm"
        title={activeProfile.hasPin ? 'Change profile PIN' : 'Set a profile PIN'}
        description={`Four digits to open ${activeProfile.name}. Automatic sign-in turns off.`}
        footer={(
          <>
            <Button size="sm" type="button" variant="outline" disabled={pinBusy} onClick={() => { setShowPinSetup(false); setPin(''); setPinError(''); }}>Cancel</Button>
            {!activeProfile.hasPin ? <Button size="sm" type="button" variant="outline" disabled={pin.length !== 4 || pinBusy} onClick={() => void savePin(true)}>Save and lock</Button> : null}
            <Button size="sm" type="submit" form="settings-profile-pin" disabled={pin.length !== 4 || pinBusy}>Save PIN</Button>
          </>
        )}
      >
        <form id="settings-profile-pin" className="space-y-3" onSubmit={(event) => { event.preventDefault(); void savePin(false); }}>
          <PinDigitInput value={pin} onChange={(value) => { setPin(value); setPinError(''); }} autoFocus disabled={pinBusy} />
          {pinError ? <SettingsDialogMessage>{pinError}</SettingsDialogMessage> : null}
        </form>
      </SettingsDialog>
    </div>
  );
}

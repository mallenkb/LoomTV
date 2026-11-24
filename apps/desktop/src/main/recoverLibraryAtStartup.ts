import { dialog } from 'electron';
import { migrationBackupForRecovery, restoreVideoDatabase, type RecoverySource } from './videoDatabaseRecovery.ts';

export async function recoverLibraryAtStartup(dataDir: string): Promise<boolean> {
  let migration: ReturnType<typeof migrationBackupForRecovery>;
  try {
    migration = migrationBackupForRecovery(dataDir);
  } catch (error) {
    console.warn('Could not read the migration backup record:', error);
  }
  const date = migration && new Date(migration.created_at).toLocaleString();
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'LoomTV library recovery',
    message: 'SQLite found damage in your LoomTV library.',
    detail: 'Restoring a backup brings back the accounts, settings, and playback history saved at that time. Later changes stay in a separate copy of the damaged database. Devices will need to pair again.',
    buttons: ['Quit', 'Choose a database backup…', ...(date ? [`Restore backup from ${date}`] : [])],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 0) return false;
  let source: RecoverySource;
  if (response === 2 && migration) {
    source = { backup: migration };
  } else {
    const choice = await dialog.showOpenDialog({
      title: 'Choose a saved LoomTV database',
      properties: ['openFile'],
      filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }],
    });
    if (choice.canceled || !choice.filePaths[0]) return false;
    source = { filename: choice.filePaths[0] };
  }
  try {
    const saved = await restoreVideoDatabase(dataDir, source);
    await dialog.showMessageBox({
      type: 'info',
      message: 'Your restored library is ready.',
      detail: `LoomTV kept the damaged database at ${saved}`,
      buttons: ['Open library'],
    });
    return true;
  } catch (error) {
    console.error('Library recovery failed:', error);
    dialog.showErrorBox('LoomTV could not restore the library', error instanceof Error ? error.message : String(error));
    return false;
  }
}

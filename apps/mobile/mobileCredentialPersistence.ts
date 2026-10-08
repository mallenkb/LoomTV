let credentialMutations: Promise<unknown> = Promise.resolve();

// Native SecureStore operations cannot be aborted. Keep deletion behind every
// preceding write so a disconnected credential cannot survive on disk.
export function serializeMobileCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = credentialMutations.catch(() => undefined).then(operation);
  credentialMutations = pending;
  return pending;
}

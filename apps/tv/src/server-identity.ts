export function normalizeCertificateFingerprint(value: string): string {
  const normalized = String(value || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error('The server certificate fingerprint is invalid.');
  return normalized;
}

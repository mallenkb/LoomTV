const TMDB_PROVIDER_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';
const PRIME_VIDEO_BLUE_LOGO_PATH = '/8aBqoNeGGr0oSA85iopgNZUOTOc.jpg';

type ProviderLogoSource = {
  id?: number;
  name?: string;
  logoUrl?: string;
  logoPath?: string | null;
};

export function isPrimeVideoProvider(provider: ProviderLogoSource): boolean {
  const name = provider.name?.trim().toLowerCase() || '';
  return provider.id === 9
    || provider.id === 119
    || provider.id === 2100
    || /amazon\s+prime\s+video|prime\s+video/.test(name);
}

export function preferredProviderLogoUrl(provider: ProviderLogoSource): string {
  if (isPrimeVideoProvider(provider)) return `${TMDB_PROVIDER_IMAGE_BASE}${PRIME_VIDEO_BLUE_LOGO_PATH}`;
  if (provider.logoUrl) return provider.logoUrl;
  return provider.logoPath ? `${TMDB_PROVIDER_IMAGE_BASE}${provider.logoPath}` : '';
}

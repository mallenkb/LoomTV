type ContentRatingLike = {
  code?: string;
};

export function preferredContentRating(
  contentRatings?: Record<string, ContentRatingLike>,
  fallback?: string,
): string {
  const preferredCountries = ['US', 'GB', 'CA', 'AU'];
  for (const country of preferredCountries) {
    const code = contentRatings?.[country]?.code?.trim();
    if (code) return code;
  }
  const firstAvailable = Object.values(contentRatings || {}).find((rating) => rating.code?.trim())?.code?.trim();
  return firstAvailable || fallback?.trim() || '';
}

export default function ContentRatingBadge({ rating, className = '' }: { rating?: string; className?: string }) {
  const label = rating?.trim();
  if (!label) return null;
  return (
    <span className={`inline-flex w-fit items-center rounded-md border border-[var(--loom-muted)]/80 bg-[var(--loom-surface-3)] px-1 py-0 text-[11px] font-medium leading-4 text-[var(--loom-text)] backdrop-blur-[12px] ${className}`}>
      {label}
    </span>
  );
}

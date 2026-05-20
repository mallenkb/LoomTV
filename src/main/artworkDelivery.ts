export type ArtworkRecord = Record<string, string>;

export function rewriteArtworkRecordForDelivery(
  artwork: ArtworkRecord,
  deliveryUrlForSource: (source: string) => string,
): ArtworkRecord {
  return Object.fromEntries(
    Object.entries(artwork || {}).map(([target, source]) => [
      target,
      source ? deliveryUrlForSource(source) : '',
    ]),
  );
}

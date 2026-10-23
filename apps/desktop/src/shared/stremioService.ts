export type StremioServiceStatus = {
  available: boolean;
  version?: string;
  message: string;
};

export type StremioTorrentFile = { index: number; name: string; size: number };

export type StremioTorrentPreparation = {
  files: StremioTorrentFile[];
  suggestedIndex?: number;
  selectionReason: 'provider' | 'single-file' | 'choose';
  notice: string;
  serviceVersion: string;
};

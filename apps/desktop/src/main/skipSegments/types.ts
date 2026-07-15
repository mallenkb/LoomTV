export type MediaSegmentType = 'intro' | 'recap' | 'credits' | 'preview';

export type MediaSegmentSource =
  | 'manual'
  | 'chapter'
  | 'theintrodb'
  | 'aniskip'
  | 'chromaprint';

export type MediaSegmentCandidateStatus = 'active' | 'review' | 'rejected';

export interface MediaSegment {
  id: string;
  type: MediaSegmentType;
  startMs: number;
  endMs: number | null;
  confidence: number;
  source: MediaSegmentSource;
  mediaDurationMs: number;
  updatedAt: string;
}

export interface MediaSegmentRequest {
  mediaId: string;
  season?: number;
  episode?: number;
}

export interface MediaSegmentResponse {
  segments: MediaSegment[];
  revision: string;
}

export interface ManualMediaSegmentInput extends MediaSegmentRequest {
  type: MediaSegmentType;
  startMs: number;
  endMs: number | null;
}

export interface MediaSegmentCandidate extends MediaSegment {
  mediaId: string;
  season: number;
  episode: number;
  filePath: string;
  fileRevision: string;
  releaseKey?: string;
  status: MediaSegmentCandidateStatus;
  expiresAt?: number;
}

export interface NormalizedSegmentInput {
  type: MediaSegmentType;
  startMs: number;
  endMs: number | null;
  source: MediaSegmentSource;
  confidence: number;
}

export interface ProviderCacheEntry {
  provider: 'theintrodb' | 'aniskip';
  lookupKey: string;
  durationBucket: number;
  status: 'success' | 'empty';
  segments: NormalizedSegmentInput[];
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
}

export interface MediaChapter {
  startMs: number;
  endMs: number;
  title: string;
}

export interface SegmentAnalysisStatus {
  enabled: boolean;
  available: boolean;
  helperPath: string | null;
  state: 'disabled' | 'idle' | 'queued' | 'running' | 'paused' | 'unavailable' | 'error';
  message?: string;
}

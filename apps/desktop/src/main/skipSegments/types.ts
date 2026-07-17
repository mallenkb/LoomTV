export type MediaSegmentType = 'intro' | 'recap' | 'credits' | 'preview';

export type MediaSegmentSource =
  | 'manual'
  | 'chapter'
  | 'theintrodb'
  | 'aniskip'
  | 'chromaprint';

type MediaSegmentCandidateStatus = 'active' | 'review' | 'rejected';
export type SegmentAnalysisMetadata = {
  detector?: 'chromaprint' | 'blackframe' | 'chapter';
  peerSupport?: number;
  originalStartMs?: number;
  originalEndMs?: number | null;
  startSnap?: 'chapter' | 'silence' | 'keyframe' | 'media-edge' | 'original';
  endSnap?: 'chapter' | 'silence' | 'keyframe' | 'media-edge' | 'original';
  confidenceComponents?: Record<string, number>;
  userDecision?: { status?: 'active' | 'rejected'; type?: MediaSegmentType };
};

export interface MediaSegment {
  id: string;
  type: MediaSegmentType;
  startMs: number;
  endMs: number | null;
  confidence: number;
  source: MediaSegmentSource;
  mediaDurationMs: number;
  updatedAt: string;
  analysisMetadata?: SegmentAnalysisMetadata;
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
  candidateId?: string;
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
  analysisMetadata?: SegmentAnalysisMetadata;
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

export interface SegmentAnalysisStatus {
  enabled: boolean;
  available: boolean;
  helperPath: string | null;
  state: 'disabled' | 'idle' | 'queued' | 'running' | 'paused' | 'unavailable' | 'error';
  message?: string;
  paused?: boolean;
  pendingCount?: number;
  currentJob?: { jobKey: string; kind: string; mediaId: string; season: number; episode: number; detail: string };
  lastError?: string;
  fingerprintCount?: number;
  fingerprintCacheBytes?: number;
  progress?: { complete: number; total: number };
  lastCompletedAt?: number;
  recentJobs?: Array<{
    jobKey: string;
    kind: string;
    mediaId: string;
    season: number;
    episode: number;
    state: string;
    detail: string;
    updatedAt: number;
  }>;
}

export type LocalAnalysisOutcome =
  | { kind: 'complete'; response: MediaSegmentResponse }
  | { kind: 'waiting_for_peers'; response: MediaSegmentResponse; detail: string };

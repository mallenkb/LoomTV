export type TranscodeBackend = 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'rkmpp';
export type TranscodeCodec = 'h264' | 'hevc' | 'av1';

export interface CodecCapability {
  encoder: string;
  compiled: boolean;
  available: boolean;
  verified: boolean;
  reason: string;
}

export interface TranscodeBackendCapability {
  id: TranscodeBackend;
  label: string;
  hwaccel: string;
  platformSupported: boolean;
  device: string | null;
  hwaccelAvailable: boolean;
  available: boolean;
  codecs: Partial<Record<TranscodeCodec, CodecCapability>>;
  decode: { advertised: boolean; available: boolean };
}

export interface TranscodeCapabilities {
  state: 'available' | 'limited' | 'unavailable' | 'probing';
  ffmpegPath: string | null;
  platform: NodeJS.Platform | string;
  backends: TranscodeBackendCapability[];
  recommendedBackend: TranscodeBackend | 'software';
  hardwareAcceleration: boolean;
  softwareFallback: true;
  codecs: Record<TranscodeCodec, boolean>;
  softwareCodecs: Record<TranscodeCodec, boolean>;
  softwareEncoders: Partial<Record<TranscodeCodec, string | null>>;
  toneMapping: boolean;
  probedAt: number;
  reason?: string;
}

export interface ProbeOptions {
  platform?: NodeJS.Platform | string;
  environment?: NodeJS.ProcessEnv;
  skipSmokeTest?: boolean;
  probeTimeoutMs?: number;
  cacheDir?: string;
  /** Explicit self-tests bypass the saved result but share an in-flight probe. */
  force?: boolean;
  /** Override command execution for deterministic probes or embedded runtimes. */
  commandRunner?: (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => string | Buffer | void | Promise<string | Buffer | void>;
}

export function getTranscodeCapabilities(ffmpegPath: string | null | undefined, options?: ProbeOptions): TranscodeCapabilities;
export function probeTranscodeCapabilities(ffmpegPath: string | null | undefined, options?: ProbeOptions): Promise<TranscodeCapabilities>;
export function clearTranscodeCapabilityCache(): void;

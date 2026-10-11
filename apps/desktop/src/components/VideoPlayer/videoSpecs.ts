/** What the file's video stream is, from ffprobe or the library's saved probe. */
export type VideoSpecs = {
  width?: number;
  height?: number;
  codec?: string;
  profile?: string;
  pixelFormat?: string;
  frameRate?: number;
  colorTransfer?: string;
  colorPrimaries?: string;
  bitrateKbps?: number;
  container?: string;
};

type ProbeLike = {
  container?: unknown;
  bitrateKbps?: unknown;
  tracks?: unknown;
};

type FactsLike = {
  width?: number;
  height?: number;
  videoCodec?: string;
  videoProfile?: string;
  pixelFormat?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  bitrateKbps?: number;
  container?: string;
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const positive = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);

/** The first video stream of a probe response. Probe data is not schema checked, so read it defensively. */
export function probeVideoSpecs(data: unknown): VideoSpecs {
  const probe = (data && typeof data === 'object' ? data : {}) as ProbeLike;
  const tracks = Array.isArray(probe.tracks) ? probe.tracks as Record<string, unknown>[] : [];
  const video = tracks.find((track) => track && track.type === 'video') || {};
  return {
    width: positive(video.width),
    height: positive(video.height),
    codec: text(video.codec),
    profile: text(video.profile),
    pixelFormat: text(video.pixelFormat),
    frameRate: positive(video.frameRate),
    colorTransfer: text(video.colorTransfer),
    colorPrimaries: text(video.colorPrimaries),
    bitrateKbps: positive(probe.bitrateKbps),
    container: text(probe.container),
  };
}

export function factsVideoSpecs(facts: FactsLike): VideoSpecs {
  return {
    width: positive(facts.width),
    height: positive(facts.height),
    codec: text(facts.videoCodec),
    profile: text(facts.videoProfile),
    pixelFormat: text(facts.pixelFormat),
    colorTransfer: text(facts.colorTransfer),
    colorPrimaries: text(facts.colorPrimaries),
    bitrateKbps: positive(facts.bitrateKbps),
    container: text(facts.container),
  };
}

/** Fill each field from the first source that has it. */
export function mergeVideoSpecs(...sources: VideoSpecs[]): VideoSpecs {
  const merged: VideoSpecs = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source) as [keyof VideoSpecs, never][]) {
      if (value !== undefined && merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264', avc1: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8',
  mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', vc1: 'VC-1', prores: 'ProRes',
};

const CONTAINER_NAMES: Record<string, string> = {
  matroska: 'MKV', webm: 'WebM', mov: 'MP4 / MOV',
  mp4: 'MP4', mpegts: 'MPEG-TS', avi: 'AVI', hls: 'HLS',
};

/** The usual name for a frame size: 2160p, 1080p, 720p. Widescreen crops are named by width. */
export function resolutionName(width?: number, height?: number): string | undefined {
  if (!width || !height) return undefined;
  if (width >= 3800 || height >= 2100) return '4K';
  if (width >= 2500 || height >= 1400) return '1440p';
  if (width >= 1900 || height >= 1060) return '1080p';
  if (width >= 1260 || height >= 700) return '720p';
  if (height >= 560) return '576p';
  if (height >= 470) return '480p';
  return `${height}p`;
}

function formatResolution(width?: number, height?: number): string | undefined {
  if (!width || !height) return undefined;
  const name = resolutionName(width, height);
  return `${width} × ${height}${name ? ` (${name})` : ''}`;
}

/** Bit depth and chroma subsampling from an FFmpeg pixel format such as yuv420p10le. */
function describePixelFormat(pixelFormat?: string): string | undefined {
  if (!pixelFormat) return undefined;
  const match = /^yuvj?(4[24][024])p(\d+)?/.exec(pixelFormat);
  if (!match) return pixelFormat;
  const [, chroma, depth] = match;
  return `${depth || '8'}-bit ${chroma[0]}:${chroma[1]}:${chroma[2]}`;
}

function formatFrameRate(frameRate?: number): string | undefined {
  if (!frameRate) return undefined;
  const rounded = Math.round(frameRate * 1000) / 1000;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(3).replace(/0+$/, '')} fps`;
}

/** HDR format from the transfer function. Dolby Vision needs side data the probe does not keep. */
function describeDynamicRange(specs: VideoSpecs): string | undefined {
  const transfer = specs.colorTransfer?.toLowerCase();
  const wideGamut = specs.colorPrimaries?.toLowerCase() === 'bt2020';
  if (transfer === 'smpte2084') return 'HDR10 (PQ)';
  if (transfer === 'arib-std-b67') return 'HLG';
  if (!transfer && !specs.colorPrimaries) return undefined;
  return wideGamut ? 'SDR, BT.2020' : 'SDR';
}

function formatBitrate(kbps?: number): string | undefined {
  if (!kbps) return undefined;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${Math.round(kbps)} kb/s`;
}

/**
 * Rows for the player's Playback information list. `playing` is the frame
 * size the engine reports decoding, shown only when it differs from the file,
 * such as a transcode to a lower resolution.
 */
export function videoSpecRows(specs: VideoSpecs, playing?: { width?: number; height?: number }): [string, string][] {
  const codec = specs.codec ? CODEC_NAMES[specs.codec.toLowerCase()] || specs.codec.toUpperCase() : undefined;
  const format = [codec, specs.profile].filter(Boolean).join(' ');
  const playingResolution = formatResolution(playing?.width, playing?.height);
  const fileResolution = formatResolution(specs.width, specs.height);
  const rows: [string, string | undefined][] = [
    ['Resolution', fileResolution],
    ['Playing at', playingResolution && playingResolution !== fileResolution ? playingResolution : undefined],
    ['Video format', format || undefined],
    ['Color', describePixelFormat(specs.pixelFormat)],
    ['Frame rate', formatFrameRate(specs.frameRate)],
    ['Dynamic range', describeDynamicRange(specs)],
    ['Bitrate', formatBitrate(specs.bitrateKbps)],
    ['Container', specs.container ? CONTAINER_NAMES[specs.container.toLowerCase()] || specs.container.toUpperCase() : undefined],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

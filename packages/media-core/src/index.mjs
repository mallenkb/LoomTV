import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * The contract version is deliberately independent from the app version. It
 * identifies the algorithms and vocabulary shared by desktop and headless
 * runtimes, so a catalog can be safely moved between them.
 */
export const MEDIA_CORE_CONTRACT_VERSION = 3;

export {
  classifyVideoFile,
  cleanMediaTitle,
  isLikelyAnimePath,
  isLikelyEpisodeFileName,
  parseEpisodeFileName,
  seriesTitleFromEpisodeName,
} from './classification.mjs';

export const VIDEO_EXTENSIONS = Object.freeze([
  '.3gp', '.avi', '.divx', '.flv', '.m2ts', '.m4v', '.mkv', '.mov',
  '.mp4', '.mpeg', '.mpg', '.mts', '.mxf', '.ogm', '.ogv', '.ts', '.vob',
  '.webm', '.wmv',
]);

export const TRANSCODE_CODECS = Object.freeze(['h264', 'hevc', 'av1']);
export const PROFILE_TYPES = Object.freeze(['owner', 'standard', 'kid', 'guest']);

const videoExtensionSet = new Set(VIDEO_EXTENSIONS);
const transcodeCodecSet = new Set(TRANSCODE_CODECS);
const profileTypeSet = new Set(PROFILE_TYPES);

/** Return true when a path has a media extension understood by both runtimes. */
export function isVideoFilePath(filePath) {
  return videoExtensionSet.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Generate the stable ID used by desktop and headless catalogs.
 *
 * This intentionally keeps the desktop app's existing absolute-path hash
 * algorithm. Headless scans use the same function, so a mounted library does
 * not acquire a second identity just because it was indexed without Electron.
 */
export function createMediaItemId(filePath) {
  return createHash('sha256').update(path.resolve(String(filePath))).digest('hex').slice(0, 32);
}

export function normalizeTranscodeCodec(value, fallback = 'h264') {
  const codec = String(value || '').trim().toLowerCase();
  return transcodeCodecSet.has(codec) ? codec : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/**
 * Normalize client playback constraints before a runtime chooses an encoder.
 * Backend selection remains runtime-specific; the request shape does not.
 */
export function normalizePlaybackProfile(input = {}) {
  const codec = normalizeTranscodeCodec(input.codec || input.targetVideoCodec);
  return {
    codec,
    maxWidth: boundedInteger(input.maxWidth, 0, 0, 8_192),
    maxHeight: boundedInteger(input.maxHeight, 0, 0, 8_192),
    videoBitrateKbps: boundedInteger(input.videoBitrateKbps, 0, 0, 100_000),
    audioBitrateKbps: boundedInteger(input.audioBitrateKbps, 160, 32, 1_024),
    toneMap: input.toneMap === true || input.toneMap === '1' || input.toneMap === 1,
  };
}

const DEFAULT_CLIENT_CONTAINERS = Object.freeze(['mp4', 'webm']);
const DEFAULT_CLIENT_VIDEO_CODECS = Object.freeze(['h264', 'vp8', 'vp9', 'av1']);
const DEFAULT_CLIENT_AUDIO_CODECS = Object.freeze(['aac', 'mp3', 'opus', 'vorbis']);

function normalizedList(value, fallback) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const result = [...new Set(values
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean))];
  return result.length ? result : [...fallback];
}

function normalizeContainer(value) {
  const container = String(value || '').trim().toLowerCase();
  if (container.includes('matroska')) return 'mkv';
  if (container.includes('quicktime') || container === 'm4v') return 'mp4';
  if (container.includes('mpegts')) return 'ts';
  return container.replace(/^\./, '') || 'unknown';
}

function normalizeCodec(value) {
  const codec = String(value || '').trim().toLowerCase();
  if (['h265', 'hvc1', 'hev1'].includes(codec)) return 'hevc';
  if (['av01'].includes(codec)) return 'av1';
  if (['vp09'].includes(codec)) return 'vp9';
  if (['mp4a.40.2', 'mp4a'].includes(codec)) return 'aac';
  if (['ac-3', 'ac3'].includes(codec)) return 'ac3';
  if (['ec-3', 'eac3'].includes(codec)) return 'eac3';
  return codec;
}

/**
 * Normalize the capabilities advertised by a desktop, browser, or mobile
 * client. Defaults are deliberately conservative browser capabilities so an
 * older client can omit fields without accidentally receiving an unsupported
 * direct stream.
 */
export function normalizeClientPlaybackCapabilities(input = {}) {
  const streamingProtocols = normalizedList(input.streamingProtocols, input.supportsHls === false ? ['http'] : ['http', 'hls'])
    .filter((entry) => ['http', 'hls'].includes(entry));
  const subtitleModes = normalizedList(input.subtitleModes, input.supportsTextSubtitles === false
    ? ['burn-in'] : ['text', 'external', 'burn-in'])
    .filter((entry) => ['text', 'bitmap', 'burn-in', 'external'].includes(entry));
  const hdrFormats = normalizedList(input.hdrFormats, input.supportsHdr === true ? ['hdr10', 'hlg'] : [])
    .filter((entry) => ['hdr10', 'hdr10-plus', 'hlg', 'dolby-vision'].includes(entry));
  return {
    contractVersion: 1,
    containers: normalizedList(input.containers, DEFAULT_CLIENT_CONTAINERS).map(normalizeContainer),
    videoCodecs: normalizedList(input.videoCodecs, DEFAULT_CLIENT_VIDEO_CODECS).map(normalizeCodec),
    audioCodecs: normalizedList(input.audioCodecs, DEFAULT_CLIENT_AUDIO_CODECS).map(normalizeCodec),
    streamingProtocols,
    subtitleModes,
    hdrFormats,
    supportsHls: streamingProtocols.includes('hls'),
    supportsHdr: hdrFormats.length > 0,
    supportsTextSubtitles: subtitleModes.includes('text') || subtitleModes.includes('external'),
    maxWidth: boundedInteger(input.maxWidth, 0, 0, 16_384),
    maxHeight: boundedInteger(input.maxHeight, 0, 0, 16_384),
    maxVideoBitrateKbps: boundedInteger(input.maxVideoBitrateKbps, 0, 0, 500_000),
  };
}

function mediaFacts(media = {}) {
  const metadata = media.localMetadata || media.metadata || media;
  const filePath = media.path || media.filePath || '';
  const extension = path.extname(String(filePath)).replace(/^\./, '').toLowerCase();
  const container = normalizeContainer(metadata.container || media.container || extension);
  const videoCodec = normalizeCodec(metadata.videoCodec || media.videoCodec);
  const audioCodec = normalizeCodec(metadata.audioCodec || media.audioCodec);
  const width = boundedInteger(metadata.width || media.width, 0, 0, 16_384);
  const height = boundedInteger(metadata.height || media.height, 0, 0, 16_384);
  const bitrate = boundedInteger(metadata.bitrateKbps || media.bitrateKbps, 0, 0, 500_000);
  const transfer = String(metadata.colorTransfer || media.colorTransfer || '').toLowerCase();
  const primaries = String(metadata.colorPrimaries || media.colorPrimaries || '').toLowerCase();
  const pixelFormat = String(metadata.pixelFormat || media.pixelFormat || '').toLowerCase();
  const hdr = media.hdr === true || metadata.hdr === true
    || ['smpte2084', 'arib-std-b67', 'hlg'].includes(transfer)
    || primaries.includes('bt2020')
    || (primaries.includes('bt2020') && /10|12/.test(pixelFormat));
  const tracks = Array.isArray(metadata.tracks || media.tracks) ? (metadata.tracks || media.tracks).map((track, ordinal) => ({
    id: String(track.id || `stream:${Number.isInteger(track.index) ? track.index : ordinal}`),
    index: Number.isInteger(track.index) ? track.index : ordinal,
    kind: track.kind || track.type || 'unknown',
    codec: normalizeCodec(track.codec),
    language: track.language,
    title: track.title,
    channels: track.channels,
    width: track.width,
    height: track.height,
    profile: track.profile,
    pixelFormat: track.pixelFormat,
    colorTransfer: track.colorTransfer,
    colorPrimaries: track.colorPrimaries,
    colorSpace: track.colorSpace,
    frameRate: track.frameRate,
    default: track.default === true,
    forced: track.forced === true,
    external: track.external === true,
  })) : [];
  if (!tracks.some((track) => track.kind === 'video') && videoCodec) tracks.push({ id: 'stream:0', index: 0, kind: 'video', codec: videoCodec, width, height, default: true, forced: false });
  if (!tracks.some((track) => track.kind === 'audio') && audioCodec) tracks.push({ id: 'stream:1', index: 1, kind: 'audio', codec: audioCodec, default: true, forced: false });
  const hdrFormat = metadata.hdrFormat || media.hdrFormat || null;
  return {
    sourceId: String(media.sourceId || metadata.sourceId || 'primary'),
    sourceState: media.state || media.sourceState || (media.available === false ? 'offline' : 'online'),
    container, videoCodec, audioCodec: audioCodec || 'none', width, height, bitrate, hdr, hdrFormat, tracks,
  };
}

function trackFor(facts, kind, requestedId, { allowNone = false, forcedFallback = false } = {}) {
  if (allowNone && requestedId === null) return null;
  const candidates = facts.tracks.filter((track) => track.kind === kind);
  if (requestedId !== undefined && requestedId !== null) {
    const selected = candidates.find((track) => track.id === requestedId || String(track.index) === String(requestedId));
    if (!selected) throw Object.assign(new Error(`The requested ${kind} track is unavailable.`), { code: 'playback_track_not_found', status: 422, trackKind: kind });
    return selected;
  }
  if (forcedFallback) return candidates.find((track) => track.forced) || null;
  return candidates.find((track) => track.default) || candidates[0] || null;
}

function subtitleKind(codec) {
  if (['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(codec)) return 'text';
  return 'bitmap';
}

function playbackUnavailable(code, message, status = 422, details = {}) {
  return Object.assign(new Error(message), { code, status, retryable: status >= 500, ...details });
}

/**
 * Select a transport and output profile without starting a process. The
 * server can use this same decision for LAN clients and the desktop renderer
 * can display the reason before a transcode is requested.
 */
export function playbackPlanForMedia(media = {}, input = {}, request = {}) {
  const capabilities = normalizeClientPlaybackCapabilities(input.capabilities || input);
  const facts = mediaFacts(media);
  if (facts.sourceState !== 'online') throw playbackUnavailable(
    facts.sourceState === 'unreadable' ? 'media_source_unreadable' : 'media_source_unavailable',
    'The selected media source is not currently readable.', 409, { sourceState: facts.sourceState },
  );
  const video = trackFor(facts, 'video', request.videoTrackId);
  if (!video) throw playbackUnavailable('media_probe_incomplete', 'No playable video track was found.', 422);
  const audio = trackFor(facts, 'audio', request.audioTrackId, { allowNone: true });
  const subtitle = trackFor(facts, 'subtitle', request.subtitleTrackId, { allowNone: true, forcedFallback: true });
  const selectedVideoCodec = normalizeCodec(video.codec || facts.videoCodec);
  const selectedAudioCodec = audio ? normalizeCodec(audio.codec || facts.audioCodec) : 'none';
  const containerSupported = capabilities.containers.includes(facts.container);
  const videoSupported = selectedVideoCodec && capabilities.videoCodecs.includes(selectedVideoCodec);
  const audioSupported = selectedAudioCodec === 'none' || capabilities.audioCodecs.includes(selectedAudioCodec);
  const selectedWidth = Number(video.width || facts.width) || 0;
  const selectedHeight = Number(video.height || facts.height) || 0;
  const sizeSupported = (!capabilities.maxWidth || !selectedWidth || selectedWidth <= capabilities.maxWidth)
    && (!capabilities.maxHeight || !selectedHeight || selectedHeight <= capabilities.maxHeight);
  const bitrateSupported = !capabilities.maxVideoBitrateKbps
    || !facts.bitrate
    || facts.bitrate <= capabilities.maxVideoBitrateKbps;
  const hdrSupported = !facts.hdr || Boolean(facts.hdrFormat && capabilities.hdrFormats.includes(facts.hdrFormat));
  const selectedSubtitleKind = subtitle ? subtitleKind(normalizeCodec(subtitle.codec)) : null;
  const subtitleSupported = !subtitle || capabilities.subtitleModes.includes(selectedSubtitleKind)
    || (selectedSubtitleKind === 'text' && capabilities.subtitleModes.includes('external'));
  const sourceDirectCompatible = containerSupported && videoSupported && audioSupported
    && sizeSupported && bitrateSupported && hdrSupported && subtitleSupported;
  // The canonical HLS writer currently emits one multiplexed A/V rendition.
  // A selected subtitle therefore has to be burned whenever delivery is not
  // direct, even when the client could render that subtitle from another URL.
  const burnSubtitles = Boolean(subtitle && !sourceDirectCompatible && capabilities.subtitleModes.includes('burn-in'));
  if (subtitle && !sourceDirectCompatible && !burnSubtitles) throw playbackUnavailable(
    'subtitle_mode_unsupported', 'The selected subtitle requires burn-in for this delivery mode, which the client did not advertise.', 422,
  );

  const codec = 'h264';
  const reasons = [];
  if (!containerSupported) reasons.push(`${facts.container || 'unknown'} container`);
  if (!videoSupported) reasons.push(`${facts.videoCodec || 'unknown'} video`);
  if (!audioSupported) reasons.push(`${facts.audioCodec || 'unknown'} audio`);
  if (!sizeSupported) reasons.push('client dimensions');
  if (!bitrateSupported) reasons.push('client bitrate');
  if (!hdrSupported) reasons.push('HDR tone mapping');
  if (burnSubtitles) reasons.push('subtitle burn-in');
  const direct = sourceDirectCompatible && !burnSubtitles;
  const remux = !direct && selectedVideoCodec === 'h264' && videoSupported
    && sizeSupported && bitrateSupported && hdrSupported && !burnSubtitles;
  const mode = direct ? 'direct' : remux ? 'remux' : 'transcode';
  if (mode !== 'direct' && !capabilities.supportsHls) throw playbackUnavailable(
    'playback_transport_unsupported', 'This playback plan requires HLS, which the client did not advertise.', 422,
  );
  if (mode !== 'direct' && !capabilities.videoCodecs.includes('h264')) throw playbackUnavailable(
    'playback_codec_unsupported', 'The canonical MPEG-TS HLS rendition requires H.264 support.', 422,
  );
  const reasonCode = direct ? 'direct_compatible'
    : remux ? (audioSupported ? 'remux_container' : 'remux_audio')
      : !videoSupported ? 'transcode_video_codec'
        : !sizeSupported ? 'transcode_dimensions'
          : !bitrateSupported ? 'transcode_bitrate'
            : !hdrSupported ? 'transcode_hdr' : 'transcode_subtitles';
  return {
    contractVersion: 1,
    mode,
    transport: direct ? 'http' : 'hls',
    reasonCode,
    reason: direct ? 'The selected source tracks match the client capabilities.'
      : `${mode === 'remux' ? 'Remuxing' : 'Transcoding'} is required for ${reasons.join(', ') || 'container compatibility'}.`,
    sourceId: facts.sourceId,
    sourceAction: direct ? 'direct' : 'transcode',
    selectedVideoTrackId: video.id,
    ...(audio ? { selectedAudioTrackId: audio.id } : {}),
    ...(subtitle ? { selectedSubtitleTrackId: subtitle.id } : {}),
    selectedVideoTrackIndex: video.index,
    ...(audio ? { selectedAudioTrackIndex: audio.index } : {}),
    ...(subtitle ? { selectedSubtitleTrackIndex: subtitle.index } : {}),
    ...(subtitle ? { selectedSubtitleTrackOrdinal: facts.tracks.filter((track) => track.kind === 'subtitle' && track.index <= subtitle.index).length - 1 } : {}),
    outputContainer: direct ? facts.container : 'mpegts',
    outputVideoCodec: direct ? selectedVideoCodec : 'h264',
    ...(audio ? { outputAudioCodec: direct ? selectedAudioCodec : 'aac' } : {}),
    burnSubtitles,
    toneMap: facts.hdr && !hdrSupported,
    ...(capabilities.maxWidth ? { maxWidth: capabilities.maxWidth } : {}),
    ...(capabilities.maxHeight ? { maxHeight: capabilities.maxHeight } : {}),
    ...(capabilities.maxVideoBitrateKbps ? { videoBitrateKbps: capabilities.maxVideoBitrateKbps } : {}),
    audioBitrateKbps: 160,
    codec: direct ? selectedVideoCodec : codec,
    backend: direct ? 'client-native' : 'auto',
    copyVideo: direct || remux,
    copyAudio: direct || (remux && selectedAudioCodec === 'aac'),
    requiresFfmpeg: !direct,
    facts,
  };
}

function frameRate(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/');
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function hdrFormatForStream(stream, transfer, primaries, pixelFormat) {
  const sideData = Array.isArray(stream?.side_data_list) ? stream.side_data_list : [];
  const codecTag = String(stream?.codec_tag_string || '').toLowerCase();
  if (codecTag.includes('dvh') || sideData.some((entry) => /dovi|dolby vision/i.test(String(entry?.side_data_type || '')))) return 'dolby-vision';
  if (sideData.some((entry) => /smpte2094-40|hdr dynamic metadata/i.test(String(entry?.side_data_type || '')))) return 'hdr10-plus';
  if (transfer === 'arib-std-b67' || transfer === 'hlg') return 'hlg';
  if (transfer === 'smpte2084' && (primaries.includes('bt2020') || /10|12/.test(pixelFormat))) return 'hdr10';
  return null;
}

export function ffprobeMediaArguments(filePath) {
  return ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', filePath];
}

export function parseFfprobeMediaProbe(raw, { sourceId = 'primary', probedAt = Date.now() } = {}) {
  const parsed = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(String(raw)) : raw;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.streams)) throw playbackUnavailable('media_probe_invalid', 'FFprobe returned an invalid media document.', 422);
  const tracks = parsed.streams.slice(0, 256).flatMap((stream, ordinal) => {
    if (!stream || stream.disposition?.attached_pic === 1 || stream.codec_type === 'attachment') return [];
    const kind = ['video', 'audio', 'subtitle', 'data'].includes(stream.codec_type) ? stream.codec_type : 'unknown';
    const index = Number.isInteger(stream.index) ? stream.index : ordinal;
    return [{
      id: `stream:${index}`, index, kind, codec: normalizeCodec(stream.codec_name),
      ...(stream.tags?.language ? { language: String(stream.tags.language).slice(0, 32) } : {}),
      ...(stream.tags?.title ? { title: String(stream.tags.title).slice(0, 200) } : {}),
      ...(Number.isFinite(stream.channels) ? { channels: Number(stream.channels) } : {}),
      ...(Number.isFinite(stream.width) ? { width: Number(stream.width) } : {}),
      ...(Number.isFinite(stream.height) ? { height: Number(stream.height) } : {}),
      ...(stream.profile ? { profile: String(stream.profile).slice(0, 80) } : {}),
      ...(stream.pix_fmt ? { pixelFormat: String(stream.pix_fmt).slice(0, 80) } : {}),
      ...(stream.color_transfer ? { colorTransfer: String(stream.color_transfer).slice(0, 80) } : {}),
      ...(stream.color_primaries ? { colorPrimaries: String(stream.color_primaries).slice(0, 80) } : {}),
      ...(stream.color_space ? { colorSpace: String(stream.color_space).slice(0, 80) } : {}),
      ...(frameRate(stream.avg_frame_rate || stream.r_frame_rate) ? { frameRate: frameRate(stream.avg_frame_rate || stream.r_frame_rate) } : {}),
      default: stream.disposition?.default === 1, forced: stream.disposition?.forced === 1,
    }];
  });
  const video = tracks.find((track) => track.kind === 'video');
  const audio = tracks.find((track) => track.kind === 'audio');
  const durationSeconds = Number(parsed.format?.duration);
  const bitrateKbps = Number(parsed.format?.bit_rate) / 1000;
  const transfer = String(video?.colorTransfer || '').toLowerCase();
  const primaries = String(video?.colorPrimaries || '').toLowerCase();
  const pixelFormat = String(video?.pixelFormat || '').toLowerCase();
  const videoStream = parsed.streams.find((stream) => stream?.codec_type === 'video' && stream?.disposition?.attached_pic !== 1);
  const hdrFormat = hdrFormatForStream(videoStream, transfer, primaries, pixelFormat);
  return {
    sourceId,
    container: normalizeContainer(String(parsed.format?.format_name || '').split(',')[0]),
    ...(Number.isFinite(durationSeconds) && durationSeconds >= 0 ? { durationSeconds } : {}),
    ...(Number.isFinite(bitrateKbps) && bitrateKbps >= 0 ? { bitrateKbps: Math.round(bitrateKbps) } : {}),
    ...(video?.width ? { width: video.width } : {}), ...(video?.height ? { height: video.height } : {}),
    ...(video?.codec ? { videoCodec: video.codec } : {}), ...(audio?.codec ? { audioCodec: audio.codec } : {}),
    hdr: Boolean(hdrFormat),
    ...(hdrFormat ? { hdrFormat } : {}),
    tracks,
    chapters: (Array.isArray(parsed.chapters) ? parsed.chapters : []).slice(0, 10_000).flatMap((chapter) => {
      const startMs = Math.round(Number(chapter.start_time) * 1000);
      const endMs = Math.round(Number(chapter.end_time) * 1000);
      const title = String(chapter.tags?.title || '').trim().slice(0, 500);
      return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && title ? [{ startMs, endMs, title }] : [];
    }),
    adapterGaps: ['external_sidecar_subtitles'],
    probedAt,
  };
}

export function normalizeProfileType(value, fallback = 'standard') {
  const type = String(value || '').trim().toLowerCase();
  return profileTypeSet.has(type) ? type : fallback;
}

/**
 * Keep profile-facing data portable without leaking credentials or runtime
 * storage fields through a shared library/session payload.
 */
export function profileView(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    id: String(profile.id || ''),
    name: String(profile.name || 'Viewer').trim().slice(0, 80) || 'Viewer',
    type: normalizeProfileType(profile.type),
    hasPin: profile.hasPin === true,
    isGuest: profile.isGuest === true,
  };
}

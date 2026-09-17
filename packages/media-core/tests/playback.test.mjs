import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeClientPlaybackCapabilities, parseFfprobeMediaProbe, playbackPlanForMedia } from '../src/index.mjs';

function probe(format, videoCodec = 'h264', audioCodec = 'aac', options) {
  return parseFfprobeMediaProbe({
    format,
    streams: [
      { index: 0, codec_type: 'video', codec_name: videoCodec, width: 1920, height: 1080 },
      { index: 1, codec_type: 'audio', codec_name: audioCodec },
    ],
  }, options);
}

const movFamily = 'mov,mp4,m4a,3gp,3g2,mj2';

test('ffprobe MP4 family uses filename and brand hints without making MOV direct safe', () => {
  for (const format of [
    { format_name: movFamily, filename: '/media/movie.MP4' },
    { format_name: movFamily, filename: 'C:\\media\\movie.m4v' },
    { format_name: movFamily, tags: { major_brand: 'isom' } },
    { format_name: movFamily, tags: { major_brand: 'mp42' } },
  ]) {
    const media = probe(format);
    assert.equal(media.container, 'mp4');
    assert.equal(playbackPlanForMedia(media).mode, 'direct');
  }
  assert.equal(probe({ format_name: movFamily }, 'h264', 'aac', { filePath: '/media/movie.mp4' }).container, 'mp4');
  for (const format of [
    { format_name: movFamily },
    { format_name: movFamily, filename: '/media/movie.mov' },
    { format_name: movFamily, filename: '/media/movie.mp4', tags: { major_brand: 'qt  ' } },
    { format_name: 'quicktime' },
  ]) {
    const media = probe(format);
    assert.equal(media.container, 'mov');
    assert.equal(playbackPlanForMedia(media).mode, 'remux');
  }
  const prores = probe({ format_name: movFamily, filename: '/media/movie.mov' }, 'prores', 'pcm_s16le');
  assert.equal(playbackPlanForMedia(prores, { containers: ['mov'] }).mode, 'transcode');
  assert.equal(playbackPlanForMedia(probe({ format_name: movFamily, tags: { major_brand: 'isom' } }, 'prores')).mode, 'transcode');
});

test('ffprobe distinguishes WebM from Matroska using path hints', () => {
  for (const format of [
    { format_name: 'matroska,webm', filename: '/media/movie.WEBM' },
    { format_name: 'webm' },
  ]) {
    const media = probe(format, 'vp9', 'opus');
    assert.equal(media.container, 'webm');
    assert.equal(playbackPlanForMedia(media).mode, 'direct');
  }
  assert.equal(probe({ format_name: 'matroska,webm' }, 'vp9', 'opus', { filePath: 'C:\\media\\movie.webm' }).container, 'webm');
  assert.equal(probe({ format_name: 'matroska,webm', filename: '/media/movie.mkv' }).container, 'mkv');
  assert.equal(probe({ format_name: 'matroska,webm' }).container, 'mkv');
  assert.equal(playbackPlanForMedia({ path: '/media/movie.webm', container: 'matroska,webm', videoCodec: 'vp9', audioCodec: 'opus' }).mode, 'direct');
});

test('omitted capability lists retain defaults while explicit empty lists remain empty', () => {
  const defaults = normalizeClientPlaybackCapabilities();
  for (const field of ['containers', 'videoCodecs', 'audioCodecs', 'streamingProtocols', 'subtitleModes']) {
    assert.ok(defaults[field].length > 0);
    assert.deepEqual(normalizeClientPlaybackCapabilities({ [field]: [] })[field], []);
  }
  const media = probe({ format_name: 'mp4' });
  assert.equal(playbackPlanForMedia(media).mode, 'direct');
  assert.throws(() => playbackPlanForMedia(media, { videoCodecs: [] }), { code: 'playback_codec_unsupported' });
  assert.throws(() => playbackPlanForMedia(media, { audioCodecs: [] }), { code: 'playback_codec_unsupported' });
  assert.equal(playbackPlanForMedia(media, { containers: [] }).mode, 'remux');
});

test('planner honors HTTP and HLS transport declarations', () => {
  const media = probe({ format_name: 'mp4' });
  assert.equal(playbackPlanForMedia(media, { streamingProtocols: ['http'] }).transport, 'http');
  const hls = playbackPlanForMedia(media, { streamingProtocols: ['hls'] });
  assert.equal(hls.mode, 'remux');
  assert.equal(hls.transport, 'hls');
  assert.match(hls.reason, /HTTP transport/);
  for (const streamingProtocols of [[], ['unknown']]) {
    assert.throws(() => playbackPlanForMedia(media, { streamingProtocols }), { code: 'playback_transport_unsupported' });
  }
  assert.throws(() => playbackPlanForMedia(probe({ format_name: 'mkv' }), { supportsHls: false }), { code: 'playback_transport_unsupported' });
  const subtitled = { ...media, tracks: [...media.tracks, { id: 'stream:2', index: 2, kind: 'subtitle', codec: 'subrip', forced: true }] };
  assert.equal(playbackPlanForMedia(subtitled, { streamingProtocols: ['hls'] }).burnSubtitles, true);
  assert.throws(() => playbackPlanForMedia(subtitled, { streamingProtocols: ['hls'], subtitleModes: ['text'] }), { code: 'subtitle_mode_unsupported' });
});

test('HLS requires AAC only when the selected output has audio', () => {
  for (const videoCodec of ['h264', 'hevc']) {
    const media = probe({ format_name: 'mkv' }, videoCodec, 'opus');
    assert.throws(() => playbackPlanForMedia(media, { audioCodecs: ['opus'] }), { code: 'playback_codec_unsupported' });
    assert.equal(playbackPlanForMedia(media).outputAudioCodec, 'aac');
    const muted = playbackPlanForMedia(media, { audioCodecs: [] }, { audioTrackId: null });
    assert.equal(muted.transport, 'hls');
    assert.equal(muted.outputAudioCodec, undefined);
  }
  const silent = { container: 'mkv', videoCodec: 'h264' };
  assert.equal(playbackPlanForMedia(silent, { audioCodecs: [] }).outputAudioCodec, undefined);
  assert.equal(playbackPlanForMedia(probe({ format_name: 'webm' }, 'vp9', 'opus'), { audioCodecs: ['opus'] }).mode, 'direct');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { browserPlaybackPlanForMetadata } from '../src/main/transcodeDecisionCore.ts';
import type { LocalMediaDetails } from '../src/main/metadata/types.ts';

const h264Aac: LocalMediaDetails = {
  videoCodec: 'h264',
  videoProfile: 'High',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioTracks: 1,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
};

test('browser-safe MP4 direct plays without FFmpeg', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.mp4', h264Aac);

  assert.equal(plan.mode, 'direct');
  assert.equal(plan.contentType, 'video/mp4');
  assert.equal(plan.requiresFfmpeg, false);
  assert.equal(plan.requiresSeekRestart, false);
  assert.equal(plan.copyVideo, false);
  assert.equal(plan.copyAudio, false);
});

test('native HEVC MP4 direct plays first and can fall back if the client rejects it', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.mp4', {
    ...h264Aac,
    videoCodec: 'hevc',
    videoProfile: 'Main 10',
    pixelFormat: 'yuv420p10le',
  });

  assert.equal(plan.mode, 'direct');
  assert.equal(plan.requiresFfmpeg, false);
  assert.equal(plan.contentType, 'video/mp4');
});

test('browser-safe MKV remuxes by stream-copying video and audio', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.mkv', {
    ...h264Aac,
    container: 'matroska',
  });

  assert.equal(plan.mode, 'remux');
  assert.equal(plan.contentType, 'video/mp4');
  assert.equal(plan.requiresFfmpeg, true);
  assert.equal(plan.copyVideo, true);
  assert.equal(plan.copyAudio, true);
});

test('MP4-compatible HEVC in MKV remuxes by stream-copying video and audio', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.mkv', {
    ...h264Aac,
    videoCodec: 'hevc',
    videoProfile: 'Main',
    pixelFormat: 'yuv420p',
    container: 'matroska',
  });

  assert.equal(plan.mode, 'remux');
  assert.equal(plan.copyVideo, true);
  assert.equal(plan.copyAudio, true);
});

test('safe video with unsupported audio becomes direct-stream', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.mkv', {
    ...h264Aac,
    audioCodec: 'dts',
    container: 'matroska',
  });

  assert.equal(plan.mode, 'direct-stream');
  assert.equal(plan.copyVideo, true);
  assert.equal(plan.copyAudio, false);
});

test('unsupported video transcodes while keeping browser-safe audio', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.mkv', {
    ...h264Aac,
    videoCodec: 'prores',
    audioCodec: 'aac',
    container: 'matroska',
  });

  assert.equal(plan.mode, 'transcode');
  assert.equal(plan.copyVideo, false);
  assert.equal(plan.copyAudio, true);
});

test('selected subtitles force video transcode for burn-in', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.mp4', h264Aac, {
    subtitleTrackIndex: 2,
    subtitleStreamOrdinal: 0,
    subtitleCodec: 'subrip',
  });

  assert.equal(plan.mode, 'transcode');
  assert.equal(plan.copyVideo, false);
  assert.equal(plan.copyAudio, true);
});

test('browser-safe WebM direct plays as WebM', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.webm', {
    videoCodec: 'vp9',
    audioCodec: 'opus',
    audioTracks: 1,
    container: 'matroska,webm',
  });

  assert.equal(plan.mode, 'direct');
  assert.equal(plan.contentType, 'video/webm');
});

test('selected tracks repackage even when the source container is safe', () => {
  const plan = browserPlaybackPlanForMetadata('/media/movie.mp4', h264Aac, {
    audioTrackIndex: 3,
  });

  assert.equal(plan.mode, 'remux');
  assert.equal(plan.copyVideo, true);
  assert.equal(plan.copyAudio, true);
});

test('missing metadata tries safe containers directly but not unsafe ones', () => {
  assert.equal(browserPlaybackPlanForMetadata('/media/movie.mp4').mode, 'direct');
  assert.equal(browserPlaybackPlanForMetadata('/media/movie.mkv').mode, 'transcode');
});

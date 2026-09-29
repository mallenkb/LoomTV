import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBrowserStreamArgs } from '../src/main/streamTranscodePlan.ts';

test('preserves a shared timestamp origin for seeked direct-stream copies', () => {
  assert.deepEqual(buildBrowserStreamArgs({
    filePath: '/media/show.mkv',
    options: { startSeconds: 91.9, videoTrackIndex: 2, audioTrackIndex: 3 },
    copyVideo: true,
    copyAudio: true,
    hardwareEncoder: null,
  }), [
    '-nostdin', '-ss', '91', '-copyts', '-start_at_zero', '-i', '/media/show.mkv',
    '-map', '0:2', '-map', '0:3?',
    '-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1',
    '-c:v', 'copy', '-c:a', 'copy',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1',
  ]);
});

test('builds the unchanged software encode argument order without audio', () => {
  assert.deepEqual(buildBrowserStreamArgs({
    filePath: '/media/movie.avi',
    options: { audioTrackIndex: -1 },
    copyVideo: false,
    copyAudio: false,
    hardwareEncoder: null,
  }), [
    '-nostdin', '-i', '/media/movie.avi', '-map', '0:v:0',
    '-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1',
    '-vf', 'format=yuv420p', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-an',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1',
  ]);
});

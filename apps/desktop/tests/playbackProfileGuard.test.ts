import assert from 'node:assert/strict';
import test from 'node:test';

import { isProfileSelectionRequiredError } from '../src/components/VideoPlayer/playbackProfileGuard.ts';

test('recognizes a missing desktop profile returned through Electron IPC', () => {
  assert.equal(
    isProfileSelectionRequiredError(
      new Error("Error invoking remote method 'media:get-stream-url': ProfileError: No profile is selected on this device."),
    ),
    true,
  );
});

test('does not classify ordinary stream failures as profile failures', () => {
  assert.equal(isProfileSelectionRequiredError(new Error('FFmpeg is not available.')), false);
});

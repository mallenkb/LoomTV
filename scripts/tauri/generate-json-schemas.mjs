import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { settingsPayloadSchema } from '../../apps/desktop/src/lib/desktopDecoders.ts';
import { lanProfilePreferencesSchema } from '../../packages/lan-protocol/src/schemas.ts';

for (const [name, schema] of Object.entries({ settings: settingsPayloadSchema, preferences: lanProfilePreferencesSchema })) {
  await writeFile(new URL(`../../crates/loomtv-core/schemas/${name}.json`, import.meta.url), JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
}
console.log('Generated Rust validation schemas from the desktop TypeScript decoders.');

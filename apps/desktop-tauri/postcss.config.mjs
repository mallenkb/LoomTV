import tailwind from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';

export default {
  plugins: [tailwind({ base: fileURLToPath(new URL('../desktop/src', import.meta.url)) })],
};

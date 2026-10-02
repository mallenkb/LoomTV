import { z } from 'zod';

const root = z.object({
  id: z.string(), name: z.string(), path: z.string(), count: z.number(),
  scanning: z.boolean(), discovered: z.number(), message: z.string().nullable(),
  scannedAt: z.number().nullable(),
});
export const mediaRootsSchema = z.array(root);
export const photoRootsSchema = z.array(root.extend({ state: z.enum(['available', 'unavailable']) }));

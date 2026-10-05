import { z } from 'zod';

export const startupLibraryRenderArgsSchema = z.tuple([z.number().finite().positive().max(Number.MAX_SAFE_INTEGER)]);

export class IpcArgumentValidationError extends Error {
  constructor(channel: string, options?: ErrorOptions) {
    super(`Invalid arguments for IPC channel "${channel}".`, options);
    this.name = 'IpcArgumentValidationError';
  }
}

export function parseIpcArguments<TSchema extends z.ZodType<unknown[]>>(
  channel: string,
  args: unknown[],
  schema: TSchema,
): z.output<TSchema> {
  const result = schema.safeParse(args);
  if (!result.success) throw new IpcArgumentValidationError(channel, { cause: result.error });
  return result.data;
}

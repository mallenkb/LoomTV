import { z } from 'zod';

export class DatabaseRowValidationError extends Error {
  constructor(context: string, options?: ErrorOptions) {
    super(`The ${context} database row has an invalid shape.`, options);
    this.name = 'DatabaseRowValidationError';
  }
}

export function parseDatabaseRow<TSchema extends z.ZodType>(
  value: unknown,
  schema: TSchema,
  context: string,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new DatabaseRowValidationError(context, { cause: result.error });
  return result.data;
}

export function parseDatabaseRows<TSchema extends z.ZodType>(
  values: readonly unknown[],
  schema: TSchema,
  context: string,
): Array<z.output<TSchema>> {
  return values.map((value) => parseDatabaseRow(value, schema, context));
}

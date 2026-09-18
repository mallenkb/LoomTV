/** Shared FFI types so startup warmup and playback use the same library handles. */
export type KoffiType = object;
export type KoffiTypeSpec = string | KoffiType;
export type NativeValue = string | number | bigint | boolean | null | undefined
  | Buffer
  | Record<string, unknown>
  | readonly (string | null)[];
export type DynamicFunction = (...args: NativeValue[]) => NativeValue;
export type KoffiLibrary = {
  func: (name: string, returnType: KoffiTypeSpec, argumentTypes: readonly KoffiTypeSpec[]) => DynamicFunction;
};
export type KoffiRuntime = {
  load: (libraryPath: string) => KoffiLibrary;
  struct: (fields: Record<string, KoffiTypeSpec>) => KoffiType;
  decode: (value: NativeValue, type: KoffiTypeSpec) => Record<string, NativeValue>;
};

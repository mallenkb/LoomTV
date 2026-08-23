declare module 'react-native-zeroconf' {
  export type ZeroconfService = {
    name: string;
    host?: string;
    addresses?: string[];
    port?: number;
    txt?: Record<string, string | number>;
  };
  export default class Zeroconf {
    on(event: 'resolved', listener: (service: ZeroconfService) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'start' | 'stop', listener: () => void): this;
    removeAllListeners(): this;
    removeDeviceListeners(): void;
    scan(type?: string, protocol?: string, domain?: string): void;
    stop(): void;
  }
}

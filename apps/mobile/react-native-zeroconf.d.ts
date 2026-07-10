declare module 'react-native-zeroconf' {
  type ZeroconfEvent = 'start' | 'stop' | 'found' | 'resolved' | 'remove' | 'update' | 'error';

  export type ZeroconfService = {
    name: string;
    host?: string;
    addresses?: string[];
    port?: number;
    txt?: Record<string, string | number>;
  };

  export default class Zeroconf {
    on(event: 'resolved', listener: (service: ZeroconfService) => void): this;
    on(event: 'remove' | 'found', listener: (name: string) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: Exclude<ZeroconfEvent, 'resolved' | 'remove' | 'found' | 'error'>, listener: () => void): this;
    removeAllListeners(event?: ZeroconfEvent): this;
    removeDeviceListeners(): void;
    scan(type?: string, protocol?: string, domain?: string): void;
    stop(): void;
  }
}

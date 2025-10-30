// types.d.ts - Global type declarations
interface Window {
  electron: {
    invoke(channel: string, ...args: any[]): Promise<any>;
  };
  app: {
    saveAll(): void;
  };
}

declare var window: Window;
export function detectPlatformKey(platform?: string, arch?: string): string | null;

export function findBundledNativeBinary(nativeDir: string): string | null;

export function selectBinaryForCurrentPlatform(options?: {
  platform?: string;
  arch?: string;
  cwd?: string;
  nativeDir?: string;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
}):
  | {
      platformKey: string;
      binaryPath: string;
    }
  | null;

export function runPostinstall(options?: {
  platform?: string;
  arch?: string;
  cwd?: string;
  nativeDir?: string;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
}): boolean;

export function isExecutedDirectly(
  moduleUrl?: string,
  entryPath?: string
): boolean;

export function runPostinstallEntrypoint(options?: {
  moduleUrl?: string;
  entryPath?: string;
  run?: () => boolean;
}): boolean | null;

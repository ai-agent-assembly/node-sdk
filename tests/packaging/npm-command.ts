import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

export function execNpm(
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding
): string {
  return execFileSync("npm", args, {
    ...options,
    // npm is a .cmd shim on Windows, which cannot be launched via execFile
    // without a shell. Keep non-Windows shell-free so path arguments stay argv.
    shell: process.platform === "win32",
  });
}

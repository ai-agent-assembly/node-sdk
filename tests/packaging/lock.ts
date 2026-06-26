import fs from "node:fs";
import path from "node:path";

const PACKAGING_LOCK_PATH = path.resolve(process.cwd(), ".packaging-test.lock");
const LOCK_RETRY_INTERVAL_MS = 25;
const RETRYABLE_LOCK_ERROR_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

/**
 * On-disk lock ownership record. Written into `.packaging-test.lock` when the
 * lock is acquired so that a later waiter can decide whether an existing lock is
 * held by a live process or is an orphan left behind by a holder that died (or
 * by a vitest test that timed out before its `finally` could release the lock).
 */
interface LockMetadata {
  pid: number;
  timestamp: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withPackagingLock<T>(
  callback: () => Promise<T> | T
): Promise<T> {
  let lockFd: number | undefined;

  while (lockFd === undefined) {
    try {
      lockFd = fs.openSync(PACKAGING_LOCK_PATH, "wx");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) {
        throw error;
      }

      const errorCode = String(error.code);
      if (!RETRYABLE_LOCK_ERROR_CODES.has(errorCode)) {
        throw error;
      }

      await sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }

  try {
    const metadata: LockMetadata = { pid: process.pid, timestamp: Date.now() };
    fs.writeFileSync(lockFd, JSON.stringify(metadata));
    return await callback();
  } finally {
    fs.closeSync(lockFd);
    fs.rmSync(PACKAGING_LOCK_PATH, { force: true });
  }
}

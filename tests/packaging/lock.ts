import fs from "node:fs";
import path from "node:path";

const PACKAGING_LOCK_PATH = path.resolve(process.cwd(), ".packaging-test.lock");
const LOCK_RETRY_INTERVAL_MS = 25;
// A lock holder writes its {pid,timestamp} within milliseconds of creating the
// file, so a lock that is still empty after this grace window lost its writer
// (a 0-byte lock left by a previous run, or a holder that crashed mid-create).
const EMPTY_LOCK_GRACE_MS = 5_000;
// TTL backstop for a lock whose owning pid still appears alive — e.g. after pid
// reuse on a long-lived runner. It is deliberately far larger than any plausible
// single packaging hold (build + npm pack run in seconds, not minutes) because
// those builds run via blocking execSync: a slow-but-live build must never be
// reclaimed out from under itself, which would let two builds race the same
// dist/. Dead-pid detection, not this TTL, is the primary staleness signal.
const STALE_LOCK_TTL_MS = 120_000;
// Bound the acquire wait so a lock held by a live, non-stale process surfaces an
// actionable error instead of an opaque "Test timed out". Keep this just under
// the packaging test timeout so queued Windows runners can wait for earlier
// multi-second pack/build checks while still failing with a clear message.
const LOCK_ACQUIRE_TIMEOUT_MS = 110_000;
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

/**
 * Returns true if a process with the given pid is still running. Uses the
 * signal-0 probe, which performs the permission/existence check without actually
 * delivering a signal. An EPERM means the process exists but is owned by another
 * user, so it is treated as alive; any other error (notably ESRCH) means dead.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Reads the ownership metadata of the current lock file, or undefined if the
 * lock is absent, empty, or not yet written (a holder that created the file but
 * crashed before writing its metadata).
 */
function readLockMetadata(): LockMetadata | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(PACKAGING_LOCK_PATH, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    if (typeof parsed.pid === "number" && typeof parsed.timestamp === "number") {
      return { pid: parsed.pid, timestamp: parsed.timestamp };
    }
  } catch {
    // Fall through: an unparseable lock is handled by the staleness fallback.
  }
  return undefined;
}

/**
 * Age of the lock file on disk in milliseconds, used to judge staleness of a
 * lock that has no parseable owner metadata. Returns undefined if the file no
 * longer exists.
 */
function lockFileAgeMs(): number | undefined {
  try {
    return Date.now() - fs.statSync(PACKAGING_LOCK_PATH).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Reclaims the lock if it is an orphan, returning true when one was removed.
 *
 * A lock is treated as stale when its owning process is dead, when it exceeds
 * the (large) TTL backstop, or — for a lock with no parseable metadata — once it
 * is older than the short empty-lock grace window. A live holder is never
 * reclaimed: it writes its metadata immediately on acquire, and its blocking
 * build completes far inside the TTL.
 */
function reclaimStaleLock(): boolean {
  const metadata = readLockMetadata();

  let isStale: boolean;
  if (metadata === undefined) {
    const ageMs = lockFileAgeMs();
    isStale = ageMs !== undefined && ageMs > EMPTY_LOCK_GRACE_MS;
  } else {
    isStale =
      !isProcessAlive(metadata.pid) ||
      Date.now() - metadata.timestamp > STALE_LOCK_TTL_MS;
  }

  if (!isStale) {
    return false;
  }

  fs.rmSync(PACKAGING_LOCK_PATH, { force: true });
  return true;
}

export async function withPackagingLock<T>(
  callback: () => Promise<T> | T
): Promise<T> {
  let lockFd: number | undefined;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

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

      // The lock is held. If it is an orphan (dead holder, or a stale 0-byte
      // lock left by a previous run), reclaim it and retry immediately;
      // otherwise back off and wait for the live holder to release it.
      if (reclaimStaleLock()) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms acquiring packaging lock ` +
            `at ${PACKAGING_LOCK_PATH}. It is held by a live, non-stale process; ` +
            `if it is orphaned, delete the file and re-run.`,
          { cause: error }
        );
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

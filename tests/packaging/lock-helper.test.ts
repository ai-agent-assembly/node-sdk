import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPackagingLock } from "./lock.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createFsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("withPackagingLock", () => {
  it("retries lock acquisition for Windows contention errors", async () => {
    const openSpy = vi
      .spyOn(fs, "openSync")
      .mockImplementationOnce(() => {
        throw createFsError("EPERM");
      })
      .mockImplementationOnce(() => 123);
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    const result = await withPackagingLock(async () => "ok");

    expect(result).toBe("ok");
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy).toHaveBeenCalledWith(123);
    expect(rmSpy).toHaveBeenCalledTimes(1);
  });

  it("reclaims a stale lock whose owning process is dead", async () => {
    const staleLock = JSON.stringify({ pid: 999999, timestamp: Date.now() });
    const openSpy = vi
      .spyOn(fs, "openSync")
      .mockImplementationOnce(() => {
        throw createFsError("EEXIST");
      })
      .mockImplementationOnce(() => 456);
    vi.spyOn(fs, "readFileSync").mockReturnValue(staleLock);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw createFsError("ESRCH");
    });
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

    const result = await withPackagingLock(async () => "reclaimed");

    expect(result).toBe("reclaimed");
    // First open hits the orphan; after reclaim the retry acquires it.
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(999999, 0);
    // Once to reclaim the orphan, once to release in the finally block.
    expect(rmSpy).toHaveBeenCalledTimes(2);
  });

  it("throws for non-retryable filesystem errors", async () => {
    vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw createFsError("ENOENT");
    });

    await expect(withPackagingLock(async () => "ignored")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

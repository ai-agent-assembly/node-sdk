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

  it("throws for non-retryable filesystem errors", async () => {
    vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw createFsError("ENOENT");
    });

    await expect(withPackagingLock(async () => "ignored")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

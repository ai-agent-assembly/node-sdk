import { describe, expect, it, vi } from "vitest";

interface MockBinding {
  connect: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  // Native `queryPolicy` is synchronous and returns a `{decision, reason}`
  // verdict (AAASM-3047), mirroring the napi shim's `PolicyDecision`.
  queryPolicy: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

async function loadNativeClientWithBinding(bindingFactory: () => MockBinding) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => {
      const binding = bindingFactory();
      return () => binding;
    }
  }));

  return import("../src/native/client.js");
}

async function loadNativeClientWithRequire(requireFactory: () => (path: string) => unknown) {
  vi.resetModules();
  vi.doMock("node:module", () => ({
    createRequire: () => requireFactory()
  }));

  return import("../src/native/client.js");
}

describe("createNativeClient", () => {
  it("reuses a cached native binding outside vitest runtime mode", async () => {
    const nativeBindingCacheKey = Symbol.for("@agent-assembly/sdk/native-binding");
    const globalWithCache = globalThis as Record<symbol, unknown>;
    const previousVitestFlag = process.env.VITEST;

    delete globalWithCache[nativeBindingCacheKey];
    process.env.VITEST = "false";

    try {
      let requireCallCount = 0;
      const binding = {
        connect: vi.fn(async () => ({ id: "handle-cache" })),
        sendEvent: vi.fn(() => undefined),
        queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
        disconnect: vi.fn(async () => undefined)
      } satisfies MockBinding;

      const mod = await loadNativeClientWithRequire(() => {
        return (request: string) => {
          // Count only the native-binding load (the thing under test for
          // caching); the AAASM-3683 package.json version lookup uses its own
          // require and must not inflate this count.
          if (request === "@agent-assembly/sdk/package.json") {
            return { version: "0.0.0-test" };
          }
          requireCallCount += 1;
          return binding;
        };
      });

      const firstClient = mod.createNativeClient({
        gateway: "/tmp/aa.sock",
        apiKey: "test-key",
        mode: "napi-inprocess"
      });
      await firstClient.queryPolicy({ action: "check-1" });

      const secondClient = mod.createNativeClient({
        gateway: "/tmp/aa.sock",
        apiKey: "test-key",
        mode: "napi-inprocess"
      });
      await secondClient.queryPolicy({ action: "check-2" });

      expect(requireCallCount).toBe(1);
    } finally {
      if (previousVitestFlag === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitestFlag;
      }
      delete globalWithCache[nativeBindingCacheKey];
    }
  });

  it("returns grpc-sidecar noop client by default", async () => {
    const mod = await loadNativeClientWithBinding(() => ({
      connect: vi.fn(async () => ({})),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    }));

    const client = mod.createNativeClient({
      gateway: "https://gateway.example.com",
      apiKey: "test-key"
    });

    expect(client.mode).toBe("grpc-sidecar");
    client.sendEvent({ action: "tool_call" });
    await expect(client.queryPolicy({ action: "check" })).resolves.toEqual({
      denied: false,
      pending: false
    });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("napi-inprocess: queryPolicy connects and maps a runtime DENY verdict", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "handle-1" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "deny", reason: "blocked" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    const mod = await loadNativeClientWithBinding(() => binding);

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    // AAASM-3050: queryPolicy now consults the native runtime and maps its
    // authoritative verdict. A "deny" surfaces as a blocking decision.
    const query = { agent_id: "agent-1", action_type: "tool_call", tool_name: "rm" };
    await expect(client.queryPolicy(query)).resolves.toEqual({
      denied: true,
      pending: false,
      reason: "blocked"
    });
    expect(binding.queryPolicy).toHaveBeenCalledWith({ id: "handle-1" }, query);

    // AAASM-3683: connect now also receives the agent id (wired at register
    // time, so undefined here) and the resolved sdk_version. Under the mocked
    // createRequire the package.json lookup yields no version, so it is undefined.
    expect(binding.connect).toHaveBeenCalledWith("/tmp/aa.sock", undefined, undefined);
    await expect(client.close()).resolves.toBeUndefined();
    expect(binding.disconnect).toHaveBeenCalledTimes(1);
  });

  it("napi-inprocess: maps a runtime ALLOW verdict to a neutral decision", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "handle-allow" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "ok" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    const mod = await loadNativeClientWithBinding(() => binding);
    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.queryPolicy({ action_type: "tool_call" })).resolves.toEqual({
      denied: false,
      pending: false
    });
    await client.close();
  });

  it("napi-inprocess: maps a runtime PENDING verdict to the approval path", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "handle-pending" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "pending", reason: "awaiting approval" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    const mod = await loadNativeClientWithBinding(() => binding);
    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.queryPolicy({ action_type: "tool_call" })).resolves.toEqual({
      denied: false,
      pending: true,
      reason: "awaiting approval"
    });
    await client.close();
  });

  it("maps connect failure to NativeConnectError", async () => {
    const mod = await loadNativeClientWithBinding(() => ({
      connect: vi.fn(async () => {
        throw new Error("AA_ERR_CONNECT:socketPath cannot be empty");
      }),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    }));

    const client = mod.createNativeClient({
      gateway: "",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.queryPolicy({ action: "check" })).rejects.toBeInstanceOf(
      mod.NativeConnectError
    );
  });

  it("maps non-Error connect failures to a generic Error", async () => {
    const mod = await loadNativeClientWithBinding(() => ({
      connect: vi.fn(async () => {
        throw "broken-connect";
      }),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    }));

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.queryPolicy({ action: "check" })).rejects.toThrow("broken-connect");
  });

  it("returns original Error when native error code is unknown", async () => {
    const unknownError = new Error("AA_ERR_UNKNOWN:unexpected");
    const mod = await loadNativeClientWithBinding(() => ({
      connect: vi.fn(async () => {
        throw unknownError;
      }),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    }));

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.queryPolicy({ action: "check" })).rejects.toBe(unknownError);
  });

  it("surfaces deferred sendEvent failure on next queryPolicy call", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "handle-2" })),
      sendEvent: vi.fn(() => {
        throw new Error("AA_ERR_SEND_EVENT:queue closed");
      }),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    const mod = await loadNativeClientWithBinding(() => binding);

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await client.queryPolicy({ action: "warmup" });
    client.sendEvent({ action: "tool_call" });

    await expect(client.queryPolicy({ action: "check" })).rejects.toBeInstanceOf(
      mod.NativeSendEventError
    );
  });

  it("surfaces deferred sendEvent failure when sendEvent is called before first connect finishes", async () => {
    let resolveConnect: ((handle: { id: string }) => void) | undefined;
    const connectPromise = new Promise<{ id: string }>((resolve) => {
      resolveConnect = resolve;
    });

    const binding = {
      connect: vi.fn(() => connectPromise),
      sendEvent: vi.fn(() => {
        throw new Error("AA_ERR_SEND_EVENT:queue closed");
      }),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    const mod = await loadNativeClientWithBinding(() => binding);
    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    client.sendEvent({ action: "tool_call" });
    resolveConnect?.({ id: "handle-3" });
    await vi.waitFor(() => {
      expect(binding.sendEvent).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();

    await expect(client.queryPolicy({ action: "check" })).rejects.toBeInstanceOf(
      mod.NativeSendEventError
    );
  });

  it("maps disconnect failures to a typed native error", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "handle-4" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => {
        throw new Error("AA_ERR_DISCONNECT:disconnect failed");
      })
    } satisfies MockBinding;

    const mod = await loadNativeClientWithBinding(() => binding);
    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    // queryPolicy ensures the session is connected; a failing disconnect then
    // surfaces as a typed NativeDisconnectError on close.
    await client.queryPolicy({ action: "check" });
    await expect(client.close()).rejects.toBeInstanceOf(mod.NativeDisconnectError);
  });

  it("returns immediately on close when native client was never connected", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "unused" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    const mod = await loadNativeClientWithBinding(() => binding);
    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.close()).resolves.toBeUndefined();
    expect(binding.connect).not.toHaveBeenCalled();
    expect(binding.disconnect).not.toHaveBeenCalled();
  });

  it("surfaces deferred send error on close", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "handle-6" })),
      sendEvent: vi.fn(() => {
        throw new Error("AA_ERR_SEND_EVENT:queue closed");
      }),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    const mod = await loadNativeClientWithBinding(() => binding);
    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await client.queryPolicy({ action: "warmup" });
    client.sendEvent({ action: "tool_call" });

    await expect(client.close()).rejects.toBeInstanceOf(mod.NativeSendEventError);
  });

  it("tries known native binding paths and succeeds on fallback path", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "handle-5" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    const mod = await loadNativeClientWithRequire(() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("not found");
        }
        return binding;
      };
    });

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });

    await expect(client.queryPolicy({ action: "check" })).resolves.toEqual({
      denied: false,
      pending: false
    });
  });

  it("throws NativeConnectError when native binding cannot be loaded from known paths", async () => {
    const mod = await loadNativeClientWithRequire(() => {
      return () => {
        throw new Error("module not found");
      };
    });

    expect(() =>
      mod.createNativeClient({
        gateway: "/tmp/aa.sock",
        apiKey: "test-key",
        mode: "napi-inprocess"
      })
    ).toThrow(mod.NativeConnectError);
  });

  // AAASM-3683: the npm package version is read and forwarded into connect so it
  // — not the aa-sdk-client crate version — is what gets signed into the
  // handshake for accurate downgrade detection.
  it("forwards the resolved sdk_version into the native connect", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "handle-vers" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;

    // A require that yields the package version for the package.json lookup and
    // the binding for the native module path.
    const mod = await loadNativeClientWithRequire(() => (request: string) => {
      if (request === "@agent-assembly/sdk/package.json") {
        return { version: "9.8.7" };
      }
      return binding;
    });

    const client = mod.createNativeClient({
      gateway: "/tmp/aa.sock",
      apiKey: "test-key",
      mode: "napi-inprocess"
    });
    await client.queryPolicy({ action: "warmup" });

    expect(binding.connect).toHaveBeenCalledWith("/tmp/aa.sock", undefined, "9.8.7");
    await client.close();
  });

  it("resolveSdkVersion returns the package version when present", async () => {
    const mod = await loadNativeClientWithRequire(() => (request: string) => {
      if (request === "@agent-assembly/sdk/package.json") {
        return { version: "1.2.3" };
      }
      throw new Error("unexpected require");
    });

    expect(mod.resolveSdkVersion()).toBe("1.2.3");
  });

  it("resolveSdkVersion returns undefined when the version cannot be resolved", async () => {
    const mod = await loadNativeClientWithRequire(() => () => {
      throw new Error("package.json not found");
    });

    expect(mod.resolveSdkVersion()).toBeUndefined();
  });
});

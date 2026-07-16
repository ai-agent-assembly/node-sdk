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

  // AAASM-4468: the default (`grpc-sidecar`) mode now loads the native binding
  // and builds the same connect+register path as napi-inprocess, so it is
  // registration-capable — not a hardcoded no-op stub.
  it("default (grpc-sidecar) mode loads the binding and is registration-capable", async () => {
    const binding = {
      connect: vi.fn(async () => ({ id: "sidecar-handle" })),
      sendEvent: vi.fn(() => undefined),
      queryPolicy: vi.fn(() => ({ decision: "allow", reason: "" })),
      disconnect: vi.fn(async () => undefined)
    } satisfies MockBinding;
    const mod = await loadNativeClientWithBinding(() => binding);

    const client = mod.createNativeClient({
      gateway: "https://gateway.example.com",
      apiKey: "test-key"
    });

    expect(client.mode).toBe("grpc-sidecar");
    expect(client.canRegister).toBe(true);
    await expect(client.queryPolicy({ action: "check" })).resolves.toEqual({
      denied: false,
      pending: false
    });
    // The verdict came from the native binding, not a hardcoded stub.
    expect(binding.connect).toHaveBeenCalled();
    expect(binding.queryPolicy).toHaveBeenCalled();
    await expect(client.close()).resolves.toBeUndefined();
  });

  // AAASM-4468: when the binding cannot be loaded (unsupported platform / missing
  // native binary) the default mode falls back to the no-op stub whose
  // canRegister:false lets initAssembly fail loud, rather than throwing like
  // napi-inprocess does.
  it("default (grpc-sidecar) mode falls back to a non-registering stub when the binding cannot load", async () => {
    const mod = await loadNativeClientWithRequire(() => () => {
      throw new Error("module not found");
    });

    const client = mod.createNativeClient({
      gateway: "https://gateway.example.com",
      apiKey: "test-key"
    });

    expect(client.mode).toBe("grpc-sidecar");
    expect(client.canRegister).toBe(false);
    await expect(client.register({ agentId: "a", name: "a", framework: "none" })).resolves.toBe(
      ""
    );
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

  // AAASM-4013: the native shim folds an unreachable/slow/closed runtime onto a
  // NON-throwing `allow` + FAIL_OPEN_REASON, and an unspecified runtime verdict
  // onto the empty decision "". Under `failClosed` (enforce) neither is an
  // authoritative allow, so both must deny rather than silently proceed.
  describe("fail-closed on non-authoritative verdicts (AAASM-4013)", () => {
    it("napi-inprocess + failClosed: the fail-open allow sentinel denies", async () => {
      const mod = await loadNativeClientWithBinding(() => ({
        connect: vi.fn(async () => ({ id: "handle-sentinel" })),
        sendEvent: vi.fn(() => undefined),
        // The REAL runtime-down verdict: a non-throwing allow tagged with the
        // shim's fail-open reason (not a synthetic throw).
        queryPolicy: vi.fn(() => ({ decision: "allow", reason: mod.FAIL_OPEN_REASON })),
        disconnect: vi.fn(async () => undefined)
      }));

      const client = mod.createNativeClient({
        gateway: "/tmp/aa.sock",
        apiKey: "test-key",
        mode: "napi-inprocess",
        failClosed: true
      });

      await expect(client.queryPolicy({ action_type: "tool_call" })).resolves.toEqual({
        denied: true,
        pending: false,
        reason: mod.FAIL_OPEN_REASON
      });
      await client.close();
    });

    it("napi-inprocess + failClosed: an unknown/empty decision denies", async () => {
      const mod = await loadNativeClientWithBinding(() => ({
        connect: vi.fn(async () => ({ id: "handle-unknown" })),
        sendEvent: vi.fn(() => undefined),
        // Unspecified/garbled runtime verdict maps to "" via decision_to_str.
        queryPolicy: vi.fn(() => ({ decision: "", reason: "" })),
        disconnect: vi.fn(async () => undefined)
      }));

      const client = mod.createNativeClient({
        gateway: "/tmp/aa.sock",
        apiKey: "test-key",
        mode: "napi-inprocess",
        failClosed: true
      });

      await expect(client.queryPolicy({ action_type: "tool_call" })).resolves.toEqual({
        denied: true,
        pending: false,
        reason: "runtime returned no authoritative decision"
      });
      await client.close();
    });

    it("napi-inprocess without failClosed: the sentinel still fails open (observe/disabled)", async () => {
      const mod = await loadNativeClientWithBinding(() => ({
        connect: vi.fn(async () => ({ id: "handle-open" })),
        sendEvent: vi.fn(() => undefined),
        queryPolicy: vi.fn(() => ({ decision: "allow", reason: mod.FAIL_OPEN_REASON })),
        disconnect: vi.fn(async () => undefined)
      }));

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

    it("napi-inprocess + failClosed: a genuine authoritative allow still proceeds", async () => {
      const mod = await loadNativeClientWithBinding(() => ({
        connect: vi.fn(async () => ({ id: "handle-genuine" })),
        sendEvent: vi.fn(() => undefined),
        // A real policy allow (not the fail-open sentinel) must not be denied,
        // even under enforce.
        queryPolicy: vi.fn(() => ({ decision: "allow", reason: "policy: permitted" })),
        disconnect: vi.fn(async () => undefined)
      }));

      const client = mod.createNativeClient({
        gateway: "/tmp/aa.sock",
        apiKey: "test-key",
        mode: "napi-inprocess",
        failClosed: true
      });

      await expect(client.queryPolicy({ action_type: "tool_call" })).resolves.toEqual({
        denied: false,
        pending: false
      });
      await client.close();
    });

    it("napi-inprocess + failClosed: a REDACT verdict is authoritative and proceeds", async () => {
      // `redact` is a real runtime verdict (the tool runs, with output
      // redaction applied downstream), NOT a "no verdict" sentinel — so it must
      // proceed even under enforce. Only the fail-open sentinel / unknown
      // decision deny under failClosed.
      const mod = await loadNativeClientWithBinding(() => ({
        connect: vi.fn(async () => ({ id: "handle-redact" })),
        sendEvent: vi.fn(() => undefined),
        queryPolicy: vi.fn(() => ({ decision: "redact", reason: "secrets stripped" })),
        disconnect: vi.fn(async () => undefined)
      }));

      const client = mod.createNativeClient({
        gateway: "/tmp/aa.sock",
        apiKey: "test-key",
        mode: "napi-inprocess",
        failClosed: true
      });

      await expect(client.queryPolicy({ action_type: "tool_call" })).resolves.toEqual({
        denied: false,
        pending: false
      });
      await client.close();
    });

    it("napi-inprocess without failClosed: an unknown/empty decision still fails open (observe/disabled)", async () => {
      // The observe/disabled counterpart of the failClosed unknown-decision
      // test above: with no enforce posture, an unspecified runtime verdict must
      // NOT start blocking — the proxy / eBPF layers stay authoritative.
      const mod = await loadNativeClientWithBinding(() => ({
        connect: vi.fn(async () => ({ id: "handle-unknown-open" })),
        sendEvent: vi.fn(() => undefined),
        queryPolicy: vi.fn(() => ({ decision: "", reason: "" })),
        disconnect: vi.fn(async () => undefined)
      }));

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
    // AAASM-4699: a pending send error must not skip teardown — the native
    // session is still disconnected before that advisory error is re-thrown.
    expect(binding.disconnect).toHaveBeenCalledTimes(1);
  });

  it("tries known native binding paths and succeeds on fallback path", async () => {
    // AAASM-4302: the CWD candidate is now gated behind AA_ALLOW_CWD_NATIVE_FALLBACK=1
    // to prevent hijack by an attacker-writable CWD. This test preserves the original
    // three-candidate fallback-chain intent by opting in via the env var; without it,
    // the loader only probes the two relative-path candidates.
    const previousFallbackFlag = process.env.AA_ALLOW_CWD_NATIVE_FALLBACK;
    process.env.AA_ALLOW_CWD_NATIVE_FALLBACK = "1";
    try {
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
    } finally {
      if (previousFallbackFlag === undefined) {
        delete process.env.AA_ALLOW_CWD_NATIVE_FALLBACK;
      } else {
        process.env.AA_ALLOW_CWD_NATIVE_FALLBACK = previousFallbackFlag;
      }
    }
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

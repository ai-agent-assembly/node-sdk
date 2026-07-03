export type RuntimeMode = "grpc-sidecar" | "napi-inprocess";

export interface InitAssemblyOptions {
  gateway: string;
  apiKey: string;
  mode?: RuntimeMode;
  /**
   * Fail-closed posture for the native policy check (AAASM-4013). When `true`
   * (set only under `enforcementMode: "enforce"`), a runtime that returns no
   * authoritative verdict — the fail-open sentinel or an unknown decision — is
   * treated as a denial rather than an allow. Defaults to `false` (fail open),
   * preserving the advisory behavior for `observe` / `disabled` / unset modes.
   */
  failClosed?: boolean;
}

export interface AssemblyRuntimeHandle {
  close: () => Promise<void>;
}

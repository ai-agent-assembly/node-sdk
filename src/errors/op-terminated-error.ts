/**
 * Raised when the gateway terminates an in-flight op (AAASM-1422 PR-F).
 *
 * Carries the originating `opId` so callers can correlate the failure
 * against the operation they were awaiting. Surfaced by
 * `OpControlSubscriber.waitForOp` when an `OP_CONTROL_SIGNAL_TERMINATE`
 * arrives for the awaited op.
 */
export class OpTerminatedError extends Error {
  public readonly opId: string;

  constructor(message: string, opId: string) {
    super(message);
    this.name = "OpTerminatedError";
    this.opId = opId;
  }
}

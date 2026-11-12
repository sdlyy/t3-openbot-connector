export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof BridgeError
    ? { code: error.code, message: error.message }
    : { code: "internal_error", message: "The connector could not complete this operation." };
}

import type { HolderErrorWire } from "../holder-types.js";

/** A refusal with an HTTP status and a message written for the holder. */
export class HolderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Omit<HolderErrorWire, "error"> = {},
  ) {
    super(message);
    this.name = "HolderError";
  }
}

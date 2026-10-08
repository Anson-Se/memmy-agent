/** Thrown when a model answered but its output failed the rule checks. */
export class ModelOutputInvalidError extends Error {
  override readonly name = "ModelOutputInvalidError";
  readonly code = "model_output_invalid";
}

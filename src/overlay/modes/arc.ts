import { createDrift } from "./drift";
import type { ModeRenderer } from "./types";

/** Placeholder until the Arc port lands: renders as Stack. */
export function createArc(): ModeRenderer {
  return createDrift(0);
}

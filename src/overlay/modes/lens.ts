import { createDrift } from "./drift";
import type { ModeRenderer } from "./types";

/** Placeholder until the Lens port lands: renders as Stack. */
export function createLens(): ModeRenderer {
  return createDrift(0);
}

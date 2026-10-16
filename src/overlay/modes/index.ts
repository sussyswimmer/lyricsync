import type { Mode } from "../../../contract/contract";
import { createArc } from "./arc";
import { createDrift } from "./drift";
import { createLens } from "./lens";
import type { ModeRenderer } from "./types";

export function createMode(mode: Mode): ModeRenderer {
  switch (mode) {
    case "arc":
      return createArc();
    case "lens":
      return createLens();
    case "drift":
      return createDrift(1);
    case "stack":
      return createDrift(0);
  }
}

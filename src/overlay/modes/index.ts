import type { Style } from "../../core/songlook";
import { createArc } from "./arc";
import { createDrift } from "./drift";
import { createLens, createPoster, createSpotlight } from "./lens";
import type { ModeRenderer } from "./types";

export function createMode(mode: Style): ModeRenderer {
  switch (mode) {
    case "arc":
      return createArc();
    case "lens":
      return createLens();
    case "drift":
      return createDrift(1);
    case "stack":
      return createDrift(0);
    case "poster":
      return createPoster();
    case "spotlight":
      return createSpotlight();
  }
}

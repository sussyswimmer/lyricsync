import type { Style } from "../../core/songlook";
import { createArc } from "./arc";
import { createDrift } from "./drift";
import { createCascade, createCollage, createLens, createPop, createPoster, createReel, createReveal, createSlant, createSpotlight, createTape, createWave } from "./lens";
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
    case "wave":
      return createWave();
    case "reveal":
      return createReveal();
    case "collage":
      return createCollage();
    case "reel":
      return createReel();
    case "slant":
      return createSlant();
    case "pop":
      return createPop();
    case "cascade":
      return createCascade();
    case "tape":
      return createTape();
  }
}

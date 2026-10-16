/** The prototype's procedural demo covers (original art), drawn on demand as PNG data URLs. */
type Draw = (x: CanvasRenderingContext2D) => void;

const DRAWINGS: readonly Draw[] = [
  // Neon Monsoon: teal night, orange sun, magenta stripes
  (x) => {
    const g = x.createLinearGradient(0, 0, 0, 240);
    g.addColorStop(0, "#0f3b46");
    g.addColorStop(1, "#08161c");
    x.fillStyle = g;
    x.fillRect(0, 0, 240, 240);
    x.fillStyle = "#f7a93b";
    x.beginPath();
    x.arc(150, 96, 52, 0, 7);
    x.fill();
    x.fillStyle = "#d4377a";
    for (let i = 0; i < 6; i++) x.fillRect(0, 150 + i * 13, 240, 6);
    x.fillStyle = "#0b2229";
    x.fillRect(0, 206, 240, 34);
  },
  // Jade Hour: cream paper, green hill, dark sun, gold frame
  (x) => {
    x.fillStyle = "#e9e4d2";
    x.fillRect(0, 0, 240, 240);
    x.fillStyle = "#1f7a5c";
    x.beginPath();
    x.moveTo(0, 240);
    x.quadraticCurveTo(80, 60, 240, 120);
    x.lineTo(240, 240);
    x.fill();
    x.fillStyle = "#0f3d2f";
    x.beginPath();
    x.arc(70, 70, 30, 0, 7);
    x.fill();
    x.strokeStyle = "#c9b46b";
    x.lineWidth = 5;
    x.strokeRect(18, 18, 204, 204);
  },
  // Ultraviolet: pink-to-violet radial glow with cyan rings
  (x) => {
    const g = x.createRadialGradient(120, 120, 10, 120, 120, 170);
    g.addColorStop(0, "#ff4fa3");
    g.addColorStop(0.45, "#6a2bd1");
    g.addColorStop(1, "#130b2b");
    x.fillStyle = g;
    x.fillRect(0, 0, 240, 240);
    x.globalAlpha = 0.55;
    x.strokeStyle = "#7fe7ff";
    x.lineWidth = 2;
    for (let r = 30; r < 200; r += 22) {
      x.beginPath();
      x.arc(120, 120, r, 0, 7);
      x.stroke();
    }
    x.globalAlpha = 1;
  },
];

export const COVER_COUNT = DRAWINGS.length;
const urls = new Map<number, string>();

/** Cover `index` as a data URL, or null outside a browser. */
export function demoCover(index: number): string | null {
  const cached = urls.get(index);
  if (cached !== undefined) return cached;
  const draw = DRAWINGS[index];
  if (!draw || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  draw(ctx);
  const url = canvas.toDataURL("image/png");
  urls.set(index, url);
  return url;
}

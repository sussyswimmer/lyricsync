/**
 * The demo covers (original procedural art), drawn on demand as PNG data URLs: the prototype's three,
 * then one each for the look demos (tracks 7–9).
 */
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
  // Ledger Lines: a ruled page in black and white, a dark band with an ink stamp
  (x) => {
    x.fillStyle = "#e9e9e7";
    x.fillRect(0, 0, 240, 240);
    x.fillStyle = "#161616";
    x.fillRect(0, 0, 240, 92);
    x.strokeStyle = "#f2f2f2";
    x.lineWidth = 5;
    x.beginPath();
    x.arc(184, 46, 24, 0, 7);
    x.stroke();
    x.fillStyle = "#a8a8a8";
    for (let y = 112; y < 232; y += 15) x.fillRect(16, y, 208, 2);
    x.fillStyle = "#262626";
    [150, 188, 120, 172, 96, 160, 136, 182].forEach((w, i) => x.fillRect(16, 104 + i * 15, w, 6));
    x.fillStyle = "#6e6e6e";
    x.fillRect(36, 92, 3, 148);
  },
  // Strobe Hearts: neon on black, a magenta ring over a lime one, cyan strobe bars
  (x) => {
    x.fillStyle = "#07060a";
    x.fillRect(0, 0, 240, 240);
    x.lineWidth = 14;
    x.strokeStyle = "#a8ff3e";
    x.beginPath();
    x.arc(148, 128, 56, 0, 7);
    x.stroke();
    x.strokeStyle = "#ff2fd0";
    x.beginPath();
    x.arc(94, 104, 56, 0, 7);
    x.stroke();
    x.fillStyle = "#3df2ff";
    for (let i = 0; i < 5; i++) x.fillRect(0, 202 + i * 8, 240, 3);
  },
  // Glacier Nocturne: a cold night, a pale moon over two ridges of ice
  (x) => {
    const g = x.createLinearGradient(0, 0, 0, 240);
    g.addColorStop(0, "#040b16");
    g.addColorStop(1, "#0e2236");
    x.fillStyle = g;
    x.fillRect(0, 0, 240, 240);
    x.fillStyle = "#c9dcea";
    x.beginPath();
    x.arc(170, 62, 20, 0, 7);
    x.fill();
    const ridge = (color: string, points: readonly [number, number][]): void => {
      x.fillStyle = color;
      x.beginPath();
      x.moveTo(0, 240);
      for (const [px, py] of points) x.lineTo(px, py);
      x.lineTo(240, 240);
      x.fill();
    };
    ridge("#3f6684", [[0, 170], [58, 118], [104, 160], [150, 112], [240, 180]]);
    ridge("#16324a", [[0, 204], [80, 168], [140, 196], [200, 160], [240, 186]]);
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

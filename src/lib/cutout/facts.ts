export type MotifId = "uni" | "rayures" | "carreaux" | "imprime";

export type Swatch = { id: string; name: string; hex: string };

export const SWATCHES: readonly Swatch[] = [
  { id: "blanc", name: "Blanc", hex: "#f4f4f2" },
  { id: "noir", name: "Noir", hex: "#171717" },
  { id: "gris", name: "Gris", hex: "#8d939c" },
  { id: "beige", name: "Beige", hex: "#e3d5c0" },
  { id: "creme", name: "Crème", hex: "#f3ead2" },
  { id: "marine", name: "Marine", hex: "#1c2c4c" },
  { id: "bleu", name: "Bleu", hex: "#1e4f9e" },
  { id: "ciel", name: "Bleu clair", hex: "#b9d6ec" },
  { id: "vert", name: "Vert", hex: "#2f6b46" },
  { id: "kaki", name: "Kaki", hex: "#6c7344" },
  { id: "rouge", name: "Rouge", hex: "#b4232c" },
  { id: "rose", name: "Rose", hex: "#e4a8b6" },
  { id: "jaune", name: "Jaune", hex: "#e4ce63" },
  { id: "orange", name: "Orange", hex: "#e07a32" },
  { id: "marron", name: "Marron", hex: "#6b4430" },
  { id: "violet", name: "Violet", hex: "#5c3d86" },
];

export const MOTIFS: readonly { id: MotifId; name: string }[] = [
  { id: "uni", name: "Uni" },
  { id: "rayures", name: "Rayures" },
  { id: "carreaux", name: "Carreaux" },
  { id: "imprime", name: "Imprimé" },
];

export function swatchById(id: string): Swatch {
  return SWATCHES.find((swatch) => swatch.id === id) ?? SWATCHES[1]!;
}

export function motifName(id: MotifId): string {
  return MOTIFS.find((motif) => motif.id === id)?.name ?? "Uni";
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const SWATCH_LAB = SWATCHES.map((swatch) => ({ ...swatch, lab: rgbToLab(...hexToRgb(swatch.hex)) }));

export function nearestSwatch(r: number, g: number, b: number): Swatch {
  const lab = rgbToLab(r, g, b);
  let best: Swatch = SWATCHES[1]!;
  let bestD = Infinity;
  for (const swatch of SWATCH_LAB) {
    const d =
      (lab[0] - swatch.lab[0]) ** 2 + (lab[1] - swatch.lab[1]) ** 2 + (lab[2] - swatch.lab[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = swatch;
    }
  }
  return best;
}

export function dominantSwatch(rgba: Uint8ClampedArray): Swatch {
  const bins = new Uint32Array(4096);
  const sumR = new Float64Array(4096);
  const sumG = new Float64Array(4096);
  const sumB = new Float64Array(4096);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]! < 220) continue;
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    bins[key]!++;
    sumR[key] += r;
    sumG[key] += g;
    sumB[key] += b;
  }
  let best = 0;
  let bestN = 0;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i]! > bestN) {
      best = i;
      bestN = bins[i]!;
    }
  }
  if (!bestN) return SWATCHES[1]!;
  return nearestSwatch(sumR[best]! / bestN, sumG[best]! / bestN, sumB[best]! / bestN);
}

function deviation(signal: Float32Array): number {
  let mean = 0;
  for (let i = 0; i < signal.length; i++) mean += signal[i]!;
  mean /= signal.length;
  let acc = 0;
  for (let i = 0; i < signal.length; i++) acc += (signal[i]! - mean) ** 2;
  return Math.sqrt(acc / signal.length);
}

function autocorrelationPeak(signal: Float32Array): number {
  const n = signal.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i]!;
  mean /= n;
  let energy = 0;
  const centered = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = signal[i]! - mean;
    centered[i] = v;
    energy += v * v;
  }
  if (energy < 1e-3) return 0;
  let best = 0;
  const maxLag = Math.min(18, Math.floor(n / 3));
  for (let lag = 2; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < n - lag; i++) corr += centered[i]! * centered[i + lag]!;
    corr /= energy;
    if (corr > best) best = corr;
  }
  return best;
}

export function detectMotif(rgba: Uint8ClampedArray, w: number, h: number): MotifId {
  const size = 72;
  const lum = new Float32Array(size * size);
  const used = new Uint8Array(size * size);
  let count = 0;
  let mean = 0;
  for (let y = 0; y < size; y++) {
    const iy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / size));
    for (let x = 0; x < size; x++) {
      const ix = Math.min(w - 1, Math.floor(((x + 0.5) * w) / size));
      const o = (iy * w + ix) * 4;
      if (rgba[o + 3]! < 210) continue;
      const yv = rgba[o]! * 0.2126 + rgba[o + 1]! * 0.7152 + rgba[o + 2]! * 0.0722;
      const i = y * size + x;
      lum[i] = yv;
      used[i] = 1;
      mean += yv;
      count++;
    }
  }
  if (count < 30) return "uni";
  mean /= count;
  let variance = 0;
  for (let i = 0; i < used.length; i++) {
    if (!used[i]) continue;
    variance += (lum[i]! - mean) ** 2;
  }
  const std = Math.sqrt(variance / count);
  if (std < 12) return "uni";

  const rows = new Float32Array(size);
  const cols = new Float32Array(size);
  for (let y = 0; y < size; y++) {
    let sum = 0;
    let n = 0;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!used[i]) continue;
      sum += lum[i]!;
      n++;
    }
    rows[y] = n ? sum / n : mean;
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < size; y++) {
      const i = y * size + x;
      if (!used[i]) continue;
      sum += lum[i]!;
      n++;
    }
    cols[x] = n ? sum / n : mean;
  }
  const horizontal = autocorrelationPeak(rows);
  const vertical = autocorrelationPeak(cols);
  const rowAmp = deviation(rows);
  const colAmp = deviation(cols);
  const rowStripes = horizontal > 0.55 && rowAmp > 18;
  const colStripes = vertical > 0.55 && colAmp > 18;
  if (rowStripes && colStripes && std > 22) return "carreaux";
  if ((rowStripes || colStripes) && std > 16) return "rayures";
  if (std > 32) return "imprime";
  return "uni";
}

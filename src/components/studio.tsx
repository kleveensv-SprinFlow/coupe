import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlignJustify, Circle, Download, Eraser, Flower2, Grid2x2, Paintbrush, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  MOTIFS,
  SWATCHES,
  detectMotif,
  dominantSwatch,
  motifName,
  swatchById,
  type MotifId,
} from "@/lib/cutout/facts";
import {
  buildCutout,
  dominantGroup,
  paintAlpha,
  resizeIds,
  rgbaFromAlpha,
  type GarmentGroup,
} from "@/lib/cutout/refine";
import { drawModelInput, segmentSquare } from "@/lib/cutout/segment-client";

type Phase = "idle" | "working" | "ready" | "error";
type View = "cut" | "original";
type Backdrop = "clear" | "white" | "slate";
type Brush = "add" | "erase";

type Pixels = {
  source: HTMLImageElement;
  photo: Uint8ClampedArray;
  alpha: Uint8Array;
  rgba: Uint8ClampedArray;
  workW: number;
  workH: number;
  labels: string[];
  classIds: Uint8Array;
  maskW: number;
  maskH: number;
  zones: { label: string; name: string; ratio: number }[];
  coverage: number;
};

type Settings = {
  group: GarmentGroup;
  contract: number;
  softness: number;
};

const GROUPS: { id: GarmentGroup; label: string }[] = [
  { id: "haut", label: "Haut" },
  { id: "bas", label: "Bas" },
  { id: "chaussures", label: "Chaussures" },
  { id: "tout", label: "Tout" },
];

const MAX_WORK = 1400;

function humanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/fetch|network|Failed to|huggingface|HTTP|load/i.test(message)) {
    return "Le modèle de découpe n’a pas pu être téléchargé. Réessayez dans un instant.";
  }
  if (message && message.length < 180) return message;
  return "La découpe a échoué. Réessayez avec une autre photo.";
}

function percent(progress?: number): number | null {
  if (progress === undefined || Number.isNaN(progress)) return null;
  const value = progress <= 1 ? progress * 100 : progress;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function drawWork(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, MAX_WORK / Math.max(width, height));
  const workW = Math.max(1, Math.round(width * scale));
  const workH = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = workW;
  canvas.height = workH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas indisponible");
  ctx.drawImage(source, 0, 0, workW, workH);
  return { photo: ctx.getImageData(0, 0, workW, workH).data, workW, workH };
}

function stamp(
  alpha: Uint8Array,
  rgba: Uint8ClampedArray,
  photo: Uint8ClampedArray,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  mode: Brush,
) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.35)));
  const r = radius;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    const left = Math.max(0, Math.floor(cx - r));
    const right = Math.min(w - 1, Math.ceil(cx + r));
    const top = Math.max(0, Math.floor(cy - r));
    const bottom = Math.min(h - 1, Math.ceil(cy + r));
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, bottom);
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) continue;
        const fall = 1 - d / r;
        const weight = fall * fall;
        const i = y * w + x;
        const target = Math.round(weight * 255);
        if (mode === "add") alpha[i] = Math.max(alpha[i]!, target);
        else alpha[i] = Math.min(alpha[i]!, 255 - target);
        const o = i * 4;
        rgba[o] = photo[o]!;
        rgba[o + 1] = photo[o + 1]!;
        rgba[o + 2] = photo[o + 2]!;
        rgba[o + 3] = alpha[i]!;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Cette photo n’a pas pu être lue. Utilisez un JPG ou un PNG.");
  }
}

export function Studio() {
  const viewRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pixelsRef = useRef<Pixels | null>(null);
  const settingsRef = useRef<Settings>({ group: "haut", contract: 2, softness: 1 });
  const historyRef = useRef<Uint8Array[]>([]);
  const objectUrl = useRef<string | null>(null);
  const painting = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const colorLockRef = useRef(false);
  const motifLockRef = useRef(false);
  const rebuildTimer = useRef<number | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Préparation du modèle…");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("cut");
  const [backdrop, setBackdrop] = useState<Backdrop>("clear");
  const [dragOver, setDragOver] = useState(false);
  const [settings, setSettings] = useState<Settings>(settingsRef.current);
  const [brush, setBrush] = useState<Brush>("erase");
  const [brushSize, setBrushSize] = useState(28);
  const [colorId, setColorId] = useState("noir");
  const [motifId, setMotifId] = useState<MotifId>("uni");
  const [colorLock, setColorLock] = useState(false);
  const [motifLock, setMotifLock] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [tick, setTick] = useState(0);

  const pixels = pixelsRef.current;
  const color = swatchById(colorId);

  useEffect(() => {
    paint();
  }, [tick, view, backdrop, phase]);

  useEffect(() => {
    return () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      if (rebuildTimer.current) window.clearTimeout(rebuildTimer.current);
    };
  }, []);

  function paint() {
    const canvas = viewRef.current;
    const current = pixelsRef.current;
    if (!canvas || !current) return;
    canvas.width = current.workW;
    canvas.height = current.workH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, current.workW, current.workH);
    if (view === "cut" && backdrop === "white") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, current.workW, current.workH);
    } else if (view === "cut" && backdrop === "slate") {
      ctx.fillStyle = "#2a3038";
      ctx.fillRect(0, 0, current.workW, current.workH);
    }
    const sheet = document.createElement("canvas");
    sheet.width = current.workW;
    sheet.height = current.workH;
    const sheetCtx = sheet.getContext("2d");
    if (!sheetCtx) return;
    const data =
      view === "original"
        ? (() => {
            const image = sheetCtx.createImageData(current.workW, current.workH);
            image.data.set(current.photo);
            for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
            return image;
          })()
        : (() => {
            const image = sheetCtx.createImageData(current.workW, current.workH);
            image.data.set(current.rgba);
            return image;
          })();
    sheetCtx.putImageData(data, 0, 0);
    ctx.drawImage(sheet, 0, 0);
  }

  function remember(current: Pixels) {
    historyRef.current.push(current.alpha.slice());
    if (historyRef.current.length > 12) historyRef.current.shift();
    setCanUndo(true);
  }

  function applyCut(current: Omit<Pixels, "rgba" | "alpha" | "zones" | "coverage">, next: Settings) {
    const cut = buildCutout({
      labels: current.labels,
      classIds: current.classIds,
      maskW: current.maskW,
      maskH: current.maskH,
      photo: current.photo,
      workW: current.workW,
      workH: current.workH,
      group: next.group,
      contract: next.contract,
      softness: next.softness,
    });
    const stored: Pixels = { ...current, ...cut };
    pixelsRef.current = stored;
    historyRef.current = [];
    setCanUndo(false);
    if (!colorLockRef.current) setColorId(dominantSwatch(cut.rgba).id);
    if (!motifLockRef.current) setMotifId(detectMotif(cut.rgba, current.workW, current.workH));
    setTick((value) => value + 1);
    return stored;
  }

  function rebuild(next: Settings) {
    const current = pixelsRef.current;
    if (!current) return;
    applyCut(current, next);
  }

  function updateSettings(partial: Partial<Settings>, immediate: boolean) {
    const next = { ...settingsRef.current, ...partial };
    settingsRef.current = next;
    setSettings(next);
    if (rebuildTimer.current) window.clearTimeout(rebuildTimer.current);
    if (immediate) {
      rebuild(next);
      return;
    }
    rebuildTimer.current = window.setTimeout(() => rebuild(next), 80);
  }

  async function runFile(file: Blob) {
    setPhase("working");
    setError("");
    setView("cut");
    setProgress(null);
    setStatus("Lecture de la photo…");
    try {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      const image = await loadImage(file);
      objectUrl.current = image.src.startsWith("blob:") ? image.src : null;
      const work = drawWork(image, image.naturalWidth, image.naturalHeight);
      const prepared = drawModelInput(image, image.naturalWidth, image.naturalHeight);
      setStatus("Préparation du modèle de découpe…");
      const segmented = await segmentSquare(prepared.image, prepared.crop, (update) => {
        const value = percent(update.progress);
        if (update.status === "progress" || update.status === "download" || update.status === "initiate") {
          setStatus(value === null ? "Téléchargement du modèle" : `Téléchargement du modèle · ${value} %`);
          setProgress(value);
          return;
        }
        setProgress(null);
        setStatus("Isolation du vêtement…");
      });
      const group = dominantGroup(segmented.labels, segmented.classIds);
      const next = { ...settingsRef.current, group };
      settingsRef.current = next;
      setSettings(next);
      colorLockRef.current = false;
      motifLockRef.current = false;
      setColorLock(false);
      setMotifLock(false);
      applyCut(
        {
          source: image,
          photo: work.photo,
          workW: work.workW,
          workH: work.workH,
          labels: segmented.labels,
          classIds: segmented.classIds,
          maskW: segmented.width,
          maskH: segmented.height,
        },
        next,
      );
      setPhase("ready");
    } catch (caught) {
      setError(humanError(caught));
      setPhase(pixelsRef.current ? "ready" : "error");
    }
  }

  async function useSample() {
    const response = await fetch("/samples/jacket.jpg");
    if (!response.ok) {
      setError("L’exemple est indisponible.");
      setPhase("error");
      return;
    }
    const blob = await response.blob();
    await runFile(blob);
  }

  function undo() {
    const current = pixelsRef.current;
    const previous = historyRef.current.pop();
    if (!current || !previous) return;
    current.alpha = previous;
    const ids = resizeIds(current.classIds, current.maskW, current.maskH, current.workW, current.workH);
    current.rgba = paintAlpha(current.photo, current.alpha, ids, current.labels, current.workW, current.workH);
    setCanUndo(historyRef.current.length > 0);
    setTick((value) => value + 1);
  }

  function pointerPos(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (phase !== "ready" || view !== "cut" || !pixelsRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    painting.current = true;
    remember(pixelsRef.current);
    const point = pointerPos(event);
    lastPoint.current = point;
    const current = pixelsRef.current;
    stamp(
      current.alpha,
      current.rgba,
      current.photo,
      current.workW,
      current.workH,
      point.x,
      point.y,
      point.x,
      point.y,
      brushSize,
      brush,
    );
    setTick((value) => value + 1);
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!painting.current || !lastPoint.current || !pixelsRef.current) return;
    const point = pointerPos(event);
    const current = pixelsRef.current;
    stamp(
      current.alpha,
      current.rgba,
      current.photo,
      current.workW,
      current.workH,
      lastPoint.current.x,
      lastPoint.current.y,
      point.x,
      point.y,
      brushSize,
      brush,
    );
    lastPoint.current = point;
    setTick((value) => value + 1);
  }

  function finishStroke() {
    if (!painting.current) return;
    painting.current = false;
    lastPoint.current = null;
    const current = pixelsRef.current;
    if (!current) return;
    const ids = resizeIds(current.classIds, current.maskW, current.maskH, current.workW, current.workH);
    current.rgba = paintAlpha(current.photo, current.alpha, ids, current.labels, current.workW, current.workH);
    if (!colorLockRef.current) setColorId(dominantSwatch(current.rgba).id);
    if (!motifLockRef.current) setMotifId(detectMotif(current.rgba, current.workW, current.workH));
    setTick((value) => value + 1);
  }

  async function download(kind: "png" | "jpg") {
    const current = pixelsRef.current;
    if (!current) return;
    const image = current.source;
    const scale = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
    const w = Math.max(1, Math.round(image.naturalWidth * scale));
    const h = Math.max(1, Math.round(image.naturalHeight * scale));
    const mask = document.createElement("canvas");
    mask.width = current.workW;
    mask.height = current.workH;
    const maskCtx = mask.getContext("2d");
    if (!maskCtx) return;
    const maskImage = maskCtx.createImageData(current.workW, current.workH);
    for (let i = 0; i < current.alpha.length; i++) {
      const o = i * 4;
      maskImage.data[o] = 255;
      maskImage.data[o + 1] = 255;
      maskImage.data[o + 2] = 255;
      maskImage.data[o + 3] = current.alpha[i]!;
    }
    maskCtx.putImageData(maskImage, 0, 0);
    const sized = document.createElement("canvas");
    sized.width = w;
    sized.height = h;
    const sizedCtx = sized.getContext("2d");
    const photoCtxCanvas = document.createElement("canvas");
    photoCtxCanvas.width = w;
    photoCtxCanvas.height = h;
    const photoCtx = photoCtxCanvas.getContext("2d");
    if (!sizedCtx || !photoCtx) return;
    sizedCtx.imageSmoothingEnabled = true;
    sizedCtx.imageSmoothingQuality = "high";
    sizedCtx.drawImage(mask, 0, 0, w, h);
    photoCtx.drawImage(image, 0, 0, w, h);
    const photo = photoCtx.getImageData(0, 0, w, h);
    const alpha = sizedCtx.getImageData(0, 0, w, h);
    let br = 0;
    let bg = 0;
    let bb = 0;
    let bn = 0;
    for (let i = 0; i < alpha.data.length; i += 4) {
      if (alpha.data[i + 3]! > 12) continue;
      br += photo.data[i]!;
      bg += photo.data[i + 1]!;
      bb += photo.data[i + 2]!;
      bn++;
    }
    if (bn) {
      br /= bn;
      bg /= bn;
      bb /= bn;
    }
    for (let i = 0; i < photo.data.length; i += 4) {
      const a = alpha.data[i + 3]!;
      if (a > 0 && a < 248 && bn) {
        const r = photo.data[i]!;
        const g = photo.data[i + 1]!;
        const b = photo.data[i + 2]!;
        if (Math.hypot(r - br, g - bg, b - bb) < 78) {
          const a01 = Math.max(a / 255, 0.18);
          photo.data[i] = clamp((r - br * (1 - a / 255)) / a01);
          photo.data[i + 1] = clamp((g - bg * (1 - a / 255)) / a01);
          photo.data[i + 2] = clamp((b - bb * (1 - a / 255)) / a01);
        }
      }
      photo.data[i + 3] = a;
    }
    const cut = document.createElement("canvas");
    cut.width = w;
    cut.height = h;
    const cutCtx = cut.getContext("2d");
    if (!cutCtx) return;
    cutCtx.putImageData(photo, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      if (kind === "png") {
        cut.toBlob(resolve, "image/png");
        return;
      }
      const flat = document.createElement("canvas");
      flat.width = w;
      flat.height = h;
      const flatCtx = flat.getContext("2d");
      if (!flatCtx) {
        resolve(null);
        return;
      }
      flatCtx.fillStyle = "#ffffff";
      flatCtx.fillRect(0, 0, w, h);
      flatCtx.drawImage(cut, 0, 0);
      flat.toBlob(resolve, "image/jpeg", 0.92);
    });
    if (!blob) return;
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = kind === "png" ? "coupe-vetement.png" : "coupe-fond-blanc.jpg";
    link.click();
    URL.revokeObjectURL(href);
  }

  const ready = phase === "ready" && pixels;
  const showCanvas = ready || (phase === "working" && pixels);

  return (
    <main className="min-h-dvh">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-start lg:px-8 lg:py-10">
        <div className="lg:sticky lg:top-6">
          <header className="mb-5">
            <p className="text-xs font-semibold tracking-widest text-accent">COUPE</p>
            <h1 className="mt-2 font-display text-3xl font-extrabold leading-none text-ink lg:text-5xl">
              Détails du vêtement
            </h1>
            <p className="mt-3 max-w-md text-pretty text-base leading-relaxed text-muted">
              On garde le tissu, pixel pour pixel. Le fond, la peau et le décor passent en transparent.
            </p>
          </header>

          <div
            className={cn(
              "relative overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-line",
              dragOver && "ring-2 ring-accent",
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const file = event.dataTransfer.files[0];
              if (file) void runFile(file);
            }}
          >
            <div
              className={cn(
                "flex min-h-80 items-center justify-center",
                view === "cut" && backdrop === "clear" ? "checker" : "",
                view === "cut" && backdrop === "white" ? "bg-surface" : "",
                view === "cut" && backdrop === "slate" ? "bg-stage-dark" : "",
                view === "original" ? "bg-bg" : "",
              )}
            >
              {showCanvas ? (
                <canvas
                  ref={viewRef}
                  className={cn("max-h-[68dvh] w-full object-contain", view === "cut" && "touch-none")}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={finishStroke}
                  onPointerCancel={finishStroke}
                />
              ) : (
                <div className="checker flex min-h-80 w-full flex-col items-center justify-center px-6 py-16 text-center">
                  <p className="font-display text-2xl font-bold text-ink">Déposez une photo</p>
                  <p className="mt-2 max-w-xs text-pretty text-sm leading-relaxed text-muted">
                    Veste sur un mannequin, pantalon à plat, chaussures : seul le vêtement reste.
                  </p>
                </div>
              )}
              {phase === "working" ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-bg/80 px-8 text-center backdrop-blur-sm">
                  <p className="text-sm font-semibold text-ink">{status}</p>
                  <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-line">
                    {progress === null ? (
                      <div className="bar-indet h-full bg-accent" />
                    ) : (
                      <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
                    )}
                  </div>
                  <p className="max-w-xs text-xs leading-relaxed text-muted">
                    La première fois, le modèle de découpe se charge dans le navigateur. Ensuite c’est instantané.
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          {error ? (
            <p className="mt-3 text-sm font-medium text-ink" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-sm font-semibold text-surface"
              onClick={() => inputRef.current?.click()}
            >
              Importer une photo
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-surface px-5 text-sm font-semibold text-ink ring-1 ring-line"
              onClick={() => void useSample()}
              disabled={phase === "working"}
            >
              Essayer l’exemple
            </button>
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void runFile(file);
              }}
            />
          </div>
        </div>

        <div className={cn(!ready && "opacity-80")}>
          <div className="flex rounded-full bg-surface p-1 ring-1 ring-line">
            <Toggle
              pressed={view === "cut"}
              onClick={() => setView("cut")}
              disabled={!ready}
            >
              Fond retiré
            </Toggle>
            <Toggle
              pressed={view === "original"}
              onClick={() => setView("original")}
              disabled={!ready}
            >
              Photo d’origine
            </Toggle>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                ["clear", "Transparent"],
                ["white", "Blanc"],
                ["slate", "Ardoise"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                disabled={!ready || view !== "cut"}
                aria-pressed={backdrop === id}
                onClick={() => setBackdrop(id)}
                className={cn(
                  "min-h-11 rounded-full px-4 text-sm font-medium ring-1 ring-line disabled:opacity-40",
                  backdrop === id ? "bg-ink text-surface ring-ink" : "bg-surface text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void download("png")}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-surface disabled:opacity-40"
            >
              <Download className="size-4" aria-hidden="true" />
              PNG transparent
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => void download("jpg")}
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-surface px-4 text-sm font-semibold text-ink ring-1 ring-line disabled:opacity-40"
            >
              JPG fond blanc
            </button>
          </div>

          <Section
            index="1"
            title="Catégorie"
            hint={ready && pixels.coverage < 0.01 ? "Rien de détecté" : undefined}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {GROUPS.map((group) => {
                const active = settings.group === group.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    disabled={!ready}
                    aria-pressed={active}
                    onClick={() => updateSettings({ group: group.id }, true)}
                    className={cn(
                      "flex min-h-20 items-center justify-center rounded-3xl bg-surface px-2 font-display text-lg font-bold shadow-card ring-1 ring-line disabled:opacity-40",
                      active ? "text-accent ring-2 ring-accent" : "text-ink",
                    )}
                  >
                    {group.label}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section index="2" title={`Couleur · ${color.name}`} hint={colorLock ? "Choisie" : ready ? "Détectée" : undefined}>
            <div className="flex flex-wrap gap-2.5">
              {SWATCHES.map((swatch) => {
                const active = swatch.id === colorId;
                return (
                  <button
                    key={swatch.id}
                    type="button"
                    disabled={!ready}
                    aria-label={swatch.name}
                    aria-pressed={active}
                    onClick={() => {
                      colorLockRef.current = true;
                      setColorLock(true);
                      setColorId(swatch.id);
                    }}
                    className={cn(
                      "size-11 rounded-full ring-1 ring-line disabled:opacity-40",
                      active && "ring-2 ring-accent ring-offset-2 ring-offset-bg",
                    )}
                    style={{ backgroundColor: swatch.hex }}
                  />
                );
              })}
            </div>
          </Section>

          <Section index="3" title={`Motif · ${motifName(motifId)}`} hint={motifLock ? "Choisi" : ready ? "Suggéré" : undefined}>
            <div className="flex flex-wrap gap-2">
              {MOTIFS.map((motif) => {
                const active = motif.id === motifId;
                const Icon =
                  motif.id === "uni" ? Circle : motif.id === "rayures" ? AlignJustify : motif.id === "carreaux" ? Grid2x2 : Flower2;
                return (
                  <button
                    key={motif.id}
                    type="button"
                    disabled={!ready}
                    aria-pressed={active}
                    onClick={() => {
                      motifLockRef.current = true;
                      setMotifLock(true);
                      setMotifId(motif.id);
                    }}
                    className={cn(
                      "inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold ring-1 ring-line disabled:opacity-40",
                      active ? "bg-accent text-surface ring-accent" : "bg-surface text-ink",
                    )}
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {motif.name}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section index="4" title="Retouche du bord">
            <p className="mb-4 text-pretty text-sm leading-relaxed text-muted">
              Là où une main cache le tissu, le trou reste transparent : on ne redessine pas le vêtement. Le pinceau
              reprend les pixels d’origine, la gomme enlève ce qui dépasse.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!ready}
                aria-pressed={brush === "add"}
                onClick={() => {
                  setBrush("add");
                  setView("cut");
                }}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold ring-1 ring-line disabled:opacity-40",
                  brush === "add" ? "bg-ink text-surface ring-ink" : "bg-surface text-ink",
                )}
              >
                <Paintbrush className="size-4" aria-hidden="true" />
                Pinceau
              </button>
              <button
                type="button"
                disabled={!ready}
                aria-pressed={brush === "erase"}
                onClick={() => {
                  setBrush("erase");
                  setView("cut");
                }}
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold ring-1 ring-line disabled:opacity-40",
                  brush === "erase" ? "bg-ink text-surface ring-ink" : "bg-surface text-ink",
                )}
              >
                <Eraser className="size-4" aria-hidden="true" />
                Gomme
              </button>
              <button
                type="button"
                disabled={!canUndo}
                onClick={undo}
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-surface px-4 text-sm font-semibold text-ink ring-1 ring-line disabled:opacity-40"
              >
                <Undo2 className="size-4" aria-hidden="true" />
                Annuler
              </button>
            </div>
            <label className="mt-4 block text-sm font-medium text-ink">
              Taille de l’outil
              <input
                type="range"
                min={8}
                max={90}
                value={brushSize}
                disabled={!ready}
                onChange={(event) => setBrushSize(Number(event.target.value))}
              />
            </label>
            <label className="block text-sm font-medium text-ink">
              Resserrer le bord
              <input
                type="range"
                min={0}
                max={8}
                value={settings.contract}
                disabled={!ready}
                onChange={(event) => updateSettings({ contract: Number(event.target.value) }, false)}
              />
            </label>
            <label className="block text-sm font-medium text-ink">
              Douceur
              <input
                type="range"
                min={0}
                max={6}
                value={settings.softness}
                disabled={!ready}
                onChange={(event) => updateSettings({ softness: Number(event.target.value) }, false)}
              />
            </label>
          </Section>

          {ready && pixels.zones.length > 0 ? (
            <details className="mt-8 rounded-3xl bg-surface px-4 py-3 ring-1 ring-line">
              <summary className="cursor-pointer text-sm font-semibold text-ink">Zones repérées</summary>
              <ul className="mt-3 flex flex-wrap gap-2">
                {pixels.zones.map((zone) => (
                  <li key={zone.label} className="rounded-full bg-bg px-3 py-1 text-xs font-medium text-muted">
                    {zone.name}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
      <span className="sr-only">Mise à jour {tick}</span>
    </main>
  );
}

function Toggle({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "min-h-11 flex-1 rounded-full text-sm font-semibold disabled:opacity-40",
        pressed ? "bg-accent text-surface" : "text-muted",
      )}
    >
      {children}
    </button>
  );
}

function Section({
  index,
  title,
  hint,
  children,
}: {
  index: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink">
          <span className="mr-1 text-muted">{index}.</span>
          {title}
        </h2>
        {hint ? <p className="text-sm font-medium text-accent">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function clamp(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

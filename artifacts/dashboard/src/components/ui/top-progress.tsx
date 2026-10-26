import { useEffect, useState } from "react";

// ---- Global in-flight counter -------------------------------------------------
let activeCount = 0;
const listeners = new Set<(n: number) => void>();

function broadcast() {
  for (const l of listeners) l(activeCount);
}

export function startLoading(): () => void {
  activeCount += 1;
  broadcast();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    activeCount = Math.max(0, activeCount - 1);
    broadcast();
  };
}

// ---- Patch window.fetch ONCE so every API call drives the bar automatically --
// HMR-safe via a Symbol on globalThis so reloads don't double-wrap.
const PATCHED_KEY = Symbol.for("__mrrobot_top_progress_fetch_patched__");
type G = typeof globalThis & { [PATCHED_KEY]?: boolean };

function isSilent(input: RequestInfo | URL, init?: RequestInit): boolean {
  // Opt-out via header `x-silent: 1` or query string `__silent=1`.
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url && url.includes("__silent=1")) return true;
  } catch { /* ignore */ }
  const h = init?.headers;
  if (!h) return false;
  if (h instanceof Headers) return h.get("x-silent") === "1";
  if (Array.isArray(h)) return h.some(([k, v]) => k.toLowerCase() === "x-silent" && v === "1");
  if (typeof h === "object") {
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === "x-silent" && (h as Record<string, string>)[k] === "1") return true;
    }
  }
  return false;
}

function patchFetch() {
  if (typeof window === "undefined") return;
  const g = globalThis as G;
  if (g[PATCHED_KEY]) return;
  g[PATCHED_KEY] = true;

  const orig = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    if (isSilent(args[0], args[1])) {
      return orig(...args);
    }
    const stop = startLoading();
    try {
      return await orig(...args);
    } finally {
      // small linger so super-fast responses still register visually
      setTimeout(stop, 120);
    }
  };
}

// ---- Convenience helper for polling/background calls ------------------------
export function silentFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const h = new Headers(init?.headers);
  h.set("x-silent", "1");
  return fetch(input, { ...init, headers: h });
}

// ---- The visible bar ---------------------------------------------------------
export function TopProgressBar({
  color = "#6366f1",
  accent = "#a855f7",
  highlight = "#22d3ee",
  height = 3,
  showDelay = 220,
}: { color?: string; accent?: string; highlight?: string; height?: number; showDelay?: number } = {}) {
  // Debounced visibility — request must be in-flight > showDelay ms to show.
  // This prevents flicker from fast polling responses (<200ms).
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    patchFetch();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const l = (n: number) => {
      if (n > 0) {
        if (!timer && !visible) {
          timer = setTimeout(() => { setVisible(true); timer = null; }, showDelay);
        }
      } else {
        if (timer) { clearTimeout(timer); timer = null; }
        setVisible(false);
      }
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDelay]);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height,
        zIndex: 9999,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 220ms ease",
      }}
      aria-hidden={!visible}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(90deg, ${color} 0%, ${accent} 35%, ${highlight} 65%, ${color} 100%)`,
          backgroundSize: "200% 100%",
          animation: "topProgSlide 1.1s linear infinite",
          boxShadow: `0 0 10px ${color}99, 0 0 4px ${accent}cc`,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          width: "30%",
          background: `linear-gradient(90deg, transparent, #ffffff66, transparent)`,
          animation: "topProgGlow 1.1s linear infinite",
        }}
      />
    </div>
  );
}

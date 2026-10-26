import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";

type Props = {
  onConfirm: () => void | Promise<void>;
  confirmTitle?: string;
  confirmText?: string;
  size?: number;
  title?: string;
  hidden?: boolean;
};

export function DeleteIconButton({
  onConfirm,
  confirmTitle = "Delete Confirmation",
  confirmText = "Do you really want to delete this item? This action cannot be undone.",
  size = 32,
  title = "Delete",
  hidden = false,
}: Props) {
  if (hidden) return null;
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    setError(null);
    setOpen(true);
  }

  async function handleConfirm(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed. Please try again.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setError(null);
    setOpen(false);
  }

  const color = "#ef4444";
  const iconSize = Math.round(size * 0.55);

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        disabled={busy}
        title={title}
        aria-label={title}
        style={{
          width: size, height: size, minWidth: size,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          background: hover ? `${color}22` : `${color}11`,
          border: `1.5px solid ${hover ? color : `${color}55`}`,
          borderRadius: 8, padding: 0,
          color: hover ? color : `${color}dd`,
          cursor: busy ? "wait" : "pointer",
          transition: "background 160ms ease, border-color 160ms ease, color 160ms ease, transform 120ms ease",
          flexShrink: 0,
          opacity: busy ? 0.5 : 1,
          transform: hover ? "scale(1.05)" : "scale(1)",
          boxShadow: hover ? `0 2px 8px ${color}44` : "none",
        }}
      >
        <Trash2 size={iconSize} strokeWidth={2.2} />
      </button>

      {open && createPortal(
        <div
          onClick={handleCancel}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(15, 23, 42, 0.65)",
            backdropFilter: "blur(3px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 16,
            animation: "fadeIn 160ms ease",
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 360,
              background: "#fff",
              borderRadius: 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
              overflow: "hidden",
              animation: "popIn 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            {/* Icon header */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "22px 20px 10px",
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: "50%",
                background: "#fee2e2",
                display: "flex", alignItems: "center", justifyContent: "center",
                border: "2px solid #fecaca",
              }}>
                <Trash2 size={28} strokeWidth={2.2} color="#dc2626" />
              </div>
            </div>

            {/* Title + body */}
            <div style={{ padding: "4px 22px 18px", textAlign: "center" }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>
                {confirmTitle}
              </div>
              <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
                {confirmText}
              </div>
              {error && (
                <div style={{
                  marginTop: 12, padding: "8px 12px",
                  background: "#fef2f2", border: "1px solid #fecaca",
                  borderRadius: 8, fontSize: 12, color: "#b91c1c",
                  textAlign: "left", fontWeight: 600,
                }}>
                  ⚠ {error}
                </div>
              )}
            </div>

            {/* Buttons */}
            <div style={{
              display: "flex", gap: 8,
              padding: "0 18px 18px",
            }}>
              <button
                type="button"
                onClick={handleCancel}
                disabled={busy}
                style={{
                  flex: 1, padding: "11px 0",
                  background: "#f1f5f9", color: "#334155",
                  border: "1.5px solid #e2e8f0", borderRadius: 9,
                  fontWeight: 700, fontSize: 13, cursor: busy ? "wait" : "pointer",
                  transition: "background 140ms",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#e2e8f0"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "#f1f5f9"; }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={busy}
                style={{
                  flex: 1, padding: "11px 0",
                  background: busy ? "#fca5a5" : "#dc2626", color: "#fff",
                  border: "none", borderRadius: 9,
                  fontWeight: 800, fontSize: 13, cursor: busy ? "wait" : "pointer",
                  boxShadow: "0 4px 14px rgba(220,38,38,0.45)",
                  transition: "background 140ms",
                }}
                onMouseEnter={e => { if (!busy) (e.currentTarget as HTMLButtonElement).style.background = "#b91c1c"; }}
                onMouseLeave={e => { if (!busy) (e.currentTarget as HTMLButtonElement).style.background = "#dc2626"; }}
              >
                {busy ? "Deleting…" : error ? "Try Again" : "Yes, Delete"}
              </button>
            </div>
          </div>
          <style>{`
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes popIn {
              0%   { transform: scale(0.85); opacity: 0; }
              100% { transform: scale(1); opacity: 1; }
            }
          `}</style>
        </div>,
        document.body
      )}
    </>
  );
}

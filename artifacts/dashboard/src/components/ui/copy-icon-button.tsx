import { useState, useRef, useEffect } from "react";
import { Copy, Check } from "lucide-react";

type Props = {
  value: string;
  size?: number;        // overall button size in px (default 28)
  color?: string;       // accent color (default indigo)
  title?: string;       // tooltip text (default "Copy")
  inline?: boolean;     // small inline mode (compact padding)
};

export function CopyIconButton({
  value,
  size = 28,
  color = "#6366f1",
  title = "Copy",
  inline = false,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // legacy fallback
        const ta = document.createElement("textarea");
        ta.value = value; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  }

  const dim = inline ? Math.max(20, size - 6) : size;
  const iconSize = Math.round(dim * 0.5);
  const bg = copied ? "#14532d" : hover ? `${color}22` : "transparent";
  const border = copied ? "#16a34a" : hover ? `${color}66` : `${color}33`;
  const fg = copied ? "#4ade80" : hover ? color : `${color}cc`;

  return (
    <button
      type="button"
      onClick={copy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      title={copied ? "Copied!" : title}
      aria-label={copied ? "Copied" : title}
      style={{
        width: dim,
        height: dim,
        minWidth: dim,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: 0,
        color: fg,
        cursor: "pointer",
        transition: "background 160ms ease, border-color 160ms ease, color 160ms ease, transform 120ms ease, box-shadow 200ms ease",
        transform: pressed ? "scale(0.92)" : copied ? "scale(1.05)" : "scale(1)",
        boxShadow: copied
          ? `0 0 0 3px ${color}11, 0 0 12px #22c55e55`
          : hover
            ? `0 0 0 3px ${color}1a`
            : "none",
        flexShrink: 0,
        position: "relative",
        verticalAlign: "middle",
      }}
    >
      <span
        key={copied ? "check" : "copy"}
        style={{
          display: "inline-flex",
          animation: "copyBtnPop 220ms ease",
          lineHeight: 0,
        }}
      >
        {copied
          ? <Check size={iconSize} strokeWidth={3} />
          : <Copy size={iconSize} strokeWidth={2.2} />}
      </span>
      <style>{`
        @keyframes copyBtnPop {
          0%   { transform: scale(0.5); opacity: 0; }
          60%  { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </button>
  );
}

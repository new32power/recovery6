import { useId } from "react";

type Props = {
  size?: number;
  label?: string;
  color?: string;
  trackColor?: string;
  labelColor?: string;
  className?: string;
};

export function CircularLoader({
  size = 44,
  label,
  color = "#6366f1",
  trackColor,
  labelColor = "#64748b",
  className,
}: Props) {
  const uid = useId().replace(/:/g, "");
  const gradId = `clg-${uid}`;
  const s = size;
  const stroke = Math.max(3, Math.round(s / 10));
  const r = (s - stroke) / 2;
  const c = 2 * Math.PI * r;
  const track = trackColor ?? `${color}26`;

  return (
    <div
      className={className}
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: label ? 10 : 0,
      }}
      role="status"
      aria-label={label ?? "Loading"}
    >
      <svg
        width={s}
        height={s}
        viewBox={`0 0 ${s} ${s}`}
        className="circ-loader-spin"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0" />
            <stop offset="100%" stopColor={color} stopOpacity="1" />
          </linearGradient>
        </defs>
        <circle cx={s / 2} cy={s / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={s / 2}
          cy={s / 2}
          r={r}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * 0.7} ${c}`}
          transform={`rotate(-90 ${s / 2} ${s / 2})`}
        />
      </svg>
      {label ? (
        <div style={{ fontSize: 12, color: labelColor, fontWeight: 600, letterSpacing: 0.2 }}>
          {label}
        </div>
      ) : null}
    </div>
  );
}

export function CircularLoaderBlock({
  label = "Loading…",
  size = 44,
  color = "#6366f1",
  minHeight = 160,
}: { label?: string; size?: number; color?: string; minHeight?: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        minHeight,
      }}
    >
      <CircularLoader size={size} label={label} color={color} />
    </div>
  );
}

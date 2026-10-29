import { useId } from "react";

/**
 * Decorative trend line. Always paired with the numbers it summarises, so it
 * is hidden from assistive tech rather than given a misleading label.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const id = useId();
  if (values.length < 2)
    return <svg width={width} height={height} aria-hidden className={className} />;
  const max = Math.max(...values);
  const step = width / (values.length - 1);
  const y = (v: number) => (max > 0 ? height - 2 - (v / max) * (height - 4) : height - 2);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${points.join(" L")}`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className={className}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke="var(--series-1)"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

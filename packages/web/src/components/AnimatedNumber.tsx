import { useCountUp } from "../hooks/useCountUp.js";
import { useMotion } from "../lib/motion.js";

/**
 * A counting number for headline tiles. The tween is visual only: assistive
 * tech reads the final formatted value, never the intermediate frames.
 */
export function AnimatedNumber({
  value,
  format,
  label,
}: {
  value: number;
  format: (value: number) => string;
  /** Spoken form, when it differs from the formatted value. */
  label?: string;
}) {
  const { enabled } = useMotion();
  const shown = useCountUp(value, enabled);
  return (
    <>
      <span aria-hidden className="num">
        {format(shown)}
      </span>
      <span className="sr-only">{label ?? format(value)}</span>
    </>
  );
}

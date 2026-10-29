import { MonitorCog, Pause, Sparkles } from "lucide-react";
import { type MotionPreference, useMotion } from "../../lib/motion.js";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.js";

const OPTIONS: Array<{ value: MotionPreference; label: string; icon: typeof Pause }> = [
  { value: "system", label: "Motion follows system setting", icon: MonitorCog },
  { value: "on", label: "Motion on", icon: Sparkles },
  { value: "off", label: "Motion off", icon: Pause },
];

export function MotionToggle() {
  const { preference, setPreference } = useMotion();
  return (
    <ToggleGroup
      type="single"
      value={preference}
      onValueChange={(value) => value && setPreference(value as MotionPreference)}
      aria-label="Motion"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={label}
          title={label}
          className="px-2"
        >
          <Icon aria-hidden />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

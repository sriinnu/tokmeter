import { Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useTheme } from "../../lib/theme.js";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.js";

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "system", label: "System theme", icon: Monitor },
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  return (
    <ToggleGroup
      type="single"
      value={preference}
      onValueChange={(value) => value && setPreference(value as ThemePreference)}
      aria-label="Colour theme"
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

/**
 * BackgroundPicker.tsx
 *
 * Settings > Appearance: choose the background style. A row of swatches; the
 * choice applies at once and is remembered on this device (ThemeContext).
 */
import { Check } from "lucide-react";
import { BACKGROUND_STYLES, useTheme } from "@/components/ThemeContext";

export default function BackgroundPicker() {
  const { background, setBackground, theme } = useTheme();
  return (
    <section className="space-y-2" data-testid="background-picker" aria-labelledby="background-picker-title">
      <div>
        <div id="background-picker-title" className="text-sm font-medium text-foreground">Background style</div>
        <div className="text-[11px] text-muted-foreground">
          Applies to the dark theme and is saved on this device.{theme !== "dark" ? " Switch to the dark theme to see it." : ""}
        </div>
      </div>
      <div role="radiogroup" aria-labelledby="background-picker-title" className="grid grid-cols-2 gap-2">
        {BACKGROUND_STYLES.map((b) => {
          const on = background === b.id;
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setBackground(b.id)}
              data-testid={`background-option-${b.id}`}
              className={`flex min-h-[56px] items-center gap-3 rounded-lg border p-2 text-left transition ${on ? "border-primary bg-primary/10" : "border-border hover:border-foreground/30"}`}
            >
              <span
                aria-hidden="true"
                className="relative h-10 w-10 shrink-0 rounded-md border border-white/10"
                style={{ background: b.id === "navy-glow" ? `radial-gradient(circle at 30% 0%, #1E3B6B, ${b.swatch} 70%)` : b.swatch }}
              >
                <span className="absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full" style={{ background: b.accent }} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{b.label}</span>
                <span className="block break-words text-[11px] leading-snug text-muted-foreground">{b.note}</span>
              </span>
              {on && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

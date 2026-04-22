// ShortcutsModal.tsx — keyboard shortcuts help dialog
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SHORTCUT_DOCS, TAB_LABELS } from "@/hooks/use-keyboard-shortcuts";
import type { TabKey } from "@/components/TickerContext";
import { Keyboard } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const TAB_ORDER: TabKey[] = [
  "signals", "chart", "models", "tradedesk", "regime", "news", "voices", "takefive",
];

export default function ShortcutsModal({ open, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm" data-testid="shortcuts-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <Keyboard className="h-4 w-4 text-primary" />
            Keyboard Shortcuts
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Tab shortcuts */}
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">Tabs</div>
            <div className="space-y-1">
              {TAB_ORDER.map((tab, i) => (
                <div key={tab} className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{TAB_LABELS[tab]}</span>
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                    {i + 1}
                  </kbd>
                </div>
              ))}
            </div>
          </div>

          {/* Other shortcuts */}
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">Navigation</div>
            <div className="space-y-1">
              {SHORTCUT_DOCS.filter((_, i) => i > 0).map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{s.description}</span>
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                    {s.key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

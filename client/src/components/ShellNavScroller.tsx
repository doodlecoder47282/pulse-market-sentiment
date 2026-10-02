import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** Native horizontal scrolling plus visible, keyboard-operable scroll buttons.
 * Scroll buttons never activate a workspace; the actual tab/button does. */
export default function ShellNavScroller({ children, name }: { children: ReactNode; name: "desktop" | "mobile" }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false, overflow: false });
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => setEdges({
      start: strip.scrollLeft <= 1,
      end: strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1,
      overflow: strip.scrollWidth > strip.clientWidth + 1,
    });
    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(strip);
    if (strip.firstElementChild) observer?.observe(strip.firstElementChild);
    window.addEventListener("resize", measure);
    return () => {
      strip.removeEventListener("scroll", measure);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const scroll = (direction: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollBy({
      left: direction * strip.clientWidth * 0.8,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };
  return (
    <div className="batcave-nav-scroller" data-overflow={edges.overflow}>
      <button type="button" className="batcave-nav-scroll-button"
        aria-label="Scroll to earlier workspaces" aria-controls={`${name}-workspace-scroll`}
        aria-disabled={edges.start} onClick={() => !edges.start && scroll(-1)}
        data-testid={`${name}-nav-earlier`}>
        <ChevronLeft aria-hidden="true" />
      </button>
      <div ref={stripRef} id={`${name}-workspace-scroll`}
        className="batcave-nav-strip hscroll-contain" data-testid={`${name}-nav-scroll`}>
        {children}
      </div>
      <button type="button" className="batcave-nav-scroll-button"
        aria-label="Scroll to later workspaces" aria-controls={`${name}-workspace-scroll`}
        aria-disabled={edges.end} onClick={() => !edges.end && scroll(1)}
        data-testid={`${name}-nav-later`}>
        <ChevronRight aria-hidden="true" />
      </button>
    </div>
  );
}

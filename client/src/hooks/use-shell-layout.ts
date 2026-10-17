import { useEffect, type RefObject } from "react";

interface ShellMeasurements {
  header: number;
  banner: number;
  desktopDock: number;
  mobileDock: number;
  mobileBottom: number;
  dockGap: number;
  viewport: number;
}

/** Heights/offsets come from rendered border boxes, including safe-area padding.
 * The half-viewport rule is a reflow policy, not a guessed chrome dimension. */
export function shellGeometry(measured: ShellMeasurements) {
  const top = measured.header + measured.banner;
  const bottom = measured.mobileDock > 0 ? measured.mobileDock + measured.mobileBottom : 0;
  const topDock = measured.desktopDock > 0 ? measured.desktopDock + measured.dockGap : 0;
  const flow = top + topDock + bottom > measured.viewport / 2;
  return {
    flow,
    top: flow ? 0 : top,
    scrollTop: (flow ? 0 : top) + topDock,
    bottom,
  };
}

/** Use viewport geometry rather than offsetLeft, whose offset parent may be
 * the fixed nav instead of its scroll container. */
export function centeredScrollLeft(
  itemLeft: number, itemWidth: number, stripLeft: number,
  stripWidth: number, scrollLeft: number, scrollWidth: number,
) {
  const desired = scrollLeft + itemLeft - stripLeft - (stripWidth - itemWidth) / 2;
  return Math.max(0, Math.min(Math.max(0, scrollWidth - stripWidth), desired));
}

/** Only move the document when a focused control is behind shell chrome. */
export function focusScrollDelta(top: number, bottom: number, visibleTop: number, visibleBottom: number) {
  if (top < visibleTop) return top - visibleTop;
  if (bottom > visibleBottom) return Math.min(bottom - visibleBottom, top - visibleTop);
  return 0;
}

interface ShellRefs {
  shell: RefObject<HTMLElement>;
  header: RefObject<HTMLElement>;
  banner: RefObject<HTMLElement>;
  desktopDock: RefObject<HTMLElement>;
  mobileDock: RefObject<HTMLElement>;
}

export function useShellLayout(refs: ShellRefs, ready: boolean) {
  const { shell: shellRef, header: headerRef, banner: bannerRef, desktopDock: desktopRef, mobileDock: mobileRef } = refs;
  useEffect(() => {
    const shell = shellRef.current;
    const header = headerRef.current;
    const banner = bannerRef.current;
    const desktop = desktopRef.current;
    const mobile = mobileRef.current;
    if (!ready || !shell || !header || !banner || !desktop || !mobile) return;
    const root = document.documentElement;
    let frame = 0;
    let focusFrame = 0;
    const height = (element: HTMLElement) => Math.ceil(element.getBoundingClientRect().height);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const set = (name: string, value: number) => shell.style.setProperty(name, `${value}px`);
    const measure = () => {
      const headerHeight = height(header);
      const bannerHeight = height(banner);
      const desktopHeight = height(desktop);
      const mobileHeight = height(mobile);
      // Read the CSS safe-area inset even while the dock is in flow; CSS keeps
      // its bottom declaration so changing position cannot cause oscillation.
      const mobileBottom = px(getComputedStyle(mobile).bottom);
      const dockGap = px(getComputedStyle(shell).getPropertyValue("--batcave-dock-gap"));
      const geometry = shellGeometry({
        header: headerHeight, banner: bannerHeight, desktopDock: desktopHeight,
        mobileDock: mobileHeight, mobileBottom, dockGap,
        viewport: window.visualViewport?.height ?? window.innerHeight,
      });
      shell.dataset.shellFlow = String(geometry.flow);
      set("--batcave-header-height", headerHeight);
      set("--batcave-banner-height", bannerHeight);
      set("--batcave-desktop-dock-height", desktopHeight);
      set("--batcave-mobile-dock-height", mobileHeight);
      set("--batcave-top-offset", geometry.top);
      set("--batcave-bottom-offset", geometry.bottom);
      root.style.setProperty("--batcave-scroll-top", `${geometry.scrollTop}px`);
      root.style.setProperty("--batcave-scroll-bottom", `${geometry.bottom}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    for (const element of [header, banner, desktop, mobile]) observer?.observe(element, { box: "border-box" });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);

    const revealFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !shell.contains(target) ||
          !target.closest(".batcave-main") || target.closest(".batcave-tabs-dock, .batcave-mobile-dock")) return;
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        if (!target.isConnected) return;
        const viewport = window.visualViewport;
        const viewTop = viewport?.offsetTop ?? 0;
        let visibleTop = viewTop;
        for (const element of [header, banner, desktop]) {
          const rect = element.getBoundingClientRect();
          const styles = getComputedStyle(element);
          if (styles.position !== "sticky" && styles.position !== "fixed") continue;
          // A dock still in its natural document position is not an overlay.
          const stickyTop = px(styles.top) + viewTop;
          if (rect.height && rect.top <= stickyTop + 1) visibleTop = Math.max(visibleTop, rect.bottom);
        }
        const mobileRect = mobile.getBoundingClientRect();
        const visibleBottom = mobileRect.height ? mobileRect.top : viewTop + (viewport?.height ?? window.innerHeight);
        const rect = target.getBoundingClientRect();
        const delta = focusScrollDelta(rect.top, rect.bottom, visibleTop + 4, visibleBottom - 4);
        if (delta) window.scrollBy({ top: delta, behavior: "instant" });
      });
    };
    shell.addEventListener("focusin", revealFocus);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      shell.removeEventListener("focusin", revealFocus);
      root.style.removeProperty("--batcave-scroll-top");
      root.style.removeProperty("--batcave-scroll-bottom");
    };
  }, [ready, shellRef, headerRef, bannerRef, desktopRef, mobileRef]);
}

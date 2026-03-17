import { ReactNode, useEffect } from "react";

type ViewportAdaptationProviderProps = {
  children: ReactNode;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function ViewportAdaptationProvider({ children }: ViewportAdaptationProviderProps) {
  useEffect(() => {
    let frameId = 0;

    const updateViewportVars = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      const root = document.documentElement;

      const isTiny = width < 480;
      const isMobile = width < 768;
      const isTablet = width >= 768 && width < 1200;
      const isShort = height < 740;

      const profile = isTiny ? "tiny" : isMobile ? "mobile" : isTablet ? "tablet" : "desktop";
      const density = dpr >= 2 ? "high" : "standard";

      const contentMaxWidth =
        width >= 1920 ? "1440px" : width >= 1600 ? "1320px" : width >= 1280 ? "1240px" : "100%";

      const fontScaleBase = clamp(width / 1440, 0.92, 1.05);
      const fontScale = isShort ? clamp(fontScaleBase * 0.96, 0.9, 1.03) : fontScaleBase;

      const spacingScaleBase = clamp(width / 1366, 0.9, 1.08);
      const spacingScale = isShort ? clamp(spacingScaleBase * 0.94, 0.86, 1.05) : spacingScaleBase;

      const pageX = isTiny ? 12 : isMobile ? 16 : isTablet ? 20 : 24;
      const pageY = isTiny ? 14 : isShort ? 16 : isMobile ? 18 : 24;
      const headerHeight = isTiny ? 52 : isMobile ? 54 : 56;

      root.dataset.screenProfile = profile;
      root.dataset.screenDensity = density;
      root.dataset.screenOrientation = width >= height ? "landscape" : "portrait";

      root.style.setProperty("--viewport-width", `${width}px`);
      root.style.setProperty("--viewport-height", `${height}px`);
      root.style.setProperty("--vh-unit", `${height * 0.01}px`);
      root.style.setProperty("--app-font-scale", fontScale.toFixed(3));
      root.style.setProperty("--app-space-scale", spacingScale.toFixed(3));
      root.style.setProperty("--content-max-width", contentMaxWidth);
      root.style.setProperty("--app-page-x", `${pageX}px`);
      root.style.setProperty("--app-page-y", `${pageY}px`);
      root.style.setProperty("--app-header-height", `${headerHeight}px`);
    };

    const onResize = () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(updateViewportVars);
    };

    updateViewportVars();
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("orientationchange", onResize, { passive: true });
    window.visualViewport?.addEventListener("resize", onResize);

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, []);

  return <>{children}</>;
}

import { ReactNode, useEffect } from "react";

type ViewportAdaptationProviderProps = {
  children: ReactNode;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1180;

function detectTouchDevice() {
  return Boolean(
    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
    || navigator.maxTouchPoints > 0
    || "ontouchstart" in window,
  );
}

function detectPlatform() {
  const ua = String(navigator.userAgent || "").toLowerCase();
  const platform = String(navigator.platform || "").toLowerCase();
  const maxTouchPoints = navigator.maxTouchPoints || 0;

  const isAndroid = /android/.test(ua);
  const isIOS = /iphone|ipad|ipod/.test(ua) || (platform.includes("mac") && maxTouchPoints > 1);
  return { isAndroid, isIOS };
}

export function ViewportAdaptationProvider({ children }: ViewportAdaptationProviderProps) {
  useEffect(() => {
    let frameId = 0;

    const updateViewportVars = () => {
      const visualViewport = window.visualViewport;
      const width = Math.max(1, Math.round(visualViewport?.width || window.innerWidth || 1));
      const height = Math.max(1, Math.round(visualViewport?.height || window.innerHeight || 1));
      const dpr = window.devicePixelRatio || 1;
      const touchDevice = detectTouchDevice();
      const { isAndroid, isIOS } = detectPlatform();
      const root = document.documentElement;

      const isTiny = width < 420;
      const isMobile = width < MOBILE_BREAKPOINT;
      const isTablet = !isMobile && ((touchDevice && width < TABLET_BREAKPOINT) || (!touchDevice && width < 1024));
      const isShort = height < 740;
      const orientation = width >= height ? "landscape" : "portrait";

      const profile = isTiny ? "tiny" : isMobile ? "mobile" : isTablet ? "tablet" : "desktop";
      const density = dpr >= 2 ? "high" : "standard";
      const deviceKind = isMobile ? "phone" : isTablet ? "tablet" : "desktop";
      const platform = isAndroid ? "android" : isIOS ? "ios" : "web";

      const contentMaxWidth =
        profile === "mobile" || profile === "tiny"
          ? "100%"
          : width >= 1920
            ? "1440px"
            : width >= 1600
              ? "1320px"
              : width >= 1280
                ? "1240px"
                : "100%";

      const fontScaleBase = clamp(width / 1440, 0.92, 1.05);
      const touchFontBoost = touchDevice ? 1.01 : 1;
      const fontScale = isShort
        ? clamp(fontScaleBase * touchFontBoost * 0.96, 0.9, 1.04)
        : clamp(fontScaleBase * touchFontBoost, 0.92, 1.06);

      const spacingScaleBase = clamp(width / 1366, 0.9, 1.08);
      const spacingScale = isShort ? clamp(spacingScaleBase * 0.94, 0.86, 1.06) : spacingScaleBase;

      const pageX = isTiny ? 10 : isMobile ? 12 : isTablet ? 18 : 24;
      const pageY = isTiny ? 12 : isShort ? 14 : isMobile ? 16 : isTablet ? 20 : 24;
      const headerHeight = isTiny ? 54 : isMobile ? 56 : isTablet ? 58 : 56;
      const touchTargetSize = touchDevice ? (isTiny ? 42 : 44) : 36;

      root.dataset.screenProfile = profile;
      root.dataset.screenDensity = density;
      root.dataset.screenOrientation = orientation;
      root.dataset.deviceKind = deviceKind;
      root.dataset.platform = platform;
      root.dataset.touch = touchDevice ? "true" : "false";

      root.style.setProperty("--viewport-width", `${width}px`);
      root.style.setProperty("--viewport-height", `${height}px`);
      root.style.setProperty("--vh-unit", `${height * 0.01}px`);
      root.style.setProperty("--app-font-scale", fontScale.toFixed(3));
      root.style.setProperty("--app-space-scale", spacingScale.toFixed(3));
      root.style.setProperty("--content-max-width", contentMaxWidth);
      root.style.setProperty("--app-page-x", `${pageX}px`);
      root.style.setProperty("--app-page-y", `${pageY}px`);
      root.style.setProperty("--app-header-height", `${headerHeight}px`);
      root.style.setProperty("--touch-target-size", `${touchTargetSize}px`);
      root.style.setProperty("--device-pixel-ratio", dpr.toFixed(2));
      root.style.setProperty("--physical-viewport-width", `${Math.round(width * dpr)}px`);
      root.style.setProperty("--physical-viewport-height", `${Math.round(height * dpr)}px`);
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
    window.visualViewport?.addEventListener("scroll", onResize);

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
    };
  }, []);

  return <>{children}</>;
}

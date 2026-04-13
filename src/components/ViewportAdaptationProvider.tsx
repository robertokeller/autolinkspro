import { ReactNode, useEffect } from "react";
import { computeResponsiveViewportState } from "@/lib/viewport";

type ViewportAdaptationProviderProps = {
  children: ReactNode;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function ViewportAdaptationProvider({ children }: ViewportAdaptationProviderProps) {
  useEffect(() => {
    let frameId = 0;

    const updateViewportVars = () => {
      const viewport = computeResponsiveViewportState();
      const width = viewport.width;
      const height = viewport.height;
      const dpr = viewport.dpr;
      const root = document.documentElement;

      const isShort = viewport.isShort;
      const profile = viewport.profile;
      const orientation = viewport.orientation;
      const density = dpr >= 2 ? "high" : "standard";
      const deviceKind = viewport.isMobile ? "phone" : viewport.isTablet ? "tablet" : "desktop";
      const isPortraitPhone = viewport.isPortraitPhone;
      const isPortraitTablet = viewport.isPortraitTablet;
      const isMobileLike = viewport.isMobileLike;
      const platform = viewport.isAndroid ? "android" : viewport.isIOS ? "ios" : "web";

      const contentMaxWidth =
        profile === "mobile" || profile === "tiny" || isPortraitTablet
          ? "100%"
          : width >= 1920
            ? "1440px"
            : width >= 1600
              ? "1320px"
              : width >= 1280
                ? "1240px"
                : "100%";

      const fontScaleBase = clamp(width / 1440, 0.92, 1.05);
      const touchFontBoost = viewport.isTouch ? 1.01 : 1;
      const fontScale = isShort
        ? clamp(fontScaleBase * touchFontBoost * 0.96, 0.9, 1.04)
        : clamp(fontScaleBase * touchFontBoost, 0.92, 1.06);

      const spacingScaleBase = clamp(width / 1366, 0.9, 1.08);
      const spacingScale = isShort ? clamp(spacingScaleBase * 0.94, 0.86, 1.06) : spacingScaleBase;

      const pageX = isPortraitPhone ? 10 : viewport.isTiny ? 10 : viewport.isMobile ? 12 : viewport.isTablet ? 18 : 24;
      const pageY = isPortraitPhone ? 12 : viewport.isTiny ? 12 : isShort ? 14 : viewport.isMobile ? 16 : viewport.isTablet ? 20 : 24;
      const headerHeight = isPortraitPhone ? 54 : viewport.isTiny ? 54 : viewport.isMobile ? 56 : viewport.isTablet ? 58 : 56;
      const touchTargetSize = viewport.isTouch ? (isPortraitPhone ? 46 : viewport.isTiny ? 42 : 44) : 36;
      const mobileBottomNavHeight = isMobileLike ? (isPortraitPhone ? 70 : 74) : 0;

      root.dataset.screenProfile = profile;
      root.dataset.screenDensity = density;
      root.dataset.screenOrientation = orientation;
      root.dataset.aspectRatio = viewport.aspectRatioClass;
      root.dataset.resolution = viewport.resolutionClass;
      root.dataset.aspectRatio = viewport.aspectRatioClass;
      root.dataset.resolution = viewport.resolutionClass;
      root.dataset.deviceKind = deviceKind;
      root.dataset.portraitPhone = isPortraitPhone ? "true" : "false";
      root.dataset.portraitTablet = isPortraitTablet ? "true" : "false";
      root.dataset.mobileLike = isMobileLike ? "true" : "false";
      root.dataset.platform = platform;
      root.dataset.touch = viewport.isTouch ? "true" : "false";

      root.style.setProperty("--viewport-width", `${width}px`);
      root.style.setProperty("--viewport-height", `${height}px`);
      root.style.setProperty("--viewport-aspect-ratio", viewport.aspectRatio.toFixed(4));
      root.style.setProperty("--aspect-ratio-class", `'${viewport.aspectRatioClass}'`);
      root.style.setProperty("--resolution-class", `'${viewport.resolutionClass}'`);
      root.style.setProperty("--aspect-ratio-class", `'${viewport.aspectRatioClass}'`);
      root.style.setProperty("--resolution-class", `'${viewport.resolutionClass}'`);
      root.style.setProperty("--vh-unit", `${height * 0.01}px`);
      root.style.setProperty("--app-font-scale", fontScale.toFixed(3));
      root.style.setProperty("--app-space-scale", spacingScale.toFixed(3));
      root.style.setProperty("--content-max-width", contentMaxWidth);
      root.style.setProperty("--app-page-x", `${pageX}px`);
      root.style.setProperty("--app-page-y", `${pageY}px`);
      root.style.setProperty("--app-header-height", `${headerHeight}px`);
      root.style.setProperty("--touch-target-size", `${touchTargetSize}px`);
      root.style.setProperty("--mobile-bottom-nav-height", `${mobileBottomNavHeight}px`);
      root.style.setProperty("--mobile-bottom-nav-offset", isMobileLike ? `${mobileBottomNavHeight}px` : "0px");
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

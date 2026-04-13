const fs = require("fs");
const target = "src/lib/viewport.ts";

const content = `export type ScreenProfile = "tiny" | "mobile" | "tablet" | "desktop";
export type Orientation = "portrait" | "landscape";

export type AspectRatioClass = "21:9" | "16:9" | "16:10" | "3:2" | "4:3" | "1:1" | "9:16" | "other";
export type ScreenResolutionClass = "4k" | "1440p" | "1080p" | "720p" | "sub720p";

export const TINY_BREAKPOINT = 420;
export const MOBILE_BREAKPOINT = 768;
export const TABLET_BREAKPOINT = 1180;

export type ViewportDeviceInfo = {
  isTouch: boolean;
  isAndroid: boolean;
  isIOS: boolean;
};

export type ViewportMetrics = {
  width: number;
  height: number;
  dpr: number;
  orientation: Orientation;
  isShort: boolean;
};

export type ResponsiveViewportState = ViewportMetrics &
  ViewportDeviceInfo & {
    profile: ScreenProfile;
    isTiny: boolean;
    isMobile: boolean;
    isTablet: boolean;
    isDesktop: boolean;
    isPortraitPhone: boolean;
    isPortraitTablet: boolean;
    isMobileLike: boolean;
    aspectRatio: number;
    aspectRatioClass: AspectRatioClass;
    resolutionClass: ScreenResolutionClass;
    physicalWidth: number;
    physicalHeight: number;
  };

export function detectAspectRatioClass(width: number, height: number): AspectRatioClass {
  const ratio = width / height;
  if (ratio > 2.2) return "21:9";
  if (ratio > 1.7) return "16:9";
  if (ratio > 1.55) return "16:10";
  if (ratio > 1.4) return "3:2";
  if (ratio > 1.25) return "4:3";
  if (ratio > 0.8 && ratio <= 1.25) return "1:1";
  if (ratio < 0.6) return "9:16";
  return "other";
}

export function detectResolutionClass(width: number, height: number): ScreenResolutionClass {
  const maxDim = Math.max(width, height);
  if (maxDim >= 3840) return "4k";
  if (maxDim >= 2560) return "1440p";
  if (maxDim >= 1920) return "1080p";
  if (maxDim >= 1280) return "720p";
  return "sub720p";
}

export function detectTouchDevice() {
  if (typeof window === "undefined") return false;
  return Boolean(
    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
    || navigator.maxTouchPoints > 0
    || "ontouchstart" in window,
  );
}

export function detectPlatform() {
  if (typeof window === "undefined") {
    return { isAndroid: false, isIOS: false };
  }
  const ua = String(navigator.userAgent || "").toLowerCase();
  const platform = String(navigator.platform || "").toLowerCase();
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  const isAndroid = /android/.test(ua);
  const isIOS = /iphone|ipad|ipod/.test(ua) || (platform.includes("mac") && maxTouchPoints > 1);
  return { isAndroid, isIOS };
}

export function getViewportMetrics(): ViewportMetrics {
  if (typeof window === "undefined") {
    return {
      width: 1200,
      height: 900,
      dpr: 1,
      orientation: "landscape",
      isShort: false,
    };
  }

  const visualViewport = window.visualViewport;
  const width = Math.max(1, Math.round(visualViewport?.width || window.innerWidth || 1));
  const height = Math.max(1, Math.round(visualViewport?.height || window.innerHeight || 1));
  const dpr = window.devicePixelRatio || 1;
  const orientation: Orientation = width >= height ? "landscape" : "portrait";
  const isShort = height < 740;

  return {
    width,
    height,
    dpr,
    orientation,
    isShort,
  };
}

export function computeResponsiveViewportState(): ResponsiveViewportState {
  const metrics = getViewportMetrics();
  const { isAndroid, isIOS } = detectPlatform();
  const isTouch = detectTouchDevice();
  const { width, height, dpr } = metrics;
  const aspectRatio = width / height;
  const aspectRatioClass = detectAspectRatioClass(width, height);
  const resolutionClass = detectResolutionClass(width, height);

  const isTiny = width < TINY_BREAKPOINT;
  const narrowMobile = width < MOBILE_BREAKPOINT;
  const touchTablet = isTouch && width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT;
  const nonTouchTablet = !isTouch && width >= MOBILE_BREAKPOINT && width < 1024;

  const isMobile = narrowMobile;
  const isTablet = !isMobile && (touchTablet || nonTouchTablet);
  const isDesktop = !isMobile && !isTablet;
  const isPortraitPhone = isTouch && metrics.orientation === "portrait" && width <= 540 && aspectRatio <= 0.72;
  const isPortraitTablet = isTouch && isTablet && metrics.orientation === "portrait";
  const isMobileLike = isMobile || isPortraitTablet;
  const profile: ScreenProfile = isTiny ? "tiny" : isMobile ? "mobile" : isTablet ? "tablet" : "desktop";

  return {
    ...metrics,
    profile,
    isTouch,
    isTiny,
    isMobile,
    isTablet,
    isDesktop,
    isPortraitPhone,
    isPortraitTablet,
    isMobileLike,
    aspectRatio,
    aspectRatioClass,
    resolutionClass,
    isAndroid,
    isIOS,
    physicalWidth: Math.round(width * dpr),
    physicalHeight: Math.round(height * dpr),
  };
}
`;

fs.writeFileSync(target, content);
console.log("Rebuilt viewport.ts");

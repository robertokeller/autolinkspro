export type ScreenProfile = "tiny" | "mobile" | "tablet" | "desktop";
export type Orientation = "portrait" | "landscape";

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
    physicalWidth: number;
    physicalHeight: number;
  };

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

  const isTiny = width < TINY_BREAKPOINT;
  const narrowMobile = width < MOBILE_BREAKPOINT;
  const touchTablet = isTouch && width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT;
  const nonTouchTablet = !isTouch && width >= MOBILE_BREAKPOINT && width < 1024;

  const isMobile = narrowMobile;
  const isTablet = !isMobile && (touchTablet || nonTouchTablet);
  const isDesktop = !isMobile && !isTablet;
  const profile: ScreenProfile = isTiny ? "tiny" : isMobile ? "mobile" : isTablet ? "tablet" : "desktop";

  return {
    ...metrics,
    profile,
    isTouch,
    isTiny,
    isMobile,
    isTablet,
    isDesktop,
    isAndroid,
    isIOS,
    physicalWidth: Math.round(width * dpr),
    physicalHeight: Math.round(height * dpr),
  };
}

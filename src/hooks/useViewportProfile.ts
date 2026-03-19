import * as React from "react";

type ScreenProfile = "tiny" | "mobile" | "tablet" | "desktop";
type Orientation = "portrait" | "landscape";

type ViewportProfile = {
  width: number;
  height: number;
  dpr: number;
  profile: ScreenProfile;
  orientation: Orientation;
  isTouch: boolean;
  isTiny: boolean;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isAndroid: boolean;
  isIOS: boolean;
  physicalWidth: number;
  physicalHeight: number;
};

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1180;
const TINY_BREAKPOINT = 420;

function getViewportSize() {
  const visualViewport = window.visualViewport;
  const width = Math.max(1, Math.round(visualViewport?.width || window.innerWidth || 1));
  const height = Math.max(1, Math.round(visualViewport?.height || window.innerHeight || 1));
  return { width, height };
}

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

function computeProfile(): ViewportProfile {
  const { width, height } = getViewportSize();
  const dpr = window.devicePixelRatio || 1;
  const { isAndroid, isIOS } = detectPlatform();
  const isTouch = detectTouchDevice();

  const isTiny = width < TINY_BREAKPOINT;
  const narrowMobile = width < MOBILE_BREAKPOINT;
  const touchTablet = isTouch && width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT;
  const nonTouchTablet = !isTouch && width >= MOBILE_BREAKPOINT && width < 1024;

  const isMobile = narrowMobile;
  const isTablet = !isMobile && (touchTablet || nonTouchTablet);
  const isDesktop = !isMobile && !isTablet;
  const profile: ScreenProfile = isTiny ? "tiny" : isMobile ? "mobile" : isTablet ? "tablet" : "desktop";
  const orientation: Orientation = width >= height ? "landscape" : "portrait";

  return {
    width,
    height,
    dpr,
    profile,
    orientation,
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

export function useViewportProfile() {
  const [state, setState] = React.useState<ViewportProfile>(() => {
    if (typeof window === "undefined") {
      return {
        width: 1200,
        height: 900,
        dpr: 1,
        profile: "desktop",
        orientation: "landscape",
        isTouch: false,
        isTiny: false,
        isMobile: false,
        isTablet: false,
        isDesktop: true,
        isAndroid: false,
        isIOS: false,
        physicalWidth: 1200,
        physicalHeight: 900,
      };
    }
    return computeProfile();
  });

  React.useEffect(() => {
    let frameId = 0;

    const update = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => setState(computeProfile()));
    };

    update();
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("orientationchange", update, { passive: true });
    window.visualViewport?.addEventListener("resize", update);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);

  return state;
}

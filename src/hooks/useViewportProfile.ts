import * as React from "react";
import {
  computeResponsiveViewportState,
  type Orientation,
  type ScreenProfile,
} from "@/lib/viewport";

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
  isPortraitPhone: boolean;
  isPortraitTablet: boolean;
  isMobileLike: boolean;
  aspectRatio: number;
  aspectRatioClass: AspectRatioClass;
  resolutionClass: ScreenResolutionClass;
  aspectRatioClass: AspectRatioClass;
  resolutionClass: ScreenResolutionClass;
  isAndroid: boolean;
  isIOS: boolean;
  physicalWidth: number;
  physicalHeight: number;
};

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
        isPortraitPhone: false,
        isPortraitTablet: false,
        isMobileLike: false,
        aspectRatio: 1200 / 900,
        aspectRatioClass: "4:3",
        resolutionClass: "720p",
        aspectRatioClass: "4:3",
        resolutionClass: "720p",
        isAndroid: false,
        isIOS: false,
        physicalWidth: 1200,
        physicalHeight: 900,
      };
    }
    return computeResponsiveViewportState();
  });

  React.useEffect(() => {
    let frameId = 0;

    const update = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => setState(computeResponsiveViewportState()));
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

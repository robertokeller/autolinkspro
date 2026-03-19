import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const TABLET_TOUCH_BREAKPOINT = 1180;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${TABLET_TOUCH_BREAKPOINT - 1}px)`);
    const touchMql = window.matchMedia("(pointer: coarse)");

    const onChange = () => {
      const width = window.visualViewport?.width || window.innerWidth;
      const coarsePointer = touchMql.matches || navigator.maxTouchPoints > 0;
      const shouldUseMobileLayout = width < MOBILE_BREAKPOINT || (coarsePointer && width < TABLET_TOUCH_BREAKPOINT);
      setIsMobile(shouldUseMobileLayout);
    };

    mql.addEventListener("change", onChange);
    touchMql.addEventListener("change", onChange);
    window.visualViewport?.addEventListener("resize", onChange);
    onChange();

    return () => {
      mql.removeEventListener("change", onChange);
      touchMql.removeEventListener("change", onChange);
      window.visualViewport?.removeEventListener("resize", onChange);
    };
  }, []);

  return !!isMobile;
}

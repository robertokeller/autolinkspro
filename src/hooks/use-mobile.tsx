import * as React from "react";
import { computeResponsiveViewportState } from "@/lib/viewport";

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const onChange = () => {
      const profile = computeResponsiveViewportState();
      setIsMobile(profile.isMobile || profile.isTablet);
    };

    window.addEventListener("resize", onChange, { passive: true });
    window.addEventListener("orientationchange", onChange, { passive: true });
    window.visualViewport?.addEventListener("resize", onChange);
    onChange();

    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("orientationchange", onChange);
      window.visualViewport?.removeEventListener("resize", onChange);
    };
  }, []);

  return !!isMobile;
}

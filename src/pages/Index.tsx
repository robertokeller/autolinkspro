import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
import { ROUTES } from "@/lib/routes";
import {
  BillingPeriod,
  LandingCtaSection,
  LandingFaqSection,
  LandingFeaturesSection,
  LandingFooter,
  LandingHeader,
  LandingHero,
  LandingPricingSection,
  LandingTestimonialsSection,
  LandingComparisonSection,
  type LandingPlanCard,
} from "@/features/landing/LandingSections";

export default function Index() {
  const { user, isLoading } = useAuth();
  const { state } = useAdminControlPlane();
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("monthly");
  const isAuthenticated = Boolean(user);

  const publicPlans: LandingPlanCard[] = state.plans
    .filter((plan) => {
      if (!plan.isActive || !plan.visibleOnHome) return false;
      if (Array.isArray(plan.periods) && plan.periods.length > 0) {
        return plan.periods.some((p) => p.type === billingPeriod && p.isActive);
      }
      return (plan.billingPeriod ?? "monthly") === billingPeriod;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, 3)
    .map((plan) => {
      const period = (plan.periods ?? []).find((p) => p.type === billingPeriod);
      const price = period?.price ?? plan.price;
      const checkoutUrl = period?.kiwifyCheckoutUrl ?? plan.kiwifyCheckoutUrl;
      const safeKiwifyHref = (() => {
        if (!checkoutUrl) return undefined;
        try {
          const parsed = new URL(checkoutUrl);
          if (parsed.protocol !== "https:") return undefined;
          return parsed.toString();
        } catch {
          return undefined;
        }
      })();
      const monthlyEq = period?.monthlyEquivalentPrice ?? (billingPeriod === "monthly" ? undefined : plan.monthlyEquivalentPrice);

      return {
        id: plan.id,
        name: plan.homeTitle || plan.name,
        priceLabel: price === 0 ? "Gratis" : `R$${price.toFixed(2).replace(".", ",")}`,
        period: billingPeriod === "monthly" ? "/mes" : billingPeriod === "quarterly" ? "/trimestre" : billingPeriod === "semiannual" ? "/semestre" : "/ano",
        monthlyEquivalentPrice: monthlyEq,
        description: plan.homeDescription,
        features: Array.isArray(plan.homeFeatureHighlights) && plan.homeFeatureHighlights.length > 0
          ? plan.homeFeatureHighlights.slice(0, 6)
          : [],
        cta: plan.homeCtaText || (
          price === 0
            ? "Comecar gratis"
            : `Assinar ${plan.name}`
        ),
        ctaHref: safeKiwifyHref,
        ctaTo: safeKiwifyHref ? undefined : (isAuthenticated ? ROUTES.app.account : ROUTES.auth.cadastro),
        highlight: plan.id === "plan-pro",
      };
    });

  return (
    <div className="min-h-screen bg-background">
      <LandingHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />
      <LandingHero isAuthenticated={isAuthenticated} />
      <LandingFeaturesSection isAuthenticated={isAuthenticated} />
      <LandingTestimonialsSection />
      <LandingComparisonSection />
      <LandingPricingSection billingPeriod={billingPeriod} publicPlans={publicPlans} setBillingPeriod={setBillingPeriod} />
      <LandingFaqSection />
      <LandingCtaSection isAuthenticated={isAuthenticated} />
      <LandingFooter />
    </div>
  );
}

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
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

  const publicPlans: LandingPlanCard[] = state.plans
    .filter((plan) => plan.isActive && plan.visibleOnHome && (plan.billingPeriod ?? "monthly") === billingPeriod)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
    .map((plan) => ({
      id: plan.id,
      name: plan.homeTitle || plan.name,
      priceLabel: plan.price === 0 ? "Grátis" : `R$${plan.price.toFixed(2).replace(".", ",")}`,
      period: plan.period,
      monthlyEquivalentPrice: plan.monthlyEquivalentPrice,
      description: plan.homeDescription,
      features: Array.isArray(plan.homeFeatureHighlights) && plan.homeFeatureHighlights.length > 0
        ? plan.homeFeatureHighlights.slice(0, 6)
        : [],
      cta: plan.homeCtaText || (plan.price === 0 ? "Começar grátis" : `Assinar ${plan.name}`),
      highlight: plan.id === "plan-pro" || plan.id === "plan-pro-annual",
    }));

  const isAuthenticated = Boolean(user);

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

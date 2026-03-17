import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { backend } from "@/integrations/backend/client";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import { subscribeAdminControlPlane } from "@/lib/admin-control-plane";
import { getFeatureAccessPolicyByPlan, isFeatureEnabledByPlan, resolvePlan, type AppFeature } from "@/lib/access-control";

export function useAccessControl() {
  const { user, isAdmin, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading: profileLoading } = useQuery({
    queryKey: ["profile-plan", user?.id],
    queryFn: async () => {
      const { data: profile, error } = await backend
        .from("profiles")
        .select("plan_id, plan_expires_at")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return profile;
    },
    enabled: !!user,
  });

  const planId = data?.plan_id || "plan-starter";
  const plan = resolvePlan(planId);
  const planExpiresAt = typeof data?.plan_expires_at === "string" && data.plan_expires_at.trim()
    ? data.plan_expires_at
    : null;
  const planExpiresAtMs = planExpiresAt ? Date.parse(planExpiresAt) : Number.NaN;
  const isPlanExpired = !isAdmin && Number.isFinite(planExpiresAtMs) && planExpiresAtMs <= Date.now();
  const planExpiredMessage = "Seu plano expirou. Renove ou troque de plano para voltar a usar este recurso.";

  useEffect(() => {
    if (!user?.id) return;

    return subscribeLocalDbChanges(() => {
      queryClient.invalidateQueries({ queryKey: ["profile-plan", user.id] });
    });
  }, [queryClient, user?.id]);

  useEffect(() => {
    return subscribeAdminControlPlane(() => {
      queryClient.invalidateQueries({ queryKey: ["profile-plan", user?.id] });
    });
  }, [queryClient, user?.id]);

  const canAccess = (feature: AppFeature) => {
    if (isAdmin) return true;
    if (isPlanExpired) return false;
    return isFeatureEnabledByPlan(feature, planId);
  };

  const getFeaturePolicy = (feature: AppFeature) => {
    if (isAdmin) {
      return {
        mode: "enabled" as const,
        blockedMessage: "",
        hasCapacity: true,
        enabled: true,
      };
    }

    const policy = getFeatureAccessPolicyByPlan(feature, planId);
    if (!isPlanExpired) return policy;

    if (policy.mode === "enabled") {
      return {
        ...policy,
        mode: "blocked" as const,
        blockedMessage: planExpiredMessage,
        hasCapacity: false,
        enabled: false,
      };
    }

    return policy;
  };

  const canSeeFeature = (feature: AppFeature) => {
    if (isAdmin) return true;
    return getFeaturePolicy(feature).mode !== "hidden";
  };

  return {
    plan,
    planId,
    planExpiresAt,
    isPlanExpired,
    canAccess,
    canSeeFeature,
    getFeaturePolicy,
    isCheckingAccess: authLoading || (!!user && profileLoading),
  };
}

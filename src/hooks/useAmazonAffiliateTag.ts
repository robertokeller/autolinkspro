import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { backend } from "@/integrations/backend/client";

export type AmazonAffiliateTag = {
  id: string;
  user_id: string;
  affiliate_tag: string;
  created_at: string;
  updated_at: string;
};

export function amazonTagQueryKey(userId: string | undefined) {
  return ["amazon_affiliate_tag", userId] as const;
}

export function useAmazonAffiliateTag() {
  const { user } = useAuth();

  const query = useQuery<AmazonAffiliateTag | null>({
    queryKey: amazonTagQueryKey(user?.id),
    queryFn: async () => {
      const { data, error } = await backend
        .from("amazon_affiliate_tags")
        .select("*")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as AmazonAffiliateTag | null;
    },
    enabled: !!user,
    staleTime: 0,
  });

  return {
    tag: query.data ?? null,
    isConfigured: Boolean(query.data?.affiliate_tag?.trim()),
    isLoading: query.isLoading,
  };
}

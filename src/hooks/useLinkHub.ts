import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { LinkHubPage } from "@/lib/types";
import type { Tables, Json } from "@/integrations/backend/types";
import { toast } from "sonner";
import { useCallback } from "react";
import { LINK_HUB_DEFAULT_THEME_COLOR, normalizeHexColor } from "@/lib/link-hub-theme";

type LinkHubRow = Tables<"link_hub_pages">;

interface LinkHubConfig {
  logoUrl?: string | null;
  themeColor?: string;
  description?: string;
  groupIds?: string[];
  masterGroupIds?: string[];
  groupLabels?: Record<string, string>;
}

function parseConfig(raw: Json): LinkHubConfig {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as unknown as LinkHubConfig;
  return {};
}

function mapRow(row: LinkHubRow): LinkHubPage {
  const config = parseConfig(row.config);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: config.description || "",
    logoUrl: config.logoUrl || null,
    themeColor: normalizeHexColor(config.themeColor || LINK_HUB_DEFAULT_THEME_COLOR),
    groupIds: config.groupIds || [],
    masterGroupIds: config.masterGroupIds || [],
    groupLabels: config.groupLabels || {},
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export function useLinkHub() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ["link_hub_pages", user?.id],
    queryFn: async () => {
      const { data, error } = await backend
        .from("link_hub_pages")
        .select("*")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map(mapRow);
    },
    enabled: !!user,
  });

  const createPage = useCallback(async (input: {
    slug: string; title: string; description: string; themeColor: string;
    logoUrl: string | null; groupIds: string[]; masterGroupIds: string[];
    groupLabels?: Record<string, string>;
  }) => {
    if (!input.slug || !input.title) { toast.error("Preencha slug e titulo"); return null; }
    const { data, error } = await backend.from("link_hub_pages").insert({
      user_id: user!.id,
      slug: input.slug,
      title: input.title,
      is_active: true,
      config: {
        themeColor: input.themeColor,
        description: input.description,
        groupIds: input.groupIds,
        masterGroupIds: input.masterGroupIds,
        logoUrl: input.logoUrl,
        groupLabels: input.groupLabels || {},
      },
    }).select().single();
    if (error) {
      if (error.code === "23505") toast.error("Este slug já está em uso");
      else toast.error("Erro ao criar página");
      return null;
    }
    qc.invalidateQueries({ queryKey: ["link_hub_pages"] });
    toast.success("Página criada com sucesso!");
    return mapRow(data);
  }, [user, qc]);

  const updatePage = useCallback(async (id: string, input: {
    slug: string; title: string; description: string; themeColor: string;
    logoUrl: string | null; groupIds: string[]; masterGroupIds: string[];
    groupLabels?: Record<string, string>;
  }) => {
    if (!user) return;
    const { error } = await backend.from("link_hub_pages").update({
      slug: input.slug,
      title: input.title,
      config: {
        themeColor: input.themeColor,
        description: input.description,
        groupIds: input.groupIds,
        masterGroupIds: input.masterGroupIds,
        logoUrl: input.logoUrl,
        groupLabels: input.groupLabels || {},
      },
    }).eq("id", id).eq("user_id", user!.id);
    if (error) { toast.error("Erro ao atualizar página"); return; }
    qc.invalidateQueries({ queryKey: ["link_hub_pages"] });
    toast.success("Página atualizada!");
  }, [qc, user]);

  const toggleActive = useCallback(async (id: string, currentActive: boolean) => {
    if (!user) return;
    await backend.from("link_hub_pages").update({ is_active: !currentActive }).eq("id", id).eq("user_id", user!.id);
    qc.invalidateQueries({ queryKey: ["link_hub_pages"] });
  }, [qc, user]);

  const deletePage = useCallback(async (id: string) => {
    if (!user) return;
    await backend.from("link_hub_pages").delete().eq("id", id).eq("user_id", user!.id);
    qc.invalidateQueries({ queryKey: ["link_hub_pages"] });
    toast.success("Página removida");
  }, [qc, user]);

  const uploadLogo = useCallback(async (pageId: string, file: File): Promise<string | null> => {
    if (!user) return null;
    const ext = file.name.split(".").pop() || "png";
    const path = `${user.id}/${pageId}.${ext}`;
    const { error } = await backend.storage.from("link-hub-logos").upload(path, file, { upsert: true });
    if (error) { toast.error("Erro ao enviar logo"); return null; }
    const { data } = backend.storage.from("link-hub-logos").getPublicUrl(path);
    return data.publicUrl;
  }, [user]);

  const removeLogo = useCallback(async (pageId: string) => {
    if (!user) return;
    // Try common extensions
    const paths = ["png", "jpg", "jpeg", "webp", "svg"].map(ext => `${user.id}/${pageId}.${ext}`);
    await backend.storage.from("link-hub-logos").remove(paths);
  }, [user]);

  return { pages, isLoading, createPage, updatePage, toggleActive, deletePage, uploadLogo, removeLogo };
}

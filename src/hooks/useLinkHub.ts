import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { LinkHubPage } from "@/lib/types";
import type { Tables, Json } from "@/integrations/backend/types";
import { toast } from "sonner";
import { useCallback } from "react";

// ─── Upload security ────────────────────────────────────────────────────────

/** Only raster formats — SVG is excluded because it can contain <script> tags. */
const ALLOWED_LOGO_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Validates a logo File before uploading to storage.
 * Checks MIME type allowlist, file size, and actual magic bytes (first 12).
 * Throws a user-friendly error string on any violation.
 */
async function validateLogoFile(file: File): Promise<void> {
  if (!ALLOWED_LOGO_MIME.has(file.type)) {
    throw new Error("Formato não suportado. Use PNG, JPG ou WebP.");
  }
  if (file.size > MAX_LOGO_BYTES) {
    throw new Error("A logo pode ter no máximo 2 MB.");
  }

  // Magic bytes verification — prevents renamed files (e.g. malicious.html → logo.png).
  const header = await file.slice(0, 12).arrayBuffer();
  const b = new Uint8Array(header);

  const isPNG = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const isJPEG = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isWebP =
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

  if (!isPNG && !isJPEG && !isWebP) {
    throw new Error("Arquivo inválido: o conteúdo não corresponde ao formato declarado.");
  }
}

// ────────────────────────────────────────────────────────────────────────────
import { LINK_HUB_DEFAULT_THEME_COLOR, normalizeHexColor } from "@/lib/link-hub-theme";

type LinkHubRow = Tables<"link_hub_pages">;

interface LinkHubConfig {
  logoUrl?: string | null;
  themeColor?: string;
  description?: string;
  groupIds?: string[];
  masterGroupIds?: string[];
  groupLabels?: Record<string, string>;
  texts?: {
    benefitsTitle?: string;
    testimonialsTitle?: string;
    testimonials?: { name: string; text: string }[];
  };
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
    texts: config.texts,
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
    texts?: {
      benefitsTitle?: string;
      testimonialsTitle?: string;
      testimonials?: { name: string; text: string }[];
    };
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
        texts: input.texts,
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
    texts?: {
      benefitsTitle?: string;
      testimonialsTitle?: string;
      testimonials?: { name: string; text: string }[];
    };
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
        texts: input.texts,
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
    try {
      await validateLogoFile(file);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Arquivo de logo inválido.");
      return null;
    }
    // Extension derived from validated MIME type — never from filename.
    const ext = MIME_TO_EXT[file.type] ?? "png";
    const path = `${user.id}/${pageId}.${ext}`;
    const { error } = await backend.storage.from("link-hub-logos").upload(path, file, { upsert: true });
    if (error) { toast.error("Erro ao enviar logo"); return null; }
    const { data } = backend.storage.from("link-hub-logos").getPublicUrl(path);
    return data.publicUrl;
  }, [user]);

  const removeLogo = useCallback(async (pageId: string) => {
    if (!user) return;
    // Try all supported extensions (svg excluded — no longer accepted for upload).
    const paths = ["png", "jpg", "jpeg", "webp"].map(ext => `${user.id}/${pageId}.${ext}`);
    await backend.storage.from("link-hub-logos").remove(paths);
  }, [user]);

  return { pages, isLoading, createPage, updatePage, toggleActive, deletePage, uploadLogo, removeLogo };
}

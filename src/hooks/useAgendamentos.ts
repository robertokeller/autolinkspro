import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { ScheduledPost, RecurrenceType, ScheduledMediaAttachment } from "@/lib/types";
import type { Tables, Json } from "@/integrations/backend/types";
import { toast } from "sonner";
import { useCallback } from "react";
import { logHistorico } from "@/lib/log-historico";
import { resolveEffectiveOperationalLimitsByPlanId } from "@/lib/access-control";

const SCHEDULE_DESTINATIONS_TABLE_WARNING = "Não foi possível carregar os destinos dos agendamentos. Os agendamentos foram exibidos sem os grupos vinculados.";

type PostRow = Tables<"scheduled_posts">;
type PostDestRow = Tables<"scheduled_post_destinations">;

interface PostMeta {
  scheduleName?: string;
  finalContent?: string; masterGroupIds?: string[]; templateId?: string | null;
  templateData?: Record<string, string>;
  sessionId?: string | null; weekDays?: string[]; messageType?: string;
  detectedLinks?: string[];
  recurrenceTimes?: string[];
  media?: ScheduledMediaAttachment | null;
}

function parseScheduledMedia(raw: unknown): ScheduledMediaAttachment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (item.kind !== "image") return null;
  const base64 = typeof item.base64 === "string" ? item.base64 : "";
  if (!base64) return null;
  const mimeType = typeof item.mimeType === "string" && item.mimeType.startsWith("image/")
    ? item.mimeType
    : "image/jpeg";
  const fileName = typeof item.fileName === "string" && item.fileName.trim()
    ? item.fileName.trim()
    : "schedule_image.jpg";
  return { kind: "image", base64, mimeType, fileName };
}

function parseMeta(raw: Json): PostMeta {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as unknown as PostMeta;
  return {};
}

function normalizeRecurrence(value: string): RecurrenceType {
  if (value === "daily" || value === "weekly" || value === "none") return value;
  return "none";
}

function mapRow(row: PostRow, destinations: PostDestRow[]): ScheduledPost {
  const meta = parseMeta(row.metadata);
  const dests = destinations.filter((d) => d.post_id === row.id);
  return {
    id: row.id,
    name: String(meta.scheduleName || row.content || "Agendamento").trim(),
    content: row.content,
    finalContent: meta.finalContent || row.content,
    scheduledAt: row.scheduled_at,
    recurrenceTimes: Array.isArray(meta.recurrenceTimes)
      ? meta.recurrenceTimes.filter((item): item is string => typeof item === "string")
      : [],
    destinationGroupIds: dests.map((d) => d.group_id),
    masterGroupIds: meta.masterGroupIds || [], templateId: meta.templateId || null,
    sessionId: meta.sessionId || null, recurrence: normalizeRecurrence(String(row.recurrence || "none")),
    weekDays: (meta.weekDays || []) as ScheduledPost["weekDays"],
    messageType: (meta.messageType || "text") as ScheduledPost["messageType"],
    detectedLinks: meta.detectedLinks || [], status: row.status as ScheduledPost["status"],
    media: parseScheduledMedia(meta.media),
    createdAt: row.created_at,
  };
}

export function useAgendamentos() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();

  const { data: posts = [], isLoading } = useQuery({
    queryKey: ["scheduled_posts", user?.id],
    queryFn: async () => {
      const postsRes = await backend
        .from("scheduled_posts")
        .select("*")
        .order("scheduled_at", { ascending: true });
      if (postsRes.error) throw postsRes.error;

      const postRows = postsRes.data || [];
      if (postRows.length === 0) return [];

      // Fetch only destinations that belong to this user's posts — not the entire table.
      const postIds = postRows.map((r) => r.id);
      const destsRes = await backend
        .from("scheduled_post_destinations")
        .select("*")
        .in("post_id", postIds);
      if (destsRes.error) {
        console.warn("[useAgendamentos]", SCHEDULE_DESTINATIONS_TABLE_WARNING, destsRes.error.message);
        return postRows.map((row) => mapRow(row, []));
      }

      return postRows.map((row) => mapRow(row, destsRes.data || []));
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 30_000 : false),
  });

  const createPost = useCallback(async (post: {
    name?: string;
    content: string; scheduledAt: string; recurrence: RecurrenceType;
    destinationGroupIds: string[]; masterGroupIds: string[];
    templateId?: string; sessionId?: string; weekDays?: string[];
    messageType?: string; detectedLinks?: string[]; finalContent?: string;
    templateData?: Record<string, string>;
    recurrenceTimes?: string[];
    media?: ScheduledMediaAttachment | null;
  }) => {
    if (!post.content.trim()) { toast.error("Preencha o conteúdo"); return null; }
    if (!post.scheduledAt) { toast.error("Defina a data/hora"); return null; }
    if (post.destinationGroupIds.length === 0 && post.masterGroupIds.length === 0) { toast.error("Selecione ao menos um destino"); return null; }

    if (!isAdmin) {
      const { data: profile, error: profileError } = await backend
        .from("profiles")
        .select("plan_id")
        .maybeSingle();

      if (profileError) {
        toast.error("Não foi possível validar o limite de agendamentos");
        return null;
      }

      const limits = resolveEffectiveOperationalLimitsByPlanId(profile?.plan_id || "plan-starter");
      const maxSchedules = limits?.schedules ?? 0;
      if (maxSchedules !== -1 && posts.length >= maxSchedules) {
        toast.error("Limite de agendamentos atingido para o seu nível de acesso.");
        return null;
      }
    }

    const { data, error } = await backend.from("scheduled_posts").insert({
      content: post.content,
      scheduled_at: new Date(post.scheduledAt).toISOString(), recurrence: post.recurrence, status: "pending",
      metadata: {
        scheduleName: post.name || post.content.slice(0, 80),
        masterGroupIds: post.masterGroupIds, templateId: post.templateId || null,
        sessionId: post.sessionId || null, weekDays: post.weekDays || [],
        messageType: post.messageType || "text", detectedLinks: post.detectedLinks || [],
        finalContent: post.finalContent || post.content,
        templateData: post.templateData || null,
        recurrenceTimes: post.recurrenceTimes || [],
        media: post.media || null,
      },
    }).select().single();
    if (error) { toast.error("Erro ao criar agendamento"); return null; }

    if (post.destinationGroupIds.length > 0) {
      const destinationsInsert = await backend
        .from("scheduled_post_destinations")
        .insert(post.destinationGroupIds.map((gid) => ({ post_id: data.id, group_id: gid })));

      if (destinationsInsert.error) {
        toast.warning("Agendamento criado, mas não foi possível vincular os grupos de destino.");
      }
    }

    qc.invalidateQueries({ queryKey: ["scheduled_posts"] });
    qc.invalidateQueries({ queryKey: ["history_entries"] });
    toast.success("Agendamento criado!");
    const destCount = post.destinationGroupIds.length + post.masterGroupIds.length;
    await logHistorico(user!.id, "session_event", "Agendamentos", post.content.slice(0, 40), "info", `Agendamento criado para ${destCount} destino(s)`);
    return data;
  }, [isAdmin, posts.length, qc, user]);

  const updatePost = useCallback(async (id: string, post: {
    name?: string;
    content: string; scheduledAt: string; recurrence: RecurrenceType;
    destinationGroupIds: string[]; masterGroupIds: string[];
    templateId?: string; sessionId?: string; weekDays?: string[];
    messageType?: string; detectedLinks?: string[]; finalContent?: string;
    templateData?: Record<string, string>;
    recurrenceTimes?: string[];
    media?: ScheduledMediaAttachment | null;
  }) => {
    const { error } = await backend.from("scheduled_posts").update({
      content: post.content, scheduled_at: new Date(post.scheduledAt).toISOString(),
      recurrence: post.recurrence, status: "pending",
      metadata: {
        scheduleName: post.name || post.content.slice(0, 80),
        masterGroupIds: post.masterGroupIds, templateId: post.templateId || null,
        sessionId: post.sessionId || null, weekDays: post.weekDays || [],
        messageType: post.messageType || "text", detectedLinks: post.detectedLinks || [],
        finalContent: post.finalContent || post.content,
        templateData: post.templateData || null,
        recurrenceTimes: post.recurrenceTimes || [],
        media: post.media || null,
      },
    }).eq("id", id);
    if (error) { toast.error("Erro ao atualizar agendamento"); return; }

    const deleteDestinations = await backend
      .from("scheduled_post_destinations")
      .delete()
      .eq("post_id", id);

    if (deleteDestinations.error) {
      toast.error("Não foi possível atualizar os grupos de destino do agendamento");
      return;
    }

    if (post.destinationGroupIds.length > 0) {
      const insertDestinations = await backend
        .from("scheduled_post_destinations")
        .insert(post.destinationGroupIds.map((gid) => ({ post_id: id, group_id: gid })));

      if (insertDestinations.error) {
        toast.error("Não foi possível atualizar os grupos de destino do agendamento");
        return;
      }
    }

    qc.invalidateQueries({ queryKey: ["scheduled_posts"] });
    qc.invalidateQueries({ queryKey: ["history_entries"] });
    toast.success("Agendamento atualizado!");
    if (user) await logHistorico(user.id, "session_event", "Agendamentos", post.content.slice(0, 40), "info", "Agendamento atualizado");
  }, [qc, user]);

  const deletePost = useCallback(async (id: string) => {
    const deleteDestinations = await backend
      .from("scheduled_post_destinations")
      .delete()
      .eq("post_id", id);

    if (deleteDestinations.error) {
      toast.error("Não foi possível remover os destinos do agendamento");
      return;
    }

    const deletePostResult = await backend
      .from("scheduled_posts")
      .delete()
      .eq("id", id);

    if (deletePostResult.error) {
      toast.error("Não foi possível remover o agendamento");
      return;
    }

    qc.invalidateQueries({ queryKey: ["scheduled_posts"] });
    qc.invalidateQueries({ queryKey: ["history_entries"] });
    toast.success("Agendamento removido");
    if (user) await logHistorico(user.id, "session_event", "Agendamentos", `Agendamento #${id.slice(0, 8)}`, "warning", "Agendamento removido");
  }, [qc, user]);

  return { posts, isLoading, createPost, updatePost, deletePost };
}

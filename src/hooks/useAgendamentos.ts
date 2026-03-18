import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { backend } from "@/integrations/backend/client";
import { useAuth } from "@/contexts/AuthContext";
import type { ScheduledPost, RecurrenceType, ScheduledMediaAttachment } from "@/lib/types";
import type { Tables, Json } from "@/integrations/backend/types";
import { toast } from "sonner";
import { logHistorico } from "@/lib/log-historico";
import { resolveEffectiveOperationalLimitsByPlanId } from "@/lib/access-control";

const SCHEDULE_DESTINATIONS_TABLE_WARNING = "Nao foi possivel carregar os destinos dos agendamentos. Os agendamentos foram exibidos sem os grupos vinculados.";

type PostRow = Tables<"scheduled_posts">;
type PostDestRow = Tables<"scheduled_post_destinations">;

type UpsertPostPayload = {
  name?: string;
  content: string;
  scheduledAt: string;
  recurrence: RecurrenceType;
  destinationGroupIds: string[];
  masterGroupIds: string[];
  templateId?: string;
  sessionId?: string;
  weekDays?: string[];
  messageType?: string;
  detectedLinks?: string[];
  finalContent?: string;
  templateData?: Record<string, string>;
  recurrenceTimes?: string[];
  media?: ScheduledMediaAttachment | null;
  imagePolicy?: string;
  scheduleSource?: string;
  productImageUrl?: string;
};

interface PostMeta {
  scheduleName?: string;
  finalContent?: string;
  masterGroupIds?: string[];
  templateId?: string | null;
  templateData?: Record<string, string>;
  sessionId?: string | null;
  weekDays?: string[];
  messageType?: string;
  detectedLinks?: string[];
  recurrenceTimes?: string[];
  media?: ScheduledMediaAttachment | null;
  imagePolicy?: string;
  scheduleSource?: string;
  productImageUrl?: string;
}

function parseScheduledMedia(raw: unknown): ScheduledMediaAttachment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (item.kind !== "image") return null;

  const base64 = typeof item.base64 === "string" ? item.base64 : "";
  if (!base64) return null;

  const mimeType =
    typeof item.mimeType === "string" && item.mimeType.startsWith("image/")
      ? item.mimeType
      : "image/jpeg";

  const fileName =
    typeof item.fileName === "string" && item.fileName.trim()
      ? item.fileName.trim()
      : "schedule_image.jpg";

  return { kind: "image", base64, mimeType, fileName };
}

function parseMeta(raw: Json): PostMeta {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as unknown as PostMeta;
  }
  return {};
}

function parseTemplateData(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) continue;

    if (typeof value === "string") {
      parsed[key] = value;
      continue;
    }

    if (value == null) {
      parsed[key] = "";
      continue;
    }

    parsed[key] = String(value);
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
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
    masterGroupIds: meta.masterGroupIds || [],
    templateId: meta.templateId || null,
    templateData: parseTemplateData(meta.templateData),
    sessionId: meta.sessionId || null,
    recurrence: normalizeRecurrence(String(row.recurrence || "none")),
    weekDays: (meta.weekDays || []) as ScheduledPost["weekDays"],
    messageType: (meta.messageType || "text") as ScheduledPost["messageType"],
    detectedLinks: meta.detectedLinks || [],
    status: row.status as ScheduledPost["status"],
    media: parseScheduledMedia(meta.media),
    imagePolicy: typeof meta.imagePolicy === "string" ? meta.imagePolicy : null,
    scheduleSource: typeof meta.scheduleSource === "string" ? meta.scheduleSource : null,
    productImageUrl: typeof meta.productImageUrl === "string" ? meta.productImageUrl : null,
    createdAt: row.created_at,
  };
}

function buildScheduleMetadata(post: UpsertPostPayload): PostMeta {
  return {
    scheduleName: post.name || post.content.slice(0, 80),
    masterGroupIds: post.masterGroupIds,
    templateId: post.templateId || null,
    sessionId: post.sessionId || null,
    weekDays: post.weekDays || [],
    messageType: post.messageType || "text",
    detectedLinks: post.detectedLinks || [],
    finalContent: post.finalContent || post.content,
    templateData: post.templateData || null,
    recurrenceTimes: post.recurrenceTimes || [],
    media: post.media || null,
    imagePolicy: post.imagePolicy || null,
    scheduleSource: post.scheduleSource || null,
    productImageUrl: post.productImageUrl || null,
  };
}

export function useAgendamentos() {
  const { user, isAdmin } = useAuth();
  const qc = useQueryClient();

  const refreshScheduleQueries = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["scheduled_posts", user?.id] }),
      qc.invalidateQueries({ queryKey: ["history_entries"] }),
    ]);
    await qc.refetchQueries({ queryKey: ["scheduled_posts", user?.id], type: "active" });
  }, [qc, user?.id]);

  const { data: posts = [], isLoading } = useQuery({
    queryKey: ["scheduled_posts", user?.id],
    queryFn: async () => {
      const postsRes = await backend
        .from("scheduled_posts")
        .select("*")
        .order("scheduled_at", { ascending: true });

      if (postsRes.error) throw postsRes.error;

      const postRows = (postsRes.data || []) as PostRow[];
      if (postRows.length === 0) return [] as ScheduledPost[];

      const postIds = postRows.map((row) => row.id);
      const destsRes = await backend
        .from("scheduled_post_destinations")
        .select("*")
        .in("post_id", postIds);

      if (destsRes.error) {
        console.warn("[useAgendamentos]", SCHEDULE_DESTINATIONS_TABLE_WARNING, destsRes.error.message);
        return postRows.map((row) => mapRow(row, []));
      }

      return postRows.map((row) => mapRow(row, (destsRes.data || []) as PostDestRow[]));
    },
    enabled: !!user,
    refetchInterval: () => (document.visibilityState === "visible" ? 30_000 : false),
  });

  const createPost = useCallback(async (post: UpsertPostPayload) => {
    if (!post.content.trim()) {
      toast.error("Preencha o conteudo");
      return null;
    }

    if (!post.scheduledAt) {
      toast.error("Defina a data/hora");
      return null;
    }

    if (post.destinationGroupIds.length === 0 && post.masterGroupIds.length === 0) {
      toast.error("Selecione ao menos um destino");
      return null;
    }

    if (!isAdmin) {
      const { data: profile, error: profileError } = await backend
        .from("profiles")
        .select("plan_id")
        .maybeSingle();

      if (profileError) {
        toast.error("Nao foi possivel validar o limite de agendamentos");
        return null;
      }

      const limits = resolveEffectiveOperationalLimitsByPlanId(profile?.plan_id || "plan-starter");
      const maxSchedules = limits?.schedules ?? 0;
      if (maxSchedules !== -1 && posts.length >= maxSchedules) {
        toast.error("Limite de agendamentos atingido para o seu nivel de acesso.");
        return null;
      }
    }

    const { data, error } = await backend
      .from("scheduled_posts")
      .insert({
        content: post.content,
        scheduled_at: new Date(post.scheduledAt).toISOString(),
        recurrence: post.recurrence,
        status: "pending",
        metadata: buildScheduleMetadata(post),
      })
      .select()
      .single();

    if (error || !data?.id) {
      toast.error("Erro ao criar agendamento");
      return null;
    }

    if (post.destinationGroupIds.length > 0) {
      const destinationsInsert = await backend
        .from("scheduled_post_destinations")
        .insert(post.destinationGroupIds.map((groupId) => ({ post_id: data.id, group_id: groupId })));

      if (destinationsInsert.error) {
        const rollback = await backend.from("scheduled_posts").delete().eq("id", data.id);
        if (rollback.error) {
          toast.error("Falha ao sincronizar destinos. O agendamento pode ter ficado inconsistente.");
        } else {
          toast.error("Nao foi possivel vincular os destinos. O agendamento foi desfeito para manter sincronizacao.");
        }
        return null;
      }
    }

    await refreshScheduleQueries();
    toast.success("Agendamento criado!");

    if (user) {
      const destinationCount = post.destinationGroupIds.length + post.masterGroupIds.length;
      await logHistorico(
        user.id,
        "session_event",
        "Agendamentos",
        post.content.slice(0, 40),
        "info",
        `Agendamento criado para ${destinationCount} destino(s)`,
      );
    }

    return data;
  }, [isAdmin, posts.length, refreshScheduleQueries, user]);

  const updatePost = useCallback(async (id: string, post: UpsertPostPayload) => {
    const [snapshotPostRes, snapshotDestinationsRes] = await Promise.all([
      backend.from("scheduled_posts").select("*").eq("id", id).maybeSingle(),
      backend.from("scheduled_post_destinations").select("*").eq("post_id", id),
    ]);

    const previousPost = (snapshotPostRes.data || null) as PostRow | null;
    const previousDestinations = (snapshotDestinationsRes.data || []) as PostDestRow[];

    if (snapshotPostRes.error || !previousPost) {
      toast.error("Nao foi possivel carregar o agendamento atual");
      return;
    }

    if (snapshotDestinationsRes.error) {
      toast.error("Nao foi possivel carregar os destinos atuais do agendamento");
      return;
    }

    const rollbackToSnapshot = async () => {
      const restorePost = await backend
        .from("scheduled_posts")
        .update({
          content: previousPost.content,
          scheduled_at: previousPost.scheduled_at,
          recurrence: previousPost.recurrence,
          status: previousPost.status,
          metadata: previousPost.metadata,
        })
        .eq("id", id);

      const clearDestinations = await backend
        .from("scheduled_post_destinations")
        .delete()
        .eq("post_id", id);

      if (clearDestinations.error) return false;

      if (previousDestinations.length > 0) {
        const restoreDestinations = await backend
          .from("scheduled_post_destinations")
          .insert(previousDestinations.map((dest) => ({ post_id: id, group_id: dest.group_id })));
        if (restoreDestinations.error) return false;
      }

      return !restorePost.error;
    };

    const updatePostResult = await backend
      .from("scheduled_posts")
      .update({
        content: post.content,
        scheduled_at: new Date(post.scheduledAt).toISOString(),
        recurrence: post.recurrence,
        status: "pending",
        metadata: buildScheduleMetadata(post),
      })
      .eq("id", id);

    if (updatePostResult.error) {
      toast.error("Erro ao atualizar agendamento");
      return;
    }

    const deleteDestinations = await backend
      .from("scheduled_post_destinations")
      .delete()
      .eq("post_id", id);

    if (deleteDestinations.error) {
      const rollbackOk = await rollbackToSnapshot();
      toast.error(
        rollbackOk
          ? "Nao foi possivel atualizar os destinos. O agendamento foi restaurado."
          : "Nao foi possivel atualizar os destinos e o rollback falhou.",
      );
      return;
    }

    if (post.destinationGroupIds.length > 0) {
      const insertDestinations = await backend
        .from("scheduled_post_destinations")
        .insert(post.destinationGroupIds.map((groupId) => ({ post_id: id, group_id: groupId })));

      if (insertDestinations.error) {
        const rollbackOk = await rollbackToSnapshot();
        toast.error(
          rollbackOk
            ? "Nao foi possivel atualizar os destinos. O agendamento foi restaurado."
            : "Nao foi possivel atualizar os destinos e o rollback falhou.",
        );
        return;
      }
    }

    await refreshScheduleQueries();
    toast.success("Agendamento atualizado!");

    if (user) {
      await logHistorico(
        user.id,
        "session_event",
        "Agendamentos",
        post.content.slice(0, 40),
        "info",
        "Agendamento atualizado",
      );
    }
  }, [refreshScheduleQueries, user]);

  const deletePost = useCallback(async (id: string) => {
    const deletePostResult = await backend
      .from("scheduled_posts")
      .delete()
      .eq("id", id);

    if (deletePostResult.error) {
      toast.error("Nao foi possivel remover o agendamento");
      return;
    }

    await refreshScheduleQueries();
    toast.success("Agendamento removido");

    if (user) {
      await logHistorico(
        user.id,
        "session_event",
        "Agendamentos",
        `Agendamento #${id.slice(0, 8)}`,
        "warning",
        "Agendamento removido",
      );
    }
  }, [refreshScheduleQueries, user]);

  return { posts, isLoading, createPost, updatePost, deletePost };
}

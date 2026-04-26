import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { backend } from "@/integrations/backend/client";
import type { Tables } from "@/integrations/backend/types";
import { normalizeShopeeSubId } from "@/lib/shopee-subid";

type ShopeeSubIdRow = Tables<"shopee_sub_ids">;
type ProfileRow = Pick<Tables<"profiles">, "notification_prefs">;

type ShopeeSubIdStorageMode = "table" | "profile-json";

const SHOPEE_SUB_IDS_PROFILE_PREFS_KEY = "shopee_sub_ids";
const SHOPEE_SUB_IDS_PROFILE_PREFS_VERSION = 1;

interface ShopeeSubIdItem {
  id: string;
  value: string;
  isDefault: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

function generateSubIdRecordId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `subid-${Date.now()}-${random}`;
}

function validateShopeeSubIdValue(rawValue: string, normalizedValue: string): string | null {
  if (!normalizedValue && rawValue) {
    return "Use apenas letras e numeros (maximo 80).";
  }
  if (!normalizedValue) return "Informe um Sub ID.";
  return null;
}

function mapShopeeSubIdRow(row: ShopeeSubIdRow): ShopeeSubIdItem {
  return {
    id: String(row.id || "").trim(),
    value: String(row.value || "").trim(),
    isDefault: row.is_default === true,
    createdAt: row.created_at ? String(row.created_at) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null,
  };
}

function isShopeeSubIdsTableMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybe = error as { code?: unknown; message?: unknown };
  const code = String(maybe.code || "").trim();
  if (code === "42P01") return true;

  const message = String(maybe.message || "").toLowerCase();
  const mentionsShopeeSubIds = message.includes("shopee_sub_ids") || message.includes("shopee_sub_id");
  if (!mentionsShopeeSubIds) return false;
  return (
    message.includes("does not exist")
    || message.includes("não existe")
    || message.includes("nao existe")
    || message.includes("not found")
    || message.includes("tabela não encontrada")
    || message.includes("tabela nao encontrada")
  );
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function toSortTimestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeProfileSubIdItems(items: ShopeeSubIdItem[]): ShopeeSubIdItem[] {
  const dedupedByValue = new Set<string>();
  const dedupedById = new Set<string>();
  const normalized: ShopeeSubIdItem[] = [];

  for (const item of items) {
    const value = normalizeShopeeSubId(item.value);
    const rawId = String(item.id || "").trim();
    const id = rawId || generateSubIdRecordId();
    const valueKey = value.toLowerCase();

    if (!value || dedupedById.has(id) || dedupedByValue.has(valueKey)) {
      continue;
    }

    dedupedById.add(id);
    dedupedByValue.add(valueKey);
    normalized.push({
      id,
      value,
      isDefault: item.isDefault === true,
      createdAt: parseIsoOrNull(item.createdAt),
      updatedAt: parseIsoOrNull(item.updatedAt),
    });
  }

  normalized.sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return toSortTimestamp(left.createdAt) - toSortTimestamp(right.createdAt);
  });

  const hasDefault = normalized.some((item) => item.isDefault);
  if (!hasDefault && normalized.length > 0) {
    normalized[0] = { ...normalized[0], isDefault: true };
  }

  return normalized.map((item, index) => {
    if (index === 0 && item.isDefault) return item;
    if (item.isDefault && index > 0) {
      return { ...item, isDefault: false };
    }
    return item;
  });
}

function parseShopeeSubIdsFromProfilePrefs(rawPrefs: unknown): ShopeeSubIdItem[] {
  const prefs = toObjectRecord(rawPrefs);
  const root = prefs[SHOPEE_SUB_IDS_PROFILE_PREFS_KEY];
  const container = toObjectRecord(root);

  const rawItems = Array.isArray(root)
    ? root
    : (Array.isArray(container.items) ? container.items : []);

  const mapped = rawItems
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      id: String(entry.id || "").trim(),
      value: String(entry.value || "").trim(),
      isDefault: entry.is_default === true || entry.isDefault === true,
      createdAt: parseIsoOrNull(entry.created_at ?? entry.createdAt),
      updatedAt: parseIsoOrNull(entry.updated_at ?? entry.updatedAt),
    }));

  return normalizeProfileSubIdItems(mapped);
}

function mergeShopeeSubIdsIntoProfilePrefs(rawPrefs: unknown, items: ShopeeSubIdItem[]): Record<string, unknown> {
  const prefs = toObjectRecord(rawPrefs);
  const normalizedItems = normalizeProfileSubIdItems(items);

  return {
    ...prefs,
    [SHOPEE_SUB_IDS_PROFILE_PREFS_KEY]: {
      version: SHOPEE_SUB_IDS_PROFILE_PREFS_VERSION,
      items: normalizedItems.map((item) => ({
        id: item.id,
        value: item.value,
        is_default: item.isDefault === true,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })),
    },
  };
}

function appendProfileSubId(items: ShopeeSubIdItem[], normalizedValue: string): ShopeeSubIdItem[] {
  const duplicate = items.some((item) => item.value.toLowerCase() === normalizedValue.toLowerCase());
  if (duplicate) {
    throw new Error("Este Sub ID ja esta cadastrado para sua conta.");
  }

  const nowIso = new Date().toISOString();
  const shouldBeDefault = items.length === 0 || !items.some((item) => item.isDefault);
  const next = shouldBeDefault
    ? items.map((item) => ({ ...item, isDefault: false }))
    : [...items];

  next.push({
    id: generateSubIdRecordId(),
    value: normalizedValue,
    isDefault: shouldBeDefault,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  return next;
}

function setProfileDefaultSubId(items: ShopeeSubIdItem[], targetId: string): ShopeeSubIdItem[] {
  if (!items.some((item) => item.id === targetId)) {
    throw new Error("Sub ID invalido.");
  }

  const nowIso = new Date().toISOString();
  return items.map((item) => ({
    ...item,
    isDefault: item.id === targetId,
    updatedAt: item.id === targetId ? nowIso : item.updatedAt,
  }));
}

function removeProfileSubId(items: ShopeeSubIdItem[], targetId: string): { next: ShopeeSubIdItem[]; removed: boolean } {
  const target = items.find((item) => item.id === targetId) || null;
  if (!target) {
    return { next: items, removed: false };
  }

  let next = items.filter((item) => item.id !== targetId);
  if (target.isDefault && next.length > 0) {
    const nowIso = new Date().toISOString();
    next = next.map((item, index) => ({
      ...item,
      isDefault: index === 0,
      updatedAt: index === 0 ? nowIso : item.updatedAt,
    }));
  }

  return { next, removed: true };
}

function extractBackendErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const maybe = error as { code?: unknown; message?: unknown };
  const code = String(maybe.code || "").trim();

  if (code === "23505") {
    return "Este Sub ID ja esta cadastrado para sua conta.";
  }

  const message = typeof maybe.message === "string" ? maybe.message.trim() : "";
  return message || fallback;
}

export function useShopeeSubIds() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const storageModeRef = useRef<ShopeeSubIdStorageMode | null>(null);

  const resolveStorageMode = async (): Promise<ShopeeSubIdStorageMode> => {
    if (!user) throw new Error("Usuario nao autenticado.");
    if (storageModeRef.current) return storageModeRef.current;

    const { error } = await backend
      .from("shopee_sub_ids")
      .select("id")
      .eq("user_id", user.id)
      .limit(1);

    if (error) {
      if (isShopeeSubIdsTableMissingError(error)) {
        storageModeRef.current = "profile-json";
        return "profile-json";
      }
      throw new Error(extractBackendErrorMessage(error, "Falha ao validar armazenamento de Sub IDs Shopee."));
    }

    storageModeRef.current = "table";
    return "table";
  };

  const listSubIdsFromTable = async (): Promise<ShopeeSubIdItem[]> => {
    const { data, error } = await backend
      .from("shopee_sub_ids")
      .select("id, value, is_default, created_at, updated_at")
      .eq("user_id", user!.id)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) {
      if (isShopeeSubIdsTableMissingError(error)) {
        storageModeRef.current = "profile-json";
        return listSubIdsFromProfilePrefs();
      }
      throw new Error(extractBackendErrorMessage(error, "Falha ao listar Sub IDs Shopee."));
    }

    const rows = (data ?? []) as ShopeeSubIdRow[];
    return rows.map(mapShopeeSubIdRow);
  };

  const getProfilePrefsRow = async (): Promise<ProfileRow | null> => {
    const { data, error } = await backend
      .from("profiles")
      .select("notification_prefs")
      .eq("user_id", user!.id)
      .maybeSingle();

    if (error) {
      throw new Error(extractBackendErrorMessage(error, "Falha ao acessar perfil para Sub IDs Shopee."));
    }

    if (!data) return null;
    return data as ProfileRow;
  };

  const listSubIdsFromProfilePrefs = async (): Promise<ShopeeSubIdItem[]> => {
    const profile = await getProfilePrefsRow();
    if (!profile) return [];
    return parseShopeeSubIdsFromProfilePrefs(profile.notification_prefs);
  };

  const saveSubIdsToProfilePrefs = async (items: ShopeeSubIdItem[]): Promise<void> => {
    const profile = await getProfilePrefsRow();
    if (!profile) {
      throw new Error("Perfil do usuario nao encontrado para salvar Sub IDs.");
    }

    const nextPrefs = mergeShopeeSubIdsIntoProfilePrefs(profile.notification_prefs, items);
    const { error } = await backend
      .from("profiles")
      .update({ notification_prefs: nextPrefs })
      .eq("user_id", user!.id);

    if (error) {
      throw new Error(extractBackendErrorMessage(error, "Falha ao salvar Sub IDs Shopee no perfil."));
    }
  };

  const subIdsQuery = useQuery<ShopeeSubIdItem[]>({
    queryKey: ["shopee_sub_ids", user?.id],
    queryFn: async () => {
      const mode = await resolveStorageMode();
      if (mode === "profile-json") {
        return listSubIdsFromProfilePrefs();
      }
      return listSubIdsFromTable();
    },
    enabled: !!user,
  });

  const subIds = subIdsQuery.data ?? [];

  const invalidateSubIds = async () => {
    await queryClient.invalidateQueries({ queryKey: ["shopee_sub_ids", user?.id] });
  };

  const addMutation = useMutation({
    mutationFn: async (input: string) => {
      if (!user) throw new Error("Usuario nao autenticado.");

      const rawValue = String(input || "").trim();
      const normalized = normalizeShopeeSubId(rawValue);
      const validationError = validateShopeeSubIdValue(rawValue, normalized);
      if (validationError) throw new Error(validationError);

      const mode = await resolveStorageMode();
      if (mode === "profile-json") {
        const existing = await listSubIdsFromProfilePrefs();
        const next = appendProfileSubId(existing, normalized);
        await saveSubIdsToProfilePrefs(next);
        return;
      }

      const shouldBeDefault = subIds.length === 0 || !subIds.some((item) => item.isDefault);
      const { error } = await backend
        .from("shopee_sub_ids")
        .insert({
          user_id: user.id,
          value: normalized,
          is_default: shouldBeDefault,
        });

      if (error) {
        if (isShopeeSubIdsTableMissingError(error)) {
          storageModeRef.current = "profile-json";
          const existing = await listSubIdsFromProfilePrefs();
          const next = appendProfileSubId(existing, normalized);
          await saveSubIdsToProfilePrefs(next);
          return;
        }
        throw new Error(extractBackendErrorMessage(error, "Falha ao cadastrar Sub ID."));
      }
    },
    onSuccess: async () => {
      await invalidateSubIds();
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (subIdId: string) => {
      if (!user) throw new Error("Usuario nao autenticado.");
      const targetId = String(subIdId || "").trim();
      if (!targetId) throw new Error("Sub ID invalido.");

      const mode = await resolveStorageMode();
      if (mode === "profile-json") {
        const existing = await listSubIdsFromProfilePrefs();
        const next = setProfileDefaultSubId(existing, targetId);
        await saveSubIdsToProfilePrefs(next);
        return;
      }

      const currentDefault = subIds.find((item) => item.isDefault) || null;
      if (currentDefault?.id === targetId) {
        return;
      }

      const { error: clearError } = await backend
        .from("shopee_sub_ids")
        .update({ is_default: false })
        .eq("user_id", user.id)
        .eq("is_default", true);

      if (clearError) {
        if (isShopeeSubIdsTableMissingError(clearError)) {
          storageModeRef.current = "profile-json";
          const existing = await listSubIdsFromProfilePrefs();
          const next = setProfileDefaultSubId(existing, targetId);
          await saveSubIdsToProfilePrefs(next);
          return;
        }
        throw new Error(extractBackendErrorMessage(clearError, "Falha ao atualizar Sub ID padrao."));
      }

      const { data: updatedRows, error: setError } = await backend
        .from("shopee_sub_ids")
        .update({ is_default: true })
        .eq("user_id", user.id)
        .eq("id", targetId)
        .select("id");

      if (setError || !Array.isArray(updatedRows) || updatedRows.length === 0) {
        if (currentDefault?.id) {
          await backend
            .from("shopee_sub_ids")
            .update({ is_default: true })
            .eq("user_id", user.id)
            .eq("id", currentDefault.id);
        }
        throw new Error(extractBackendErrorMessage(setError, "Nao foi possivel definir este Sub ID como padrao."));
      }
    },
    onSuccess: async () => {
      await invalidateSubIds();
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (subIdId: string) => {
      if (!user) throw new Error("Usuario nao autenticado.");
      const targetId = String(subIdId || "").trim();
      if (!targetId) throw new Error("Sub ID invalido.");

      const mode = await resolveStorageMode();
      if (mode === "profile-json") {
        const existing = await listSubIdsFromProfilePrefs();
        const { next, removed } = removeProfileSubId(existing, targetId);
        if (!removed) return;
        await saveSubIdsToProfilePrefs(next);
        return;
      }

      const target = subIds.find((item) => item.id === targetId) || null;
      if (!target) {
        return;
      }

      const { error: deleteError } = await backend
        .from("shopee_sub_ids")
        .delete()
        .eq("user_id", user.id)
        .eq("id", targetId);

      if (deleteError) {
        if (isShopeeSubIdsTableMissingError(deleteError)) {
          storageModeRef.current = "profile-json";
          const existing = await listSubIdsFromProfilePrefs();
          const { next, removed } = removeProfileSubId(existing, targetId);
          if (!removed) return;
          await saveSubIdsToProfilePrefs(next);
          return;
        }
        throw new Error(extractBackendErrorMessage(deleteError, "Falha ao remover Sub ID."));
      }

      if (!target.isDefault) {
        return;
      }

      const nextDefault = subIds.find((item) => item.id !== targetId) || null;
      if (!nextDefault) {
        return;
      }

      const { error: setError } = await backend
        .from("shopee_sub_ids")
        .update({ is_default: true })
        .eq("user_id", user.id)
        .eq("id", nextDefault.id);

      if (setError) {
        throw new Error(extractBackendErrorMessage(setError, "Sub ID removido, mas nao foi possivel promover um novo padrao."));
      }
    },
    onSuccess: async () => {
      await invalidateSubIds();
    },
  });

  return {
    subIds,
    isLoading: subIdsQuery.isLoading,
    isAdding: addMutation.isPending,
    isSettingDefault: setDefaultMutation.isPending,
    isRemoving: removeMutation.isPending,
    addSubId: addMutation.mutateAsync,
    setDefaultSubId: setDefaultMutation.mutateAsync,
    removeSubId: removeMutation.mutateAsync,
  };
}

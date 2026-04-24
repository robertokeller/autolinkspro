import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, Ban, Calendar, CalendarCheck, CalendarX, CheckCircle2, CreditCard, Edit, FileText, History, Image, Key, Loader2, LogIn, MoreHorizontal, Paperclip, RefreshCw, RotateCcw, Search, Send, Shield, ToggleRight, Trash2, UserPlus, Users, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";
import { Checkbox } from "@/components/ui/checkbox";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import { triggerGlobalResyncPulse } from "@/lib/admin-shared";
import { backend } from "@/integrations/backend/client";
import { formatBRT } from "@/lib/timezone";
import { toast } from "sonner";
import { InlineLoadingState } from "@/components/InlineLoadingState";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
import { useAuth } from "@/contexts/AuthContext";
import type { ManagedPlan } from "@/lib/admin-control-plane";
import { loadAdminSystemObservability, type UserObservabilityRow } from "@/lib/system-observability";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import { getPasswordPolicyError, PASSWORD_POLICY_HINT } from "@/lib/password-policy";
import { ROUTES } from "@/lib/routes";
import { formatPhoneDisplay } from "@/lib/phone-utils";

type UserRole = "admin" | "user";
type AccountStatus = "active" | "inactive" | "blocked" | "archived";
type PlanSyncMode = "auto" | "manual_override";

interface AdminUserRow {
  id: string;
  user_id: string;
  name: string;
  email: string;
  phone: string;
  plan_id: string;
  created_at: string;
  role: UserRole;
  account_status: AccountStatus;
  plan_expires_at: string | null;
  plan_sync_mode?: PlanSyncMode;
  plan_sync_note?: string;
  plan_sync_updated_at?: string | null;
}

function formatExpiry(expiresAt: string | null): { label: string; urgent: boolean; expired: boolean } | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  const msLeft = ms - now;
  const daysLeft = Math.ceil(msLeft / (1_000 * 60 * 60 * 24));
  const label = new Date(ms).toLocaleDateString("pt-BR");
  if (msLeft <= 0) return { label: `Expirado ${label}`, urgent: true, expired: true };
  if (daysLeft <= 7) return { label: `Vence ${label} (${daysLeft}d)`, urgent: true, expired: false };
  return { label: `Válido até ${label}`, urgent: false, expired: false };
}

interface InvokeResult {
  error?: string;
  users?: AdminUserRow[];
  created_user?: AdminUserRow;
}

async function invokeAdmin(body: Record<string, unknown>) {
  const payload = (await invokeBackendRpc<InvokeResult>("admin-users", { body })) || {};
  if (payload.error) throw new Error(payload.error);
  return payload;
}

const STATUS_BADGE: Record<AccountStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  active: { label: "Ativo", variant: "default" },
  inactive: { label: "Inativo", variant: "secondary" },
  blocked: { label: "Bloqueado", variant: "destructive" },
  archived: { label: "Arquivado", variant: "outline" },
};

const AUTO_REFRESH_DEBOUNCE_MS = 250;
const AUTO_REFRESH_MIN_INTERVAL_MS = 10_000;

export default function AdminUsers() {
  const { state: controlPlane } = useAdminControlPlane();
  const { user: currentUser } = useAuth();
  const navigate = useNavigate();
  const [userList, setUserList] = useState<AdminUserRow[]>([]);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());

  const [editUser, setEditUser] = useState<AdminUserRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editRole, setEditRole] = useState<UserRole>("user");
  const [editStatus, setEditStatus] = useState<AccountStatus>("active");
  const [savingEdit, setSavingEdit] = useState(false);

  const [openCreate, setOpenCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPhone, setCreatePhone] = useState("");

  const [extendPlanTarget, setExtendPlanTarget] = useState<AdminUserRow | null>(null);
  const [extendingPlan, setExtendingPlan] = useState(false);

  const [billingNoteUser, setBillingNoteUser] = useState<AdminUserRow | null>(null);
  const [billingNoteType, setBillingNoteType] = useState<"refund" | "credit" | "note">("refund");
  const [billingNoteAmount, setBillingNoteAmount] = useState("");
  const [billingNoteReason, setBillingNoteReason] = useState("");
  const [savingBillingNote, setSavingBillingNote] = useState(false);

  // Plan Manager dialog
  const [planManagerUser, setPlanManagerUser] = useState<AdminUserRow | null>(null);
  const [pmPlanId, setPmPlanId] = useState("");
  const [pmExpiryDate, setPmExpiryDate] = useState(""); // YYYY-MM-DD
  const [pmPlanSyncMode, setPmPlanSyncMode] = useState<PlanSyncMode>("auto");
  const [pmNewPassword, setPmNewPassword] = useState("");
  const [pmShowPassword, setPmShowPassword] = useState(false);
  const [savingPlanManager, setSavingPlanManager] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<UserRole>("user");
  const [savingCreate, setSavingCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminUserRow | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);
  const [blockTarget, setBlockTarget] = useState<AdminUserRow | null>(null);
  const [showAdminPromotionConfirm, setShowAdminPromotionConfirm] = useState(false);
  // WhatsApp contact dialog
  const [waContactUser, setWaContactUser] = useState<AdminUserRow | null>(null);
  const [waMessage, setWaMessage] = useState("");
  const [sendingWaMessage, setSendingWaMessage] = useState(false);
  const [waMedia, setWaMedia] = useState<{ base64: string; mimeType: string; fileName: string } | null>(null);
  const waFileInputRef = useRef<HTMLInputElement>(null);

  // Bulk WhatsApp broadcast dialog
  const [showBulkWaDialog, setShowBulkWaDialog] = useState(false);
  const [bulkWaMessage, setBulkWaMessage] = useState("");
  const [bulkWaMedia, setBulkWaMedia] = useState<{ base64: string; mimeType: string; fileName: string } | null>(null);
  const [sendingBulkWa, setSendingBulkWa] = useState(false);
  const bulkWaFileInputRef = useRef<HTMLInputElement>(null);

  // ── Bulk status dialog ──────────────────────────────────────────────────────
  const [showBulkStatusDialog, setShowBulkStatusDialog] = useState(false);
  const [bulkStatusValue, setBulkStatusValue] = useState<AccountStatus>("active");
  const [applyingBulkStatus, setApplyingBulkStatus] = useState(false);

  // ── Bulk plan dialog ────────────────────────────────────────────────────────
  const [showBulkPlanDialog, setShowBulkPlanDialog] = useState(false);
  const [bulkPlanId, setBulkPlanId] = useState("");
  const [applyingBulkPlan, setApplyingBulkPlan] = useState(false);

  // ── Plan history dialog ─────────────────────────────────────────────────────
  interface PlanLogEntry { id: string; createdAt: string; actorName: string; action: string; summary: string }
  const [planHistoryUser, setPlanHistoryUser] = useState<AdminUserRow | null>(null);
  const [planHistoryLogs, setPlanHistoryLogs] = useState<PlanLogEntry[]>([]);
  const [planHistoryLoading, setPlanHistoryLoading] = useState(false);

  // ── Impersonate ─────────────────────────────────────────────────────────────
  const [impersonateLoading, setImpersonateLoading] = useState<string | null>(null);

  const [userUsageMap, setUserUsageMap] = useState<Record<string, UserObservabilityRow["usage"]>>({});
  const [usageSummary, setUsageSummary] = useState({
    usersActive: 0,
    routesTotal: 0,
    automationsTotal: 0,
    groupsTotal: 0,
    waSessionsTotal: 0,
    tgSessionsTotal: 0,
    errors24h: 0,
  });
  const initialLoadDoneRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const autoRefreshTimerRef = useRef<number | null>(null);
  const lastAutoRefreshAtRef = useRef(0);

  const planCatalog = useMemo(() => {
    return controlPlane.plans;
  }, [controlPlane.plans]);

  const activePlans = useMemo(() => {
    const active = controlPlane.plans.filter((plan) => plan.isActive);
    return active.length > 0 ? active : controlPlane.plans;
  }, [controlPlane.plans]);

  const defaultSignupPlan = useMemo(() => {
    const byId = planCatalog.find((plan) => plan.id === controlPlane.defaultSignupPlanId);
    return byId || activePlans[0] || planCatalog[0] || null;
  }, [activePlans, controlPlane.defaultSignupPlanId, planCatalog]);

  const resolveAssignablePlans = (currentPlanId: string): ManagedPlan[] => {
    if (activePlans.some((plan) => plan.id === currentPlanId)) return activePlans;
    const current = planCatalog.find((plan) => plan.id === currentPlanId);
    return current ? [current, ...activePlans] : activePlans;
  };

  const getAccessLevelNameFromPlan = (planId: string) => {
    const plan = planCatalog.find((item) => item.id === planId);
    if (!plan) return "Nível não achado";
    return controlPlane.accessLevels.find((level) => level.id === plan.accessLevelId)?.name || "Nível não achado";
  };

  const loadData = useCallback(async (options?: { silent?: boolean; includeObservability?: boolean }) => {
    const silent = options?.silent ?? false;
    const includeObservability = options?.includeObservability ?? true;

    if (loadInFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }

    loadInFlightRef.current = true;
    if (!silent && !initialLoadDoneRef.current) {
      setLoading(true);
    }

    try {
      const usersPromise = invokeAdmin({ action: "list_users" });
      const observabilityPromise = includeObservability
        ? loadAdminSystemObservability().catch(() => null)
        : Promise.resolve(null);

      const usersRes = await usersPromise;
      const rows = (usersRes.users || []).map((row) => ({
        ...row,
        plan_sync_mode: row.plan_sync_mode === "manual_override" ? "manual_override" : "auto",
        plan_sync_note: String(row.plan_sync_note ?? ""),
        plan_sync_updated_at: row.plan_sync_updated_at ?? null,
      }));
      setUserList(rows);

      if (!initialLoadDoneRef.current) {
        initialLoadDoneRef.current = true;
        setLoading(false);
      }

      const observabilityRes = await observabilityPromise;
      if (!observabilityRes) {
        lastAutoRefreshAtRef.current = Date.now();
        return;
      }

      const usersObs = Array.isArray(observabilityRes?.users) ? observabilityRes.users : [];
      const usageByUserId: Record<string, UserObservabilityRow["usage"]> = {};
      for (const row of usersObs) {
        usageByUserId[String(row.user_id || "")] = row.usage;
      }
      setUserUsageMap(usageByUserId);

      const global = observabilityRes?.global;
      setUsageSummary({
        usersActive: Number(global?.usersActive || 0),
        routesTotal: Number(global?.routesTotal || 0),
        automationsTotal: Number(global?.automationsTotal || 0),
        groupsTotal: Number(global?.groupsTotal || 0),
        waSessionsTotal: Number(global?.waSessionsTotal || 0),
        tgSessionsTotal: Number(global?.tgSessionsTotal || 0),
        errors24h: Number(global?.errors24h || 0),
      });

      lastAutoRefreshAtRef.current = Date.now();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra carregar os dados");
    } finally {
      if (!initialLoadDoneRef.current) {
        initialLoadDoneRef.current = true;
        setLoading(false);
      }
      loadInFlightRef.current = false;
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        void loadData({ silent: true, includeObservability: false });
      }
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const scheduleAutoRefresh = () => {
      if (autoRefreshTimerRef.current !== null) {
        window.clearTimeout(autoRefreshTimerRef.current);
      }

      autoRefreshTimerRef.current = window.setTimeout(() => {
        const now = Date.now();
        if (now - lastAutoRefreshAtRef.current < AUTO_REFRESH_MIN_INTERVAL_MS) {
          return;
        }
        void loadData({ silent: true, includeObservability: false });
      }, AUTO_REFRESH_DEBOUNCE_MS);
    };

    const unsubscribe = subscribeLocalDbChanges(scheduleAutoRefresh);

    window.addEventListener("focus", scheduleAutoRefresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", scheduleAutoRefresh);
      if (autoRefreshTimerRef.current !== null) {
        window.clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [loadData]);

  const filtered = useMemo(() => {
    const term = search.toLowerCase().trim();
    const statusFiltered = showArchived
      ? userList.filter((user) => user.account_status === "archived")
      : userList.filter((user) => user.account_status !== "archived");

    if (!term) return statusFiltered;
    return statusFiltered.filter(
      (user) =>
        user.name.toLowerCase().includes(term) ||
        user.email.toLowerCase().includes(term) ||
        (user.phone || "").includes(term) ||
        user.plan_id.toLowerCase().includes(term) ||
        user.role.toLowerCase().includes(term) ||
        user.account_status.toLowerCase().includes(term),
    );
  }, [search, showArchived, userList]);

  const archivedCount = useMemo(
    () => userList.filter((user) => user.account_status === "archived").length,
    [userList],
  );

  const handleOpenEdit = (user: AdminUserRow) => {
    setEditUser(user);
    setEditName(user.name || "");
    setEditEmail(user.email || "");
    setEditPhone(user.phone || "");
    setEditRole(user.role);
    setEditStatus(user.account_status || "active");
  };

  const doActualSave = async () => {
    if (!editUser) return;
    setSavingEdit(true);
    try {
      await invokeAdmin({
        action: "update_user",
        user_id: editUser.user_id,
        name: editName,
        email: editEmail,
        phone: editPhone,
        role: editRole,
        account_status: editStatus,
      });
      toast.success(`Usuário ${editUser.email} atualizado`);
      setEditUser(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra atualizar o usuário");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editUser) return;
    if (!editEmail.trim()) {
      toast.error("Forneça um e-mail válido");
      return;
    }

    if (editRole === "admin" && editUser.role !== "admin") {
      setShowAdminPromotionConfirm(true);
      return;
    }

    await doActualSave();
  };

  const handleCreateUser = async () => {
    if (!createEmail || !createPassword) {
      toast.error("Forneça e-mail e senha");
      return;
    }
    const createPasswordError = getPasswordPolicyError(createPassword.trim());
    if (createPasswordError) {
      toast.error(createPasswordError);
      return;
    }
    setSavingCreate(true);
    try {
      const result = await invokeAdmin({
        action: "create_user",
        name: createName,
        email: createEmail,
        phone: createPhone,
        password: createPassword,
        role: createRole,
      });
      const created = result.created_user;
      const roleOk = created?.role === createRole;
      const statusOk = created?.account_status === "active";

      if (created && roleOk && statusOk) {
        toast.success(`Usuário ${createEmail} criado com perfil ${createRole === "admin" ? "Administrador" : "Comum"}`);
      } else {
        toast.warning("Criado, mas confere os dados na lista.");
      }

      setOpenCreate(false);
      setCreateName("");
      setCreateEmail("");
      setCreatePhone("");
      setCreatePassword("");
      setCreateRole("user");
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra criar o usuário");
    } finally {
      setSavingCreate(false);
    }
  };

  const confirmBlock = async () => {
    if (!blockTarget) return;
    const user = blockTarget;
    setBlockTarget(null);
    try {
      await invokeAdmin({ action: "set_status", user_id: user.user_id, account_status: "blocked" });
      toast.success("Usuário bloqueado");
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra bloquear");
    }
  };

  const runUserLifecycleAction = async (user: AdminUserRow, action: "activate" | "inactivate" | "block" | "archive" | "restore") => {
    if (action === "block") {
      if (user.user_id === currentUser?.id) {
        toast.error("Você não pode bloquear a si mesmo");
        return;
      }
      setBlockTarget(user);
      return;
    }
    try {
      if (action === "archive") {
        await invokeAdmin({ action: "archive_user", user_id: user.user_id });
        toast.success("Usuário arquivado");
      } else if (action === "restore") {
        await invokeAdmin({ action: "restore_user", user_id: user.user_id });
        toast.success("Usuário restaurado");
      } else {
        const accountStatus = action === "activate" ? "active" : action === "inactivate" ? "inactive" : "blocked";
        await invokeAdmin({ action: "set_status", user_id: user.user_id, account_status: accountStatus });
        toast.success("Status atualizado");
      }
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra fazer essa ação");
    }
  };

  const handleExtendPlan = async () => {
    if (!extendPlanTarget || extendingPlan) return;
    if (extendPlanTarget.role === "admin") {
      toast.error("Conta admin não possui plano para renovação");
      setExtendPlanTarget(null);
      return;
    }
    setExtendingPlan(true);
    try {
      await invokeAdmin({ action: "extend_plan", user_id: extendPlanTarget.user_id });
      toast.success(`Plano de ${extendPlanTarget.email} renovado com sucesso`);
      setExtendPlanTarget(null);
      await loadData();
      triggerGlobalResyncPulse("admin-users-extend-plan");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra renovar o plano");
    } finally {
      setExtendingPlan(false);
    }
  };

  const handleSaveBillingNote = async () => {
    if (!billingNoteUser || savingBillingNote) return;
    if (!billingNoteReason.trim()) {
      toast.error("Forneça o motivo");
      return;
    }
    if ((billingNoteType === "refund" || billingNoteType === "credit") && Number(billingNoteAmount) <= 0) {
      toast.error("Forneça um valor maior que zero");
      return;
    }
    setSavingBillingNote(true);
    try {
      await invokeAdmin({
        action: "add_billing_note",
        user_id: billingNoteUser.user_id,
        note_type: billingNoteType,
        amount: billingNoteType === "note" ? 0 : Number(billingNoteAmount),
        reason: billingNoteReason.trim(),
      });
      const typeLabel = billingNoteType === "refund" ? "Reembolso" : billingNoteType === "credit" ? "Crédito" : "Nota";
      toast.success(`${typeLabel} registrado para ${billingNoteUser.email}`);
      setBillingNoteUser(null);
      setBillingNoteAmount("");
      setBillingNoteReason("");
      setBillingNoteType("refund");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra registrar");
    } finally {
      setSavingBillingNote(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deletingUser) return;
    setDeletingUser(true);
    try {
      await invokeAdmin({ action: "delete_user", user_id: deleteTarget.user_id });
      toast.success("Usuário apagado");
      setDeleteTarget(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra apagar");
    } finally {
      setDeletingUser(false);
    }
  };

  const handleOpenPlanManager = (user: AdminUserRow) => {
    setPlanManagerUser(user);
    setPmPlanId(user.role === "admin" ? "" : user.plan_id);
    setPmPlanSyncMode(user.role === "admin" ? "auto" : (user.plan_sync_mode ?? "auto"));
    setPmNewPassword("");
    setPmShowPassword(false);
    if (user.role === "admin") {
      setPmExpiryDate("");
    } else if (user.plan_expires_at) {
      const d = new Date(user.plan_expires_at);
      setPmExpiryDate(Number.isFinite(d.getTime()) ? d.toISOString().split("T")[0] : "");
    } else {
      setPmExpiryDate("");
    }
  };

  const pmAddDays = (days: number) => {
    const baseMs = pmExpiryDate
      ? (() => {
          const d = new Date(pmExpiryDate + "T12:00:00");
          return d.getTime() > Date.now() ? d.getTime() : Date.now();
        })()
      : Date.now();
    const newDate = new Date(baseMs + days * 24 * 60 * 60 * 1000);
    setPmExpiryDate(newDate.toISOString().split("T")[0]);
  };

  const pmRenewByPeriod = () => {
    if (!planManagerUser) return;
    if (planManagerUser.role === "admin") return;
    const currentPlanId = pmPlanId || planManagerUser.plan_id;
    const plan = planCatalog.find((p) => p.id === currentPlanId);
    if (!plan) return;
    const periodMatch = String(plan.period || "").match(/(\d+)/);
    const periodDays = periodMatch ? Number(periodMatch[1]) : 30;
    pmAddDays(periodDays);
  };

  const handleSavePlanManager = async () => {
    if (!planManagerUser || savingPlanManager) return;
    setSavingPlanManager(true);
    try {
      if (planManagerUser.role !== "admin") {
        const targetPlanId = pmPlanId || planManagerUser.plan_id;
        const planChanged = targetPlanId !== planManagerUser.plan_id;
        if (planChanged) {
          await invokeAdmin({ action: "update_plan", user_id: planManagerUser.user_id, plan_id: targetPlanId });
        }

        const originalExpiry = planManagerUser.plan_expires_at
          ? new Date(planManagerUser.plan_expires_at).toISOString().split("T")[0]
          : "";
        if (pmExpiryDate !== originalExpiry) {
          const expiresAt = pmExpiryDate
            ? new Date(pmExpiryDate + "T23:59:59").toISOString()
            : null;
          await invokeAdmin({ action: "set_plan_expiry", user_id: planManagerUser.user_id, expires_at: expiresAt });
        }

        const originalSyncMode: PlanSyncMode = planManagerUser.plan_sync_mode ?? "auto";
        const changedLocally = planChanged || pmExpiryDate !== originalExpiry;
        const nextSyncMode: PlanSyncMode = changedLocally
          ? "manual_override"
          : pmPlanSyncMode;
        if (nextSyncMode !== originalSyncMode || changedLocally) {
          await invokeAdmin({
            action: "set_plan_sync_mode",
            user_id: planManagerUser.user_id,
            mode: nextSyncMode,
            reason: changedLocally ? "admin_plan_manager_local_change" : "admin_plan_manager_mode_change",
          });
        }
      }

      if (pmNewPassword.trim()) {
        const resetPasswordError = getPasswordPolicyError(pmNewPassword.trim());
        if (resetPasswordError) {
          toast.error(resetPasswordError);
          setSavingPlanManager(false);
          return;
        }
        await invokeAdmin({ action: "reset_password", user_id: planManagerUser.user_id, password: pmNewPassword.trim() });
        toast.success("Senha trocada!");
      }

      toast.success(`Dados de ${planManagerUser.email} atualizados`);
      setPlanManagerUser(null);
      await loadData();
      triggerGlobalResyncPulse("admin-users-plan-change");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra salvar");
    } finally {
      setSavingPlanManager(false);
    }
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedUsers.size === filtered.length && filtered.length > 0) {
      setSelectedUsers(new Set());
    } else {
      setSelectedUsers(new Set(filtered.map((u) => u.user_id)));
    }
  };

  const handleBulkWhatsApp = () => {
    if (selectedUsers.size === 0) return;
    setBulkWaMessage("");
    setBulkWaMedia(null);
    setShowBulkWaDialog(true);
  };

  const readFileAsBase64 = (file: File): Promise<{ base64: string; mimeType: string; fileName: string }> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        // strip the data URL prefix
        const idx = result.indexOf(",");
        const base64 = idx >= 0 ? result.slice(idx + 1) : result;
        resolve({ base64, mimeType: file.type || "image/jpeg", fileName: file.name });
      };
      reader.onerror = () => reject(new Error("Falha ao ler arquivo"));
      reader.readAsDataURL(file);
    });

  // Only raster image types — SVG excluded (can embed scripts).
  const ALLOWED_WA_MEDIA_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

  const handleWaFileSelect = async (e: React.ChangeEvent<HTMLInputElement>, target: "single" | "bulk") => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_WA_MEDIA_MIME.has(file.type)) {
      toast.error("Formato não suportado. Use PNG, JPG, WebP ou GIF.");
      e.target.value = "";
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Arquivo muito grande. Máximo 10 MB.");
      e.target.value = "";
      return;
    }
    try {
      const media = await readFileAsBase64(file);
      if (target === "single") setWaMedia(media);
      else setBulkWaMedia(media);
    } catch {
      toast.error("Não foi possível carregar o arquivo");
    }
    e.target.value = "";
  };

  const handleSendBulkWhatsApp = async () => {
    if (sendingBulkWa || (!bulkWaMessage.trim() && !bulkWaMedia)) return;
    const ids = Array.from(selectedUsers);
    if (ids.length === 0) return;
    setSendingBulkWa(true);
    try {
      const res = await invokeBackendRpc<{ sent?: number; failed?: number; status?: string; error?: string }>("admin-wa-broadcast", {
        body: {
          action: "send",
          message: bulkWaMessage.trim(),
          filterUserIds: ids,
          filterPlan: [],
          filterStatus: "all",
          ...(bulkWaMedia ? { media: bulkWaMedia } : {}),
        },
      });
      if ((res as { error?: string })?.error) throw new Error((res as { error?: string }).error);
      const sent = res?.sent ?? 0;
      const failed = res?.failed ?? 0;
      if (failed === 0) toast.success(`WhatsApp enviado para ${sent} usuário${sent !== 1 ? "s" : ""}.`);
      else toast.warning(`Enviado para ${sent}, ${failed} falha${failed !== 1 ? "s" : ""}.`);
      setShowBulkWaDialog(false);
      setSelectedUsers(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível enviar o broadcast");
    } finally {
      setSendingBulkWa(false);
    }
  };

  const handleSendWhatsAppMessage = async () => {
    if (!waContactUser || sendingWaMessage || (!waMessage.trim() && !waMedia)) return;
    setSendingWaMessage(true);
    try {
      await invokeAdmin({
        action: "send_whatsapp_contact",
        user_id: waContactUser.user_id,
        phone: waContactUser.phone,
        message: waMessage.trim(),
        ...(waMedia ? { media: waMedia } : {}),
      });
      toast.success(`Mensagem enviada para ${waContactUser.name || waContactUser.phone}`);
      setWaContactUser(null);
      setWaMessage("");
      setWaMedia(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível enviar a mensagem");
    } finally {
      setSendingWaMessage(false);
    }
  };

  // ── Bulk status change ──────────────────────────────────────────────────────
  const handleBulkChangeStatus = async () => {
    const ids = Array.from(selectedUsers);
    if (!ids.length || !bulkStatusValue || applyingBulkStatus) return;
    setApplyingBulkStatus(true);
    try {
      await Promise.all(
        ids.map((id) => invokeAdmin({ action: "set_status", user_id: id, account_status: bulkStatusValue })),
      );
      const label = STATUS_BADGE[bulkStatusValue]?.label || bulkStatusValue;
      toast.success(`${ids.length} usuário${ids.length !== 1 ? "s" : ""} marcado${ids.length !== 1 ? "s" : ""} como "${label}"`);
      setShowBulkStatusDialog(false);
      setSelectedUsers(new Set());
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra alterar status em massa");
    } finally {
      setApplyingBulkStatus(false);
    }
  };

  // ── Bulk plan assignment ────────────────────────────────────────────────────
  const handleBulkAssignPlan = async () => {
    const ids = Array.from(selectedUsers);
    if (!ids.length || !bulkPlanId || applyingBulkPlan) return;
    setApplyingBulkPlan(true);
    try {
      await Promise.all(
        ids.map((id) => invokeAdmin({ action: "update_plan", user_id: id, plan_id: bulkPlanId })),
      );
      const planName = planCatalog.find((p) => p.id === bulkPlanId)?.name || bulkPlanId;
      toast.success(`Plano "${planName}" aplicado para ${ids.length} usuário${ids.length !== 1 ? "s" : ""}`);
      setShowBulkPlanDialog(false);
      setSelectedUsers(new Set());
      await loadData();
      triggerGlobalResyncPulse("admin-users-bulk-plan");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra atribuir plano em massa");
    } finally {
      setApplyingBulkPlan(false);
    }
  };

  // ── Plan history ────────────────────────────────────────────────────────────
  const handleLoadPlanHistory = async (user: AdminUserRow) => {
    setPlanHistoryUser(user);
    setPlanHistoryLoading(true);
    setPlanHistoryLogs([]);
    try {
      const [auditRes, usersRes] = await Promise.all([
        backend
          .from("admin_audit_logs")
          .select("id, created_at, user_id, action, details")
          .eq("target_user_id", user.user_id)
          .in("action", ["update_plan", "set_plan_expiry", "set_plan_sync_mode", "extend_plan", "update_user"])
          .order("created_at", { ascending: false })
          .limit(30),
        invokeAdmin({ action: "list_users" }),
      ]);
      const userMap = new Map<string, { name: string; email: string }>(
        (usersRes.users || []).map((u: AdminUserRow) => [u.user_id, { name: u.name, email: u.email }]),
      );
      const ACTION_LABELS: Record<string, string> = {
        update_plan: "Plano alterado",
        set_plan_expiry: "Vencimento ajustado",
        set_plan_sync_mode: "Sincronia Kiwify",
        extend_plan: "Plano renovado",
        update_user: "Dados atualizado",
      };
      const rows = (auditRes.data || []).map((row) => {
        const actor = userMap.get(String(row.user_id || "")) || { name: "Admin", email: "" };
        const details = (row.details && typeof row.details === "object" ? row.details : {}) as Record<string, unknown>;
        let summary = "";
        const action = String(row.action || "");
        if (action === "update_plan") {
          const from = String(details.old_plan_id || details.from_plan || "-");
          const to = String(details.plan_id || details.to_plan || details.new_plan_id || "-");
          summary = `De "${from}" → "${to}"`;
        } else if (action === "set_plan_expiry") {
          const expiresAt = String(details.expires_at || details.expiry || "-");
          summary = expiresAt === "null" || expiresAt === "-" ? "Vencimento removido" : `Vencimento: ${new Date(expiresAt).toLocaleDateString("pt-BR")}`;
        } else if (action === "set_plan_sync_mode") {
          summary = String(details.mode || "auto") === "manual_override" ? "Sobrescrita manual ativada" : "Sincronização automática ativada";
        } else if (action === "extend_plan") {
          summary = "Plano renovado por mais um período";
        } else {
          summary = "Dados do usuário atualizados";
        }
        return {
          id: String(row.id),
          createdAt: String(row.created_at),
          actorName: actor.name || "Admin",
          action: ACTION_LABELS[action] || action,
          summary,
        };
      });
      setPlanHistoryLogs(rows);
    } catch {
      toast.error("Não foi possível carregar o histórico");
    } finally {
      setPlanHistoryLoading(false);
    }
  };

  // ── Impersonate ─────────────────────────────────────────────────────────────
  const handleImpersonate = async (user: AdminUserRow) => {
    if (impersonateLoading) return;
    setImpersonateLoading(user.user_id);
    try {
      const res = await invokeBackendRpc<{
        ok?: boolean;
        redirect_url?: string;
        token?: string;
        error?: string;
      }>("admin-users", { body: { action: "impersonate_user", user_id: user.user_id } });
      if (res?.error) throw new Error(res.error);
      if (res?.redirect_url) {
        // Security: validate protocol before opening to prevent open redirect via javascript: etc.
        const parsed = (() => {
          try {
            return new URL(res.redirect_url, window.location.origin);
          } catch {
            return null;
          }
        })();
        if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
          toast.error("URL de redirecionamento inválida recebida do servidor.");
        } else {
          toast.success("Abrindo sessão de impersonação…");
          window.open(parsed.toString(), "_blank", "noopener,noreferrer");
        }
      } else if (res?.token) {
        toast.error("Resposta inválida do servidor para Entrar como.");
      } else {
        toast.error("Resposta inesperada do servidor ao iniciar Entrar como.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro desconhecido";
      if (/unknown action|not supported|invalid action|aç[aã]o administrativa inv[aá]lida|opç[aã]o administrativa inv[aá]lida|acao administrativa invalida|opcao administrativa invalida/i.test(msg)) {
        toast.info("Entrar como ainda não está disponível no backend.");
      } else {
        toast.error(msg);
      }
    } finally {
      setImpersonateLoading(null);
    }
  };

  const statusBadge = (status: AccountStatus) => {
    const { label, variant } = STATUS_BADGE[status] ?? { label: status, variant: "outline" as const };
    return <Badge variant={variant} className="text-xs">{label}</Badge>;
  };

  return (
    <div className="admin-page">
      <PageHeader title="Usuários" description="Gerencie usuários, planos e status das contas" />

      <div className="admin-toolbar border-primary/30 bg-primary/5 text-center text-xs text-primary sm:text-left">
        Plano Padrão de Cadastro: <strong>{defaultSignupPlan?.name || "Não definido"}</strong>
        {defaultSignupPlan ? ` (nível: ${getAccessLevelNameFromPlan(defaultSignupPlan.id)})` : ""}
      </div>

      <div className="admin-toolbar">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar usuário..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
          />
        </div>
        <Badge variant="outline" className="text-xs">
          {filtered.length} usuário{filtered.length !== 1 ? "s" : ""}
        </Badge>
        <Button
          variant={showArchived ? "default" : "outline"}
          className="gap-2"
          onClick={() => setShowArchived((prev) => !prev)}
        >
          <Archive className="h-4 w-4" />
          {showArchived ? "Ver Ativos" : `Ver Arquivados (${archivedCount})`}
        </Button>
        <Button onClick={() => setOpenCreate(true)} className="gap-2">
          <UserPlus className="h-4 w-4" />
          Criar Usuário
        </Button>
      </div>

      <div className="admin-toolbar border-dashed justify-start gap-1.5">
        <span className="text-xs text-muted-foreground mr-1">Sistema:</span>
        <Badge variant="outline" className="admin-chip">Ativos: <strong className="ml-1 text-foreground">{usageSummary.usersActive}</strong></Badge>
        <Badge variant="outline" className="admin-chip">Rotas: <strong className="ml-1 text-foreground">{usageSummary.routesTotal}</strong></Badge>
        <Badge variant="outline" className="admin-chip">Automações: <strong className="ml-1 text-foreground">{usageSummary.automationsTotal}</strong></Badge>
        <Badge variant="outline" className="admin-chip">Grupos: <strong className="ml-1 text-foreground">{usageSummary.groupsTotal}</strong></Badge>
        <Badge variant="outline" className="admin-chip">WA: <strong className="ml-1 text-foreground">{usageSummary.waSessionsTotal}</strong></Badge>
        <Badge variant="outline" className="admin-chip">TG: <strong className="ml-1 text-foreground">{usageSummary.tgSessionsTotal}</strong></Badge>
        <Badge variant={usageSummary.errors24h > 0 ? "destructive" : "secondary"} className="admin-chip">Erros 24h: <strong className="ml-1">{usageSummary.errors24h}</strong></Badge>
      </div>

      {selectedUsers.size > 0 && (
        <div className="admin-toolbar border-green-500/30 bg-green-50/50 dark:bg-green-950/20 justify-between">
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <Checkbox
              checked={selectedUsers.size === filtered.length && filtered.length > 0}
              onCheckedChange={toggleSelectAll}
              className="data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600"
            />
            <span className="font-medium">
              {selectedUsers.size} {selectedUsers.size === 1 ? "usuário selecionado" : "usuários selecionados"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-muted-foreground"
              onClick={() => setSelectedUsers(new Set())}
            >
              Limpar seleção
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => { setBulkStatusValue("active"); setShowBulkStatusDialog(true); }}
            >
              <ToggleRight className="h-3.5 w-3.5" />
              Mudar Status
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => { setBulkPlanId(activePlans[0]?.id || ""); setShowBulkPlanDialog(true); }}
            >
              <CreditCard className="h-3.5 w-3.5" />
              Atribuir Plano
            </Button>
            <Button
              size="sm"
              className="gap-1.5 bg-green-600 text-white hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
              onClick={handleBulkWhatsApp}
            >
              <WhatsAppIcon className="h-3.5 w-3.5" />
              Enviar via WhatsApp ({selectedUsers.size})
            </Button>
          </div>
        </div>
      )}

      <Card className="admin-card">
        <CardContent className="p-0">
          <div className="divide-y">
            {!loading && filtered.length > 0 && (
              <div className="flex items-center gap-3 px-4 py-2 border-b bg-muted/20">
                <Checkbox
                  checked={selectedUsers.size === filtered.length && filtered.length > 0}
                  onCheckedChange={toggleSelectAll}
                  className="data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600"
                />
                <span className="text-xs text-muted-foreground">
                  {selectedUsers.size === 0
                    ? "Selecionar todos"
                    : selectedUsers.size === filtered.length
                      ? "Desmarcar todos"
                      : `${selectedUsers.size} de ${filtered.length} selecionados`}
                </span>
              </div>
            )}
            {loading && (
              <div className="p-6">
                <InlineLoadingState label="Carregando..." />
              </div>
            )}
            {!loading && filtered.map((user) => {
              const usage = userUsageMap[user.user_id];
              const expiry = formatExpiry(user.plan_expires_at ?? null);
              const lim = resolveEffectiveLimitsByPlanId(user.plan_id);
              const fmt = (used: number, max: number) => max === -1 ? String(used) : `${used}/${max}`;
              return (
                <div
                  key={user.user_id}
                  className={`grid grid-cols-[auto_1fr_auto] items-start gap-3 px-4 py-3.5 transition-colors hover:bg-secondary/30 ${selectedUsers.has(user.user_id) ? "bg-green-50/30 dark:bg-green-950/10" : ""}`}
                >
                  {/* Checkbox */}
                  <Checkbox
                    checked={selectedUsers.has(user.user_id)}
                    onCheckedChange={() => toggleUserSelection(user.user_id)}
                    className="mt-1 shrink-0 data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600"
                  />

                  {/* Identity + metadata */}
                  <div className="min-w-0 space-y-1">
                    {/* Name + role + status */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium leading-none">{user.name || "Sem nome"}</span>
                      {statusBadge(user.account_status || "active")}
                      <Badge variant={user.role === "admin" ? "destructive" : "secondary"} className="admin-chip">
                        {user.role === "admin" ? "Admin" : "Usuário"}
                      </Badge>
                    </div>
                    {/* Email */}
                    <p className="text-xs text-muted-foreground">{user.email}</p>
                    {/* Phone */}
                    {user.phone && (
                      <p className="text-xs text-muted-foreground/70 tabular-nums">{formatPhoneDisplay(user.phone)}</p>
                    )}
                    {/* Plan + access + expiry */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <Badge variant="outline" className="admin-chip">
                        {user.role === "admin" ? "Sem plano" : (planCatalog.find((p) => p.id === user.plan_id)?.name || user.plan_id)}
                      </Badge>
                      {user.role !== "admin" && (
                        <Badge variant="secondary" className="admin-chip">
                          {getAccessLevelNameFromPlan(user.plan_id)}
                        </Badge>
                      )}
                      {user.role !== "admin" && (
                        <Badge variant="outline" className="admin-chip">
                          {user.plan_sync_mode === "manual_override" ? "Kiwify: manual" : "Kiwify: auto"}
                        </Badge>
                      )}
                      {expiry && (
                        <Badge
                          variant={expiry.expired ? "destructive" : "outline"}
                          className={`admin-chip ${
                            expiry.expired
                              ? "border-destructive/50 text-destructive"
                              : expiry.urgent
                                ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                          }`}
                        >
                          {expiry.label}
                        </Badge>
                      )}
                    </div>
                    {/* Usage pills or admin note */}
                    {user.role === "admin" ? (
                      <p className="text-xs text-muted-foreground/60">Conta administrativa — sem limites de plano</p>
                    ) : (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {[
                          { k: "Rotas", v: fmt(usage?.routesTotal || 0, lim?.routes ?? -1) },
                          { k: "Auto", v: fmt(usage?.automationsTotal || 0, lim?.automations ?? -1) },
                          { k: "Grupos", v: fmt(usage?.groupsTotal || 0, lim?.groups ?? -1) },
                          { k: "WA", v: fmt(usage?.waSessionsTotal || 0, lim?.whatsappSessions ?? -1) },
                          { k: "TG", v: fmt(usage?.tgSessionsTotal || 0, lim?.telegramSessions ?? -1) },
                        ].map(({ k, v }) => (
                          <span key={k} className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-2xs text-muted-foreground">
                            {k} <span className="font-medium text-foreground">{v}</span>
                          </span>
                        ))}
                        {(usage?.errors24h ?? 0) > 0 && (
                          <span className="inline-flex items-center rounded-md bg-destructive/10 px-1.5 py-0.5 text-2xs font-medium text-destructive">
                            {usage?.errors24h} erros
                          </span>
                        )}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground/50">
                      Desde {formatBRT(new Date(user.created_at), "dd/MM/yyyy")}
                    </p>
                  </div>

                  {/* Actions: 3 primary buttons + overflow dropdown */}
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50 dark:text-green-500 dark:hover:text-green-400 dark:hover:bg-green-950/40"
                      onClick={() => { setWaContactUser(user); setWaMessage(""); }}
                      title={user.phone ? `WhatsApp (${formatPhoneDisplay(user.phone)})` : "Sem telefone cadastrado"}
                      disabled={!user.phone}
                    >
                      <WhatsAppIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => handleOpenEdit(user)}
                      title="Editar"
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => handleOpenPlanManager(user)}
                      title="Gerenciar plano"
                    >
                      <Calendar className="h-3.5 w-3.5" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground"
                          title="Mais ações"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        {user.account_status !== "active" && user.account_status !== "archived" && (
                          <DropdownMenuItem onClick={() => void runUserLifecycleAction(user, "activate")}>
                            <CheckCircle2 className="mr-2 h-3.5 w-3.5 text-green-600" />
                            Ativar
                          </DropdownMenuItem>
                        )}
                        {user.account_status !== "blocked" && (
                          <DropdownMenuItem
                            onClick={() => void runUserLifecycleAction(user, "block")}
                            disabled={user.user_id === currentUser?.id}
                          >
                            <Ban className="mr-2 h-3.5 w-3.5" />
                            Bloquear
                          </DropdownMenuItem>
                        )}
                        {user.account_status !== "archived" && (
                          <DropdownMenuItem onClick={() => void runUserLifecycleAction(user, "archive")}>
                            <Archive className="mr-2 h-3.5 w-3.5" />
                            Arquivar
                          </DropdownMenuItem>
                        )}
                        {user.account_status === "archived" && (
                          <DropdownMenuItem onClick={() => void runUserLifecycleAction(user, "restore")}>
                            <RotateCcw className="mr-2 h-3.5 w-3.5" />
                            Restaurar
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => void handleLoadPlanHistory(user)}
                        >
                          <History className="mr-2 h-3.5 w-3.5" />
                          Histórico de plano
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => void handleImpersonate(user)}
                          disabled={!!impersonateLoading || user.role === "admin"}
                        >
                          {impersonateLoading === user.user_id
                            ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            : <LogIn className="mr-2 h-3.5 w-3.5" />}
                          Entrar como
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(user)}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Apagar conta
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}

            {!loading && filtered.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">Nenhum usuário encontrado</div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editUser} onOpenChange={() => setEditUser(null)}>
        <DialogContent className="max-w-2xl rounded-[2rem] border-none p-0 shadow-2xl bg-background/95 backdrop-blur-xl">
          <DialogHeader className="p-6 border-b border-border/40 bg-muted/20 rounded-t-[2rem]">
            <DialogTitle>Editar Usuário</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Atualize os dados da conta, permissões e status do usuário.
            </p>
          </DialogHeader>
          {editUser && (() => {
            const expiry = formatExpiry(editUser.plan_expires_at ?? null);
            const planName = editUser.role === "admin"
              ? "Sem plano (admin)"
              : (planCatalog.find((plan) => plan.id === editUser.plan_id)?.name || editUser.plan_id);
            const accessLevelLabel = editUser.role === "admin"
              ? "Painel admin"
              : getAccessLevelNameFromPlan(editUser.plan_id);

            return (
              <div className="space-y-5">
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-user-name">Nome</Label>
                    <Input
                      id="edit-user-name"
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      placeholder="Nome do usuário"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-user-email">Email</Label>
                    <Input
                      id="edit-user-email"
                      type="email"
                      value={editEmail}
                      onChange={(event) => setEditEmail(event.target.value)}
                      placeholder="email@dominio.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-user-phone">Telefone (WhatsApp)</Label>
                    <Input
                      id="edit-user-phone"
                      type="tel"
                      value={editPhone}
                      onChange={(event) => setEditPhone(event.target.value)}
                      placeholder="+55 (11) 91234-5678"
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Permissão</Label>
                    <Select value={editRole} onValueChange={(value) => setEditRole(value as UserRole)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">Comum</SelectItem>
                        <SelectItem value="admin">Administrador</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Status</Label>
                    <Select value={editStatus} onValueChange={(value) => setEditStatus(value as AccountStatus)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Ativo</SelectItem>
                        <SelectItem value="inactive">Inativo</SelectItem>
                        <SelectItem value="blocked">Bloqueado</SelectItem>
                        <SelectItem value="archived">Arquivado</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Permissão só controla acesso ao painel admin. O restante segue o nível do plano.
                </p>

                <div className="rounded-md border bg-muted/30 p-4 space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <p className="text-xs font-medium">Plano e validade</p>
                      <p className="text-sm font-medium">{planName}</p>
                      <p className="text-xs text-muted-foreground">{accessLevelLabel}</p>
                      <p className="text-xs text-muted-foreground">
                        Alterações de plano e renovação são feitas em <strong>Gerenciar Plano</strong>.
                      </p>
                      {editUser.role === "admin" ? (
                        <p className="text-xs text-muted-foreground">Conta admin sem vencimento de plano</p>
                      ) : expiry ? (
                        <p
                          className={`text-xs ${
                            expiry.expired
                              ? "font-semibold text-destructive"
                              : expiry.urgent
                                ? "font-semibold text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                          }`}
                        >
                          {expiry.label}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Sem data de vencimento</p>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="gap-1.5 sm:self-start"
                      onClick={() => {
                        setEditUser(null);
                        handleOpenPlanManager(editUser);
                      }}
                    >
                      <Calendar className="h-3.5 w-3.5" />
                      Gerenciar Plano
                    </Button>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start gap-1.5 text-muted-foreground"
                    onClick={() => {
                      setBillingNoteUser(editUser);
                    }}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Reembolso / Nota
                  </Button>
                </div>
              </div>
            );
          })()}
          <DialogFooter>
            <Button onClick={handleSaveEdit} disabled={savingEdit} className="gap-2">
              <Shield className="h-3.5 w-3.5" />
              {savingEdit ? "Salvando..." : "Salvar Alterações"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && !deletingUser && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar Usuário?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso apaga a conta de <strong>{deleteTarget?.email}</strong> de vez. Não é possível desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingUser}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
              disabled={deletingUser}
            >
              {deletingUser ? "Apagando..." : "Apagar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showAdminPromotionConfirm} onOpenChange={setShowAdminPromotionConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Promover pra Admin?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{editUser?.email}</strong> vai ter acesso total ao painel admin, incluindo gerenciar usuários e configurações. Só confirme se tiver certeza.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setShowAdminPromotionConfirm(false);
                void doActualSave();
              }}
            >
              Promover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!blockTarget} onOpenChange={(open) => !open && setBlockTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bloquear?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{blockTarget?.email}</strong> vai ser bloqueado e perde o acesso. Você pode desbloquear depois.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmBlock()}
            >
              Bloquear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!extendPlanTarget} onOpenChange={(open) => !open && !extendingPlan && setExtendPlanTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Renovar Plano?</AlertDialogTitle>
            <AlertDialogDescription>
              O plano de <strong>{extendPlanTarget?.email}</strong> vai ganhar mais um período
              {(() => {
                const expiry = formatExpiry(extendPlanTarget?.plan_expires_at ?? null);
                if (!expiry || expiry.expired) return " a partir de hoje.";
                return ` a partir do vencimento atual.`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={extendingPlan}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleExtendPlan()} disabled={extendingPlan}>
              <CalendarCheck className="mr-2 h-4 w-4" />
              {extendingPlan ? "Renovando..." : "Renovar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!billingNoteUser} onOpenChange={(open) => { if (!open && !savingBillingNote) { setBillingNoteUser(null); setBillingNoteAmount(""); setBillingNoteReason(""); setBillingNoteType("refund"); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nota de Cobrança</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Usuário: <strong>{billingNoteUser?.email}</strong>
            </p>
            <div className="space-y-2">
              <Label>Tipo</Label>
              <Select value={billingNoteType} onValueChange={(v) => setBillingNoteType(v as "refund" | "credit" | "note")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="refund">Reembolso</SelectItem>
                  <SelectItem value="credit">Crédito Manual</SelectItem>
                  <SelectItem value="note">Nota Avulsa</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {billingNoteType !== "note" && (
              <div className="space-y-2">
                <Label>Valor (R$)</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0,00"
                  value={billingNoteAmount}
                  onChange={(e) => setBillingNoteAmount(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Motivo / Descrição</Label>
              <Input
                placeholder={billingNoteType === "refund" ? "Ex: cancelamento pedido pelo cliente" : "Descreva o motivo"}
                value={billingNoteReason}
                onChange={(e) => setBillingNoteReason(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Isso fica registrado no histórico. Pra reembolsos de verdade, processe também no painel de pagamentos.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => void handleSaveBillingNote()} disabled={savingBillingNote} className="gap-2">
              <FileText className="h-3.5 w-3.5" />
              {savingBillingNote ? "Salvando..." : "Registrar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Criar Usuário</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Nome</Label>
              <Input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Nome" />
            </div>
            <div className="space-y-2">
              <Label>E-mail</Label>
              <Input
                type="email"
                value={createEmail}
                onChange={(event) => setCreateEmail(event.target.value)}
                placeholder="email@dominio.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Telefone (WhatsApp)</Label>
              <Input
                type="tel"
                value={createPhone}
                onChange={(event) => setCreatePhone(event.target.value)}
                placeholder="+55 (11) 91234-5678"
              />
            </div>
            <div className="space-y-2">
              <Label>Senha</Label>
              <Input
                type="password"
                value={createPassword}
                onChange={(event) => setCreatePassword(event.target.value)}
                placeholder={PASSWORD_POLICY_HINT}
              />
            </div>
            <div className="space-y-2">
              <Label>Plano automático</Label>
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <p className="text-sm font-medium">
                  {createRole === "admin"
                    ? "Sem plano (admin)"
                    : (defaultSignupPlan?.name || "Plano padrão não achado")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {createRole === "admin"
                    ? "Admins acessam apenas o painel administrativo."
                    : (defaultSignupPlan
                      ? `Nível: ${getAccessLevelNameFromPlan(defaultSignupPlan.id)}`
                      : "Defina um plano pra novos cadastros na aba Planos.")}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {createRole === "admin"
                  ? "Conta admin não recebe plano nem vencimento."
                  : "Novo usuário recebe o plano padrão e o nível dele."}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Permissão</Label>
              <Select value={createRole} onValueChange={(value) => setCreateRole(value as UserRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">
                    <div className="flex items-center gap-2">
                      <Users className="h-3.5 w-3.5" />
                      Comum
                    </div>
                  </SelectItem>
                  <SelectItem value="admin">
                    <div className="flex items-center gap-2">
                      <Shield className="h-3.5 w-3.5" />
                      Administrador
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Só dê admin pra quem for gerenciar o sistema.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleCreateUser} disabled={savingCreate} className="gap-2">
              <UserPlus className="h-4 w-4" />
              {savingCreate ? "Criando..." : "Criar Usuário"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── WhatsApp Contact Dialog ────────────────────────────────── */}
      <Dialog
        open={!!waContactUser}
        onOpenChange={(open) => { if (!open && !sendingWaMessage) { setWaContactUser(null); setWaMessage(""); setWaMedia(null); } }}
      >
        <DialogContent className="max-w-md rounded-[2rem] border-none p-0 shadow-2xl bg-background/95 backdrop-blur-xl">
          <DialogHeader className="p-6 border-b border-border/40 bg-muted/20 rounded-t-[2rem]">
            <DialogTitle className="flex items-center gap-2">
              <WhatsAppIcon className="h-5 w-5 text-green-600 dark:text-green-500" />
              Contato via WhatsApp
            </DialogTitle>
          </DialogHeader>

          {waContactUser && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2.5 space-y-0.5">
                <p className="text-sm font-medium">{waContactUser.name || "Sem nome"}</p>
                <p className="text-xs text-muted-foreground">{waContactUser.email}</p>
                <p className="text-xs text-green-600 dark:text-green-500 font-medium">{waContactUser.phone}</p>
              </div>

              {/* Media preview */}
              {waMedia && (
                <div className="relative overflow-hidden rounded-lg border bg-muted/30">
                  {waMedia.mimeType.startsWith("image/") ? (
                    <img
                      src={`data:${waMedia.mimeType};base64,${waMedia.base64}`}
                      alt={waMedia.fileName}
                      className="max-h-40 w-full object-contain"
                    />
                  ) : (
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Paperclip className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm truncate">{waMedia.fileName}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setWaMedia(null)}
                    className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 hover:bg-background"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="wa-message">Mensagem</Label>
                <Textarea
                  id="wa-message"
                  placeholder="Escreva a mensagem que deseja enviar..."
                  value={waMessage}
                  onChange={(e) => setWaMessage(e.target.value)}
                  rows={4}
                  className="resize-y"
                />
              </div>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => waFileInputRef.current?.click()}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Image className="h-4 w-4" />
                  {waMedia ? "Trocar mídia" : "Anexar imagem"}
                </button>
                <p className="text-xs text-muted-foreground">Máx. 10 MB</p>
              </div>
              <input
                ref={waFileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => void handleWaFileSelect(e, "single")}
              />
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => { setWaContactUser(null); setWaMessage(""); setWaMedia(null); }}
              disabled={sendingWaMessage}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void handleSendWhatsAppMessage()}
              disabled={sendingWaMessage || (!waMessage.trim() && !waMedia)}
              className="gap-2 bg-green-600 text-white hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
            >
              {sendingWaMessage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {sendingWaMessage ? "Enviando..." : "Enviar Mensagem"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Bulk WhatsApp Dialog ───────────────────────────────────── */}
      <Dialog
        open={showBulkWaDialog}
        onOpenChange={(open) => { if (!open && !sendingBulkWa) { setShowBulkWaDialog(false); setBulkWaMessage(""); setBulkWaMedia(null); } }}
      >
        <DialogContent className="max-w-lg rounded-[2rem] border-none p-0 shadow-2xl bg-background/95 backdrop-blur-xl">
          <DialogHeader className="p-6 border-b border-border/40 bg-muted/20 rounded-t-[2rem]">
            <DialogTitle className="flex items-center gap-2">
              <WhatsAppIcon className="h-5 w-5 text-green-600 dark:text-green-500" />
              Enviar WhatsApp em massa
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-md border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 px-3 py-2.5">
              <p className="text-sm font-medium text-green-700 dark:text-green-400">
                {selectedUsers.size} {selectedUsers.size === 1 ? "destinatário" : "destinatários"} selecionado{selectedUsers.size !== 1 ? "s" : ""}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Apenas usuários com telefone cadastrado receberão a mensagem.
              </p>
            </div>

            {/* Media preview */}
            {bulkWaMedia && (
              <div className="relative overflow-hidden rounded-lg border bg-muted/30">
                {bulkWaMedia.mimeType.startsWith("image/") ? (
                  <img
                    src={`data:${bulkWaMedia.mimeType};base64,${bulkWaMedia.base64}`}
                    alt={bulkWaMedia.fileName}
                    className="max-h-40 w-full object-contain"
                  />
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Paperclip className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm truncate">{bulkWaMedia.fileName}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setBulkWaMedia(null)}
                  className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 hover:bg-background"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="bulk-wa-message">Mensagem</Label>
              <Textarea
                id="bulk-wa-message"
                placeholder="Escreva a mensagem que será enviada para os destinatários..."
                value={bulkWaMessage}
                onChange={(e) => setBulkWaMessage(e.target.value)}
                rows={5}
                className="resize-y"
              />
              <p className="text-right text-xs text-muted-foreground">{bulkWaMessage.length} caracteres</p>
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => bulkWaFileInputRef.current?.click()}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <Image className="h-4 w-4" />
                {bulkWaMedia ? "Trocar imagem" : "Anexar imagem"}
              </button>
              <p className="text-xs text-muted-foreground">Máx. 10 MB</p>
            </div>
            <input
              ref={bulkWaFileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => void handleWaFileSelect(e, "bulk")}
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => { setShowBulkWaDialog(false); setBulkWaMessage(""); setBulkWaMedia(null); }}
              disabled={sendingBulkWa}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void handleSendBulkWhatsApp()}
              disabled={sendingBulkWa || (!bulkWaMessage.trim() && !bulkWaMedia)}
              className="gap-2 bg-green-600 text-white hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
            >
              {sendingBulkWa ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {sendingBulkWa ? "Enviando..." : `Enviar para ${selectedUsers.size}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Plan Manager Dialog ─────────────────────────────────────── */}
      <Dialog
        open={!!planManagerUser}
        onOpenChange={(open) => { if (!open && !savingPlanManager) setPlanManagerUser(null); }}
      >
        <DialogContent className="max-w-md rounded-[2rem] border-none p-0 shadow-2xl bg-background/95 backdrop-blur-xl">
          <DialogHeader className="p-6 border-b border-border/40 bg-muted/20 rounded-t-[2rem]">
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Gerenciar Plano
            </DialogTitle>
          </DialogHeader>

          {planManagerUser && (
            <div className="space-y-5">
              {/* User info */}
              <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-0.5">
                <p className="text-sm font-medium">{planManagerUser.name || "Sem nome"}</p>
                <p className="text-xs text-muted-foreground">{planManagerUser.email}</p>
              </div>

              {planManagerUser.role === "admin" ? (
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Usuário admin não usa plano nem vencimento. Este modal fica disponível apenas para trocar senha.
                </div>
              ) : (
                <>
                  {/* Plan selection */}
                  <div className="space-y-2">
                    <Label>Plano</Label>
                    <Select value={pmPlanId} onValueChange={setPmPlanId}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {resolveAssignablePlans(planManagerUser.plan_id).map((plan) => (
                          <SelectItem key={plan.id} value={plan.id}>
                            {plan.name}{plan.price === 0 ? " — Grátis" : ` — R$${plan.price}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Nível: <strong>{getAccessLevelNameFromPlan(pmPlanId)}</strong>
                    </p>
                  </div>

                  {/* Expiry date */}
                  <div className="space-y-2">
                    <Label>Vencimento</Label>
                    <Input
                      type="date"
                      value={pmExpiryDate}
                      onChange={(e) => setPmExpiryDate(e.target.value)}
                      className="w-full"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { label: "+7d", days: 7 },
                        { label: "+14d", days: 14 },
                        { label: "+30d", days: 30 },
                        { label: "+60d", days: 60 },
                        { label: "+90d", days: 90 },
                        { label: "+180d", days: 180 },
                        { label: "+1 ano", days: 365 },
                      ].map(({ label, days }) => (
                        <Button
                          key={label}
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => pmAddDays(days)}
                        >
                          {label}
                        </Button>
                      ))}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs gap-1"
                        onClick={pmRenewByPeriod}
                        title="Estender pelo período configurado no plano"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Renovar
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs gap-1"
                        onClick={() => {
                          setPmPlanId("plan-starter");
                          const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                          setPmExpiryDate(end.toISOString().split("T")[0]);
                        }}
                        title="Aplicar plano Trial por 7 dias"
                      >
                        Trial 7d
                      </Button>
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs gap-1 text-muted-foreground"
                        onClick={() => {
                          const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
                          setPmExpiryDate(yesterday.toISOString().split("T")[0]);
                        }}
                        title="Marcar como já expirado"
                      >
                        <CalendarX className="h-3 w-3" />
                        Expirar agora
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-muted-foreground"
                        onClick={() => setPmExpiryDate("")}
                        title="Remover data de vencimento"
                      >
                        Sem vencimento
                      </Button>
                    </div>
                    {pmExpiryDate ? (
                      <p className="text-xs text-muted-foreground">
                        {(() => {
                          const expiry = formatExpiry(new Date(pmExpiryDate + "T23:59:59").toISOString());
                          return expiry ? (
                            <span className={expiry.expired ? "text-destructive font-medium" : expiry.urgent ? "text-amber-600 dark:text-amber-400 font-medium" : ""}>
                              {expiry.label}
                            </span>
                          ) : null;
                        })()}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Sem vencimento</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label>Sincronização com Kiwify</Label>
                    <Select value={pmPlanSyncMode} onValueChange={(v) => setPmPlanSyncMode(v as PlanSyncMode)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual_override">Sobrescrita manual</SelectItem>
                        <SelectItem value="auto">Automática (Kiwify)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Ao alterar plano/vencimento por aqui, a conta entra em <strong>sobrescrita manual</strong> para evitar que webhooks sobrescrevam a decisão do admin.
                    </p>
                  </div>
                </>
              )}

              {/* Password reset */}
              <div className="space-y-2 border-t pt-4">
                <Label className="flex items-center gap-1.5">
                  <Key className="h-3.5 w-3.5" />
                  Nova senha (opcional)
                </Label>
                <div className="flex gap-2">
                  <Input
                    type={pmShowPassword ? "text" : "password"}
                    placeholder={PASSWORD_POLICY_HINT}
                    value={pmNewPassword}
                    onChange={(e) => setPmNewPassword(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => setPmShowPassword((v) => !v)}
                  >
                    {pmShowPassword ? "Ocultar" : "Mostrar"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Deixe vazio pra não mudar a senha.
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPlanManagerUser(null)}
              disabled={savingPlanManager}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void handleSavePlanManager()}
              disabled={savingPlanManager}
              className="gap-2"
            >
              <CalendarCheck className="h-3.5 w-3.5" />
              {savingPlanManager ? "Salvando..." : "Salvar alterações"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Bulk Status Dialog ──────────────────────────────────────── */}
      <Dialog open={showBulkStatusDialog} onOpenChange={(open) => { if (!open && !applyingBulkStatus) setShowBulkStatusDialog(false); }}>
        <DialogContent className="max-w-sm rounded-[2rem] border-none p-0 shadow-2xl bg-background/95 backdrop-blur-xl">
          <DialogHeader className="p-6 border-b border-border/40 bg-muted/20 rounded-t-[2rem]">
            <DialogTitle className="flex items-center gap-2">
              <ToggleRight className="h-4 w-4" />
              Mudar status em massa
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Aplicar novo status para <strong>{selectedUsers.size} usuário{selectedUsers.size !== 1 ? "s" : ""}</strong> selecionado{selectedUsers.size !== 1 ? "s" : ""}.
            </p>
            <div className="space-y-2">
              <Label>Novo status</Label>
              <Select value={bulkStatusValue} onValueChange={(v) => setBulkStatusValue(v as AccountStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Ativo</SelectItem>
                  <SelectItem value="inactive">Inativo</SelectItem>
                  <SelectItem value="blocked">Bloqueado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              Contas admin são ignoradas automaticamente pelo backend.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkStatusDialog(false)} disabled={applyingBulkStatus}>
              Cancelar
            </Button>
            <Button onClick={() => void handleBulkChangeStatus()} disabled={applyingBulkStatus} className="gap-2">
              {applyingBulkStatus && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {applyingBulkStatus ? "Aplicando..." : `Aplicar para ${selectedUsers.size}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Bulk Plan Dialog ────────────────────────────────────────── */}
      <Dialog open={showBulkPlanDialog} onOpenChange={(open) => { if (!open && !applyingBulkPlan) setShowBulkPlanDialog(false); }}>
        <DialogContent className="max-w-sm rounded-[2rem] border-none p-0 shadow-2xl bg-background/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Atribuir plano em massa
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Aplicar plano para <strong>{selectedUsers.size} usuário{selectedUsers.size !== 1 ? "s" : ""}</strong> selecionado{selectedUsers.size !== 1 ? "s" : ""}.
            </p>
            <div className="space-y-2">
              <Label>Plano</Label>
              <Select value={bulkPlanId} onValueChange={setBulkPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o plano..." />
                </SelectTrigger>
                <SelectContent>
                  {activePlans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.name}{plan.price === 0 ? " — Grátis" : ` — R$${plan.price}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {bulkPlanId && (
                <p className="text-xs text-muted-foreground">
                  Nível: <strong>{getAccessLevelNameFromPlan(bulkPlanId)}</strong>
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Contas admin não recebem plano. O vencimento existente é mantido.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkPlanDialog(false)} disabled={applyingBulkPlan}>
              Cancelar
            </Button>
            <Button onClick={() => void handleBulkAssignPlan()} disabled={applyingBulkPlan || !bulkPlanId} className="gap-2">
              {applyingBulkPlan && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {applyingBulkPlan ? "Aplicando..." : `Atribuir para ${selectedUsers.size}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Plan History Dialog ─────────────────────────────────────── */}
      <Dialog open={!!planHistoryUser} onOpenChange={(open) => { if (!open && !planHistoryLoading) setPlanHistoryUser(null); }}>
        <DialogContent className="max-w-lg rounded-[2rem] border-none p-0 shadow-2xl bg-background/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-4 w-4" />
              Histórico de Plano
            </DialogTitle>
          </DialogHeader>
          {planHistoryUser && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <p className="text-sm font-medium">{planHistoryUser.name || "Sem nome"}</p>
                <p className="text-xs text-muted-foreground">{planHistoryUser.email}</p>
              </div>
              {planHistoryLoading && (
                <div className="flex items-center gap-2 py-4 justify-center text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Carregando histórico...
                </div>
              )}
              {!planHistoryLoading && planHistoryLogs.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nenhuma alteração de plano registrada.
                </p>
              )}
              {!planHistoryLoading && planHistoryLogs.length > 0 && (
                <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                  {planHistoryLogs.map((log) => (
                    <div key={log.id} className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-medium text-foreground">{log.action}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {new Date(log.createdAt).toLocaleString("pt-BR")}
                        </span>
                      </div>
                      <p className="text-muted-foreground">{log.summary}</p>
                      <p className="text-xs text-muted-foreground/60 mt-0.5">por {log.actorName}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlanHistoryUser(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

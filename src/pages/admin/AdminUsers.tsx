import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Ban, Calendar, CalendarCheck, CalendarX, CheckCircle2, Edit, FileText, Key, RefreshCw, RotateCcw, Search, Shield, Trash2, UserPlus, Users } from "lucide-react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import { formatBRT } from "@/lib/timezone";
import { toast } from "sonner";
import { RoutePendingState } from "@/components/RoutePendingState";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
import { useAuth } from "@/contexts/AuthContext";
import type { ManagedPlan } from "@/lib/admin-control-plane";
import { loadAdminSystemObservability, type UserObservabilityRow } from "@/lib/system-observability";
import { resolveEffectiveLimitsByPlanId } from "@/lib/access-control";
import { getPasswordPolicyError, PASSWORD_POLICY_HINT } from "@/lib/password-policy";

type UserRole = "admin" | "user";
type AccountStatus = "active" | "inactive" | "blocked" | "archived";

interface AdminUserRow {
  id: string;
  user_id: string;
  name: string;
  email: string;
  plan_id: string;
  created_at: string;
  role: UserRole;
  account_status: AccountStatus;
  plan_expires_at: string | null;
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

export default function AdminUsers() {
  const { state: controlPlane } = useAdminControlPlane();
  const { user: currentUser } = useAuth();
  const [userList, setUserList] = useState<AdminUserRow[]>([]);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);

  const [editUser, setEditUser] = useState<AdminUserRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editPlan, setEditPlan] = useState("");
  const [editRole, setEditRole] = useState<UserRole>("user");
  const [editStatus, setEditStatus] = useState<AccountStatus>("active");
  const [savingEdit, setSavingEdit] = useState(false);

  const [openCreate, setOpenCreate] = useState(false);
  const [createName, setCreateName] = useState("");

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
    if (!plan) return "Nível não encontrado";
    return controlPlane.accessLevels.find((level) => level.id === plan.accessLevelId)?.name || "Nível não encontrado";
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, observabilityRes] = await Promise.all([
        invokeAdmin({ action: "list_users" }),
        loadAdminSystemObservability(),
      ]);
      setUserList(usersRes.users || []);

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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao carregar painel admin");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const unsubscribe = subscribeLocalDbChanges(() => {
      void loadData();
    });

    const handleFocus = () => {
      void loadData();
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", handleFocus);
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
    const fallbackPlanId = defaultSignupPlan?.id || activePlans[0]?.id || "plan-starter";
    setEditPlan(user.plan_id || fallbackPlanId);
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
        plan_id: editPlan,
        role: editRole,
        account_status: editStatus,
      });
      toast.success(`Usuário ${editUser.email} atualizado`);
      setEditUser(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao atualizar usuário");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editUser) return;

    if (editRole === "user") {
      const allowedPlanIds = new Set(resolveAssignablePlans(editUser.plan_id).map((plan) => plan.id));
      if (!allowedPlanIds.has(editPlan)) {
        toast.error("Usuário cliente precisa ter um plano válido para manter o nível de acesso.");
        return;
      }
    }

    if (editRole === "admin" && editUser.role !== "admin") {
      setShowAdminPromotionConfirm(true);
      return;
    }

    await doActualSave();
  };

  const handleCreateUser = async () => {
    if (!createEmail || !createPassword) {
      toast.error("Informe e-mail e senha");
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
        password: createPassword,
        role: createRole,
      });
      const created = result.created_user;
      const roleOk = created?.role === createRole;
      const statusOk = created?.account_status === "active";

      if (created && roleOk && statusOk) {
        toast.success(`Usuário ${createEmail} criado com perfil ${createRole === "admin" ? "Administrador" : "Comum"}`);
      } else {
        toast.warning("Usuário criado, mas sem confirmação completa de perfil. Revise os dados na lista.");
      }

      setOpenCreate(false);
      setCreateName("");
      setCreateEmail("");
      setCreatePassword("");
      setCreateRole("user");
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao criar usuário");
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
      toast.error(err instanceof Error ? err.message : "Falha ao bloquear usuário");
    }
  };

  const runUserLifecycleAction = async (user: AdminUserRow, action: "activate" | "inactivate" | "block" | "archive" | "restore") => {
    if (action === "block") {
      if (user.user_id === currentUser?.id) {
        toast.error("Você não pode bloquear sua própria conta");
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
      toast.error(err instanceof Error ? err.message : "Falha ao executar ação de usuário");
    }
  };

  const handleExtendPlan = async () => {
    if (!extendPlanTarget || extendingPlan) return;
    setExtendingPlan(true);
    try {
      await invokeAdmin({ action: "extend_plan", user_id: extendPlanTarget.user_id });
      toast.success(`Plano de ${extendPlanTarget.email} renovado com sucesso`);
      setExtendPlanTarget(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao renovar plano");
    } finally {
      setExtendingPlan(false);
    }
  };

  const handleSaveBillingNote = async () => {
    if (!billingNoteUser || savingBillingNote) return;
    if (!billingNoteReason.trim()) {
      toast.error("Informe o motivo");
      return;
    }
    if ((billingNoteType === "refund" || billingNoteType === "credit") && Number(billingNoteAmount) <= 0) {
      toast.error("Informe um valor maior que zero");
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
      toast.error(err instanceof Error ? err.message : "Falha ao registrar nota");
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
      toast.error(err instanceof Error ? err.message : "Falha ao apagar usuário");
    } finally {
      setDeletingUser(false);
    }
  };

  const handleOpenPlanManager = (user: AdminUserRow) => {
    setPlanManagerUser(user);
    setPmPlanId(user.plan_id);
    setPmNewPassword("");
    setPmShowPassword(false);
    if (user.plan_expires_at) {
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
      const planChanged = pmPlanId && pmPlanId !== planManagerUser.plan_id;
      if (planChanged) {
        await invokeAdmin({ action: "update_plan", user_id: planManagerUser.user_id, plan_id: pmPlanId });
      }

      const originalExpiry = planManagerUser.plan_expires_at
        ? new Date(planManagerUser.plan_expires_at).toISOString().split("T")[0]
        : "";
      if (pmExpiryDate !== originalExpiry || planChanged) {
        const expiresAt = pmExpiryDate
          ? new Date(pmExpiryDate + "T23:59:59").toISOString()
          : null;
        await invokeAdmin({ action: "set_plan_expiry", user_id: planManagerUser.user_id, expires_at: expiresAt });
      }

      if (pmNewPassword.trim()) {
        const resetPasswordError = getPasswordPolicyError(pmNewPassword.trim());
        if (resetPasswordError) {
          toast.error(resetPasswordError);
          setSavingPlanManager(false);
          return;
        }
        await invokeAdmin({ action: "reset_password", user_id: planManagerUser.user_id, password: pmNewPassword.trim() });
        toast.success("Senha redefinida com sucesso");
      }

      toast.success(`Plano de ${planManagerUser.email} atualizado`);
      setPlanManagerUser(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar alterações");
    } finally {
      setSavingPlanManager(false);
    }
  };

  const statusBadge = (status: AccountStatus) => {
    const { label, variant } = STATUS_BADGE[status] ?? { label: status, variant: "outline" as const };
    return <Badge variant={variant} className="text-xs">{label}</Badge>;
  };

  return (
    <div className="admin-page">
      <PageHeader title="Usuários" description="Gerencie usuários, plano atribuído e ciclo de vida da conta" />

      <div className="admin-toolbar border-primary/30 bg-primary/5 text-center text-xs text-primary sm:text-left">
        Plano Padrão de Cadastro: <strong>{defaultSignupPlan?.name || "Não definido"}</strong>
        {defaultSignupPlan ? ` (nível: ${getAccessLevelNameFromPlan(defaultSignupPlan.id)})` : ""}
      </div>

      <div className="admin-toolbar">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, e-mail, plano, perfil ou status..."
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

      <div className="admin-toolbar border-dashed justify-center sm:justify-start">
        <Badge variant="outline" className="admin-chip">Ativos: {usageSummary.usersActive}</Badge>
        <Badge variant="outline" className="admin-chip">Rotas: {usageSummary.routesTotal}</Badge>
        <Badge variant="outline" className="admin-chip">Automações: {usageSummary.automationsTotal}</Badge>
        <Badge variant="outline" className="admin-chip">Grupos: {usageSummary.groupsTotal}</Badge>
        <Badge variant="outline" className="admin-chip">WA: {usageSummary.waSessionsTotal}</Badge>
        <Badge variant="outline" className="admin-chip">TG: {usageSummary.tgSessionsTotal}</Badge>
        <Badge variant={usageSummary.errors24h > 0 ? "destructive" : "secondary"} className="admin-chip">Erros 24h: {usageSummary.errors24h}</Badge>
      </div>

      <Card className="admin-card">
        <CardContent className="p-0">
          <div className="divide-y">
            {loading && (
              <div className="p-6">
                <RoutePendingState label="Carregando usuários..." />
              </div>
            )}
            {!loading && filtered.map((user) => (
              <div
                key={user.user_id}
                className="flex items-start justify-between gap-3 p-4 transition-colors hover:bg-secondary/30 sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{user.name || "Sem nome"}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground/60">
                    Desde {formatBRT(new Date(user.created_at), "dd/MM/yyyy")}
                  </p>
                  {(() => {
                    const usage = userUsageMap[user.user_id];
                    const lim = resolveEffectiveLimitsByPlanId(user.plan_id);
                    const fmt = (used: number, max: number) => max === -1 ? String(used) : `${used}/${max}`;
                    return (
                      <>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Rotas: {fmt(usage?.routesTotal || 0, lim?.routes ?? -1)}
                          {" | "}Automações: {fmt(usage?.automationsTotal || 0, lim?.automations ?? -1)}
                          {" | "}Grupos: {fmt(usage?.groupsTotal || 0, lim?.groups ?? -1)}
                          {" | "}WA: {fmt(usage?.waSessionsTotal || 0, lim?.whatsappSessions ?? -1)}
                          {" | "}TG: {fmt(usage?.tgSessionsTotal || 0, lim?.telegramSessions ?? -1)}
                          {" | "}Erros 24h: {usage?.errors24h || 0}
                        </p>
                        <p className="text-xs text-muted-foreground/60">
                          slots grupos: Auto ≤{lim?.groupsPerAutomation === -1 ? "∞" : (lim?.groupsPerAutomation ?? "?")}{" · "}Rota ≤{lim?.groupsPerRoute === -1 ? "∞" : (lim?.groupsPerRoute ?? "?")}
                        </p>
                      </>
                    );
                  })()}
                </div>

                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
                  <Badge variant="outline" className="admin-chip">
                    {planCatalog.find((plan) => plan.id === user.plan_id)?.name || user.plan_id}
                  </Badge>
                  <Badge variant="secondary" className="admin-chip">
                    {getAccessLevelNameFromPlan(user.plan_id)}
                  </Badge>
                  {(() => {
                    const expiry = formatExpiry(user.plan_expires_at ?? null);
                    if (!expiry) return null;
                    return (
                      <Badge
                        variant={expiry.expired ? "destructive" : expiry.urgent ? "outline" : "outline"}
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
                    );
                  })()}
                  {statusBadge(user.account_status || "active")}
                  <Badge variant={user.role === "admin" ? "destructive" : "secondary"} className="admin-chip">
                    {user.role === "admin" ? "Admin" : "Usuário"}
                  </Badge>
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
                  {user.account_status !== "active" && user.account_status !== "archived" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => runUserLifecycleAction(user, "activate")}
                      title="Ativar"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {user.account_status !== "blocked" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => runUserLifecycleAction(user, "block")}
                      title="Bloquear"
                    >
                      <Ban className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {user.account_status !== "archived" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => runUserLifecycleAction(user, "archive")}
                      title="Arquivar"
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {user.account_status === "archived" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => runUserLifecycleAction(user, "restore")}
                      title="Restaurar"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => setDeleteTarget(user)}
                    title="Apagar"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}

            {!loading && filtered.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">Nenhum Usuário Encontrado</div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editUser} onOpenChange={() => setEditUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar Usuário</DialogTitle>
          </DialogHeader>
          {editUser && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Nome</Label>
                <Input
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  placeholder="Nome do usuário"
                />
              </div>
              <div>
                <Label>Email</Label>
                <p className="text-sm text-muted-foreground">{editUser.email}</p>
              </div>
              <div className="space-y-2">
                <Label>Plano</Label>
                <Select value={editPlan} onValueChange={setEditPlan}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {resolveAssignablePlans(editUser.plan_id).map((plan) => (
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.name} - {plan.price === 0 ? "Grátis" : `R$${plan.price}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Nível de acesso do usuário: {getAccessLevelNameFromPlan(editPlan)}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Permissão Administrativa</Label>
                <Select value={editRole} onValueChange={(value) => setEditRole(value as UserRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Usuário Comum</SelectItem>
                    <SelectItem value="admin">Administrador</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Esta permissão controla apenas acesso ao painel admin. As funções do sistema seguem o nível definido no plano.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Status da Conta</Label>
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
              {editUser && (() => {
                const expiry = formatExpiry(editUser.plan_expires_at ?? null);
                return (
                  <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-medium">Validade da Assinatura</p>
                        {expiry ? (
                          <p className={`text-xs ${
                            expiry.expired ? "font-semibold text-destructive" : expiry.urgent ? "font-semibold text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                          }`}>{expiry.label}</p>
                        ) : (
                          <p className="text-xs text-muted-foreground">Sem data de expiração definida</p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 shrink-0"
                        onClick={() => setExtendPlanTarget(editUser)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Renovar Plano
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full gap-1.5 justify-start text-muted-foreground"
                      onClick={() => { setBillingNoteUser(editUser); }}
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Registrar Reembolso / Nota de Cobrança
                    </Button>
                  </div>
                );
              })()}
            </div>
          )}
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
              Esta ação remove permanentemente a conta de <strong>{deleteTarget?.email}</strong> e não pode ser desfeita.
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
            <AlertDialogTitle>Promover a Administrador?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{editUser?.email}</strong> terá acesso completo ao painel admin, incluindo gestão de usuários e configurações globais. Confirme apenas se tem certeza.
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
              Confirmar Promoção
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!blockTarget} onOpenChange={(open) => !open && setBlockTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bloquear Usuário?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{blockTarget?.email}</strong> será bloqueado e não poderá mais acessar o sistema. Você pode desfazer isso a qualquer momento.
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
              O plano de <strong>{extendPlanTarget?.email}</strong> será estendido por mais um período completo
              {(() => {
                const expiry = formatExpiry(extendPlanTarget?.plan_expires_at ?? null);
                if (!expiry || expiry.expired) return " a partir de hoje.";
                return ` a partir da data de vencimento atual.`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={extendingPlan}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleExtendPlan()} disabled={extendingPlan}>
              <CalendarCheck className="mr-2 h-4 w-4" />
              {extendingPlan ? "Renovando..." : "Confirmar Renovação"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!billingNoteUser} onOpenChange={(open) => { if (!open && !savingBillingNote) { setBillingNoteUser(null); setBillingNoteAmount(""); setBillingNoteReason(""); setBillingNoteType("refund"); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar Nota de Cobrança</DialogTitle>
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
                placeholder={billingNoteType === "refund" ? "Ex: cancelamento solicitado pelo cliente" : "Descreva o motivo"}
                value={billingNoteReason}
                onChange={(e) => setBillingNoteReason(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Esta entrada será registrada no histórico de auditoria. Para reembolsos reais, processe também pelo painel do fornecedor de pagamentos.
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
            <DialogTitle>Criar Novo Usuário</DialogTitle>
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
              <Label>Senha</Label>
              <Input
                type="password"
                value={createPassword}
                onChange={(event) => setCreatePassword(event.target.value)}
                placeholder={PASSWORD_POLICY_HINT}
              />
            </div>
            <div className="space-y-2">
              <Label>Plano Inicial (automático)</Label>
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <p className="text-sm font-medium">{defaultSignupPlan?.name || "Plano padrão não encontrado"}</p>
                <p className="text-xs text-muted-foreground">
                  {defaultSignupPlan
                    ? `Nível atribuído: ${getAccessLevelNameFromPlan(defaultSignupPlan.id)}`
                    : "Defina um plano padrão em Planos para novos cadastros."}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Novo usuário cliente recebe automaticamente o plano padrão de cadastro e o nível vinculado a esse plano.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Permissão Administrativa</Label>
              <Select value={createRole} onValueChange={(value) => setCreateRole(value as UserRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">
                    <div className="flex items-center gap-2">
                      <Users className="h-3.5 w-3.5" />
                      Usuário Comum
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
                Atribua Administrador apenas para quem pode gerenciar o painel admin.
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

      {/* ── Plan Manager Dialog ─────────────────────────────────────── */}
      <Dialog
        open={!!planManagerUser}
        onOpenChange={(open) => { if (!open && !savingPlanManager) setPlanManagerUser(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
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
                <Label>Data de Vencimento</Label>
                <Input
                  type="date"
                  value={pmExpiryDate}
                  onChange={(e) => setPmExpiryDate(e.target.value)}
                  className="w-full"
                />
                <div className="flex flex-wrap gap-1.5">
                  {[
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
                  <p className="text-xs text-muted-foreground">Acesso sem data de expiração</p>
                )}
              </div>

              {/* Password reset */}
              <div className="space-y-2 border-t pt-4">
                <Label className="flex items-center gap-1.5">
                  <Key className="h-3.5 w-3.5" />
                  Redefinir senha (opcional)
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
                  Deixe em branco para não alterar a senha.
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
    </div>
  );
}

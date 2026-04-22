import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { InlineLoadingState } from "@/components/InlineLoadingState";
import { backend } from "@/integrations/backend/client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import type { Tables } from "@/integrations/backend/types";
import { formatBRT } from "@/lib/timezone";
import { Download, Filter, Loader2, RefreshCw, ScrollText, Shield, User, X } from "lucide-react";
import { toast } from "sonner";

type ActorRole = "admin" | "user";
type LogCategory = "admin_action" | "user_activity";
type StatusFilter = "all" | "success" | "error" | "warning";

interface AdminUserRow {
  user_id: string;
  name: string;
  email: string;
  role: ActorRole;
}

interface InvokeResult {
  error?: string;
  users?: AdminUserRow[];
}

interface UnifiedLogRow {
  id: string;
  createdAt: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  actorRole: ActorRole;
  category: LogCategory;
  action: string;
  summary: string;
  status: Exclude<StatusFilter, "all">;
  targetName?: string;
  targetEmail?: string;
}

const ADMIN_ACTION_LABELS: Record<string, string> = {
  update_user: "Usuário atualizado",
  update_plan: "Plano alterado",
  set_name: "Nome alterado",
  set_role: "Permissão alterada",
  set_status: "Status alterado",
  archive_user: "Usuário arquivado",
  restore_user: "Usuário restaurado",
  delete_user: "Usuário apagado",
  create_user: "Usuário criado",
  update_admin_plans: "Configuração de planos atualizada",
  update_access_levels: "Controle de acesso atualizado",
  ops_service_control: "Controle operacional de serviço",
};

const STATUS_LABELS: Record<Exclude<StatusFilter, "all">, string> = {
  success: "Sucesso",
  error: "Erro",
  warning: "Atenção",
};

const STATUS_BADGE_VARIANT: Record<Exclude<StatusFilter, "all">, "default" | "destructive" | "secondary"> = {
  success: "default",
  error: "destructive",
  warning: "secondary",
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

function mapAdminSummary(action: string, details: unknown): string {
  const safe = asRecord(details);
  if (action === "update_user") {
    const parts: string[] = [];
    if (safe.plan_id) parts.push(`plano: ${String(safe.plan_id)}`);
    if (safe.role) parts.push(`perfil: ${String(safe.role)}`);
    if (safe.account_status) parts.push(`status: ${String(safe.account_status)}`);
    return parts.length > 0 ? parts.join(" | ") : "Dados atualizados";
  }
  if (action === "update_plan") return `Plano: ${String(safe.plan_id || "-")}`;
  if (action === "set_role") return `Nova role: ${String(safe.role || "user")}`;
  if (action === "set_status") return `Novo status: ${String(safe.account_status || "active")}`;
  if (action === "create_user") {
    const email = String(safe.email || "-");
    const role = String(safe.role || "user");
    return `Criado: ${email} (${role})`;
  }
  if (action === "update_admin_plans") {
    const total = String(safe.total_plans || "0");
    const active = String(safe.active_plans || "0");
    return `Planos totais: ${total} | ativos: ${active}`;
  }
  if (action === "update_access_levels") {
    const levels = String(safe.levels || "0");
    const enabled = String(safe.enabled_feature_rules || "0");
    return `Níveis: ${levels} | regras liberadas: ${enabled}`;
  }
  if (action === "ops_service_control") {
    const service = String(safe.service || "-");
    const operation = String(safe.operation || "-");
    const ok = safe.ok === true;
    return `${service} | ${operation} | ${ok ? "sucesso" : "falha"}`;
  }
  return "Ação admin feita";
}

function mapHistorySummary(row: Tables<"history_entries">): string {
  const detailRecord = asRecord(row.details);
  const detailMessage = String(detailRecord.message || "").trim();
  if (detailMessage) return detailMessage;

  const type = String(row.type || "ação");
  const source = String(row.source || "origem");
  const destination = String(row.destination || "destino");
  return `${type}: ${source} para ${destination}`;
}

function mapHistoryStatus(raw: string): Exclude<StatusFilter, "all"> {
  const value = String(raw || "").toLowerCase();
  if (["error", "failed", "failure"].includes(value)) return "error";
  if (["blocked", "warning", "warn", "skipped"].includes(value)) return "warning";
  return "success";
}

async function loadAdminUsers() {
  const payload = (await invokeBackendRpc<InvokeResult>("admin-users", { body: { action: "list_users" } })) || {};
  if (payload.error) throw new Error(payload.error);
  return payload.users || [];
}

export default function AdminLogs() {
  const [allLogs, setAllLogs] = useState<UnifiedLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const [actorFilter, setActorFilter] = useState<"all" | ActorRole>("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | LogCategory>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [userFilter, setUserFilter] = useState<string>("all");
  const [periodFilter, setPeriodFilter] = useState<"all" | "24h" | "7d" | "30d">("7d");

  const hasActiveFilters = actorFilter !== "all" || categoryFilter !== "all" || statusFilter !== "all" || userFilter !== "all" || search !== "" || periodFilter !== "7d";

  const clearFilters = () => {
    setSearch("");
    setActorFilter("all");
    setCategoryFilter("all");
    setStatusFilter("all");
    setUserFilter("all");
    setPeriodFilter("7d");
  };

  const reload = async () => {
    setLoading(true);
    try {
      const [users, auditRes, historyRes] = await Promise.all([
        loadAdminUsers(),
        backend.from("admin_audit_logs").select("*").order("created_at", { ascending: false }).limit(400),
        backend.from("history_entries").select("*").order("created_at", { ascending: false }).limit(800),
      ]);

      if (auditRes.error) throw new Error(auditRes.error.message || "Não deu pra carregar logs admin");
      if (historyRes.error) throw new Error(historyRes.error.message || "Não deu pra carregar logs de usuários");

      const userMap = new Map(users.map((row) => [row.user_id, row]));
      const fallbackUser: AdminUserRow = {
        user_id: "",
        name: "Usuário",
        email: "-",
        role: "user",
      };

      const auditRows = (auditRes.data || []) as Tables<"admin_audit_logs">[];
      const historyRows = (historyRes.data || []) as Tables<"history_entries">[];

      const adminLogs: UnifiedLogRow[] = auditRows.map((row) => {
        const actor = userMap.get(String(row.user_id || "")) || fallbackUser;
        const target = row.target_user_id ? userMap.get(String(row.target_user_id)) : undefined;
        const label = ADMIN_ACTION_LABELS[String(row.action)] || String(row.action || "Ação admin");

        return {
          id: `admin-${row.id}`,
          createdAt: String(row.created_at),
          actorId: String(row.user_id || ""),
          actorName: actor.name || "Administrador",
          actorEmail: actor.email || "-",
          actorRole: actor.role === "admin" ? "admin" : "user",
          category: "admin_action",
          action: label,
          summary: mapAdminSummary(String(row.action || ""), row.details),
          status: "success",
          targetName: target?.name,
          targetEmail: target?.email,
        };
      });

      const userActivityLogs: UnifiedLogRow[] = historyRows.map((row) => {
        const actor = userMap.get(String(row.user_id || "")) || fallbackUser;
        const status = mapHistoryStatus(String(row.status || ""));
        return {
          id: `hist-${row.id}`,
          createdAt: String(row.created_at),
          actorId: String(row.user_id || ""),
          actorName: actor.name || "Usuário",
          actorEmail: actor.email || "-",
          actorRole: actor.role === "admin" ? "admin" : "user",
          category: "user_activity",
          action: `Histórico: ${String(row.type || "evento")}`,
          summary: mapHistorySummary(row),
          status,
        };
      });

      const merged = [...adminLogs, ...userActivityLogs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setAllLogs(merged);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não deu pra carregar os logs");
      setAllLogs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const userOptions = useMemo(() => {
    const map = new Map<string, { name: string; email: string }>();
    for (const row of allLogs) {
      if (!row.actorId) continue;
      if (!map.has(row.actorId)) {
        map.set(row.actorId, { name: row.actorName, email: row.actorEmail });
      }
    }
    return Array.from(map.entries())
      .map(([id, info]) => ({ id, label: `${info.name} (${info.email})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allLogs]);

  const filteredLogs = useMemo(() => {
    const term = search.toLowerCase().trim();
    const nowMs = Date.now();
    const minTimestamp =
      periodFilter === "24h"
        ? nowMs - 24 * 60 * 60 * 1000
        : periodFilter === "7d"
          ? nowMs - 7 * 24 * 60 * 60 * 1000
          : periodFilter === "30d"
            ? nowMs - 30 * 24 * 60 * 60 * 1000
            : null;

    return allLogs.filter((row) => {
      if (actorFilter !== "all" && row.actorRole !== actorFilter) return false;
      if (categoryFilter !== "all" && row.category !== categoryFilter) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (userFilter !== "all" && row.actorId !== userFilter) return false;

      if (minTimestamp != null) {
        const rowMs = new Date(row.createdAt).getTime();
        if (!Number.isFinite(rowMs) || rowMs < minTimestamp) return false;
      }

      if (!term) return true;
      const haystack = [
        row.actorName,
        row.actorEmail,
        row.action,
        row.summary,
        row.targetName,
        row.targetEmail,
        row.category,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [actorFilter, allLogs, categoryFilter, periodFilter, search, statusFilter, userFilter]);

  const exportDiagnostics = async () => {
    setExporting(true);
    try {
      const windowHours = periodFilter === "24h"
        ? 24
        : periodFilter === "7d"
          ? 7 * 24
          : periodFilter === "30d"
            ? 30 * 24
            : 14 * 24;

      const response = await invokeBackendRpc<{
        ok?: boolean;
        fileName?: string;
        export?: unknown;
      }>("admin-export-diagnostics", {
        body: { windowHours },
      });

      const payload = response?.export ?? response;
      const fileName = String(response?.fileName || `autolinks-diagnostico-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      const serialized = JSON.stringify(payload, null, 2);
      const blob = new Blob([serialized], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      toast.success(`Diagnóstico exportado (${fileName})`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível exportar o diagnóstico");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="admin-page">
      <PageHeader
        title="Logs do Sistema"
        description="Veja o que cada pessoa fez e quando"
      />

      <Card className="admin-card">
        <CardHeader className="pb-2">
          <CardTitle className="admin-card-title flex items-center justify-center gap-2 sm:justify-start">
            <Filter className="h-4 w-4" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Input
            placeholder="Buscar por nome, ação ou alvo"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="xl:col-span-2"
          />

          <Select value={actorFilter} onValueChange={(value) => setActorFilter(value as "all" | ActorRole)}>
            <SelectTrigger>
              <SelectValue placeholder="Ator" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os Atores</SelectItem>
              <SelectItem value="admin">Só Admins</SelectItem>
              <SelectItem value="user">Só Usuários</SelectItem>
            </SelectContent>
          </Select>

          <Select value={categoryFilter} onValueChange={(value) => setCategoryFilter(value as "all" | LogCategory)}>
            <SelectTrigger>
              <SelectValue placeholder="Tipo" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os Tipos</SelectItem>
              <SelectItem value="admin_action">Ações Admin</SelectItem>
              <SelectItem value="user_activity">Atividade dos Usuários</SelectItem>
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os Status</SelectItem>
              <SelectItem value="success">Sucesso</SelectItem>
              <SelectItem value="warning">Atenção</SelectItem>
              <SelectItem value="error">Erro</SelectItem>
            </SelectContent>
          </Select>

          <Select value={periodFilter} onValueChange={(value) => setPeriodFilter(value as "all" | "24h" | "7d" | "30d")}>
            <SelectTrigger>
              <SelectValue placeholder="Período" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">Últimas 24h</SelectItem>
              <SelectItem value="7d">Últimos 7 dias</SelectItem>
              <SelectItem value="30d">Últimos 30 dias</SelectItem>
              <SelectItem value="all">Todo Período</SelectItem>
            </SelectContent>
          </Select>

          <Select value={userFilter} onValueChange={setUserFilter}>
            <SelectTrigger className="xl:col-span-2">
              <SelectValue placeholder="Usuário" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os Usuários</SelectItem>
              {userOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" onClick={() => void reload()} className="gap-2 xl:col-span-1">
            <RefreshCw className="h-3.5 w-3.5" />
            Atualizar
          </Button>
          <Button onClick={() => void exportDiagnostics()} className="gap-2 xl:col-span-1" disabled={exporting}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Baixar Diagnóstico
          </Button>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-2 text-muted-foreground xl:col-span-1">
              <X className="h-3.5 w-3.5" />
              Limpar
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="admin-toolbar border-dashed justify-center sm:justify-start">
        <Badge variant="outline" className="admin-chip">{filteredLogs.length} registro(s)</Badge>
        <Badge variant="outline" className="admin-chip">{allLogs.filter((row) => row.category === "admin_action").length} admin</Badge>
        <Badge variant="outline" className="admin-chip">{allLogs.filter((row) => row.category === "user_activity").length} usuários</Badge>
        <span className="text-xs text-muted-foreground">Mostrando até 400 admin e 800 de usuários (mais recentes)</span>
      </div>

      <Card className="admin-card">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6">
              <InlineLoadingState label="Carregando..." />
            </div>
          ) : filteredLogs.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="Nada encontrado"
              description="Tenta mudar os filtros."
            />
          ) : (
            <div className="divide-y">
              {filteredLogs.map((row) => {
                const ActorIcon = row.actorRole === "admin" ? Shield : User;
                return (
                  <div key={row.id} className="flex flex-col gap-2 p-4 hover:bg-secondary/30">
                    <div className="flex flex-wrap items-center gap-2">
                      <ActorIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      <p className="text-sm font-medium">{row.action}</p>
                      <Badge variant={row.actorRole === "admin" ? "destructive" : "secondary"} className="text-xs">
                        {row.actorRole === "admin" ? "Admin" : "Usuário"}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {row.category === "admin_action" ? "Admin" : "App"}
                      </Badge>
                      <Badge variant={STATUS_BADGE_VARIANT[row.status]} className="text-xs">
                        {STATUS_LABELS[row.status]}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span>O que foi feito: {row.summary}</span>
                      <span>Horário: {formatBRT(row.createdAt, "dd/MM/yyyy HH:mm:ss")}</span>
                      <span>Quem fez: {row.actorName} ({row.actorEmail})</span>
                      {row.targetEmail && <span>Em quem: {row.targetName || "Usuário"} ({row.targetEmail})</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


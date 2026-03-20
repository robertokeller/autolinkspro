import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, CalendarClock, Eye, Megaphone, Pencil, Plus, RefreshCw, Send, Trash2, Wrench } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { toast } from "sonner";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";

interface AdminUserRow {
  user_id: string;
  email: string;
  name: string;
  plan_id: string;
  role: "admin" | "user";
  account_status: "active" | "inactive" | "blocked" | "archived";
}

interface AnnouncementMetrics {
  delivered: number;
  read: number;
  dismissed: number;
  unread: number;
  read_rate: number;
}

interface AnnouncementRow {
  id: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  channel: "bell" | "modal" | "both";
  auto_popup_on_login: boolean;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  target_filter: {
    planIds: string[];
    accessLevelIds: string[];
    roles: Array<"admin" | "user">;
    userIds: string[];
    matchMode: "any" | "all";
  };
  metrics?: AnnouncementMetrics;
  last_delivered_at: string | null;
  created_at: string;
}

interface MaintenanceState {
  maintenance_enabled: boolean;
  maintenance_title: string;
  maintenance_message: string;
  maintenance_eta: string | null;
  allow_admin_bypass: boolean;
}

type AnnouncementPeriodMode = "once" | "days" | "until_disable";

interface AnnouncementFormState {
  id: string | null;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  channel: "bell" | "modal" | "both";
  autoPopup: boolean;
  periodMode: AnnouncementPeriodMode;
  startsAt: string;
  endsAt: string;
  visibleDays: number;
  matchMode: "any" | "all";
  planIds: string[];
  accessLevelIds: string[];
  roles: Array<"admin" | "user">;
  userIds: string[];
}

const DEFAULT_MAINTENANCE: MaintenanceState = {
  maintenance_enabled: false,
  maintenance_title: "Sistema em manutenção",
  maintenance_message: "Estamos fazendo melhorias. Tenta de novo em alguns minutos.",
  maintenance_eta: null,
  allow_admin_bypass: true,
};

function nowIso() {
  return new Date().toISOString();
}

function toggleInList(list: string[], value: string, checked: boolean) {
  const base = new Set(list);
  if (checked) base.add(value);
  else base.delete(value);
  return [...base];
}

function toDateTimeLocalValue(iso: string | null) {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const offset = parsed.getTimezoneOffset();
  const localMs = parsed.getTime() - offset * 60_000;
  return new Date(localMs).toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value: string) {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function formatDateTimeForUi(value: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function emptyForm(): AnnouncementFormState {
  return {
    id: null,
    title: "",
    message: "",
    severity: "info",
    channel: "bell",
    autoPopup: false,
    periodMode: "until_disable",
    startsAt: "",
    endsAt: "",
    visibleDays: 3,
    matchMode: "any",
    planIds: [],
    accessLevelIds: [],
    roles: [],
    userIds: [],
  };
}

function inferPeriodMode(item: AnnouncementRow): AnnouncementPeriodMode {
  if (!item.ends_at) return "until_disable";
  if (item.starts_at && item.ends_at) {
    const startMs = Date.parse(item.starts_at);
    const endMs = Date.parse(item.ends_at);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      const days = (endMs - startMs) / (24 * 60 * 60 * 1000);
      if (days >= 1) return "days";
    }
  }
  return "once";
}

function formFromAnnouncement(item: AnnouncementRow): AnnouncementFormState {
  const mode = inferPeriodMode(item);
  const startMs = item.starts_at ? Date.parse(item.starts_at) : Number.NaN;
  const endMs = item.ends_at ? Date.parse(item.ends_at) : Number.NaN;
  const inferredDays = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)))
    : 3;

  return {
    id: item.id,
    title: item.title,
    message: item.message,
    severity: item.severity,
    channel: item.channel,
    autoPopup: item.auto_popup_on_login === true,
    periodMode: mode,
    startsAt: toDateTimeLocalValue(item.starts_at),
    endsAt: toDateTimeLocalValue(item.ends_at),
    visibleDays: inferredDays,
    matchMode: item.target_filter.matchMode || "any",
    planIds: Array.isArray(item.target_filter.planIds) ? item.target_filter.planIds : [],
    accessLevelIds: Array.isArray(item.target_filter.accessLevelIds) ? item.target_filter.accessLevelIds : [],
    roles: Array.isArray(item.target_filter.roles) ? item.target_filter.roles : [],
    userIds: Array.isArray(item.target_filter.userIds) ? item.target_filter.userIds : [],
  };
}

function buildPeriodPayload(form: AnnouncementFormState) {
  const startIso = fromDateTimeLocalValue(form.startsAt) || nowIso();

  if (form.periodMode === "until_disable") {
    return {
      starts_at: startIso,
      ends_at: null as string | null,
    };
  }

  if (form.periodMode === "days") {
    const baseDate = new Date(startIso);
    const endDate = new Date(baseDate.getTime() + Math.max(1, form.visibleDays) * 24 * 60 * 60 * 1000);
    return {
      starts_at: baseDate.toISOString(),
      ends_at: endDate.toISOString(),
    };
  }

  const endIso = fromDateTimeLocalValue(form.endsAt) || new Date(new Date(startIso).getTime() + 60 * 60 * 1000).toISOString();
  return {
    starts_at: startIso,
    ends_at: endIso,
  };
}

function periodLabel(item: AnnouncementRow) {
  if (!item.starts_at && !item.ends_at) return "Sem período";
  if (item.starts_at && !item.ends_at) return "Até desativar";

  const start = Date.parse(String(item.starts_at || ""));
  const end = Date.parse(String(item.ends_at || ""));
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const days = (end - start) / (24 * 60 * 60 * 1000);
    if (days >= 1) return `Por ${Math.ceil(days)} dia(s)`;
  }

  return "Única vez";
}

function severityLabel(severity: "info" | "warning" | "critical") {
  if (severity === "info") return "Informativa";
  if (severity === "warning") return "Aviso";
  return "Crítica";
}

function channelLabel(channel: "bell" | "modal" | "both") {
  if (channel === "bell") return "Sino";
  if (channel === "modal") return "Modal";
  return "Sino + modal";
}

const DELIVER_COOLDOWN_MS = 2 * 60 * 1000;

function redeliverCooldownSec(lastDeliveredAt: string | null): number {
  if (!lastDeliveredAt) return 0;
  const elapsed = Date.now() - Date.parse(lastDeliveredAt);
  const remaining = DELIVER_COOLDOWN_MS - elapsed;
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

export default function AdminNotifications() {
  const { state: controlPlane } = useAdminControlPlane();

  const [activeTab, setActiveTab] = useState<"notifications" | "maintenance">("notifications");
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState<AnnouncementFormState>(emptyForm());
  const [pendingDelete, setPendingDelete] = useState<AnnouncementRow | null>(null);

  const [maintenance, setMaintenance] = useState<MaintenanceState>(DEFAULT_MAINTENANCE);

  const loadUsers = useCallback(async () => {
    const result = await invokeBackendRpc<{ users: AdminUserRow[] }>("admin-users", {
      body: { action: "list_users" },
    });
    setUsers(Array.isArray(result.users) ? result.users : []);
  }, []);

  const loadAnnouncements = useCallback(async () => {
    const result = await invokeBackendRpc<{ announcements: AnnouncementRow[] }>("admin-announcements", {
      body: { action: "list" },
    });
    setAnnouncements(Array.isArray(result.announcements) ? result.announcements : []);
  }, []);

  const loadMaintenance = useCallback(async () => {
    const result = await invokeBackendRpc<MaintenanceState>("admin-maintenance", {
      body: { action: "get" },
    });
    setMaintenance({
      maintenance_enabled: result.maintenance_enabled === true,
      maintenance_title: result.maintenance_title || DEFAULT_MAINTENANCE.maintenance_title,
      maintenance_message: result.maintenance_message || DEFAULT_MAINTENANCE.maintenance_message,
      maintenance_eta: result.maintenance_eta || null,
      allow_admin_bypass: result.allow_admin_bypass !== false,
    });
  }, []);

  const loadAll = useCallback(async () => {
    setIsBusy(true);
    try {
      await Promise.all([loadUsers(), loadAnnouncements(), loadMaintenance()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra carregar as notificações");
    } finally {
      setIsBusy(false);
    }
  }, [loadAnnouncements, loadMaintenance, loadUsers]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    return subscribeLocalDbChanges(() => {
      void loadAnnouncements();
      void loadMaintenance();
    });
  }, [loadAnnouncements, loadMaintenance]);

  const activeUsers = useMemo(() => users.filter((user) => user.account_status === "active"), [users]);

  const formTargetFilter = useMemo(() => ({
    planIds: form.planIds,
    accessLevelIds: form.accessLevelIds,
    roles: form.roles,
    userIds: form.userIds,
    matchMode: form.matchMode,
  }), [form.accessLevelIds, form.matchMode, form.planIds, form.roles, form.userIds]);

  const openCreateModal = () => {
    setForm(emptyForm());
    setPreviewCount(null);
    setIsModalOpen(true);
  };

  const openEditModal = (item: AnnouncementRow) => {
    setForm(formFromAnnouncement(item));
    setPreviewCount(null);
    setIsModalOpen(true);
  };

  const previewRecipients = async () => {
    setIsBusy(true);
    try {
      const result = await invokeBackendRpc<{ count: number }>("admin-announcements", {
        body: { action: "preview_recipients", target_filter: formTargetFilter },
      });
      setPreviewCount(Number(result.count || 0));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra calcular o alcance");
    } finally {
      setIsBusy(false);
    }
  };

  const saveAnnouncement = async () => {
    if (!form.title.trim() || !form.message.trim()) {
      toast.error("Coloca título e mensagem");
      return;
    }

    const period = buildPeriodPayload(form);
    if (period.starts_at && period.ends_at && new Date(period.ends_at) <= new Date(period.starts_at)) {
      toast.error("A data final tem que ser depois da inicial");
      return;
    }
    setIsBusy(true);
    try {
      if (form.id) {
        await invokeBackendRpc("admin-announcements", {
          body: {
            action: "update",
            id: form.id,
            title: form.title.trim(),
            message: form.message.trim(),
            severity: form.severity,
            channel: form.channel,
            auto_popup_on_login: form.autoPopup,
            starts_at: period.starts_at,
            ends_at: period.ends_at,
            target_filter: formTargetFilter,
            redeliver: false,
          },
        });
        toast.success("Notificação salva!");
      } else {
        await invokeBackendRpc("admin-announcements", {
          body: {
            action: "create",
            title: form.title.trim(),
            message: form.message.trim(),
            severity: form.severity,
            channel: form.channel,
            auto_popup_on_login: form.autoPopup,
            starts_at: period.starts_at,
            ends_at: period.ends_at,
            is_active: true,
            target_filter: formTargetFilter,
            deliver_now: true,
          },
        });
        toast.success("Notificação criada e enviada!");
      }

      setIsModalOpen(false);
      setForm(emptyForm());
      setPreviewCount(null);
      await loadAnnouncements();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra salvar a notificação");
    } finally {
      setIsBusy(false);
    }
  };

  const redeliverAnnouncement = async (id: string) => {
    setIsBusy(true);
    try {
      await invokeBackendRpc("admin-announcements", { body: { action: "deliver_now", id } });
      toast.success("Enviada!");
      await loadAnnouncements();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra reenviar");
    } finally {
      setIsBusy(false);
    }
  };

  const deactivateAnnouncement = async (id: string) => {
    setIsBusy(true);
    try {
      await invokeBackendRpc("admin-announcements", { body: { action: "deactivate", id } });
      toast.success("Desativada!");
      await loadAnnouncements();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra desativar");
    } finally {
      setIsBusy(false);
    }
  };

  const deleteAnnouncement = async (id: string) => {
    setIsBusy(true);
    try {
      await invokeBackendRpc("admin-announcements", { body: { action: "delete", id } });
      toast.success("Apagada!");
      await loadAnnouncements();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra apagar");
    } finally {
      setIsBusy(false);
    }
  };

  const saveMaintenance = async () => {
    setIsBusy(true);
    try {
      await invokeBackendRpc("admin-maintenance", {
        body: {
          action: "set",
          maintenance_enabled: maintenance.maintenance_enabled,
          maintenance_title: maintenance.maintenance_title,
          maintenance_message: maintenance.maintenance_message,
          maintenance_eta: maintenance.maintenance_eta,
          allow_admin_bypass: maintenance.allow_admin_bypass,
        },
      });
      toast.success("Manutenção salva!");
      await loadMaintenance();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra salvar a manutenção");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="admin-page">
      <PageHeader
        title="Notificações"
        description="Envie avisos pros usuários e controle o modo de manutenção"
      >
        <Button variant="outline" className="gap-2" onClick={() => void loadAll()} disabled={isBusy}>
          <RefreshCw className="h-4 w-4" />
          Atualizar
        </Button>
      </PageHeader>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "notifications" | "maintenance")}>
        <TabsList className="admin-toolbar h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="notifications" className="gap-2">
            <Bell className="h-4 w-4" />
            Notificações
          </TabsTrigger>
          <TabsTrigger value="maintenance" className="gap-2">
            <Wrench className="h-4 w-4" />
            Manutenção
          </TabsTrigger>
        </TabsList>

        <TabsContent value="notifications" className="space-y-4">
          <Card className="admin-card">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="admin-card-title flex items-center gap-2">
                <Megaphone className="h-4 w-4" />
                Notificações Criadas
              </CardTitle>
              <Button className="gap-2" onClick={openCreateModal} disabled={isBusy}>
                <Plus className="h-4 w-4" />
                Criar Notificação
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {announcements.length === 0 && (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  Nenhuma notificação criada.
                </div>
              )}

              {announcements.map((item) => (
                <div key={item.id} className="admin-card rounded-lg p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h4 className="font-medium">{item.title}</h4>
                    <Badge variant={item.is_active ? "default" : "secondary"} className="admin-chip">{item.is_active ? "Ativa" : "Inativa"}</Badge>
                    <Badge variant="outline" className="admin-chip">{severityLabel(item.severity)}</Badge>
                    <Badge variant="outline" className="admin-chip">{channelLabel(item.channel)}</Badge>
                    <Badge variant="outline" className="admin-chip gap-1">
                      <CalendarClock className="h-3 w-3" />
                      {periodLabel(item)}
                    </Badge>
                    <div className="flex-1" />
                    <Button size="sm" variant="outline" className="gap-1" onClick={() => openEditModal(item)} disabled={isBusy}>
                      <Pencil className="h-3.5 w-3.5" />
                      Editar
                    </Button>
                    {(() => {
                      const cooldownSec = redeliverCooldownSec(item.last_delivered_at);
                      return (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void redeliverAnnouncement(item.id)}
                          disabled={isBusy || cooldownSec > 0}
                          title={cooldownSec > 0 ? `Aguarde ${cooldownSec}s para reenviar novamente` : undefined}
                        >
                          <Send className="mr-1 h-3.5 w-3.5" />
                          {cooldownSec > 0 ? `Aguarde ${cooldownSec}s` : "Reenviar"}
                        </Button>
                      );
                    })()}
                    {item.is_active && (
                      <Button size="sm" variant="ghost" onClick={() => void deactivateAnnouncement(item.id)} disabled={isBusy}>
                        Desativar
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setPendingDelete(item)} disabled={isBusy}>
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Apagar
                    </Button>
                  </div>

                  <p className="text-sm text-muted-foreground">{item.message}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className="admin-chip">Entregues: {item.metrics?.delivered ?? 0}</Badge>
                    <Badge variant="outline" className="admin-chip">Lidas: {item.metrics?.read ?? 0}</Badge>
                    <Badge variant="outline" className="admin-chip">Não lidas: {item.metrics?.unread ?? 0}</Badge>
                    <Badge variant="outline" className="admin-chip">Descartadas: {item.metrics?.dismissed ?? 0}</Badge>
                    {(item.metrics?.delivered ?? 0) > 0 && (
                      <Badge variant="outline" className="admin-chip gap-1">
                        <Eye className="h-3 w-3" />
                        Taxa: {item.metrics?.read_rate ?? 0}%
                      </Badge>
                    )}
                    <Badge variant="outline" className="admin-chip">Início: {formatDateTimeForUi(item.starts_at)}</Badge>
                    <Badge variant="outline" className="admin-chip">Fim: {formatDateTimeForUi(item.ends_at)}</Badge>
                    {item.last_delivered_at && (
                      <Badge variant="outline" className="admin-chip">Último envio: {formatDateTimeForUi(item.last_delivered_at)}</Badge>
                    )}
                    <Badge variant="outline" className="admin-chip">Criada em: {formatDateTimeForUi(item.created_at)}</Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="maintenance" className="space-y-4">
          <Card className="admin-card">
            <CardHeader>
              <CardTitle className="admin-card-title flex items-center gap-2">
                <Wrench className="h-4 w-4" />
                Manutenção Global
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <Switch
                  checked={maintenance.maintenance_enabled}
                  onCheckedChange={(checked) => setMaintenance((prev) => ({ ...prev, maintenance_enabled: checked }))}
                />
                <span className="text-sm">Ativar manutenção (bloqueia o acesso dos clientes)</span>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Título</Label>
                  <Input
                    value={maintenance.maintenance_title}
                    onChange={(event) => setMaintenance((prev) => ({ ...prev, maintenance_title: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Previsão de volta</Label>
                  <Input
                    value={maintenance.maintenance_eta || ""}
                    onChange={(event) => setMaintenance((prev) => ({
                      ...prev,
                      maintenance_eta: event.target.value.trim() || null,
                    }))}
                    placeholder="Ex.: 12/03 às 23:30"
                  />
                </div>
              </div>

              <div className="space-y-2">
                  <Label>Mensagem</Label>
                <Textarea
                  rows={3}
                  value={maintenance.maintenance_message}
                  onChange={(event) => setMaintenance((prev) => ({ ...prev, maintenance_message: event.target.value }))}
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={maintenance.allow_admin_bypass}
                  onCheckedChange={(checked) => setMaintenance((prev) => ({ ...prev, allow_admin_bypass: checked }))}
                />
                <span className="text-sm">Admins podem acessar mesmo em manutenção</span>
              </div>

              <div className="flex justify-end">
                <Button onClick={() => void saveMaintenance()} disabled={isBusy}>
                  Salvar
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="max-w-4xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar Notificação" : "Criar Notificação"}</DialogTitle>
            <DialogDescription>
              Configure quem vai ver, por quanto tempo e como a notificação aparece.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Título</Label>
                <Input
                  value={form.title}
                  onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                  placeholder="Ex.: Nova regra de envio"
                />
              </div>
              <div className="space-y-2">
                <Label>Severidade</Label>
                <Select value={form.severity} onValueChange={(value) => setForm((prev) => ({ ...prev, severity: value as "info" | "warning" | "critical" }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">Informativa</SelectItem>
                    <SelectItem value="warning">Aviso</SelectItem>
                    <SelectItem value="critical">Crítica</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Mensagem</Label>
              <Textarea
                value={form.message}
                onChange={(event) => setForm((prev) => ({ ...prev, message: event.target.value }))}
                placeholder="Mensagem exibida para o usuário no sino e na central"
                rows={4}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Onde aparece</Label>
                <Select value={form.channel} onValueChange={(value) => setForm((prev) => ({ ...prev, channel: value as "bell" | "modal" | "both" }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bell">Só sino</SelectItem>
                    <SelectItem value="modal">Só modal</SelectItem>
                    <SelectItem value="both">Sino + modal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Filtro de alcance</Label>
                <Select value={form.matchMode} onValueChange={(value) => setForm((prev) => ({ ...prev, matchMode: value as "any" | "all" }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Pelo menos um (ANY)</SelectItem>
                    <SelectItem value="all">Todos juntos (ALL)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  <strong>Pelo menos um (ANY):</strong> avisa quem bater em qualquer critério.
                  {" "}<strong>Todos (ALL):</strong> só avisa quem bater em todos ao mesmo tempo.
                </p>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border p-3">
              <Label className="text-sm">Por quanto tempo</Label>
              <div className="grid gap-2 md:grid-cols-3">
                <Button
                  type="button"
                  variant={form.periodMode === "once" ? "default" : "outline"}
                  onClick={() => setForm((prev) => ({ ...prev, periodMode: "once" }))}
                >
                  Uma vez
                </Button>
                <Button
                  type="button"
                  variant={form.periodMode === "days" ? "default" : "outline"}
                  onClick={() => setForm((prev) => ({ ...prev, periodMode: "days" }))}
                >
                  Por alguns dias
                </Button>
                <Button
                  type="button"
                  variant={form.periodMode === "until_disable" ? "default" : "outline"}
                  onClick={() => setForm((prev) => ({ ...prev, periodMode: "until_disable" }))}
                >
                  Até eu desativar
                </Button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Começa em</Label>
                  <Input
                    type="datetime-local"
                    value={form.startsAt}
                    onChange={(event) => setForm((prev) => ({ ...prev, startsAt: event.target.value }))}
                  />
                </div>

                {form.periodMode === "once" && (
                  <div className="space-y-2">
                    <Label>Termina em</Label>
                    <Input
                      type="datetime-local"
                      value={form.endsAt}
                      onChange={(event) => setForm((prev) => ({ ...prev, endsAt: event.target.value }))}
                    />
                  </div>
                )}

                {form.periodMode === "days" && (
                  <div className="space-y-2">
                    <Label>Quantos dias</Label>
                    <Input
                      type="number"
                      min={1}
                      max={180}
                      value={String(form.visibleDays)}
                      onChange={(event) => {
                        const parsed = Number(event.target.value || "1");
                        setForm((prev) => ({ ...prev, visibleDays: Number.isFinite(parsed) ? Math.max(1, Math.min(180, parsed)) : 1 }));
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={form.autoPopup}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, autoPopup: checked }))}
              />
              <span className="text-sm">Mostrar popup no login</span>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-3 rounded-lg border p-3">
                <Label>Planos</Label>
                <div className="space-y-2">
                  {controlPlane.plans.map((plan) => (
                    <label key={plan.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.planIds.includes(plan.id)}
                        onCheckedChange={(checked) => setForm((prev) => ({
                          ...prev,
                          planIds: toggleInList(prev.planIds, plan.id, checked === true),
                        }))}
                      />
                      {plan.name}
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <Label>Níveis de Acesso</Label>
                <div className="space-y-2">
                  {controlPlane.accessLevels.map((level) => (
                    <label key={level.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.accessLevelIds.includes(level.id)}
                        onCheckedChange={(checked) => setForm((prev) => ({
                          ...prev,
                          accessLevelIds: toggleInList(prev.accessLevelIds, level.id, checked === true),
                        }))}
                      />
                      {level.name}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-3 rounded-lg border p-3">
                <Label>Tipo de usuário</Label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.roles.includes("user")}
                      onCheckedChange={(checked) => {
                        setForm((prev) => {
                          const next = new Set(prev.roles);
                          if (checked === true) next.add("user");
                          else next.delete("user");
                          return { ...prev, roles: [...next] as Array<"admin" | "user"> };
                        });
                      }}
                    />
                    Usuários
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.roles.includes("admin")}
                      onCheckedChange={(checked) => {
                        setForm((prev) => {
                          const next = new Set(prev.roles);
                          if (checked === true) next.add("admin");
                          else next.delete("admin");
                          return { ...prev, roles: [...next] as Array<"admin" | "user"> };
                        });
                      }}
                    />
                    Admins
                  </label>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <Label>Escolher usuários</Label>
                <div className="max-h-44 space-y-2 overflow-auto pr-1">
                  {activeUsers.map((user) => (
                    <label key={user.user_id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.userIds.includes(user.user_id)}
                        onCheckedChange={(checked) => setForm((prev) => ({
                          ...prev,
                          userIds: toggleInList(prev.userIds, user.user_id, checked === true),
                        }))}
                      />
                      <span className="line-clamp-1">{user.name} ({user.email})</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <div className="mr-auto flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void previewRecipients()} disabled={isBusy}>
                Ver alcance
              </Button>
              {previewCount != null && <Badge variant="secondary">{previewCount} destinatário(s)</Badge>}
            </div>
            <Button type="button" variant="outline" onClick={() => setIsModalOpen(false)} disabled={isBusy}>
              Cancelar
            </Button>
            <Button type="button" onClick={() => void saveAnnouncement()} disabled={isBusy}>
              {form.id ? "Salvar Alterações" : "Criar Notificação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDelete != null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar notificação?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso apaga a notificação de vez e tira ela da central dos usuários.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{pendingDelete?.title || "Notificação"}</p>
            {pendingDelete?.message && (
              <p className="mt-1 line-clamp-3 text-muted-foreground">{pendingDelete.message}</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const id = pendingDelete?.id;
                setPendingDelete(null);
                if (id) {
                  void deleteAnnouncement(id);
                }
              }}
              disabled={isBusy}
            >
              Apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

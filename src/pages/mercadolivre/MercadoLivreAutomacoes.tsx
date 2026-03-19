import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Plus, Pause, Trash2, Clock, Pencil, Copy, Play, RefreshCw, Filter } from "lucide-react";
import { useMeliAutomacoes, type CreateMeliAutomationInput, type MeliAutomationRow } from "@/hooks/useMeliAutomacoes";
import { useGrupos } from "@/hooks/useGrupos";
import { useTemplates } from "@/hooks/useTemplates";
import { useSessoes } from "@/hooks/useSessoes";
import { useSessionScopedGroups } from "@/hooks/useSessionScopedGroups";
import { useRotas } from "@/hooks/useRotas";
import { toast } from "sonner";
import { formatSystem } from "@/lib/timezone";
import { normalizeScheduleTime } from "@/lib/scheduling";
import { SessionSelect } from "@/components/selectors/SessionSelect";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";
import { useAuth } from "@/contexts/AuthContext";
import { backend } from "@/integrations/backend/client";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { keywordsToCsv, readAutomationKeywordFilters, splitKeywordCsv } from "@/lib/automation-keywords";
import { readMeliAutomationConfig } from "@/lib/meli-automation-config";

type FormState = {
  name: string;
  activeHoursStart: string;
  activeHoursEnd: string;
  intervalMinutes: string;
  minPrice: string;
  maxPrice: string;
  vitrineTabs: string[];
  sessionId: string;
  destinationGroupIds: string[];
  masterGroupIds: string[];
  templateId: string;
  positiveKeywords: string;
  negativeKeywords: string;
};

type MeliVitrineTabNode = {
  key: string;
  label: string;
  activeCount?: number;
  children?: MeliVitrineTabNode[];
};

type MeliVitrineCatalog = {
  tabs: MeliVitrineTabNode[];
};

const EMPTY_FORM: FormState = {
  name: "",
  activeHoursStart: "08:00",
  activeHoursEnd: "20:00",
  intervalMinutes: "30",
  minPrice: "",
  maxPrice: "",
  vitrineTabs: ["top_performance"],
  sessionId: "",
  destinationGroupIds: [],
  masterGroupIds: [],
  templateId: "",
  positiveKeywords: "",
  negativeKeywords: "",
};

function maskScheduleTimeInput(rawValue: string): string {
  const digits = String(rawValue || "").replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function flattenVitrineTabTree(nodes: MeliVitrineTabNode[], parentLabel = ""): Array<{
  key: string;
  label: string;
  activeCount: number;
}> {
  const out: Array<{ key: string; label: string; activeCount: number }> = [];
  for (const node of nodes) {
    const key = String(node.key || "").trim();
    const label = String(node.label || "").trim();
    if (!key || !label) continue;

    const fullLabel = parentLabel ? `${parentLabel} / ${label}` : label;
    out.push({
      key,
      label: fullLabel,
      activeCount: Number(node.activeCount || 0),
    });

    if (Array.isArray(node.children) && node.children.length > 0) {
      out.push(...flattenVitrineTabTree(node.children, fullLabel));
    }
  }

  const seen = new Set<string>();
  return out.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

function automationToForm(row: MeliAutomationRow): FormState {
  const keywordFilters = readAutomationKeywordFilters(row.config);
  const sourceConfig = readMeliAutomationConfig(row.config);
  return {
    name: row.name,
    activeHoursStart: row.active_hours_start || "08:00",
    activeHoursEnd: row.active_hours_end || "20:00",
    intervalMinutes: String(row.interval_minutes),
    minPrice: Number(row.min_price) > 0 ? String(row.min_price) : "",
    maxPrice: Number(row.max_price) < 9999 ? String(row.max_price) : "",
    vitrineTabs: sourceConfig.vitrineTabs,
    sessionId: row.session_id || "",
    destinationGroupIds: (row.destination_group_ids || []) as string[],
    masterGroupIds: (row.master_group_ids || []) as string[],
    templateId: row.template_id || "",
    positiveKeywords: keywordsToCsv(keywordFilters.positiveKeywords),
    negativeKeywords: keywordsToCsv(keywordFilters.negativeKeywords),
  };
}

export default function MercadoLivreAutomacoes() {
  const { user } = useAuth();
  const {
    automations,
    isLoading,
    createAutomation,
    updateAutomation,
    toggleAutomation,
    deleteAutomation,
    duplicateAutomation,
    pauseAllAutomations,
    resumeAllAutomations,
    refreshAllAutomations,
    isTogglingAutomation,
    isPausingAll,
    isResumingAll,
    isRefreshingAll,
  } = useMeliAutomacoes();
  const { syncedGroups, masterGroups } = useGrupos();
  const { templates, defaultTemplate } = useTemplates("meli");
  const { allSessions } = useSessoes();
  const { refreshAllRoutes } = useRotas();

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [isSyncingRoutes, setIsSyncingRoutes] = useState(false);
  const [isSyncingSingleRoutes, setIsSyncingSingleRoutes] = useState(false);

  const { data: vitrineCatalog } = useQuery({
    queryKey: ["meli-vitrine-tab-catalog"],
    queryFn: async () => await invokeBackendRpc<MeliVitrineCatalog>("meli-vitrine-list", {
      body: {
        tab: "top_performance",
        page: 1,
        limit: 1,
      },
    }),
    staleTime: 5 * 60 * 1000,
  });

  const vitrineTabOptions = useMemo(() => {
    const remoteTabs = flattenVitrineTabTree(vitrineCatalog?.tabs || []);
    if (remoteTabs.length > 0) return remoteTabs;
    return [{ key: "top_performance", label: "Top Performance", activeCount: 0 }];
  }, [vitrineCatalog?.tabs]);

  const tabLabelByKey = useMemo(() => {
    return new Map(vitrineTabOptions.map((item) => [item.key, item.label] as const));
  }, [vitrineTabOptions]);

  const connectedSessions = allSessions.filter((session) => session.status === "online");
  const shouldPauseAll = automations.some((item) => item.is_active);
  const isBulkTogglePending = isPausingAll || isResumingAll;
  const isHeaderActionPending = isBulkTogglePending || isRefreshingAll || isSyncingRoutes;
  const isSingleActionPending = isTogglingAutomation || isSyncingSingleRoutes;

  useEffect(() => {
    if (!user) return;

    void backend.from("history_entries").insert({
      user_id: user.id,
      type: "automation_trace",
      source: "Piloto automatico ML",
      destination: "tab:activated",
      status: "info",
      details: {
        message: "Aba de Piloto automatico ML ativada",
        step: "tab_activated",
        sourceRun: "smart-tab",
      },
      direction: "system",
      message_type: "text",
      processing_status: "processed",
      block_reason: "",
      error_step: "",
    });
  }, [user]);

  const { filteredGroups, filteredMasterGroups } = useSessionScopedGroups({
    sessionId: form.sessionId,
    groups: syncedGroups,
    masterGroups,
  });

  const openCreate = () => {
    const defaultTabKey = vitrineTabOptions[0]?.key || "top_performance";
    setEditingId(null);
    setForm({
      ...EMPTY_FORM,
      templateId: defaultTemplate?.id || "",
      vitrineTabs: [defaultTabKey],
    });
    setShowModal(true);
  };

  const openEdit = (automation: MeliAutomationRow) => {
    setEditingId(automation.id);
    setForm(automationToForm(automation));
    setShowModal(true);
  };

  const handleSessionChange = (sessionId: string) => {
    setForm((prev) => ({ ...prev, sessionId, destinationGroupIds: [], masterGroupIds: [] }));
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) { toast.error("De um nome para a automacao"); return; }
    if (!form.sessionId) { toast.error("Escolha a sessao de envio"); return; }
    if (!form.templateId) { toast.error("Escolha um template de mensagem"); return; }
    if (form.destinationGroupIds.length === 0 && form.masterGroupIds.length === 0) {
      toast.error("Escolha pelo menos um grupo de destino");
      return;
    }
    if (form.vitrineTabs.length === 0) {
      toast.error("Escolha ao menos uma categoria da Vitrine ML");
      return;
    }

    const normalizedStart = normalizeScheduleTime(form.activeHoursStart);
    const normalizedEnd = normalizeScheduleTime(form.activeHoursEnd);
    if (!normalizedStart || !normalizedEnd) {
      toast.error("Horario invalido. Use o formato HH:mm (ex: 09:30)");
      return;
    }

    setSubmitting(true);
    try {
      const input: CreateMeliAutomationInput = {
        name: form.name.trim(),
        intervalMinutes: parseInt(form.intervalMinutes, 10) || 30,
        minPrice: form.minPrice ? parseFloat(form.minPrice) : 0,
        maxPrice: form.maxPrice ? parseFloat(form.maxPrice) : 9999,
        vitrineTabs: form.vitrineTabs,
        destinationGroupIds: form.destinationGroupIds,
        masterGroupIds: form.masterGroupIds,
        templateId: form.templateId,
        sessionId: form.sessionId,
        activeHoursStart: normalizedStart,
        activeHoursEnd: normalizedEnd,
        positiveKeywords: splitKeywordCsv(form.positiveKeywords),
        negativeKeywords: splitKeywordCsv(form.negativeKeywords),
      };

      if (editingId) {
        await updateAutomation({ id: editingId, ...input });
      } else {
        await createAutomation(input);
      }
      setShowModal(false);
    } catch {
      // Handled in hook
    } finally {
      setSubmitting(false);
    }
  };

  const getSessionLabel = (sessionId: string | null) => {
    if (!sessionId) return null;
    return allSessions.find((session) => session.id === sessionId)?.label;
  };

  const getTemplateLabel = (templateId: string | null) => {
    if (!templateId) return null;
    return templates.find((template) => template.id === templateId)?.name;
  };

  const handleBulkToggleAndRefreshRoutes = async () => {
    setIsSyncingRoutes(true);
    try {
      if (shouldPauseAll) {
        await pauseAllAutomations();
      } else {
        await resumeAllAutomations();
      }
      await refreshAllRoutes();
    } finally {
      setIsSyncingRoutes(false);
    }
  };

  const handleSingleToggleAndRefreshRoutes = async (id: string, isActive: boolean) => {
    setIsSyncingSingleRoutes(true);
    try {
      await toggleAutomation(id, isActive);
      await refreshAllRoutes();
    } finally {
      setIsSyncingSingleRoutes(false);
    }
  };

  return (
    <div className="ds-page">
      <PageHeader title="Piloto automatico" description="Envie ofertas da Vitrine ML automaticamente para seus grupos">
        <div className="flex w-full flex-wrap items-center justify-center gap-2.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => { void refreshAllAutomations(); }}
            disabled={automations.length === 0 || isHeaderActionPending}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" />
            {isRefreshingAll ? "Atualizando..." : "Atualizar automacoes"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { void handleBulkToggleAndRefreshRoutes(); }}
            disabled={automations.length === 0 || isHeaderActionPending}
          >
            {shouldPauseAll ? <Pause className="mr-1.5 h-4 w-4" /> : <Play className="mr-1.5 h-4 w-4" />}
            {isBulkTogglePending
              ? (shouldPauseAll ? "Pausando..." : "Retomando...")
              : isSyncingRoutes
                ? "Atualizando rotas..."
                : (shouldPauseAll ? "Pausar automacoes" : "Retomar automacoes")}
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            Nova automacao
          </Button>
        </div>
      </PageHeader>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <Card key={index} className="glass">
              <CardContent className="p-5">
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : automations.length > 0 ? (
        <div className="space-y-4">
          {automations.map((automation) => {
            const sessionLabel = getSessionLabel(automation.session_id);
            const templateLabel = getTemplateLabel(automation.template_id);
            const activeStart = automation.active_hours_start || "08:00";
            const activeEnd = automation.active_hours_end || "20:00";
            const groupCount = (automation.destination_group_ids || []).length + (automation.master_group_ids || []).length;
            const keywordFilters = readAutomationKeywordFilters(automation.config);
            const sourceConfig = readMeliAutomationConfig(automation.config);

            return (
              <Card key={automation.id} className="glass">
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium leading-snug">{automation.name}</p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        Janela {activeStart}-{activeEnd} - A cada {automation.interval_minutes}min
                        {Number(automation.min_price) > 0 && ` - >=R$${automation.min_price}`}
                        {Number(automation.max_price) < 9999 && ` - <=R$${automation.max_price}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className={`text-xs ${automation.is_active ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                        {automation.is_active ? "Ativa" : "Pausada"}
                      </Badge>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(automation)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => duplicateAutomation(automation)} title="Duplicar">
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        disabled={isSingleActionPending}
                        onClick={() => { void handleSingleToggleAndRefreshRoutes(automation.id, automation.is_active); }}
                      >
                        {automation.is_active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => setDeleteId(automation.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary" className="text-xs">
                      Origem: Vitrine ML
                    </Badge>
                    {sourceConfig.vitrineTabs.map((tabKey) => (
                      <Badge key={tabKey} variant="outline" className="text-xs">
                        {tabLabelByKey.get(tabKey) || tabKey}
                      </Badge>
                    ))}
                    {sessionLabel && <Badge variant="secondary" className="text-xs">Sessao: {sessionLabel}</Badge>}
                    {templateLabel && <Badge variant="secondary" className="text-xs">Template: {templateLabel}</Badge>}
                    {groupCount > 0 && <Badge variant="secondary" className="text-xs">Grupos: {groupCount} grupo(s)</Badge>}
                    {keywordFilters.positiveKeywords.length > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        <Filter className="mr-1 h-2.5 w-2.5" />+{keywordFilters.positiveKeywords.length} positivas
                      </Badge>
                    )}
                    {keywordFilters.negativeKeywords.length > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        <Filter className="mr-1 h-2.5 w-2.5" />-{keywordFilters.negativeKeywords.length} negativas
                      </Badge>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span>{automation.products_sent} enviados</span>
                    {automation.last_run_at && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Ultimo: {formatSystem(automation.last_run_at, "dd/MM HH:mm")}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={Bot}
          title="Nenhuma automacao ainda"
          description="Crie automacoes para enviar ofertas da Vitrine ML sem precisar fazer nada."
          actionLabel="Criar automacao"
          onAction={openCreate}
        />
      )}

      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar automacao?</AlertDialogTitle>
            <AlertDialogDescription>
              A automacao <strong>{automations.find((item) => item.id === deleteId)?.name}</strong> vai ser apagada e nao tem como desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteId) deleteAutomation(deleteId);
                setDeleteId(null);
              }}
            >
              Apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto px-6 py-5">
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar automacao" : "Nova automacao"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label>Nome *</Label>
              <Input
                placeholder="Ex: Eletronicos relampago ML"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
                <Label>Horario que funciona (fuso do sistema)</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Inicio</span>
                    <Input
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="HH:mm"
                      value={form.activeHoursStart}
                      onChange={(event) => setForm({ ...form, activeHoursStart: maskScheduleTimeInput(event.target.value) })}
                      onBlur={(event) => {
                        const normalized = normalizeScheduleTime(event.target.value);
                        if (normalized) {
                          setForm((prev) => ({ ...prev, activeHoursStart: normalized }));
                        }
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Fim</span>
                    <Input
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="HH:mm"
                      value={form.activeHoursEnd}
                      onChange={(event) => setForm({ ...form, activeHoursEnd: maskScheduleTimeInput(event.target.value) })}
                      onBlur={(event) => {
                        const normalized = normalizeScheduleTime(event.target.value);
                        if (normalized) {
                          setForm((prev) => ({ ...prev, activeHoursEnd: normalized }));
                        }
                      }}
                    />
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">Use formato 24h: HH:mm</span>
              </div>

              <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
                <Label>Tempo entre envios (minutos) *</Label>
                <Input
                  type="number"
                  min="5"
                  value={form.intervalMinutes}
                  onChange={(event) => setForm({ ...form, intervalMinutes: event.target.value })}
                />
                <span className="text-xs text-muted-foreground">
                  Uma oferta vai ser enviada a cada {form.intervalMinutes || "30"} minutos
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Filtros de oferta <span className="font-normal text-muted-foreground">(nao precisa preencher)</span></Label>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Preco minimo (R$)</span>
                  <Input type="number" placeholder="Ex: 10" value={form.minPrice} onChange={(event) => setForm({ ...form, minPrice: event.target.value })} />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Preco maximo (R$)</span>
                  <Input type="number" placeholder="Ex: 500" value={form.maxPrice} onChange={(event) => setForm({ ...form, maxPrice: event.target.value })} />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Categorias da Vitrine ML</Label>
              <MultiOptionDropdown
                value={form.vitrineTabs}
                onChange={(ids) => setForm((prev) => ({ ...prev, vitrineTabs: ids }))}
                items={vitrineTabOptions.map((tab) => ({
                  id: tab.key,
                  label: tab.label,
                  meta: tab.activeCount > 0 ? `${tab.activeCount}` : undefined,
                }))}
                placeholder="Escolha as categorias da vitrine..."
                selectedLabel={(count) => `${count} categoria(s) da vitrine`}
                emptyMessage="Nenhuma categoria disponivel"
                title="Categorias da vitrine"
              />
            </div>

            <div className="space-y-2">
              <Label>Palavras-chave de filtro <span className="font-normal text-muted-foreground">(opcional)</span></Label>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                  <Label className="flex items-center gap-1.5 text-xs">
                    <span className="inline-block h-2 w-2 rounded-full bg-success" />
                    Palavras positivas
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder="iphone, samsung, notebook"
                    value={form.positiveKeywords}
                    onChange={(event) => setForm({ ...form, positiveKeywords: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Separe por virgula. A automacao so envia se a oferta tiver pelo menos uma dessas palavras.
                  </p>
                </div>
                <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                  <Label className="flex items-center gap-1.5 text-xs">
                    <span className="inline-block h-2 w-2 rounded-full bg-destructive" />
                    Palavras negativas
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder="usado, avariado, refil"
                    value={form.negativeKeywords}
                    onChange={(event) => setForm({ ...form, negativeKeywords: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Separe por virgula. Se a oferta tiver qualquer uma dessas palavras, ela e descartada.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Sessao de envio *</Label>
              <SessionSelect
                value={form.sessionId}
                onValueChange={handleSessionChange}
                sessions={connectedSessions}
                placeholder="Escolha uma sessao..."
                emptyLabel="Nenhuma sessao conectada"
              />
            </div>

            {form.sessionId && (
              <>
                <div className="space-y-2">
                  <Label>Grupos</Label>
                  <MultiOptionDropdown
                    value={form.destinationGroupIds}
                    onChange={(ids) => setForm((prev) => ({ ...prev, destinationGroupIds: ids }))}
                    items={filteredGroups.map((group) => ({
                      id: group.id,
                      label: group.name,
                      meta: `${group.memberCount}`,
                    }))}
                    placeholder="Escolha os grupos"
                    selectedLabel={(count) => `${count} grupo(s)`}
                    emptyMessage="Nenhum grupo nessa sessao"
                    title="Grupos"
                  />
                </div>

                {filteredMasterGroups.length > 0 && (
                  <div className="space-y-2">
                    <Label>Grupos mestre</Label>
                    <MultiOptionDropdown
                      value={form.masterGroupIds}
                      onChange={(ids) => setForm((prev) => ({ ...prev, masterGroupIds: ids }))}
                      items={filteredMasterGroups.map((masterGroup) => ({
                        id: masterGroup.id,
                        label: masterGroup.name,
                        meta: `${masterGroup.groupIds.length} grupos`,
                      }))}
                      placeholder="Escolher grupos mestres"
                      selectedLabel={(count) => `${count} grupo(s) mestre(s)`}
                      emptyMessage="Nenhum grupo mestre nessa sessao"
                      title="Grupos mestre"
                    />
                  </div>
                )}
              </>
            )}

            <div className="space-y-2">
              <Label>Template *</Label>
              <Select value={form.templateId} onValueChange={(value) => setForm({ ...form, templateId: value })}>
                <SelectTrigger><SelectValue placeholder="Escolha um template..." /></SelectTrigger>
                <SelectContent>
                  {templates.length === 0 && (
                    <SelectItem value="_none" disabled>Nenhum template criado</SelectItem>
                  )}
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                      {template.isDefault ? " *" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancelar</Button>
            <Button onClick={() => { void handleSubmit(); }} disabled={submitting}>
              {submitting ? "Salvando..." : editingId ? "Salvar" : "Criar automacao"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Plus, Pause, Trash2, Clock, Pencil, Copy, Play, RefreshCw, Filter } from "lucide-react";
import { useShopeeCredentials } from "@/hooks/useShopeeCredentials";
import { useShopeeAutomacoes, type CreateAutomationInput, type ShopeeAutomationRow } from "@/hooks/useShopeeAutomacoes";
import { useGrupos } from "@/hooks/useGrupos";
import { useTemplateModule } from "@/contexts/TemplateModuleContext";
import { useSessoes } from "@/hooks/useSessoes";
import { ShopeeCredentialsBanner } from "@/components/ShopeeCredentialsBanner";
import { CategoryMultiSelect } from "@/components/shopee/CategoryMultiSelect";
import { SHOPEE_CATEGORIES } from "@/lib/shopee-categories";
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
import {
  AUTOMATION_VITRINE_TAB_OPTIONS,
  keywordsToCsv,
  readAutomationKeywordFilters,
  readAutomationOfferSourceConfig,
  splitKeywordCsv,
} from "@/lib/automation-keywords";

type FormState = {
  name: string;
  activeHoursStart: string;
  activeHoursEnd: string;
  intervalMinutes: string;
  minDiscount: string;
  minCommission: string;
  minPrice: string;
  maxPrice: string;
  categories: string[];
  sessionId: string;
  destinationGroupIds: string[];
  masterGroupIds: string[];
  templateId: string;
  positiveKeywords: string;
  negativeKeywords: string;
  offerSourceMode: "search" | "vitrine";
  vitrineTabs: string[];
};

const EMPTY_FORM: FormState = {
  name: "",
  activeHoursStart: "08:00",
  activeHoursEnd: "20:00",
  intervalMinutes: "30",
  minDiscount: "",
  minCommission: "",
  minPrice: "",
  maxPrice: "",
  categories: [],
  sessionId: "",
  destinationGroupIds: [],
  masterGroupIds: [],
  templateId: "",
  positiveKeywords: "",
  negativeKeywords: "",
  offerSourceMode: "search",
  vitrineTabs: ["sales"],
};

function automationToForm(a: ShopeeAutomationRow): FormState {
  const keywordFilters = readAutomationKeywordFilters(a.config);
  const sourceConfig = readAutomationOfferSourceConfig(a.config);
  return {
    name: a.name,
    activeHoursStart: a.active_hours_start || "08:00",
    activeHoursEnd: a.active_hours_end || "20:00",
    intervalMinutes: String(a.interval_minutes),
    minDiscount: a.min_discount > 0 ? String(a.min_discount) : "",
    minCommission: a.min_commission > 0 ? String(a.min_commission) : "",
    minPrice: Number(a.min_price) > 0 ? String(a.min_price) : "",
    maxPrice: Number(a.max_price) < 9999 ? String(a.max_price) : "",
    categories: (a.categories || []) as string[],
    sessionId: a.session_id || "",
    destinationGroupIds: (a.destination_group_ids || []) as string[],
    masterGroupIds: (a.master_group_ids || []) as string[],
    templateId: a.template_id || "",
    positiveKeywords: keywordsToCsv(keywordFilters.positiveKeywords),
    negativeKeywords: keywordsToCsv(keywordFilters.negativeKeywords),
    offerSourceMode: sourceConfig.offerSourceMode,
    vitrineTabs: sourceConfig.vitrineTabs,
  };
}

export default function ShopeeAutomacoes() {
  const { user } = useAuth();
  const { isConfigured, isLoading: credLoading } = useShopeeCredentials();
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
  } = useShopeeAutomacoes();
  const { syncedGroups, masterGroups } = useGrupos();
  const { templates, defaultTemplate } = useTemplateModule();
  const { allSessions } = useSessoes();
  const { refreshAllRoutes } = useRotas();

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [isSyncingRoutes, setIsSyncingRoutes] = useState(false);
  const [isSyncingSingleRoutes, setIsSyncingSingleRoutes] = useState(false);

  const connectedSessions = allSessions.filter((s) => s.status === "online");
  const shouldPauseAll = automations.some((a) => a.is_active);
  const isBulkTogglePending = isPausingAll || isResumingAll;
  const isHeaderActionPending = isBulkTogglePending || isRefreshingAll || isSyncingRoutes;
  const isSingleActionPending = isTogglingAutomation || isSyncingSingleRoutes;

  useEffect(() => {
    if (!user) return;

    void backend.from("history_entries").insert({
      user_id: user.id,
      type: "automation_trace",
      source: "Piloto automático",
      destination: "tab:activated",
      status: "info",
      details: {
        message: "Aba de Piloto automático ativada",
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
    setEditingId(null);
    setForm({ ...EMPTY_FORM, templateId: defaultTemplate?.id || "" });
    setShowModal(true);
  };

  const openEdit = (auto: ShopeeAutomationRow) => {
    setEditingId(auto.id);
    setForm(automationToForm(auto));
    setShowModal(true);
  };

  // Reset groups when session changes
  const handleSessionChange = (sessionId: string) => {
    setForm((prev) => ({ ...prev, sessionId, destinationGroupIds: [], masterGroupIds: [] }));
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) { toast.error("Dê um nome pra automação"); return; }
    if (!form.sessionId) { toast.error("Escolha a sessão de envio"); return; }
    if (!form.templateId) { toast.error("Escolha um template de mensagem"); return; }
    if (form.destinationGroupIds.length === 0 && form.masterGroupIds.length === 0) {
      toast.error("Escolha pelo menos um grupo de destino"); return;
    }

    const normalizedStart = normalizeScheduleTime(form.activeHoursStart);
    const normalizedEnd = normalizeScheduleTime(form.activeHoursEnd);
    if (!normalizedStart || !normalizedEnd) {
      toast.error("Horário inválido. Use o formato HH:mm (ex: 09:30)");
      return;
    }

    setSubmitting(true);
    try {
      const input: CreateAutomationInput = {
        name: form.name.trim(),
        intervalMinutes: parseInt(form.intervalMinutes) || 30,
        minDiscount: form.minDiscount ? parseInt(form.minDiscount) : 0,
        minCommission: form.minCommission ? parseFloat(form.minCommission) : 0,
        minPrice: form.minPrice ? parseFloat(form.minPrice) : 0,
        maxPrice: form.maxPrice ? parseFloat(form.maxPrice) : 9999,
        categories: form.categories,
        destinationGroupIds: form.destinationGroupIds,
        masterGroupIds: form.masterGroupIds,
        templateId: form.templateId,
        sessionId: form.sessionId,
        activeHoursStart: normalizedStart,
        activeHoursEnd: normalizedEnd,
        positiveKeywords: splitKeywordCsv(form.positiveKeywords),
        negativeKeywords: splitKeywordCsv(form.negativeKeywords),
        offerSourceMode: form.offerSourceMode,
        vitrineTabs: form.vitrineTabs,
      };

      if (editingId) {
        await updateAutomation({ id: editingId, ...input });
      } else {
        await createAutomation(input);
      }
      setShowModal(false);
    } catch {
      // Error already handled by hook
    } finally {
      setSubmitting(false);
    }
  };

  const getSessionLabel = (sessionId: string | null) => {
    if (!sessionId) return null;
    return allSessions.find((s) => s.id === sessionId)?.label;
  };

  const getTemplateLabel = (templateId: string | null) => {
    if (!templateId) return null;
    return templates.find((t) => t.id === templateId)?.name;
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

  if (credLoading) return null;

  return (
    <div className="ds-page">
      <PageHeader title="Piloto automático" description="Envie ofertas da Shopee automaticamente pros seus grupos">
        <div className="flex w-full flex-wrap items-center justify-center gap-2.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => { void refreshAllAutomations(); }}
            disabled={automations.length === 0 || isHeaderActionPending}
          >
            <RefreshCw className="h-4 w-4 mr-1.5" />
            {isRefreshingAll ? "Atualizando..." : "Atualizar automações"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { void handleBulkToggleAndRefreshRoutes(); }}
            disabled={automations.length === 0 || isHeaderActionPending}
          >
            {shouldPauseAll ? <Pause className="h-4 w-4 mr-1.5" /> : <Play className="h-4 w-4 mr-1.5" />}
            {isBulkTogglePending
              ? (shouldPauseAll ? "Pausando..." : "Retomando...")
              : isSyncingRoutes
                ? "Atualizando rotas..."
                : (shouldPauseAll ? "Pausar automações" : "Retomar automações")}
          </Button>
          <Button size="sm" onClick={openCreate} disabled={!isConfigured}>
            <Plus className="h-4 w-4 mr-1.5" />Nova automação
          </Button>
        </div>
      </PageHeader>

      {!isConfigured && <ShopeeCredentialsBanner />}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className="glass"><CardContent className="p-5"><Skeleton className="h-20 w-full" /></CardContent></Card>
          ))}
        </div>
      ) : automations.length > 0 ? (
        <div className="space-y-4">
          {automations.map((auto) => {
            const sessionLabel = getSessionLabel(auto.session_id);
            const templateLabel = getTemplateLabel(auto.template_id);
            const activeStart = auto.active_hours_start || "08:00";
            const activeEnd = auto.active_hours_end || "20:00";
            const groupCount = (auto.destination_group_ids || []).length + (auto.master_group_ids || []).length;
            const keywordFilters = readAutomationKeywordFilters(auto.config);
            const sourceConfig = readAutomationOfferSourceConfig(auto.config);
            const vitrineTabsSet = new Set(sourceConfig.vitrineTabs);

            return (
              <Card key={auto.id} className="glass">
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium leading-snug">{auto.name}</p>
                      <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                        Janela {activeStart}-{activeEnd} - A cada {auto.interval_minutes}min
                        {auto.min_discount > 0 && ` - >=${auto.min_discount}% OFF`}
                        {auto.min_commission > 0 && ` - Comissão >=${auto.min_commission}%`}
                        {Number(auto.min_price) > 0 && ` - >=R$${auto.min_price}`}
                        {Number(auto.max_price) < 9999 && ` - <=R$${auto.max_price}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className={`text-xs ${auto.is_active ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                        {auto.is_active ? "Ativa" : "Pausada"}
                      </Badge>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(auto)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => duplicateAutomation(auto)} title="Duplicar">
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        disabled={isSingleActionPending}
                        onClick={() => { void handleSingleToggleAndRefreshRoutes(auto.id, auto.is_active); }}
                      >
                        {auto.is_active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => setDeleteId(auto.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary" className="text-xs">
                      Origem: {sourceConfig.offerSourceMode === "vitrine" ? "Vitrine de ofertas" : "Pesquisa de ofertas"}
                    </Badge>
                    {sourceConfig.offerSourceMode === "vitrine"
                      ? AUTOMATION_VITRINE_TAB_OPTIONS
                        .filter((tab) => vitrineTabsSet.has(tab.id))
                        .map((tab) => (
                          <Badge key={tab.id} variant="outline" className="text-xs">
                            {tab.label}
                          </Badge>
                        ))
                      : (auto.categories || []).map((cat) => {
                        const catId = isNaN(Number(cat)) ? cat : Number(cat);
                        const sc = SHOPEE_CATEGORIES.find((c) => c.id === catId || String(c.id) === cat);
                        return (
                          <Badge key={cat} variant="outline" className="text-xs">
                            {sc ? `${sc.icon} ${sc.label}` : cat}
                          </Badge>
                        );
                      })}
                    {sessionLabel && <Badge variant="secondary" className="text-xs">Sessão: {sessionLabel}</Badge>}
                    {templateLabel && <Badge variant="secondary" className="text-xs">Template: {templateLabel}</Badge>}
                    {groupCount > 0 && <Badge variant="secondary" className="text-xs">Grupos: {groupCount} grupo(s)</Badge>}
                    {keywordFilters.positiveKeywords.length > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        <Filter className="h-2.5 w-2.5 mr-1" />+{keywordFilters.positiveKeywords.length} positivas
                      </Badge>
                    )}
                    {keywordFilters.negativeKeywords.length > 0 && (
                      <Badge variant="secondary" className="text-xs">
                        <Filter className="h-2.5 w-2.5 mr-1" />-{keywordFilters.negativeKeywords.length} negativas
                      </Badge>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span>{auto.products_sent} enviados</span>
                    {auto.last_run_at && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Último: {formatSystem(auto.last_run_at, "dd/MM HH:mm")}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={Bot} title="Nenhuma automação ainda" description="Crie automações pra enviar ofertas da Shopee sem precisar fazer nada." actionLabel="Criar automação" onAction={openCreate} />
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar automação?</AlertDialogTitle>
            <AlertDialogDescription>A automação <strong>{automations.find((a) => a.id === deleteId)?.name}</strong> vai ser apagada e não tem como desfazer.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (deleteId) deleteAutomation(deleteId); setDeleteId(null); }}>Apagar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create / Edit Modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto px-6 py-5">
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar automação" : "Nova automação"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            {/* 1. Nome */}
            <div className="space-y-2">
              <Label>Nome *</Label>
              <Input
                placeholder="Ex: Eletronicos Flash"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {/* 2. Horário de funcionamento */}
              <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
                <Label>Horário que funciona (fuso do sistema)</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Início</span>
                    <Input
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="HH:mm"
                      value={form.activeHoursStart}
                      onChange={(e) => setForm({ ...form, activeHoursStart: e.target.value })}
                      onBlur={(e) => {
                        const normalized = normalizeScheduleTime(e.target.value);
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
                      onChange={(e) => setForm({ ...form, activeHoursEnd: e.target.value })}
                      onBlur={(e) => {
                        const normalized = normalizeScheduleTime(e.target.value);
                        if (normalized) {
                          setForm((prev) => ({ ...prev, activeHoursEnd: normalized }));
                        }
                      }}
                    />
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">Use formato 24h: HH:mm</span>
              </div>

              {/* 3. Intervalo */}
              <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
                <Label>Tempo entre envios (minutos) *</Label>
                <Input
                  type="number"
                  min="5"
                  value={form.intervalMinutes}
                  onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })}
                />
                <span className="text-xs text-muted-foreground">Uma oferta vai ser enviada a cada {form.intervalMinutes || "30"} minutos</span>
              </div>
            </div>

            {/* 4. Filtros opcionais */}
            <div className="space-y-2">
              <Label>Filtros de oferta <span className="text-muted-foreground font-normal">(não precisa preencher)</span></Label>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Desconto min (%)</span>
                  <Input type="number" placeholder="Ex: 40" value={form.minDiscount} onChange={(e) => setForm({ ...form, minDiscount: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Comissão mín. (%)</span>
                  <Input type="number" placeholder="Ex: 6" value={form.minCommission} onChange={(e) => setForm({ ...form, minCommission: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Preço mín. (R$)</span>
                  <Input type="number" placeholder="Ex: 10" value={form.minPrice} onChange={(e) => setForm({ ...form, minPrice: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Preço máx. (R$)</span>
                  <Input type="number" placeholder="Ex: 500" value={form.maxPrice} onChange={(e) => setForm({ ...form, maxPrice: e.target.value })} />
                </div>
              </div>
            </div>

            {/* 5. Origem das ofertas */}
            <div className="space-y-2">
              <Label>Origem das ofertas</Label>
              <Select
                value={form.offerSourceMode}
                onValueChange={(value: "search" | "vitrine") => {
                  setForm((prev) => ({
                    ...prev,
                    offerSourceMode: value,
                    vitrineTabs: value === "vitrine" && prev.vitrineTabs.length === 0 ? ["sales"] : prev.vitrineTabs,
                  }));
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="search">Pesquisa de ofertas</SelectItem>
                  <SelectItem value="vitrine">Vitrine de ofertas</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.offerSourceMode === "vitrine"
                  ? "Escolha as categorias da vitrine para capturar ofertas."
                  : "Use as categorias tradicionais da pesquisa de ofertas."}
              </p>
            </div>

            {/* 6. Categorias da origem selecionada */}
            {form.offerSourceMode === "vitrine" ? (
              <div className="space-y-2">
                <Label>Categorias da vitrine</Label>
                <MultiOptionDropdown
                  value={form.vitrineTabs}
                  onChange={(ids) => setForm((prev) => ({ ...prev, vitrineTabs: ids }))}
                  items={AUTOMATION_VITRINE_TAB_OPTIONS.map((tab) => ({
                    id: tab.id,
                    label: tab.label,
                  }))}
                  placeholder="Escolha as categorias da vitrine..."
                  selectedLabel={(count) => `${count} categoria(s) da vitrine`}
                  emptyMessage="Nenhuma categoria disponível"
                  title="Categorias da vitrine"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Categorias</Label>
                <CategoryMultiSelect
                  value={form.categories}
                  onChange={(categoryIds) => setForm({ ...form, categories: categoryIds })}
                  placeholder="Escolha as categorias..."
                />
              </div>
            )}

            {/* 7. Palavras-chave opcionais */}
            <div className="space-y-2">
              <Label>Palavras-chave de filtro <span className="text-muted-foreground font-normal">(opcional)</span></Label>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                  <Label className="text-xs flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-success inline-block" />
                    Palavras positivas
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder="iphone, samsung, notebook"
                    value={form.positiveKeywords}
                    onChange={(e) => setForm({ ...form, positiveKeywords: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Separe por vírgula. A automação só envia se a oferta tiver pelo menos uma dessas palavras.
                  </p>
                </div>
                <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                  <Label className="text-xs flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-destructive inline-block" />
                    Palavras negativas
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder="usado, avariado, refil"
                    value={form.negativeKeywords}
                    onChange={(e) => setForm({ ...form, negativeKeywords: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Separe por vírgula. Se a oferta tiver qualquer uma dessas palavras, ela é descartada.
                  </p>
                </div>
              </div>
            </div>

            {/* 8. Sessão (obrigatória) */}
            <div className="space-y-2">
              <Label>Sessão de envio *</Label>
              <SessionSelect
                value={form.sessionId}
                onValueChange={handleSessionChange}
                sessions={connectedSessions}
                placeholder="Escolha uma sessão..."
                emptyLabel="Nenhuma sessão conectada"
              />
            </div>

            {/* 9. Grupos destino (filtrados pela sessão) */}
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
                    emptyMessage="Nenhum grupo nessa sessão"
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
                      emptyMessage="Nenhum grupo mestre nessa sessão"
                      title="Grupos mestre"
                    />
                  </div>
                )}
              </>
            )}

            {/* 10. Template (obrigatório) */}
            <div className="space-y-2">
              <Label>Template *</Label>
              <Select value={form.templateId} onValueChange={(v) => setForm({ ...form, templateId: v })}>
                <SelectTrigger><SelectValue placeholder="Escolha um template..." /></SelectTrigger>
                <SelectContent>
                  {templates.length === 0 && (
                    <SelectItem value="_none" disabled>Nenhum template criado</SelectItem>
                  )}
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}{t.isDefault ? " *" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Salvando..." : editingId ? "Salvar" : "Criar automação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

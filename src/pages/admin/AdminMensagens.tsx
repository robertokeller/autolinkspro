import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Ban,
  Bell,
  Bot,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Edit,
  Eye,
  Filter,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Wand2,
  Timer,
  Trash2,
  TrendingUp,
  UserCheck,
  Users,
  XCircle,
  Zap,
  Phone,
  QrCode,
  Wifi,
  WifiOff,
  Unplug,
  X,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAdminBroadcast, type BroadcastRecord } from "@/hooks/useAdminBroadcast";
import { useAdminMessageAutomations, type AutomationTriggerType, type AutomationFormData, type MessageAutomation } from "@/hooks/useAdminMessageAutomations";
import { useAdminWhatsAppSession } from "@/hooks/useAdminWhatsAppSession";
import { formatBRT } from "@/lib/timezone";
import { formatPhoneDisplay } from "@/lib/phone-utils";
import { plans } from "@/lib/plans";
import { InlineLoadingState } from "@/components/InlineLoadingState";

import { PageHeader } from "@/components/PageHeader";

// ── Helpers ─────────────────────────────────────────────────────────────────────

const ACTIVE_PLANS = plans.filter((p) => p.isActive);

const TRIGGER_META: Record<AutomationTriggerType, { label: string; icon: React.ElementType; color: string; description: string }> = {
  plan_expiring:   { label: "Plano expirando",  icon: Timer,       color: "text-warning",    description: "Avisa o cliente X dias antes do plano vencer" },
  plan_expired:    { label: "Plano expirado",   icon: ShieldAlert, color: "text-destructive", description: "Avisa o cliente X dias após o plano vencer" },
  signup_welcome:  { label: "Boas-vindas",      icon: UserCheck,   color: "text-success",    description: "Mensagem de boas-vindas após o cadastro" },
  remarketing:     { label: "Remarketing",      icon: TrendingUp,  color: "text-info",       description: "Mensagem de reengajamento X dias após o cadastro" },
  cron:            { label: "Cron / Periódico", icon: Clock,       color: "text-primary",    description: "Disparo periódico configurável" },
};

const SUPPORTED_TRIGGER_TYPES: AutomationTriggerType[] = ["plan_expiring", "plan_expired", "signup_welcome", "remarketing"];

const EXPIRY_EVENT_PRESETS = [
  { daysBefore: 7, label: "Faltam 7 dias", helper: "Aviso inicial de renovação" },
  { daysBefore: 3, label: "Faltam 3 dias", helper: "Lembrete principal" },
  { daysBefore: 1, label: "Falta 1 dia", helper: "Último aviso antes do vencimento" },
] as const;

function broadcastStatusBadge(status: string) {
  switch (status) {
    case "sent":       return <Badge variant="success"     className="gap-1.5 text-xs font-medium"><CheckCircle2 className="h-3 w-3" />Enviado</Badge>;
    case "partial":    return <Badge variant="warning"     className="gap-1.5 text-xs font-medium"><AlertTriangle className="h-3 w-3" />Parcial</Badge>;
    case "failed":     return <Badge variant="destructive" className="gap-1.5 text-xs font-medium"><XCircle className="h-3 w-3" />Falhou</Badge>;
    case "processing": return <Badge variant="secondary"   className="gap-1.5 text-xs font-medium"><Loader2 className="h-3 w-3 animate-spin" />Enviando</Badge>;
    case "scheduled":  return <Badge variant="secondary"   className="gap-1.5 text-xs font-medium"><Calendar className="h-3 w-3" />Agendado</Badge>;
    case "cancelled":  return <Badge variant="secondary"   className="gap-1.5 text-xs font-medium"><Ban className="h-3 w-3" />Cancelado</Badge>;
    default:           return <Badge variant="secondary" className="text-xs font-medium">{status}</Badge>;
  }
}

const EMPTY_FORM: AutomationFormData = {
  name: "",
  description: "",
  trigger_type: "plan_expiring",
  trigger_config: { days_before: 3 },
  message_template: "",
  filter_plan: [],
};

function defaultConfigFor(type: AutomationTriggerType): Record<string, unknown> {
  switch (type) {
    case "plan_expiring":  return { days_before: 3 };
    case "plan_expired":   return { days_after: 1 };
    case "signup_welcome": return { days_after: 0 };
    case "remarketing":    return { days_since_signup: 30 };
    case "cron":           return { cron_expr: "0 9 * * 1" };
    default:               return {};
  }
}

// ── Automation form dialog ───────────────────────────────────────────────────────

interface AutomationDialogProps {
  open: boolean;
  onClose: () => void;
  initial?: MessageAutomation | null;
  draft?: AutomationFormData | null;
  onSave: (data: AutomationFormData & { automation_id?: string }) => Promise<void>;
  isSaving: boolean;
  onPreview: (data: Pick<AutomationFormData, "trigger_type" | "trigger_config" | "filter_plan">) => Promise<void>;
  isPreviewing: boolean;
  previewCount: number | null;
}

function AutomationDialog({ open, onClose, initial, draft, onSave, isSaving, onPreview, isPreviewing, previewCount }: AutomationDialogProps) {
  const [form, setForm] = useState<AutomationFormData>(EMPTY_FORM);

  useEffect(() => {
    if (open) {
      if (initial) {
        setForm({
          name: initial.name,
          description: initial.description,
          trigger_type: initial.trigger_type,
          trigger_config: initial.trigger_config ?? defaultConfigFor(initial.trigger_type),
          message_template: initial.message_template,
          filter_plan: initial.filter_plan ?? [],
        });
      } else if (draft) {
        setForm({
          ...draft,
          trigger_config: { ...(draft.trigger_config ?? defaultConfigFor(draft.trigger_type)) },
          filter_plan: [...(draft.filter_plan ?? [])],
        });
      } else {
        setForm(EMPTY_FORM);
      }
    }
  }, [open, initial, draft]);

  const setTrigger = (t: AutomationTriggerType) => {
    setForm((f) => ({ ...f, trigger_type: t, trigger_config: defaultConfigFor(t) }));
  };

  const setConfigNum = (key: string, val: string) => {
    setForm((f) => ({ ...f, trigger_config: { ...f.trigger_config, [key]: Number(val) } }));
  };

  const togglePlan = (id: string) => {
    setForm((f) => ({
      ...f,
      filter_plan: f.filter_plan.includes(id) ? f.filter_plan.filter((p) => p !== id) : [...f.filter_plan, id],
    }));
  };

  const handleSave = async () => {
    await onSave(initial ? { ...form, automation_id: initial.id } : form);
    onClose();
  };

  const meta = TRIGGER_META[form.trigger_type];
  const MetaIcon = meta.icon;

  const configFields = () => {
    switch (form.trigger_type) {
      case "plan_expiring":
        return (
          <div className="space-y-1">
            <Label className="text-xs">Dias antes do vencimento (evento exato)</Label>
            <Input
              type="number"
              min={1}
              max={30}
              value={String(form.trigger_config.days_before ?? 3)}
              onChange={(e) => setConfigNum("days_before", e.target.value)}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">Dispara uma vez, exatamente quando faltarem N dias para o vencimento.</p>
          </div>
        );
      case "plan_expired":
        return (
          <div className="space-y-1">
            <Label className="text-xs">Dias após o vencimento (evento exato)</Label>
            <Input
              type="number"
              min={0}
              max={30}
              value={String(form.trigger_config.days_after ?? 1)}
              onChange={(e) => setConfigNum("days_after", e.target.value)}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">Dispara uma vez, exatamente N dias após o vencimento.</p>
          </div>
        );
      case "signup_welcome":
        return (
          <div className="space-y-1">
            <Label className="text-xs">Dias após o cadastro</Label>
            <Input
              type="number"
              min={0}
              max={30}
              value={String(form.trigger_config.days_after ?? 0)}
              onChange={(e) => setConfigNum("days_after", e.target.value)}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">0 = mesmo dia do cadastro.</p>
          </div>
        );
      case "remarketing":
        return (
          <div className="space-y-1">
            <Label className="text-xs">Dias desde o cadastro</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={String(form.trigger_config.days_since_signup ?? 30)}
              onChange={(e) => setConfigNum("days_since_signup", e.target.value)}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">Mensagem enviada quando o usuário atingir N dias desde o cadastro.</p>
          </div>
        );
      case "cron":
        return (
          <div className="space-y-1">
            <Label className="text-xs">Expressão Cron</Label>
            <Input
              value={String(form.trigger_config.cron_expr ?? "0 9 * * 1")}
              onChange={(e) => setForm((f) => ({ ...f, trigger_config: { ...f.trigger_config, cron_expr: e.target.value } }))}
              className="h-8 font-mono"
              placeholder="0 9 * * 1"
            />
            <p className="text-xs text-muted-foreground">Formato padrão cron. Ex: <code>0 9 * * 1</code> = toda segunda às 09h.</p>
          </div>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader className="pb-1">
          <DialogTitle className="flex items-center gap-2.5 text-base">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
              <Bot className="h-3.5 w-3.5 text-primary" />
            </div>
            {initial ? "Editar Evento" : "Novo Evento"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Configure o gatilho, a audiência e a mensagem deste evento.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Name & Description */}
          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-foreground/80">Nome do evento <span className="text-destructive">*</span></Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ex: Aviso de vencimento — 3 dias"
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-foreground/80">Descrição <span className="text-muted-foreground font-normal">(opcional)</span></Label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Uso interno"
                className="h-9"
              />
            </div>
          </div>

          {/* Trigger type */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-foreground/80">Tipo de gatilho <span className="text-destructive">*</span></Label>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {SUPPORTED_TRIGGER_TYPES.map((t) => {
                const tm = TRIGGER_META[t];
                const TIcon = tm.icon;
                const selected = form.trigger_type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTrigger(t)}
                    className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-all ${
                      selected
                        ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20 shadow-sm"
                        : "border-border hover:border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                      selected ? "bg-primary/15" : "bg-muted"
                    }`}>
                      <TIcon className={`h-3.5 w-3.5 ${selected ? "text-primary" : tm.color}`} />
                    </div>
                    <div>
                      <p className="text-xs font-semibold leading-tight">{tm.label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground leading-snug">{tm.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">Cron / Periódico estará disponível em breve.</p>
          </div>

          {/* Config fields */}
          <div className="rounded-xl border bg-muted/30 p-3.5">
            <div className="mb-3 flex items-center gap-2">
              <div className={`flex h-5 w-5 items-center justify-center rounded-md bg-muted`}>
                <MetaIcon className={`h-3 w-3 ${meta.color}`} />
              </div>
              <span className="text-xs font-semibold text-foreground/70">{meta.label} — Configuração</span>
            </div>
            {configFields()}
          </div>

          {/* Plan filter */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-foreground/80">
              Filtrar por plano
              <span className="ml-1 font-normal text-muted-foreground">(vazio = todos os planos)</span>
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              {ACTIVE_PLANS.map((plan) => (
                <label
                  key={plan.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                    form.filter_plan.includes(plan.id)
                      ? "border-primary/40 bg-primary/5 text-foreground"
                      : "hover:bg-muted/50 text-muted-foreground"
                  }`}
                >
                  <Checkbox
                    checked={form.filter_plan.includes(plan.id)}
                    onCheckedChange={() => togglePlan(plan.id)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="font-medium">{plan.name}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Message */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-foreground/80">Mensagem <span className="text-destructive">*</span></Label>
            <Textarea
              value={form.message_template}
              onChange={(e) => setForm((f) => ({ ...f, message_template: e.target.value }))}
              placeholder="Olá! Seu plano expira em breve. Renove agora para continuar aproveitando todos os recursos..."
              rows={5}
              className="resize-none text-sm"
            />
            <p className="text-xs text-muted-foreground">Suporta *negrito*, _itálico_ e emojis para WhatsApp.</p>
          </div>

          {/* Preview */}
          <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs shadow-none"
              onClick={() => onPreview({ trigger_type: form.trigger_type, trigger_config: form.trigger_config, filter_plan: form.filter_plan })}
              disabled={isPreviewing}
            >
              {isPreviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
              Calcular audiência
            </Button>
            {previewCount !== null && (
              <span className="text-xs font-medium">
                {previewCount === 0 ? (
                  <span className="text-muted-foreground">Nenhum destinatário agora</span>
                ) : (
                  <span className="text-primary">{previewCount} destinatário(s) elegíveis</span>
                )}
              </span>
            )}
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>Cancelar</Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={isSaving || !form.name.trim() || !form.message_template.trim()}
            className="gap-1.5"
          >
            {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {initial ? "Salvar alterações" : "Criar evento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Broadcast history row ────────────────────────────────────────────────────────
function BroadcastHistoryRow({ b, onCancel, isCancelling }: { b: BroadcastRecord; onCancel: (id: string) => void; isCancelling: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-sm">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {broadcastStatusBadge(b.status)}
            <span className="text-sm font-medium truncate text-foreground">{b.message.slice(0, 70)}{b.message.length > 70 ? "…" : ""}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="text-xs text-muted-foreground">
              {b.scheduled_at
                ? `Agendado · ${formatBRT(b.scheduled_at, "dd/MM/yyyy HH:mm")}`
                : b.created_at
                ? formatBRT(b.created_at, "dd/MM/yyyy HH:mm")
                : ""}
            </span>
            {b.total_recipients > 0 && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="h-3 w-3" />{b.total_recipients}
              </span>
            )}
            {b.sent_count > 0 && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <CheckCircle2 className="h-3 w-3" />{b.sent_count}
              </span>
            )}
            {b.failed_count > 0 && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <XCircle className="h-3 w-3" />{b.failed_count}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          {b.status === "scheduled" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); onCancel(b.id); }}
              disabled={isCancelling}
            >
              <Ban className="h-3.5 w-3.5" />
            </Button>
          )}
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t bg-muted/20 px-4 py-4 space-y-3">
          <p className="whitespace-pre-wrap break-words text-sm text-foreground leading-relaxed">{b.message}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {b.filter_plan.length > 0 && (
              <span className="flex items-center gap-1">
                <Filter className="h-3 w-3" />Plano: {b.filter_plan.join(", ")}
              </span>
            )}
            {b.filter_status !== "all" && (
              <span className="flex items-center gap-1">
                <Filter className="h-3 w-3" />Status: {b.filter_status}
              </span>
            )}
            {b.completed_at && (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />Concluído em {formatBRT(b.completed_at, "dd/MM/yyyy HH:mm")}
              </span>
            )}
          </div>
          {Array.isArray(b.error_details) && b.error_details.length > 0 && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
              <p className="mb-2 text-xs font-semibold text-destructive">Erros de envio</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {b.error_details.slice(0, 5).map((e, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="font-mono text-foreground">{e.phone}</span>
                    <span className="text-muted-foreground">·</span>
                    <span>{e.error}</span>
                  </li>
                ))}
                {b.error_details.length > 5 && (
                  <li className="text-muted-foreground">…e mais {b.error_details.length - 5} erros</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Automation card ─────────────────────────────────────────────────────────────

function AutomationCard({
  auto,
  onEdit,
  onToggle,
  onDelete,
  onRun,
  isRunning,
  isToggling,
}: {
  auto: MessageAutomation;
  onEdit: (a: MessageAutomation) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onRun: (id: string) => void;
  isRunning: boolean;
  isToggling: boolean;
}) {
  const meta = TRIGGER_META[auto.trigger_type];
  const MetaIcon = meta.icon;

  const configLabel = () => {
    const c = auto.trigger_config ?? {};
    switch (auto.trigger_type) {
      case "plan_expiring":  return `Evento: ${c.days_before ?? 3} dia(s) antes do vencimento`;
      case "plan_expired":   return `Evento: ${c.days_after ?? 1} dia(s) após vencer`;
      case "signup_welcome": return `${c.days_after ?? 0} dias após cadastro`;
      case "remarketing":    return `${c.days_since_signup ?? 30} dias após cadastro`;
      case "cron":           return `Cron: ${c.cron_expr ?? "?"}`;
      default:               return "";
    }
  };

  return (
    <div className={`overflow-hidden rounded-xl border bg-card transition-all ${
      auto.is_active ? "shadow-sm" : "opacity-55"
    }`}>
      <div className="flex items-start gap-4 p-4">
        {/* Icon container */}
        <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
          auto.is_active ? "bg-muted border-border" : "bg-muted/50 border-dashed"
        }`}>
          <MetaIcon className={`h-4 w-4 ${auto.is_active ? meta.color : "text-muted-foreground"}`} />
        </div>

        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-snug truncate text-foreground">{auto.name}</p>
              {auto.description && (
                <p className="mt-0.5 text-xs text-muted-foreground truncate">{auto.description}</p>
              )}
            </div>
            <Switch
              checked={auto.is_active}
              onCheckedChange={() => onToggle(auto.id)}
              disabled={isToggling}
              className="shrink-0 mt-0.5"
              aria-label="Ativar/pausar evento"
            />
          </div>

          {/* Metadata pills */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium ${meta.color}`}>
              <MetaIcon className="h-3 w-3" />
              {meta.label}
            </span>
            <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {configLabel()}
            </span>
            {auto.filter_plan.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                <Filter className="h-3 w-3" />{auto.filter_plan.length} plano(s)
              </span>
            )}
          </div>

          {/* Message preview */}
          <p className="mt-2 text-xs text-muted-foreground line-clamp-2 leading-relaxed">{auto.message_template}</p>

          {/* Stats row */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" />{auto.run_count} execuções
            </span>
            {auto.last_run_at && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />Última: {formatBRT(auto.last_run_at, "dd/MM/yyyy HH:mm")}
              </span>
            )}
            {auto.last_run_sent > 0 && (
              <span className="flex items-center gap-1 text-emerald-600">
                <CheckCircle2 className="h-3 w-3" />{auto.last_run_sent} enviados
              </span>
            )}
            {auto.last_run_failed > 0 && (
              <span className="flex items-center gap-1 text-destructive">
                <XCircle className="h-3 w-3" />{auto.last_run_failed} falhas
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-1 border-t bg-muted/20 px-3 py-2">
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => onEdit(auto)}>
          <Edit className="h-3 w-3" />Editar
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-xs text-primary hover:bg-primary/10"
          onClick={() => onRun(auto.id)}
          disabled={isRunning}
        >
          {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Executar agora
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onDelete(auto.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────────

export default function AdminMensagens() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Broadcast hook
  const {
    broadcasts,
    isLoadingHistory,
    refetchHistory,
    previewRecipients,
    isPreviewing: isBroadcastPreviewing,
    previewData,
    sendBroadcast,
    isSending,
    scheduleBroadcast,
    isScheduling,
    cancelBroadcast,
    isCancelling,
  } = useAdminBroadcast();

  // Automation hook
  const {
    automations,
    isLoading: isLoadingAutos,
    createAutomation,
    isCreating,
    updateAutomation,
    isUpdating,
    toggleAutomation,
    isToggling,
    deleteAutomation,
    runNow,
    isRunning,
    previewAutomation,
    isPreviewing: isAutoPreviewing,
    previewCount,
  } = useAdminMessageAutomations();

  // WA session – full management
  const {
    session,
    isLoading: isLoadingSession,
    createSession,
    connectSession,
    disconnectSession,
    deleteSession,
    refresh: refreshWaStatus,
    refreshSession,
    isCreating: isCreatingSession,
    isConnecting,
    isDisconnecting,
    isDeleting: isDeletingSession,
    isRefreshing,
  } = useAdminWhatsAppSession();
  const isWaOnline = session?.status === "online";
  const isWaBusy = session ? ["connecting", "qr_code"].includes(session.status) : false;

  // Broadcast form state
  const [message, setMessage] = useState("");
  const [filterPlan, setFilterPlan] = useState<string[]>([]);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterUserIds, setFilterUserIds] = useState<string[]>([]);
  const [sendMode, setSendMode] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [showPreviewList, setShowPreviewList] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);

  // Automation dialog state
  const [autoDialogOpen, setAutoDialogOpen] = useState(false);
  const [editingAuto, setEditingAuto] = useState<MessageAutomation | null>(null);
  const [autoDraft, setAutoDraft] = useState<AutomationFormData | null>(null);
  const [deleteAutoId, setDeleteAutoId] = useState<string | null>(null);

  // WA connection state
  const [showQrDialog, setShowQrDialog] = useState(false);
  const [showDeleteWaConfirm, setShowDeleteWaConfirm] = useState(false);
  const previousStatusRef = useRef<string | null>(null);

  // Active tab
  const [activeTab, setActiveTab] = useState("broadcast");

  // URL param: ?users=id1,id2 pre-fills broadcast | ?tab=whatsapp switches tab
  useEffect(() => {
    const usersParam = searchParams.get("users");
    const tabParam = searchParams.get("tab");
    const validTabs = ["broadcast", "automations", "history", "whatsapp"];
    let changed = false;
    if (usersParam) {
      const ids = usersParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) {
        setFilterUserIds(ids);
        setActiveTab("broadcast");
        changed = true;
      }
    } else if (tabParam && validTabs.includes(tabParam)) {
      setActiveTab(tabParam);
      changed = true;
    }
    if (changed) setSearchParams(new URLSearchParams(), { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getFilters = () => ({ filterPlan, filterStatus, filterUserIds });

  // ── WA session effects ─────────────────────────────────────────────────────
  useEffect(() => {
    previousStatusRef.current = session?.status ?? null;
  }, [session]);

  useEffect(() => {
    if (!showQrDialog || !session) return;
    const shouldPoll = session.status === "connecting" || session.status === "qr_code";
    if (!shouldPoll) return;
    const interval = window.setInterval(() => refreshSession(session.id, { silent: true }), 1500);
    return () => window.clearInterval(interval);
  }, [showQrDialog, session, refreshSession]);

  // ── WA connection handlers ─────────────────────────────────────────────────
  const handleCreateAndConnect = useCallback(async () => {
    try {
      const id = await createSession();
      setShowQrDialog(true);
      await connectSession(id);
      refreshSession(id, { silent: true });
    } catch { /* toast handled by hook */ }
  }, [createSession, connectSession, refreshSession]);

  const handleWaConnect = useCallback(async () => {
    if (!session) return;
    setShowQrDialog(true);
    try {
      await connectSession(session.id);
      refreshSession(session.id, { silent: true });
    } catch { /* toast handled by hook */ }
  }, [session, connectSession, refreshSession]);

  const handleWaDisconnect = useCallback(async () => {
    if (!session) return;
    try { await disconnectSession(session.id); } catch { /* toast handled */ }
  }, [session, disconnectSession]);

  const handleWaDelete = useCallback(async () => {
    if (!session) return;
    try {
      await deleteSession(session.id);
      setShowDeleteWaConfirm(false);
      setShowQrDialog(false);
    } catch { /* toast handled */ }
  }, [session, deleteSession]);

  // ── WA QR dialog content renderer ─────────────────────────────────────────
  const renderQrContent = () => {
    if (!session) return null;
    if (session.status === "online") {
      return (
        <div className="flex flex-col items-center gap-5 py-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-success/15">
            <CheckCircle2 className="h-10 w-10 text-success" />
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold">Conectado!</p>
            <p className="mt-1 text-sm text-muted-foreground">O WhatsApp do sistema está online e pronto para uso.</p>
            {session.connectedAt && (
              <p className="mt-2 flex items-center justify-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                Conectado desde {formatBRT(session.connectedAt, "dd/MM 'às' HH:mm")}
              </p>
            )}
          </div>
        </div>
      );
    }
    if (session.status === "warning") {
      return (
        <div className="flex flex-col items-center gap-4 py-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-warning/15">
            <AlertTriangle className="h-8 w-8 text-warning" />
          </div>
          <div className="text-center">
            <p className="font-semibold">Não foi possível gerar o QR Code</p>
            <p className="mt-1 text-sm text-muted-foreground">O serviço WhatsApp pode estar fora do ar.</p>
          </div>
        </div>
      );
    }
    if (session.status === "qr_code" && session.qrCode) {
      return (
        <div className="flex flex-col items-center gap-4 py-2">
          <img
            src={session.qrCode}
            alt="QR Code do WhatsApp Admin"
            className="aspect-square w-full max-w-[280px] rounded-xl border bg-white p-2 shadow-md"
          />
          <p className="text-center text-sm text-muted-foreground">
            Abra o WhatsApp no celular → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> e leia o código acima.
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <div className="text-center">
          <p className="font-semibold">Gerando QR Code...</p>
          <p className="mt-1 text-sm text-muted-foreground">Aguardando resposta do WhatsApp. Pode levar alguns segundos.</p>
        </div>
      </div>
    );
  };

  const handlePreview = async () => {
    setShowPreviewList(false);
    await previewRecipients(getFilters());
    setShowPreviewList(true);
  };

  const handleSend = async () => {
    if (!message.trim()) return;
    if (sendMode === "now") {
      await sendBroadcast({ message, ...getFilters() });
      setMessage("");
    } else {
      if (!scheduledAt) return;
      await scheduleBroadcast({ message, scheduledAt, ...getFilters() });
      setMessage("");
      setScheduledAt("");
    }
    refetchHistory();
  };

  const togglePlanFilter = (id: string) => {
    setFilterPlan((prev) => prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]);
  };

  const handleSaveAuto = async (data: AutomationFormData & { automation_id?: string }) => {
    if (data.automation_id) {
      await updateAutomation(data as AutomationFormData & { automation_id: string });
    } else {
      await createAutomation(data);
    }
  };

  const openExpiryPreset = (daysBefore: number) => {
    const existing = automations.find((a) =>
      a.trigger_type === "plan_expiring"
      && Number(a.trigger_config?.days_before ?? 3) === daysBefore,
    );

    if (existing) {
      setEditingAuto(existing);
      setAutoDraft(null);
      setAutoDialogOpen(true);
      return;
    }

    setEditingAuto(null);
    setAutoDraft({
      name: `Aviso de vencimento - ${daysBefore} dia(s)`,
      description: `Evento automático quando faltarem ${daysBefore} dia(s) para vencer.`,
      trigger_type: "plan_expiring",
      trigger_config: { days_before: daysBefore },
      message_template: `Ola! Seu plano vence em ${daysBefore} dia(s). Renove agora para manter tudo funcionando sem interrupcao.`,
      filter_plan: [],
    });
    setAutoDialogOpen(true);
  };

  const canSend = isWaOnline && message.trim().length > 0 && (sendMode === "now" || scheduledAt !== "");
  const recipientCount = previewData?.count ?? null;

  const activeCount = automations.filter((a) => a.is_active).length;

  return (
    <div className="admin-page">
      <PageHeader 
        title="Central de Mensagens" 
        description="Disparos em massa e centro de eventos por ciclo de vida."
      >
        <div className="shrink-0 flex items-center justify-end">
          {session ? (
            <Badge
              variant={isWaOnline ? "success" : "secondary"}
              className="gap-1.5 px-2.5 py-1 text-xs font-medium"
            >
              {isWaOnline ? (
                <><CheckCircle2 className="h-3 w-3" />WhatsApp online</>
              ) : (
                <><XCircle className="h-3 w-3" />WhatsApp offline</>
              )}
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1.5 px-2.5 py-1 text-xs font-medium">
              <XCircle className="h-3 w-3" />WhatsApp não configurado
            </Badge>
          )}
        </div>
      </PageHeader>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:gap-6">
        <Card className="group overflow-hidden transition-all hover:shadow-md">
          <CardContent className="flex flex-col justify-center gap-2 p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Disparos</p>
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 transition-colors group-hover:bg-primary/20">
                <Send className="h-5 w-5 text-primary" />
              </div>
            </div>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-foreground">
              {broadcasts.filter((b) => b.status === "sent" || b.status === "partial").length}
            </p>
          </CardContent>
        </Card>
        
        <Card className="group overflow-hidden transition-all hover:shadow-md">
          <CardContent className="flex flex-col justify-center gap-2 p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Agendados</p>
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/10 transition-colors group-hover:bg-warning/20">
                <Calendar className="h-5 w-5 text-warning" />
              </div>
            </div>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-foreground">
              {broadcasts.filter((b) => b.status === "scheduled").length}
            </p>
          </CardContent>
        </Card>

        <Card className="group overflow-hidden transition-all hover:shadow-md">
          <CardContent className="flex flex-col justify-center gap-2 p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Eventos Ativos</p>
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 transition-colors group-hover:bg-emerald-500/20">
                <Bot className="h-5 w-5 text-emerald-500" />
              </div>
            </div>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-foreground">
              {activeCount}
            </p>
          </CardContent>
        </Card>

        <Card className="group overflow-hidden transition-all hover:shadow-md">
          <CardContent className="flex flex-col justify-center gap-2 p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Total de Eventos</p>
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/10 transition-colors group-hover:bg-blue-500/20">
                <Zap className="h-5 w-5 text-blue-500" />
              </div>
            </div>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-foreground">
              {automations.length}
            </p>
          </CardContent>
        </Card>
      </div>

      {!isWaOnline && (
        <div className="flex items-start md:items-center gap-4 rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/40">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-base font-bold text-amber-900 dark:text-amber-300">WhatsApp Oficial Desconectado</p>
            <p className="mt-0.5 text-sm text-amber-800 dark:text-amber-400">
              Disparos automáticos e em massa estão paralisados. Reconecte o aparelho na aba{" "}
              <button
                type="button"
                className="font-bold underline underline-offset-2 hover:text-amber-950 transition-colors dark:hover:text-amber-200"
                onClick={() => setActiveTab("whatsapp")}
              >
                WhatsApp
              </button>{" "}
              agora.
            </p>
          </div>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="mb-6 grid w-full grid-cols-4 h-12 p-1">
          <TabsTrigger value="broadcast" className="gap-2.5 h-full text-sm font-medium">
            <Send className="h-4 w-4" />
            <span className="hidden sm:inline">Disparo em Massa</span>
            <span className="sm:hidden">Disparo</span>
          </TabsTrigger>
          <TabsTrigger value="automations" className="gap-2.5 h-full text-sm font-medium">
            <Bot className="h-4 w-4" />
            <span className="hidden sm:inline">Centro de Eventos</span>
            <span className="sm:hidden">Eventos</span>
            {activeCount > 0 && (
              <span className="ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-emerald-500/20 px-1 text-2xs font-bold text-emerald-600">
                {activeCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2.5 h-full text-sm font-medium">
            <Clock className="h-4 w-4" />
            <span className="hidden sm:inline">Histórico</span>
            <span className="sm:hidden">Hist</span>
            {broadcasts.length > 0 && (
              <span className="ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary/15 px-1 text-2xs font-medium text-primary">
                {broadcasts.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="whatsapp" className="gap-2.5 h-full text-sm font-medium">
            <Phone className="h-4 w-4" />
            WhatsApp
            {session && !isWaOnline && (
              <span className="ml-0.5 flex h-2 w-2 rounded-full bg-amber-500" title="Offline" />
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Tab: Disparo em Massa ──────────────────────────────────────── */}
        <TabsContent value="broadcast" className="space-y-6 focus-visible:outline-none">
          <Card className="overflow-hidden border-border/50 shadow-sm transition-shadow hover:shadow-md">
            <CardHeader className="bg-muted/20 pb-4 pt-6 border-b border-border/50">
              <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                  <Users className="h-4 w-4 text-primary" />
                </div>
                Segmentação de audiência
              </CardTitle>
              <CardDescription className="text-sm pl-10 text-muted-foreground/80">
                Selecione o público-alvo do disparo. Deixe em branco para alcançar todos os clientes ativos.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              {/* Status filter */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground/80">Status do plano</Label>
                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger className="h-10 md:w-[320px] text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os clientes ativos</SelectItem>
                    <SelectItem value="active_plan">Apenas plano ativo (não vencido)</SelectItem>
                    <SelectItem value="expired_plan">Apenas plano vencido</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Plan filter */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2 text-sm font-medium text-foreground/80">
                  Filtrar por plano
                  <span className="font-normal text-muted-foreground text-xs bg-muted/60 px-2 py-0.5 rounded-full">(vazio = qualquer plano)</span>
                </Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
                  {ACTIVE_PLANS.map((plan) => (
                    <label
                      key={plan.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 md:py-4 transition-all ${
                        filterPlan.includes(plan.id)
                          ? "border-primary/50 bg-primary/5 text-primary shadow-sm"
                          : "border-border hover:border-primary/30 hover:bg-muted/30 text-muted-foreground"
                      }`}
                    >
                      <Checkbox
                        checked={filterPlan.includes(plan.id)}
                        onCheckedChange={() => togglePlanFilter(plan.id)}
                        className="h-4 w-4"
                      />
                      <span className="font-medium text-sm">{plan.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* User IDs */}
              {filterUserIds.length > 0 && (
                <div className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
                  <Filter className="h-4 w-4 text-primary shrink-0" />
                  <span className="flex-1 text-sm text-primary font-medium">{filterUserIds.length} usuário(s) selecionado(s) diretamente</span>
                  <button
                    className="text-sm font-semibold text-primary hover:text-primary/80 transition-colors"
                    onClick={() => setFilterUserIds([])}
                  >
                    Limpar
                  </button>
                </div>
              )}

              {/* Preview */}
              <div className="flex items-center gap-4 rounded-xl border border-dashed bg-muted/20 p-4">
                <Button
                  size="default"
                  variant="secondary"
                  className="gap-2 shrink-0 h-10 px-4"
                  onClick={() => void handlePreview()}
                  disabled={isBroadcastPreviewing}
                >
                  {isBroadcastPreviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                  Calcular audiência
                </Button>
                {recipientCount !== null && showPreviewList && (
                  <span className={`text-sm font-medium flex items-center gap-2 ${
                    recipientCount === 0 ? "text-muted-foreground" : "text-primary"
                  }`}>
                    {recipientCount === 0 ? (
                      <>Nenhum destinatário encontrado</>
                    ) : (
                      <><CheckCircle2 className="h-4 w-4" />{recipientCount} destinatário(s) elegível(is)</>
                    )}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-border/50 shadow-sm transition-shadow hover:shadow-md">
            <CardHeader className="bg-muted/20 pb-4 pt-6 border-b border-border/50">
              <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
                  <MessageSquare className="h-4 w-4 text-blue-500" />
                </div>
                Conteúdo da Mensagem
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6 pt-6">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Digite a mensagem para seus clientes..."
                rows={6}
                className="resize-none text-base p-4 min-h-[160px] rounded-xl shadow-sm"
                disabled={!isWaOnline}
              />

              {/* Send mode toggle */}
              <div className="flex overflow-hidden rounded-xl border shadow-sm">
                <button
                  type="button"
                  onClick={() => setSendMode("now")}
                  className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-semibold transition-all ${
                    sendMode === "now"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/30 hover:bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <Send className="h-4 w-4" />Enviar agora
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  onClick={() => setSendMode("schedule")}
                  className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-semibold transition-all ${
                    sendMode === "schedule"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/30 hover:bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <Calendar className="h-4 w-4" />Agendar envio
                </button>
              </div>

              {sendMode === "schedule" && (
                <div className="space-y-2 rounded-xl bg-muted/20 p-5 border border-dashed">
                  <Label className="text-sm font-semibold text-foreground/80">Data e hora do envio</Label>
                  <Input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="h-11 text-sm md:max-w-[400px]"
                    min={new Date().toISOString().slice(0, 16)}
                  />
                </div>
              )}

              <Button
                className="w-full gap-2.5 h-12 text-sm font-bold shadow-md transition-transform hover:translate-y-[-1px] active:translate-y-[1px]"
                size="lg"
                disabled={!canSend || isSending || isScheduling}
                onClick={() => void handleSend()}
              >
                {isSending || isScheduling ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : sendMode === "now" ? (
                  <Send className="h-5 w-5" />
                ) : (
                  <Calendar className="h-5 w-5" />
                )}
                {isSending ? "Enviando disparo…" : isScheduling ? "Agendando disparo…" : sendMode === "now" ? "Enviar mensagem agora" : "Agendar mensagem"}
              </Button>

              {!isWaOnline && (
                <div className="p-3 mt-4 text-center rounded-lg bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-900/50">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
                    Conecte o WhatsApp na aba correspondiente para habilitar o envio.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Centro de Eventos ─────────────────────────────────────── */}
        <TabsContent value="automations" className="space-y-6 focus-visible:outline-none">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-bold tracking-tight">Centro de Eventos Programados</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Programe avisos por status e janelas do ciclo de vida, com foco em eventos exatos (ex: faltam X dias).
              </p>
            </div>
            <Button
              size="default"
              className="gap-2 shrink-0 h-10 w-full sm:w-auto shadow-sm"
              onClick={() => {
                setEditingAuto(null);
                setAutoDraft(null);
                setAutoDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              Novo evento
            </Button>
          </div>

          <Card className="overflow-hidden border-primary/20 bg-primary/5">
            <CardHeader className="py-4">
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="h-4 w-4 text-primary" />
                Atalhos de eventos de vencimento
              </CardTitle>
              <CardDescription className="text-xs">
                Crie rapidamente eventos padrão para avisar quando estiver faltando 7, 3 ou 1 dia para vencer.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 pb-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {EXPIRY_EVENT_PRESETS.map((preset) => (
                  <Button
                    key={preset.daysBefore}
                    variant="outline"
                    className="h-auto items-start justify-start gap-3 px-3 py-3 text-left"
                    onClick={() => openExpiryPreset(preset.daysBefore)}
                  >
                    <Timer className="mt-0.5 h-4 w-4 text-amber-600" />
                    <span className="flex flex-col">
                      <span className="text-xs font-semibold text-foreground">{preset.label}</span>
                      <span className="text-xs text-muted-foreground">{preset.helper}</span>
                    </span>
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-amber-500/30 bg-amber-500/5">
            <CardHeader className="py-4">
              <div className="flex items-start sm:items-center justify-between gap-4 flex-col sm:flex-row">
                <div className="space-y-1">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Timer className="h-4 w-4 text-amber-600" />
                    Aviso de Vencimento Padrão (Substitui Período de Graça)
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Ao invés de estender acesso com "Dias de Graça", notifique ativamente o cliente antes do plano expirar.
                    Clique em configurar para criar o evento do tipo <strong>Plano expirando</strong>.
                  </CardDescription>
                </div>
                <Button 
                  size="sm" 
                  variant="outline" 
                  className="gap-2 shrink-0 bg-background border-amber-200 hover:bg-amber-50"
                  onClick={() => {
                    const existing = automations.find(a => a.trigger_type === "plan_expiring");
                    if (existing) {
                      setEditingAuto(existing);
                      setAutoDraft(null);
                    } else {
                      setEditingAuto(null);
                      setAutoDraft({
                        ...EMPTY_FORM,
                        name: "Aviso de vencimento - 3 dias",
                        description: "Evento padrão de renovação com antecedência.",
                        trigger_type: "plan_expiring",
                        trigger_config: { days_before: 3 },
                        message_template: "Ola! Seu plano vence em 3 dias. Renove para manter seu acesso ativo sem interrupcao.",
                      });
                    }
                    setAutoDialogOpen(true);
                  }}
                >
                  <Edit className="h-4 w-4 text-amber-700" />
                  {automations.find(a => a.trigger_type === "plan_expiring") ? "Editar aviso existente" : "Configurar agora"}
                </Button>
              </div>
            </CardHeader>
          </Card>

          {isLoadingAutos ? (
            <InlineLoadingState label="Carregando eventos..." />
          ) : automations.length === 0 ? (
            <Card className="border-dashed bg-muted/10 shadow-sm">
              <CardContent className="flex flex-col items-center justify-center gap-5 py-20 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-dashed border-border bg-background shadow-sm">
                  <Bot className="h-8 w-8 text-muted-foreground" />
                </div>
                <div className="max-w-sm space-y-2">
                  <p className="text-xl font-bold tracking-tight">Nenhum evento configurado</p>
                  <p className="text-sm text-muted-foreground leading-relaxed mx-auto">
                    Crie engajamento enviando mensagens automáticas de boas-vindas, lembretes de vencimento ou remarketing.
                  </p>
                </div>
                <Button
                  size="default"
                  className="gap-2 mt-2"
                  onClick={() => {
                    setEditingAuto(null);
                    setAutoDraft(null);
                    setAutoDialogOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Criar meu primeiro evento
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Trigger type grouping hints */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-5">
                {(Object.keys(TRIGGER_META) as AutomationTriggerType[]).map((t) => {
                  const cnt = automations.filter((a) => a.trigger_type === t).length;
                  const activeCnt = automations.filter((a) => a.trigger_type === t && a.is_active).length;
                  const tm = TRIGGER_META[t];
                  const TIcon = tm.icon;
                  return (
                    <div key={t} className={`flex flex-col gap-2 rounded-xl border p-4 transition-all shadow-sm ${
                      cnt > 0 ? "bg-card hover:border-primary/30" : "border-dashed bg-muted/10 opacity-70"
                    }`}>
                      <div className={`flex items-center justify-center h-8 w-8 rounded-lg bg-muted text-center`}>
                        <TIcon className={`h-4 w-4 ${tm.color}`} />
                      </div>
                      <div className="mt-1">
                        <p className="text-sm font-bold leading-tight text-foreground">{tm.label}</p>
                        <p className="text-xs font-medium text-muted-foreground mt-0.5">{activeCnt}/{cnt} regras ativas</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-4 pt-2">
                {automations.map((auto) => (
                  <AutomationCard
                    key={auto.id}
                    auto={auto}
                    onEdit={(a) => {
                      setEditingAuto(a);
                      setAutoDraft(null);
                      setAutoDialogOpen(true);
                    }}
                    onToggle={toggleAutomation}
                    onDelete={(id) => setDeleteAutoId(id)}
                    onRun={runNow}
                    isRunning={isRunning}
                    isToggling={isToggling}
                  />
                ))}
              </div>
            </>
          )}

          {/* Automation trigger guide */}
          <div className="rounded-xl border border-dashed bg-muted/20 p-5 mt-8">
            <div className="mb-4 flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Como funcionam os gatilhos do centro de eventos</span>
            </div>
            <div className="grid grid-cols-1 gap-4 text-sm text-muted-foreground sm:grid-cols-2 md:grid-cols-4">
              <div className="flex flex-col gap-1.5 p-3 rounded-lg border border-border/50 bg-background/50">
                <div className="flex items-center gap-2 text-foreground/90 font-semibold">
                  <Timer className="h-4 w-4 text-amber-500" />
                  Plano expirando
                </div>
                <span>Notifica automaticamente o cliente avisando X dias antes do vencimento ocorrer.</span>
              </div>
              <div className="flex flex-col gap-1.5 p-3 rounded-lg border border-border/50 bg-background/50">
                <div className="flex items-center gap-2 text-foreground/90 font-semibold">
                  <ShieldAlert className="h-4 w-4 text-red-500" />
                  Plano expirado
                </div>
                <span>Avisa clientes cujo plano expirou faz X dias, oferecendo um link de renovação.</span>
              </div>
              <div className="flex flex-col gap-1.5 p-3 rounded-lg border border-border/50 bg-background/50">
                <div className="flex items-center gap-2 text-foreground/90 font-semibold">
                  <UserCheck className="h-4 w-4 text-emerald-500" />
                  Boas-vindas
                </div>
                <span>Manda mensagem para novos cadastros (onboarding) no dia ou até depois de X dias.</span>
              </div>
              <div className="flex flex-col gap-1.5 p-3 rounded-lg border border-border/50 bg-background/50">
                <div className="flex items-center gap-2 text-foreground/90 font-semibold">
                  <TrendingUp className="h-4 w-4 text-blue-500" />
                  Remarketing
                </div>
                <span>Tenta reengajar inativos X dias após o primeiro cadastro no sistema.</span>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ── Tab: Histórico ─────────────────────────────────────────────── */}
        <TabsContent value="history" className="space-y-6 focus-visible:outline-none">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-lg font-bold tracking-tight text-foreground">Histórico de disparos</h2>
              <p className="text-sm text-muted-foreground mt-1">Acompanhe as mensagens enviadas e falhas de envio.</p>
            </div>
            <Button size="default" variant="outline" className="gap-2 h-10 w-full sm:w-auto shadow-sm" onClick={() => void refetchHistory()}>
              <RefreshCw className="h-4 w-4" />
              Atualizar lista
            </Button>
          </div>

          {isLoadingHistory ? (
            <InlineLoadingState label="Carregando histórico..." />
          ) : broadcasts.length === 0 ? (
            <Card className="border-dashed bg-muted/10 shadow-sm">
              <CardContent className="flex flex-col items-center justify-center gap-4 py-20 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-dashed border-border bg-background shadow-sm">
                  <Bell className="h-8 w-8 text-muted-foreground" />
                </div>
                <div className="space-y-1 max-w-[260px]">
                  <p className="text-lg font-bold tracking-tight">Nenhum disparo ainda</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    O histórico de todas as mensagens aparecerá aqui.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {broadcasts.map((b) => (
                <BroadcastHistoryRow
                  key={b.id}
                  b={b}
                  onCancel={setCancelConfirmId}
                  isCancelling={isCancelling}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Tab: WhatsApp ──────────────────────────────────────────────── */}
        <TabsContent value="whatsapp" className="space-y-6 focus-visible:outline-none">
          {isLoadingSession && <InlineLoadingState label="Carregando sessão do WhatsApp..." />}

          {!isLoadingSession && !session && (
            <Card className="border-dashed bg-muted/10 shadow-sm">
              <CardContent className="flex flex-col items-center justify-center gap-6 py-20 text-center">
                <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-dashed border-border bg-background shadow-sm">
                  <QrCode className="h-10 w-10 text-muted-foreground" />
                </div>
                <div className="space-y-2 max-w-sm">
                  <p className="text-xl font-bold tracking-tight">Nenhum WhatsApp conectado</p>
                  <p className="text-sm text-muted-foreground leading-relaxed mx-auto">
                    Conecte o WhatsApp do sistema para começar a enviar mensagens aos seus clientes de forma automatizada e em massa.
                  </p>
                </div>
                <Button
                  size="lg"
                  className="gap-2 px-8 h-12 text-sm font-bold shadow-md transition-transform hover:translate-y-[-1px]"
                  onClick={() => void handleCreateAndConnect()}
                  disabled={isCreatingSession || isConnecting}
                >
                  {isCreatingSession || isConnecting ? <Loader2 className="h-5 w-5 animate-spin" /> : <QrCode className="h-5 w-5" />}
                  Conectar WhatsApp
                </Button>
              </CardContent>
            </Card>
          )}

          {!isLoadingSession && session && (
            <Card className={`overflow-hidden shadow-sm transition-all ${isWaOnline ? "ring-2 ring-success/40" : "border-border/50"}`}>
              <div className={`h-1.5 w-full ${isWaOnline ? "bg-success" : isWaBusy ? "bg-blue-500" : session.status === "warning" ? "bg-warning" : "bg-muted-foreground/30"}`} />
              <CardHeader className="pb-4 bg-muted/10 border-b border-border/50">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-background shadow-sm border border-border/50 shrink-0">
                      <Phone className="h-6 w-6 text-foreground/80" />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="text-xl font-bold tracking-tight truncate">
                        {session.name}
                      </CardTitle>
                      <CardDescription className="mt-1 text-sm font-medium tabular-nums flex items-center gap-2">
                        {session.phoneNumber ? formatPhoneDisplay(session.phoneNumber) : "Número detectado após conexão"}
                        <span className="text-muted-foreground/40">•</span>
                        Dispositivo Oficial
                      </CardDescription>
                    </div>
                  </div>
                  <Badge
                    variant={isWaOnline ? "success" : session.status === "warning" ? "warning" : "secondary"}
                    className="shrink-0 gap-1.5 px-3 py-1.5 text-xs font-semibold shadow-sm w-fit"
                  >
                    {isWaOnline ? <Wifi className="h-3.5 w-3.5" /> : isWaBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WifiOff className="h-3.5 w-3.5" />}
                    {isWaOnline ? "Online e Pronto" : isWaBusy ? "Conectando..." : session.status === "warning" ? "Aviso" : "Dispositivo Offline"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-6 pt-6">
                {isWaOnline && session.connectedAt && (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-success/20 bg-success/10 px-4 py-3 text-sm text-success-foreground font-medium shadow-sm">
                    <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
                    <span>Conexão ativa e funcionando corretamente desde {formatBRT(session.connectedAt, "dd/MM/yyyy 'às' HH:mm")}</span>
                  </div>
                )}
                {session.errorMessage && (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground font-medium shadow-sm">
                    <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
                    <span>{session.errorMessage}</span>
                  </div>
                )}
                {!isWaOnline && (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 font-medium shadow-sm dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-400">
                    <WifiOff className="h-5 w-5 shrink-0" />
                    <span>
                      WhatsApp desconectado. As funcionalidades de envio (em massa e eventos programados) estão pausadas até que o aparelho seja reconectado.
                    </span>
                  </div>
                )}
                
                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <Button size="default" variant="outline" className="gap-2 h-10 shadow-sm" onClick={() => void refreshWaStatus()} disabled={isRefreshing}>
                    {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Testar status
                  </Button>
                  {!isWaOnline && (
                    <Button size="default" className="gap-2 h-10 shadow-md transition-transform hover:translate-y-[-1px]" onClick={() => void handleWaConnect()} disabled={isConnecting}>
                      {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                      {isWaBusy ? "Ver QR Code" : "Reconectar Aparelho"}
                    </Button>
                  )}
                  {(isWaOnline || isWaBusy) && (
                    <Button size="default" variant="destructive" className="gap-2 h-10 shadow-sm" onClick={() => void handleWaDisconnect()} disabled={isDisconnecting}>
                      {isDisconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                      Desconectar
                    </Button>
                  )}
                  <div className="flex-1 min-w-[20px]" />
                  <Button
                    size="default"
                    variant="ghost"
                    className="gap-2 h-10 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setShowDeleteWaConfirm(true)}
                    disabled={isDeletingSession}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remover do Sistema
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="border-dashed bg-muted/10 shadow-none">
            <CardHeader className="pb-3 pt-5">
              <CardTitle className="flex items-center justify-center gap-2 text-sm font-bold tracking-tight text-foreground/80 uppercase">
                <MessageSquare className="h-4 w-4" />
                Como funciona
              </CardTitle>
            </CardHeader>
            <CardContent className="pb-6">
              <ul className="space-y-3 text-sm text-muted-foreground/90 max-w-3xl mx-auto px-4">
                <li className="flex items-start gap-3">
                  <div className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  <span>Conecte via <strong>QR Code</strong> — o número do seu WhatsApp fica como sendo a linha oficial do sistema.</span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  <span>Use <strong>Disparo em Massa</strong> para notificar clientes filtrados por plano ou status.</span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  <span>Configure <strong>Eventos Programados</strong> para disparos baseados no ciclo de vida (expiração, cadastro).</span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  <span>A conexão é monitorada pela nossa nuvem continuamente. Se cair ou desconectar por algum motivo (ex: aparelho sem bateria), basta ler o QR Code novamente para tudo voltar a rodar.</span>
                </li>
              </ul>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── QR Code Dialog ────────────────────────────────────────────────── */}
      <Dialog open={showQrDialog} onOpenChange={setShowQrDialog}>
        <DialogContent className="max-h-[92dvh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{session?.status === "online" ? "WhatsApp conectado!" : "Escanear QR Code"}</DialogTitle>
            <DialogDescription>
              {session?.status === "online" ? "O WhatsApp do sistema está online." : "Use o WhatsApp no celular para ler o QR Code abaixo."}
            </DialogDescription>
          </DialogHeader>
          {renderQrContent()}
          <div className="flex justify-end gap-2 pt-2">
            {session?.status === "online" ? (
              <Button className="w-full" onClick={() => setShowQrDialog(false)}>
                <CheckCircle2 className="mr-2 h-4 w-4" />Concluir
              </Button>
            ) : session?.status === "warning" ? (
              <>
                <Button variant="outline" onClick={() => setShowQrDialog(false)}>Fechar</Button>
                <Button onClick={() => void handleWaConnect()} disabled={isConnecting}>
                  {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Tentar novamente"}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setShowQrDialog(false)}>Cancelar</Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete WhatsApp session confirm ───────────────────────────────── */}
      <AlertDialog open={showDeleteWaConfirm} onOpenChange={setShowDeleteWaConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover WhatsApp do sistema?</AlertDialogTitle>
            <AlertDialogDescription>
              A sessão será desconectada e removida. Você poderá conectar novamente depois.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleWaDelete()}
              disabled={isDeletingSession}
            >
              {isDeletingSession ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Automation dialog ────────────────────────────────────────────── */}
      <AutomationDialog
        open={autoDialogOpen}
        onClose={() => {
          setAutoDialogOpen(false);
          setAutoDraft(null);
        }}
        initial={editingAuto}
        draft={autoDraft}
        onSave={handleSaveAuto}
        isSaving={isCreating || isUpdating}
        onPreview={(d) => previewAutomation(d).then(() => undefined)}
        isPreviewing={isAutoPreviewing}
        previewCount={previewCount}
      />

      {/* ── Delete automation confirm ────────────────────────────────────── */}
      <AlertDialog open={!!deleteAutoId} onOpenChange={(v) => !v && setDeleteAutoId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir evento?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. O evento será permanentemente excluído.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (deleteAutoId) await deleteAutomation(deleteAutoId);
                setDeleteAutoId(null);
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Cancel broadcast confirm ─────────────────────────────────────── */}
      <AlertDialog open={!!cancelConfirmId} onOpenChange={(v) => !v && setCancelConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar agendamento?</AlertDialogTitle>
            <AlertDialogDescription>
              O broadcast agendado será cancelado e não será enviado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (cancelConfirmId) await cancelBroadcast(cancelConfirmId);
                setCancelConfirmId(null);
                refetchHistory();
              }}
            >
              Cancelar disparo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

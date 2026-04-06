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
import { plans } from "@/lib/plans";
import { InlineLoadingState } from "@/components/InlineLoadingState";

// ── Helpers ─────────────────────────────────────────────────────────────────────

const ACTIVE_PLANS = plans.filter((p) => p.isActive);

const TRIGGER_META: Record<AutomationTriggerType, { label: string; icon: React.ElementType; color: string; description: string }> = {
  plan_expiring:   { label: "Plano expirando",  icon: Timer,       color: "text-amber-500",  description: "Avisa o cliente X dias antes do plano vencer" },
  plan_expired:    { label: "Plano expirado",   icon: ShieldAlert, color: "text-red-500",    description: "Avisa o cliente X dias após o plano vencer" },
  signup_welcome:  { label: "Boas-vindas",      icon: UserCheck,   color: "text-emerald-500",description: "Mensagem de boas-vindas após o cadastro" },
  remarketing:     { label: "Remarketing",      icon: TrendingUp,  color: "text-blue-500",   description: "Mensagem de reengajamento X dias após o cadastro" },
  cron:            { label: "Cron / Periódico", icon: Clock,       color: "text-purple-500", description: "Disparo periódico configurável" },
};

const SUPPORTED_TRIGGER_TYPES: AutomationTriggerType[] = ["plan_expiring", "plan_expired", "signup_welcome", "remarketing"];

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
  onSave: (data: AutomationFormData & { automation_id?: string }) => Promise<void>;
  isSaving: boolean;
  onPreview: (data: Pick<AutomationFormData, "trigger_type" | "trigger_config" | "filter_plan">) => Promise<void>;
  isPreviewing: boolean;
  previewCount: number | null;
}

function AutomationDialog({ open, onClose, initial, onSave, isSaving, onPreview, isPreviewing, previewCount }: AutomationDialogProps) {
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
      } else {
        setForm(EMPTY_FORM);
      }
    }
  }, [open, initial]);

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
            <Label className="text-xs">Dias antes do vencimento</Label>
            <Input
              type="number"
              min={1}
              max={30}
              value={String(form.trigger_config.days_before ?? 3)}
              onChange={(e) => setConfigNum("days_before", e.target.value)}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">Mensagem enviada quando faltam N dias para o plano expirar.</p>
          </div>
        );
      case "plan_expired":
        return (
          <div className="space-y-1">
            <Label className="text-xs">Dias após o vencimento</Label>
            <Input
              type="number"
              min={0}
              max={30}
              value={String(form.trigger_config.days_after ?? 1)}
              onChange={(e) => setConfigNum("days_after", e.target.value)}
              className="h-8"
            />
            <p className="text-xs text-muted-foreground">Mensagem enviada N dias depois do plano ter expirado.</p>
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
            {initial ? "Editar Automação" : "Nova Automação"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Configure o gatilho, a audiência e a mensagem desta automação.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Name & Description */}
          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-foreground/80">Nome da automação <span className="text-destructive">*</span></Label>
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
            {initial ? "Salvar alterações" : "Criar automação"}
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
      case "plan_expiring":  return `${c.days_before ?? 3} dias antes do vencimento`;
      case "plan_expired":   return `${c.days_after ?? 1} dias após vencer`;
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
              aria-label="Ativar/pausar automação"
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

  // WA session (read-only status)
  const { session } = useAdminWhatsAppSession();
  const isWaOnline = session?.status === "online";

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
  const [deleteAutoId, setDeleteAutoId] = useState<string | null>(null);

  // Active tab
  const [activeTab, setActiveTab] = useState("broadcast");

  // URL param: ?users=id1,id2 pre-fills broadcast
  useEffect(() => {
    const usersParam = searchParams.get("users");
    if (usersParam) {
      const ids = usersParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) {
        setFilterUserIds(ids);
        setActiveTab("broadcast");
        setSearchParams(new URLSearchParams(), { replace: true });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getFilters = () => ({ filterPlan, filterStatus, filterUserIds });

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

  const canSend = isWaOnline && message.trim().length > 0 && (sendMode === "now" || scheduledAt !== "");
  const recipientCount = previewData?.count ?? null;

  const activeCount = automations.filter((a) => a.is_active).length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <MessageSquare className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight leading-tight">Central de Mensagens</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Disparos em massa, remarketing e automações por ciclo de vida.
            </p>
          </div>
        </div>
        <div className="shrink-0">
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
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="overflow-hidden border-l-2 border-l-primary">
          <CardContent className="flex items-start justify-between pt-4 pb-3 px-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Disparos</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{broadcasts.filter((b) => b.status === "sent" || b.status === "partial").length}</p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/8">
              <Send className="h-3.5 w-3.5 text-primary" />
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden border-l-2 border-l-amber-500">
          <CardContent className="flex items-start justify-between pt-4 pb-3 px-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agendados</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{broadcasts.filter((b) => b.status === "scheduled").length}</p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/8">
              <Calendar className="h-3.5 w-3.5 text-amber-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden border-l-2 border-l-emerald-500">
          <CardContent className="flex items-start justify-between pt-4 pb-3 px-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Automações</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{activeCount}</p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/8">
              <Bot className="h-3.5 w-3.5 text-emerald-500" />
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden border-l-2 border-l-blue-500">
          <CardContent className="flex items-start justify-between pt-4 pb-3 px-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total regras</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{automations.length}</p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/8">
              <Zap className="h-3.5 w-3.5 text-blue-500" />
            </div>
          </CardContent>
        </Card>
      </div>

      {!isWaOnline && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/50 dark:bg-amber-950/20">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/40">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">WhatsApp não está online</p>
            <p className="mt-0.5 text-xs text-amber-700/80 dark:text-amber-400/80">
              Configure e conecte o WhatsApp em{" "}
              <a href="/admin/whatsapp" className="font-medium underline underline-offset-2">Admin → WhatsApp</a>{" "}
              para habilitar os disparos.
            </p>
          </div>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3 h-10">
          <TabsTrigger value="broadcast" className="gap-2 text-xs font-medium">
            <Send className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Disparo em Massa</span>
            <span className="sm:hidden">Disparo</span>
          </TabsTrigger>
          <TabsTrigger value="automations" className="gap-2 text-xs font-medium">
            <Bot className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Automações</span>
            <span className="sm:hidden">Automações</span>
            {activeCount > 0 && (
              <span className="ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-emerald-500/20 px-1 text-2xs font-bold text-emerald-600">
                {activeCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2 text-xs font-medium">
            <Clock className="h-3.5 w-3.5" />
            Histórico
            {broadcasts.length > 0 && (
              <span className="ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary/15 px-1 text-2xs font-medium text-primary">
                {broadcasts.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ── Tab: Disparo em Massa ──────────────────────────────────────── */}
        <TabsContent value="broadcast" className="mt-4 space-y-3">
          <Card>
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                Segmentação de audiência
              </CardTitle>
              <CardDescription className="text-xs pl-8">
                Selecione o público-alvo do disparo. Deixe em branco para alcançar todos os clientes ativos.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Status filter */}
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-foreground/70">Status do plano</Label>
                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger className="h-8 text-xs">
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
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-foreground/70">
                  Filtrar por plano
                  <span className="ml-1 font-normal text-muted-foreground">(vazio = qualquer plano)</span>
                </Label>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {ACTIVE_PLANS.map((plan) => (
                    <label
                      key={plan.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors ${
                        filterPlan.includes(plan.id)
                          ? "border-primary/40 bg-primary/5 text-foreground font-medium"
                          : "hover:bg-muted/50 text-muted-foreground"
                      }`}
                    >
                      <Checkbox
                        checked={filterPlan.includes(plan.id)}
                        onCheckedChange={() => togglePlanFilter(plan.id)}
                        className="h-3.5 w-3.5"
                      />
                      {plan.name}
                    </label>
                  ))}
                </div>
              </div>

              {/* User IDs */}
              {filterUserIds.length > 0 && (
                <div className="flex items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-3.5 py-2.5">
                  <Filter className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span className="flex-1 text-xs text-primary font-medium">{filterUserIds.length} usuário(s) selecionado(s) diretamente</span>
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                    onClick={() => setFilterUserIds([])}
                  >
                    Limpar
                  </button>
                </div>
              )}

              {/* Preview */}
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-8 text-xs"
                  onClick={() => void handlePreview()}
                  disabled={isBroadcastPreviewing}
                >
                  {isBroadcastPreviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                  Calcular audiência
                </Button>
                {recipientCount !== null && showPreviewList && (
                  <span className={`text-xs font-medium ${
                    recipientCount === 0 ? "text-muted-foreground" : "text-primary"
                  }`}>
                    {recipientCount === 0 ? "Nenhum destinatário" : `${recipientCount} destinatário(s)`}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                Mensagem
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Digite a mensagem para seus clientes..."
                rows={6}
                className="resize-none text-sm"
                disabled={!isWaOnline}
              />

              {/* Send mode toggle */}
              <div className="flex overflow-hidden rounded-lg border">
                <button
                  type="button"
                  onClick={() => setSendMode("now")}
                  className={`flex flex-1 items-center justify-center gap-2 py-2.5 text-xs font-medium transition-colors ${
                    sendMode === "now"
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <Send className="h-3.5 w-3.5" />Enviar agora
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  onClick={() => setSendMode("schedule")}
                  className={`flex flex-1 items-center justify-center gap-2 py-2.5 text-xs font-medium transition-colors ${
                    sendMode === "schedule"
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted/60 text-muted-foreground"
                  }`}
                >
                  <Calendar className="h-3.5 w-3.5" />Agendar envio
                </button>
              </div>

              {sendMode === "schedule" && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-foreground/70">Data e hora do envio</Label>
                  <Input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="h-9 text-xs"
                    min={new Date().toISOString().slice(0, 16)}
                  />
                </div>
              )}

              <Button
                className="w-full gap-2"
                size="default"
                disabled={!canSend || isSending || isScheduling}
                onClick={() => void handleSend()}
              >
                {isSending || isScheduling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : sendMode === "now" ? (
                  <Send className="h-4 w-4" />
                ) : (
                  <Calendar className="h-4 w-4" />
                )}
                {isSending ? "Enviando…" : isScheduling ? "Agendando…" : sendMode === "now" ? "Enviar mensagem" : "Agendar mensagem"}
              </Button>

              {!isWaOnline && (
                <p className="text-center text-xs text-muted-foreground">
                  Conecte o WhatsApp para habilitar o envio.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Automações ────────────────────────────────────────────── */}
        <TabsContent value="automations" className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Regras de automação</h2>
              <p className="text-xs text-muted-foreground">
                Disparadas automaticamente pelo ciclo de vida dos clientes.
              </p>
            </div>
            <Button
              size="sm"
              className="gap-1.5 shrink-0"
              onClick={() => { setEditingAuto(null); setAutoDialogOpen(true); }}
            >
              <Plus className="h-3.5 w-3.5" />
              Nova automação
            </Button>
          </div>

          {isLoadingAutos ? (
            <InlineLoadingState label="Carregando automações..." />
          ) : automations.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-5 py-14">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-dashed border-muted-foreground/30 bg-muted">
                  <Bot className="h-7 w-7 text-muted-foreground" />
                </div>
                <div className="space-y-1 text-center">
                  <p className="text-sm font-semibold">Nenhuma automação configurada</p>
                  <p className="mx-auto max-w-[260px] text-xs text-muted-foreground leading-relaxed">
                    Crie regras para avisar clientes sobre vencimento de plano, dar boas-vindas ou fazer remarketing.
                  </p>
                </div>
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => { setEditingAuto(null); setAutoDialogOpen(true); }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Criar primeira automação
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Trigger type grouping hints */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {(Object.keys(TRIGGER_META) as AutomationTriggerType[]).map((t) => {
                  const cnt = automations.filter((a) => a.trigger_type === t).length;
                  const activeCnt = automations.filter((a) => a.trigger_type === t && a.is_active).length;
                  const tm = TRIGGER_META[t];
                  const TIcon = tm.icon;
                  return (
                    <div key={t} className={`flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 transition-opacity ${
                      cnt > 0 ? "bg-muted/30" : "border-dashed opacity-35"
                    }`}>
                      <TIcon className={`h-3.5 w-3.5 ${tm.color}`} />
                      <p className="text-xs font-semibold leading-tight text-foreground">{tm.label}</p>
                      <p className="text-xs text-muted-foreground">{activeCnt}/{cnt} ativa(s)</p>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-3">
                {automations.map((auto) => (
                  <AutomationCard
                    key={auto.id}
                    auto={auto}
                    onEdit={(a) => { setEditingAuto(a); setAutoDialogOpen(true); }}
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
          <div className="rounded-xl border border-dashed bg-muted/20 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Wand2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Como funcionam as automações</span>
            </div>
            <div className="grid grid-cols-1 gap-2.5 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="flex gap-2.5">
                <Timer className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                <span><span className="font-semibold text-foreground/80">Plano expirando:</span> Notifica X dias antes do vencimento.</span>
              </div>
              <div className="flex gap-2.5">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-0.5 text-red-500" />
                <span><span className="font-semibold text-foreground/80">Plano expirado:</span> Avisa clientes sem plano e solicita renovação.</span>
              </div>
              <div className="flex gap-2.5">
                <UserCheck className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-500" />
                <span><span className="font-semibold text-foreground/80">Boas-vindas:</span> Onboarding no dia (ou dias após) o cadastro.</span>
              </div>
              <div className="flex gap-2.5">
                <TrendingUp className="h-3.5 w-3.5 shrink-0 mt-0.5 text-blue-500" />
                <span><span className="font-semibold text-foreground/80">Remarketing:</span> Reengaja clientes X dias após o cadastro.</span>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ── Tab: Histórico ─────────────────────────────────────────────── */}
        <TabsContent value="history" className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">Histórico de disparos</p>
            <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={() => void refetchHistory()}>
              <RefreshCw className="h-3.5 w-3.5" />
              Atualizar
            </Button>
          </div>

          {isLoadingHistory ? (
            <InlineLoadingState label="Carregando histórico..." />
          ) : broadcasts.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-4 py-14">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-dashed border-muted-foreground/30 bg-muted">
                  <Bell className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">Nenhum disparo realizado ainda.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
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
      </Tabs>

      {/* ── Automation dialog ───────────────────────────────────────────── */}
      <AutomationDialog
        open={autoDialogOpen}
        onClose={() => setAutoDialogOpen(false)}
        initial={editingAuto}
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
            <AlertDialogTitle>Excluir automação?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. A automação será permanentemente excluída.
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

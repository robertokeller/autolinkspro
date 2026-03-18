import { useCallback, useEffect, useState } from "react";
import { perfilSchema } from "@/lib/validations";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  User,
  Bell,
  CalendarClock,
  CreditCard,
  Save,
  AlertTriangle,
  Users,
  Route,
  Flame,
  FileText,
  CheckCircle2,
  ArrowUpRight,
  Shield,
  KeyRound,
  Download,
  Eye,
  EyeOff,
  Check,
} from "lucide-react";
import { TelegramIcon, WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";
import { defaultAdminControlPlaneState } from "@/lib/admin-control-plane";
import { getFeatureAccessPolicyByPlan, resolveEffectiveLimitsByPlanId, resolveEffectiveOperationalLimitsByPlanId } from "@/lib/access-control";
import { useAdminControlPlane } from "@/hooks/useAdminControlPlane";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/components/ThemeProvider";
import { backend } from "@/integrations/backend/client";
import { subscribeLocalDbChanges } from "@/integrations/backend/local-core";
import type { Json } from "@/integrations/backend/types";
import { toast } from "sonner";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { getPasswordPolicyError, PASSWORD_POLICY_HINT } from "@/lib/password-policy";

interface NotificationPrefs {
  routeErrors: boolean;
  automationComplete: boolean;
  sessionDisconnected: boolean;
  dailyReport: boolean;
  lowQuotaAlert: boolean;
  weeklyPerformanceDigest: boolean;
}

interface ProrationState {
  targetPlanId: string;
  targetPlanName: string;
  targetPrice: number;
  currentPlanName: string;
  currentPrice: number;
  daysRemaining: number;
  unusedCredit: number;
  finalAmount: number;
}

function parsePeriodToMs(period: string): number | null {
  const s = period.trim().toLowerCase();
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  const hit = s.match(/(\d+)\s*(dia|dias|d|mes|meses|m[eê]s|ano|anos)/i);
  if (hit) {
    const n = Number(hit[1]);
    const u = hit[2].toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return null;
    if (u.startsWith("dia") || u === "d") return n * 24 * 60 * 60 * 1000;
    if (u.startsWith("mes") || u.startsWith("mês")) return n * monthMs;
    if (u.startsWith("ano")) return n * yearMs;
  }
  if (s.includes("mes") || s.includes("mês") || s.includes("/mes")) return monthMs;
  if (s.includes("ano") || s.includes("/ano")) return yearMs;
  return null;
}

const defaultPrefs: NotificationPrefs = {
  routeErrors: true,
  automationComplete: true,
  sessionDisconnected: true,
  dailyReport: false,
  lowQuotaAlert: true,
  weeklyPerformanceDigest: false,
};

function toNotificationPrefs(input: unknown): NotificationPrefs {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    routeErrors: source.routeErrors !== false,
    automationComplete: source.automationComplete !== false,
    sessionDisconnected: source.sessionDisconnected !== false,
    dailyReport: source.dailyReport === true,
    lowQuotaAlert: source.lowQuotaAlert !== false,
    weeklyPerformanceDigest: source.weeklyPerformanceDigest === true,
  };
}

export default function SettingsPage() {
  const { user } = useAuth();
  const { state: adminControlPlane } = useAdminControlPlane();
  const { theme, setTheme } = useTheme();
  const [profile, setProfile] = useState({ name: "", email: "" });
  const [planId, setPlanId] = useState("plan-starter");
  const [notifications, setNotifications] = useState<NotificationPrefs>(defaultPrefs);
  const [usageCounts, setUsageCounts] = useState({
    wa: 0,
    tg: 0,
    waGroups: 0,
    tgGroups: 0,
    routes: 0,
    automations: 0,
    schedules: 0,
    templates: 0,
  });
  const [planExpiresAt, setPlanExpiresAt] = useState<string | null>(null);
  const [plansModalOpen, setPlansModalOpen] = useState(false);
  const [plansBillingPeriod, setPlansBillingPeriod] = useState<"monthly" | "annual">("monthly");
  const [prorationDialog, setProrationDialog] = useState<ProrationState | null>(null);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingNotifs, setSavingNotifs] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!user) return;

    setLoading(true);
    const [profileRes, wa, tg, waGroups, tgGroups, rt, au, sch, tp] = await Promise.all([
      backend.from("profiles").select("name, email, plan_id, notification_prefs, plan_expires_at").eq("user_id", user.id).maybeSingle(),
      backend.from("whatsapp_sessions").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      backend.from("telegram_sessions").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      backend.from("groups").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("platform", "whatsapp").is("deleted_at", null),
      backend.from("groups").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("platform", "telegram").is("deleted_at", null),
      backend.from("routes").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      backend.from("shopee_automations").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      backend.from("scheduled_posts").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      backend.from("templates").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    ]);

    if (profileRes.data) {
      setProfile({ name: profileRes.data.name, email: profileRes.data.email });
      setPlanId(profileRes.data.plan_id);
      setNotifications(toNotificationPrefs(profileRes.data.notification_prefs));
      setPlanExpiresAt(typeof profileRes.data.plan_expires_at === "string" && profileRes.data.plan_expires_at.trim()
        ? profileRes.data.plan_expires_at
        : null);
    }

    setUsageCounts({
      wa: wa.count || 0,
      tg: tg.count || 0,
      waGroups: waGroups.count || 0,
      tgGroups: tgGroups.count || 0,
      routes: rt.count || 0,
      automations: au.count || 0,
      schedules: sch.count || 0,
      templates: tp.count || 0,
    });

    setLoading(false);
  }, [user]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!user?.id) return;

    return subscribeLocalDbChanges(() => {
      void fetchAll();
    });
  }, [fetchAll, user?.id]);

  const fallbackPlan = defaultAdminControlPlaneState().plans[0];
  const currentPlan = adminControlPlane.plans.find((p) => p.id === planId) || fallbackPlan;
  const effectiveLimits = resolveEffectiveLimitsByPlanId(planId) || currentPlan.limits;
  const effectiveOperationalLimits = resolveEffectiveOperationalLimitsByPlanId(planId) || {
    whatsappSessions: effectiveLimits.whatsappSessions,
    telegramSessions: effectiveLimits.telegramSessions,
    automations: effectiveLimits.automations,
    routes: effectiveLimits.routes,
    schedules: effectiveLimits.schedules,
    whatsappGroups: effectiveLimits.groups,
    telegramGroups: effectiveLimits.groups,
  };
  const visiblePlans = adminControlPlane.plans
    .filter((plan) => plan.isActive && plan.visibleInAccount && (plan.billingPeriod ?? "monthly") === plansBillingPeriod)
    .sort((a, b) => a.price - b.price);
  const nowMs = Date.now();
  const planExpiryMs = planExpiresAt ? Date.parse(planExpiresAt) : NaN;
  const isPlanExpired = Number.isFinite(planExpiryMs) && planExpiryMs < nowMs;
  const msToExpiry = Number.isFinite(planExpiryMs) ? planExpiryMs - nowMs : Number.NaN;
  const isPlanExpiringSoon = !isPlanExpired && Number.isFinite(msToExpiry) && msToExpiry <= 24 * 60 * 60 * 1000;
  const planFeatureItems = Array.isArray(currentPlan.homeFeatureHighlights)
    ? currentPlan.homeFeatureHighlights.slice(0, 10)
    : [];
  const planExpiryLabel = Number.isFinite(planExpiryMs)
    ? new Date(planExpiryMs).toLocaleDateString("pt-BR")
    : null;

  const hasCriticalAlertsEnabled = notifications.routeErrors && notifications.sessionDisconnected;

  const saveProfile = async () => {
    if (!user) return;
    const parsed = perfilSchema.safeParse(profile);
    if (!parsed.success) {
      toast.error(parsed.error.errors[0].message);
      return;
    }
    setSavingProfile(true);
    const { error } = await backend
      .from("profiles")
      .update({ name: parsed.data.name, email: parsed.data.email })
      .eq("user_id", user.id);
    setSavingProfile(false);
    if (error) {
      toast.error("Não deu pra salvar o perfil");
      return;
    }
    toast.success("Perfil salvo");
  };

  const saveNotifications = async () => {
    if (!user) return;
    setSavingNotifs(true);
    const { error } = await backend
      .from("profiles")
      .update({ notification_prefs: notifications as unknown as Json })
      .eq("user_id", user.id);
    setSavingNotifs(false);
    if (error) {
      toast.error("Não deu pra salvar os avisos");
      return;
    }
    toast.success("Avisos salvos");
  };

  const updatePassword = async () => {
    if (!passwordForm.currentPassword) {
      toast.error("Coloque sua senha atual");
      return;
    }
    if (!passwordForm.newPassword || !passwordForm.confirmPassword) {
      toast.error("Preencha a nova senha nos dois campos");
      return;
    }
    const passwordPolicyError = getPasswordPolicyError(passwordForm.newPassword);
    if (passwordPolicyError) {
      toast.error(passwordPolicyError);
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      toast.error("As senhas estão diferentes");
      return;
    }

    setSavingPassword(true);
    const { error } = await backend.auth.updateUser({ password: passwordForm.newPassword, current_password: passwordForm.currentPassword });
    setSavingPassword(false);

    if (error) {
      toast.error(error.message ?? "Não deu pra trocar a senha");
      return;
    }

    setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
    toast.success("Senha trocada");
  };

  const exportAccountData = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      profile,
      plan: {
        id: currentPlan.id,
        name: currentPlan.name,
        price: currentPlan.price,
        period: currentPlan.period,
      },
      notificationPrefs: notifications,
      usage: usageCounts,
      ui: {
        theme,
      },
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `autolinks-minha-conta-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(href);
  };

  const handleChoosePlan = async (targetPlanId: string) => {
    if (!user) {
      toast.error("Usuário não autenticado");
      return;
    }

    if (targetPlanId === planId) {
      toast.info("Você já está nesse plano.");
      return;
    }

    const targetLimits = resolveEffectiveLimitsByPlanId(targetPlanId);
    const targetOperational = resolveEffectiveOperationalLimitsByPlanId(targetPlanId);
    if (!targetLimits || !targetOperational) {
      toast.error("Não deu pra checar os limites desse plano.");
      return;
    }

    const exceeded = [
      { label: "sessões WhatsApp", used: usageCounts.wa, max: targetOperational.whatsappSessions },
      { label: "sessões Telegram", used: usageCounts.tg, max: targetOperational.telegramSessions },
      { label: "grupos WhatsApp", used: usageCounts.waGroups, max: targetOperational.whatsappGroups },
      { label: "grupos Telegram", used: usageCounts.tgGroups, max: targetOperational.telegramGroups },
      { label: "rotas", used: usageCounts.routes, max: targetOperational.routes },
      { label: "automações", used: usageCounts.automations, max: targetOperational.automations },
      { label: "agendamentos", used: usageCounts.schedules, max: targetOperational.schedules },
      { label: "templates", used: usageCounts.templates, max: targetLimits.templates },
    ]
      .filter((item) => item.max !== -1 && item.used > item.max)
      .map((item) => `${item.label} (${item.used}/${item.max})`);

    if (exceeded.length > 0) {
      toast.error(`Não dá pra trocar: você passa do limite em ${exceeded.join(", ")}.`);
      return;
    }

    try {
      await invokeBackendRpc("account-plan", {
        body: {
          action: "change_plan",
          plan_id: targetPlanId,
        },
      });
      toast.success("Plano atualizado!");
      setPlansModalOpen(false);
      await fetchAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra trocar o plano");
    }
  };

  const limitLabel = (used: number, max: number) =>
    max === -1 ? `${used} / ∞` : `${used} / ${max}`;
  const limitPct = (used: number, max: number) =>
    max === -1 ? Math.min(used * 5, 100) : max === 0 ? 0 : (used / max) * 100;

  const usageItems = [
    { label: "Sessões WhatsApp", icon: WhatsAppIcon, used: usageCounts.wa, max: effectiveOperationalLimits.whatsappSessions },
    { label: "Sessões Telegram", icon: TelegramIcon, used: usageCounts.tg, max: effectiveOperationalLimits.telegramSessions },
    { label: "Grupos WhatsApp", icon: Users, used: usageCounts.waGroups, max: effectiveOperationalLimits.whatsappGroups },
    { label: "Grupos Telegram", icon: Users, used: usageCounts.tgGroups, max: effectiveOperationalLimits.telegramGroups },
    { label: "Rotas", icon: Route, used: usageCounts.routes, max: effectiveOperationalLimits.routes },
    { label: "Automações Shopee", icon: Flame, used: usageCounts.automations, max: effectiveOperationalLimits.automations },
    { label: "Agendamentos", icon: CalendarClock, used: usageCounts.schedules, max: effectiveOperationalLimits.schedules },
    { label: "Templates", icon: FileText, used: usageCounts.templates, max: effectiveLimits.templates },
  ];

  const notifItems = [
    { key: "routeErrors" as const, label: "Erros nas rotas", desc: "Avisa quando uma rota der problema", icon: AlertTriangle },
    { key: "automationComplete" as const, label: "Automação terminou", desc: "Avisa quando uma automação Shopee acabar", icon: CheckCircle2 },
    { key: "sessionDisconnected" as const, label: "Sessão caiu", desc: "Avisa quando WhatsApp ou Telegram desconectar", icon: WhatsAppIcon },
    { key: "dailyReport" as const, label: "Resumo do dia", desc: "Receba um resumo diário por e-mail", icon: Bell },
    { key: "lowQuotaAlert" as const, label: "Limite quase no teto", desc: "Avisa quando você usar mais de 80% do plano", icon: CreditCard },
    { key: "weeklyPerformanceDigest" as const, label: "Resumo da semana", desc: "Receba um resumo semanal", icon: FileText },
  ];

  const nearLimitItems = usageItems.filter((item) => item.max !== -1 && item.max > 0 && (item.used / item.max) * 100 >= 80);

  if (loading) {
    return (
      <div className="ds-page">
        <div className="mx-auto w-full max-w-4xl space-y-6">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="ds-page">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <PageHeader
          title="Minha conta"
          description="Seu perfil, segurança e configurações num lugar só"
        />

        <Tabs defaultValue="conta" className="space-y-5">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="conta">Conta</TabsTrigger>
            <TabsTrigger value="preferencias">Avisos</TabsTrigger>
            <TabsTrigger value="plano">Plano</TabsTrigger>
          </TabsList>

          <TabsContent value="conta" className="space-y-5">
            <Card className="glass">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <User className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Perfil</CardTitle>
                    <CardDescription>Seus dados básicos</CardDescription>
                  </div>
              </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">Nome</Label>
                    <Input
                      id="name"
                      placeholder="Seu nome"
                      value={profile.name}
                      onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="seu@email.com"
                      value={profile.email}
                      onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button size="sm" onClick={saveProfile} disabled={savingProfile}>
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    {savingProfile ? "Salvando..." : "Salvar perfil"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Shield className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Segurança</CardTitle>
                    <CardDescription>Troque sua senha aqui</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="current-password">Senha atual</Label>
                    <Input
                      id="current-password"
                      type={showPassword ? "text" : "password"}
                      placeholder="Sua senha atual"
                      value={passwordForm.currentPassword}
                      onChange={(e) => setPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-password">Nova senha</Label>
                    <div className="relative">
                      <Input
                        id="new-password"
                        type={showPassword ? "text" : "password"}
                        placeholder={PASSWORD_POLICY_HINT}
                        value={passwordForm.newPassword}
                        onChange={(e) => setPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted"
                        onClick={() => setShowPassword((prev) => !prev)}
                        title={showPassword ? "Ocultar senha" : "Mostrar senha"}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">Confirmar nova senha</Label>
                    <Input
                      id="confirm-password"
                      type={showPassword ? "text" : "password"}
                      placeholder="Repita a nova senha"
                      value={passwordForm.confirmPassword}
                      onChange={(e) => setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={updatePassword} disabled={savingPassword}>
                    <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                    {savingPassword ? "Atualizando..." : "Atualizar senha"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={exportAccountData}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    Exportar dados da conta
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="preferencias" className="space-y-5">
            <Card className="glass">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Bell className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Avisos e notificações</CardTitle>
                    <CardDescription>Escolha o que você quer receber</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-1">
                <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground/70">
                  <AlertTriangle className="h-3 w-3" />
                  Deixe ligado pelo menos os alertas de erro e sessão desconectada pra não perder envios.
                </p>
                {notifItems.map((item, idx) => (
                  <div key={item.key}>
                    <div className="flex items-center justify-between py-3">
                      <div className="flex items-center gap-3">
                        <item.icon className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">{item.label}</p>
                          <p className="text-xs text-muted-foreground">{item.desc}</p>
                        </div>
                      </div>
                      <Switch
                        checked={notifications[item.key]}
                        onCheckedChange={(c) => setNotifications({ ...notifications, [item.key]: c })}
                      />
                    </div>
                    {idx < notifItems.length - 1 && <Separator />}
                  </div>
                ))}

                {!hasCriticalAlertsEnabled && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                    Recomendado: manter os alertas importantes ligados pra evitar erros silenciosos.
                  </p>
                )}

                <div className="flex justify-end pt-3">
                  <Button size="sm" onClick={saveNotifications} disabled={savingNotifs}>
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    {savingNotifs ? "Salvando..." : "Salvar preferências"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <User className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Interface</CardTitle>
                    <CardDescription>Como você quer ver o painel</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2 sm:max-w-xs">
                  <Label htmlFor="theme">Tema</Label>
                  <Select value={theme} onValueChange={(value) => setTheme(value as "dark" | "light" | "system")}>
                    <SelectTrigger id="theme">
                      <SelectValue placeholder="Selecione" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">Sistema</SelectItem>
                      <SelectItem value="dark">Escuro</SelectItem>
                      <SelectItem value="light">Claro</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="plano" className="space-y-5">
            <Card className="glass">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <CreditCard className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{currentPlan.accountTitle || "Plano & Uso"}</CardTitle>
                      <CardDescription>{currentPlan.accountDescription || "Acompanhe o consumo dos seus recursos"}</CardDescription>
                    </div>
                  </div>
                  <Badge variant="secondary" className="bg-primary/10 font-semibold text-primary">
                    {currentPlan.name}
                  </Badge>
              </div>
              </CardHeader>
              <CardContent className="space-y-5">
                {isPlanExpired && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                    <p className="text-sm font-semibold text-destructive">Seu plano venceu</p>
                    <p className="text-xs text-muted-foreground">
                      {planExpiryLabel
                        ? `Venceu em ${planExpiryLabel}. Escolha um plano pra voltar a usar tudo.`
                        : "Venceu. Escolha um plano pra voltar a usar tudo."}
                    </p>
                    <Button
                      size="sm"
                      className="mt-3"
                      onClick={() => setPlansModalOpen(true)}
                    >
                      Renovar agora
                    </Button>
                  </div>
                )}

                {isPlanExpiringSoon && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                    <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">Seu plano vence logo</p>
                    <p className="text-xs text-muted-foreground">
                      {planExpiryLabel
                        ? `Vence em ${planExpiryLabel}. Renove antes pra não ficar sem acesso.`
                        : "Vence em breve. Renove antes pra não ficar sem acesso."}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      onClick={() => setPlansModalOpen(true)}
                    >
                      Renovar plano
                    </Button>
                  </div>
                )}

                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold">R${currentPlan.price.toFixed(2).replace(".", ",")}</span>
                  <span className="text-sm text-muted-foreground">{currentPlan.period}</span>
                </div>

                {planExpiryLabel && !isPlanExpired && (
                  <p className="text-xs text-muted-foreground">Válido até {planExpiryLabel}</p>
                )}

                <Separator />

                {planFeatureItems.length > 0 && (
                  <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-xs font-semibold">O que vem no plano</p>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {planFeatureItems.map((feature) => (
                        <li key={feature} className="flex items-start gap-2">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {nearLimitItems.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">Atenção: quase no limite</p>
                    <p className="text-xs text-muted-foreground">
                      {nearLimitItems.map((item) => item.label).join(", ")} já passou de 80% do limite.
                    </p>
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  {usageItems.map((item) => {
                    const pct = limitPct(item.used, item.max);
                    const isNearLimit = item.max !== -1 && pct >= 80;
                    return (
                      <div key={item.label} className="space-y-2 rounded-lg border p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <item.icon className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-xs font-medium">{item.label}</span>
                          </div>
                          <span className={`text-xs font-mono ${isNearLimit ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                            {limitLabel(item.used, item.max)}
                          </span>
                        </div>
                        <Progress value={pct} className="h-1.5" />
                      </div>
                    );
                  })}
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  className="w-full gap-1.5"
                  onClick={() => setPlansModalOpen(true)}
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                  Ver planos
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={plansModalOpen} onOpenChange={setPlansModalOpen}>
          <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Escolha seu plano</DialogTitle>
              <p className="text-sm text-muted-foreground">
                Os valores e recursos abaixo são os que valem pra sua conta.
              </p>
            </DialogHeader>

            {/* Billing period toggle */}
            <div className="flex justify-center">
              <div className="inline-flex items-center rounded-full border bg-secondary/40 p-1 gap-1">
                <button
                  type="button"
                  onClick={() => setPlansBillingPeriod("monthly")}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all ${
                    plansBillingPeriod === "monthly"
                      ? "bg-background shadow text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Mensal
                </button>
                <button
                  type="button"
                  onClick={() => setPlansBillingPeriod("annual")}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-all flex items-center gap-1.5 ${
                    plansBillingPeriod === "annual"
                      ? "bg-background shadow text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Anual
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">2 meses grátis 🔥</span>
                </button>
              </div>
            </div>

            {visiblePlans.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nenhum plano disponível no momento. Fale com o suporte em suporte@autolinks.pro para liberar opções de renovação.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {visiblePlans.map((plan) => {
                  const isCurrentPlan = plan.id === currentPlan.id;
                  const planLimits = resolveEffectiveLimitsByPlanId(plan.id) || plan.limits;
                  const planOperational = resolveEffectiveOperationalLimitsByPlanId(plan.id) || {
                    whatsappSessions: planLimits.whatsappSessions,
                    telegramSessions: planLimits.telegramSessions,
                    automations: planLimits.automations,
                    routes: planLimits.routes,
                    schedules: planLimits.schedules,
                    whatsappGroups: planLimits.groups,
                    telegramGroups: planLimits.groups,
                  };

                  const items = [
                    planOperational.whatsappSessions === -1
                      ? "Sessões WhatsApp ilimitadas"
                      : `${planOperational.whatsappSessions} sessões WhatsApp`,
                    planOperational.whatsappGroups === -1
                      ? "Grupos WhatsApp ilimitados"
                      : `${planOperational.whatsappGroups} grupos WhatsApp`,
                    getFeatureAccessPolicyByPlan("telegramConnections", plan.id).enabled
                      ? (planOperational.telegramSessions === -1
                        ? "Sessões Telegram ilimitadas"
                        : `${planOperational.telegramSessions} sessões Telegram`)
                      : "",
                    getFeatureAccessPolicyByPlan("telegramConnections", plan.id).enabled
                      ? (planOperational.telegramGroups === -1
                        ? "Grupos Telegram ilimitados"
                        : `${planOperational.telegramGroups} grupos Telegram`)
                      : "",
                    getFeatureAccessPolicyByPlan("routes", plan.id).enabled
                      ? (planOperational.routes === -1 ? "Rotas ilimitadas" : `${planOperational.routes} rotas`)
                      : "",
                    getFeatureAccessPolicyByPlan("shopeeAutomations", plan.id).enabled
                      ? (planOperational.automations === -1 ? "Automações Shopee ilimitadas" : `${planOperational.automations} automações Shopee`)
                      : "",
                    getFeatureAccessPolicyByPlan("schedules", plan.id).enabled
                      ? (planOperational.schedules === -1 ? "Agendamentos ilimitados" : `${planOperational.schedules} agendamentos`)
                      : "",
                    getFeatureAccessPolicyByPlan("templates", plan.id).enabled
                      ? (planLimits.templates === -1 ? "Templates ilimitados" : `${planLimits.templates} templates`)
                      : "",
                  ].filter(Boolean).slice(0, 6);
                  const levelName = adminControlPlane.accessLevels.find((level) => level.id === plan.accessLevelId)?.name || "Nível";

                  return (
                    <Card key={plan.id} className={`transition ${isCurrentPlan ? "border-primary bg-primary/5" : "hover:border-primary/40"}`}>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between gap-2">
                          <CardTitle className="text-sm">{plan.name}</CardTitle>
                          {isCurrentPlan ? <Badge variant="secondary">Plano atual</Badge> : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline">{levelName}</Badge>
                          <span>{plan.period}</span>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="rounded-md border bg-background/70 p-3">
                          <p className="text-xs text-muted-foreground">Assinatura</p>
                          <p className="text-xl font-semibold text-foreground">R${plan.price.toFixed(2).replace(".", ",")}</p>
                          {plan.billingPeriod === "annual" && plan.monthlyEquivalentPrice != null && (
                            <p className="mt-0.5 text-xs text-muted-foreground">≈ R${plan.monthlyEquivalentPrice.toFixed(2).replace(".", ",")}/mês — economize 17%</p>
                          )}
                        </div>
                        <ul className="space-y-1 text-xs text-muted-foreground">
                          {items.map((item) => (
                            <li key={`${plan.id}-${item}`} className="flex items-start gap-2">
                              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                        <Button
                          size="sm"
                          className="w-full"
                          variant={isCurrentPlan ? "outline" : "default"}
                          onClick={() => {
                            if (isCurrentPlan) {
                              toast.info("Plano em uso");
                              return;
                            }
                            const isUpgrade = plan.price > currentPlan.price;
                            const expiryMs = planExpiresAt ? Date.parse(planExpiresAt) : NaN;
                            const hasUnusedTime = Number.isFinite(expiryMs) && expiryMs > Date.now();
                            if (isUpgrade && hasUnusedTime) {
                              const periodMs = parsePeriodToMs(currentPlan.period);
                              const msRemaining = Math.max(0, expiryMs - Date.now());
                              const daysRemaining = Math.floor(msRemaining / (24 * 60 * 60 * 1000));
                              const totalDays = periodMs ? Math.round(periodMs / (24 * 60 * 60 * 1000)) : 0;
                              const unusedCredit = totalDays > 0
                                ? Math.min((msRemaining / periodMs!) * currentPlan.price, currentPlan.price)
                                : 0;
                              const finalAmount = Math.max(0, plan.price - unusedCredit);
                              setProrationDialog({
                                targetPlanId: plan.id,
                                targetPlanName: plan.name,
                                targetPrice: plan.price,
                                currentPlanName: currentPlan.name,
                                currentPrice: currentPlan.price,
                                daysRemaining,
                                unusedCredit,
                                finalAmount,
                              });
                              return;
                            }
                            void handleChoosePlan(plan.id);
                          }}
                        >
                          {isCurrentPlan ? "Plano em uso" : "Escolher plano"}
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setPlansModalOpen(false)}>Fechar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog open={!!prorationDialog} onOpenChange={(open) => !open && setProrationDialog(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirmar upgrade de plano</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 text-sm">
                  <p>
                    Você está fazendo upgrade de <strong>{prorationDialog?.currentPlanName}</strong> para <strong>{prorationDialog?.targetPlanName}</strong>.
                  </p>
                  <div className="rounded-md border bg-muted/40 p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Dias restantes no plano atual</span>
                      <span className="font-medium">{prorationDialog?.daysRemaining} dia(s)</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Crédito proporcional não utilizado</span>
                      <span className="font-medium text-green-600">− R${prorationDialog?.unusedCredit.toFixed(2).replace(".", ",")}</span>
                    </div>
                    <div className="flex justify-between border-t pt-1.5">
                      <span className="font-medium">Valor do novo plano</span>
                      <span className="font-semibold">R${prorationDialog?.finalAmount.toFixed(2).replace(".", ",")}</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    O cálculo de proporcionalidade é informativo. O processamento do pagamento ocorre pelo sistema de faturamento do seu provedor.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (prorationDialog) {
                    void handleChoosePlan(prorationDialog.targetPlanId);
                    setProrationDialog(null);
                  }
                }}
              >
                Confirmar upgrade
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

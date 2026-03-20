import { useEffect, useMemo, useState } from "react";
import { Bell, BellRing, Check, CheckCheck, Clock, Info, ShieldAlert, Trash2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { useUserNotifications, type UserNotificationItem } from "@/hooks/useUserNotifications";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

function formatDate(input: string) {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return "agora";
  const now = new Date();
  const diffMs = now.getTime() - parsed.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "agora mesmo";
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `há ${diffH}h`;
  return parsed.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function SeverityIcon({ severity, className }: { severity: "info" | "warning" | "critical"; className?: string }) {
  if (severity === "critical") return <ShieldAlert className={cn("h-4 w-4 text-destructive", className)} />;
  if (severity === "warning") return <TriangleAlert className={cn("h-4 w-4 text-amber-500", className)} />;
  return <Info className={cn("h-4 w-4 text-sky-500", className)} />;
}

function SeverityBadge({ severity }: { severity: "info" | "warning" | "critical" }) {
  if (severity === "critical")
    return <Badge variant="destructive" className="h-5 px-1.5 text-2xs">Urgente</Badge>;
  if (severity === "warning")
    return <Badge variant="warning" className="h-5 px-1.5 text-2xs">Atenção</Badge>;
  return <Badge variant="info" className="h-5 px-1.5 text-2xs">Info</Badge>;
}

function NotificationCard({
  item,
  onMarkRead,
  onDismiss,
  isBusy,
  compact = false,
}: {
  item: UserNotificationItem;
  onMarkRead: (id: string) => void;
  onDismiss: (id: string) => void;
  isBusy: boolean;
  compact?: boolean;
}) {
  const ann = item.announcement;
  if (!ann) return null;
  const isUnread = item.status === "unread";
  const isRead = item.status === "read";

  return (
    <div
      className={cn(
        "group relative rounded-xl border transition-all",
        compact ? "p-2.5" : "p-4",
        isUnread
          ? "border-primary/30 bg-primary/5 shadow-sm"
          : "border-border/50 bg-muted/20 opacity-80",
      )}
    >
      {isUnread && (
        <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-primary" />
      )}
      <div className="flex items-start gap-2.5 pr-4">
        <div className={cn("mt-0.5 shrink-0", !compact && "mt-1")}>
          <SeverityIcon severity={ann.severity} className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className={cn("font-semibold leading-tight", compact ? "text-xs" : "text-sm", !isUnread && "text-muted-foreground")}>
              {ann.title}
            </p>
            {!compact && <SeverityBadge severity={ann.severity} />}
            {isRead && !compact && (
              <Badge variant="outline" className="h-5 gap-1 px-1.5 text-2xs text-muted-foreground">
                <Check className="h-2.5 w-2.5" /> Lida
              </Badge>
            )}
          </div>
          <p className={cn("mt-0.5 leading-snug text-muted-foreground", compact ? "line-clamp-1 text-xs" : "line-clamp-3 text-xs")}>
            {ann.message}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{formatDate(item.delivered_at)}</span>
            {isRead && item.read_at && !compact && (
              <span className="text-2xs">· lida {formatDate(item.read_at)}</span>
            )}
          </div>
        </div>
      </div>
      {!compact && item.status !== "dismissed" && (
        <div className="mt-3 flex items-center justify-end gap-2">
          {isUnread && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onMarkRead(item.id)} disabled={isBusy}>
              <Check className="mr-1 h-3 w-3" /> Marcar como lida
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-destructive" onClick={() => onDismiss(item.id)} disabled={isBusy}>
            <Trash2 className="mr-1 h-3 w-3" /> Descartar
          </Button>
        </div>
      )}
    </div>
  );
}

export function NotificationBell() {
  const [openCenter, setOpenCenter] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupItem, setPopupItem] = useState<UserNotificationItem | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const { items, unreadCount, refetch } = useUserNotifications();

  const unreadItems = useMemo(() => items.filter((i) => i.status === "unread"), [items]);
  const readItems = useMemo(() => items.filter((i) => i.status === "read"), [items]);
  const previewItems = useMemo(() => items.filter((i) => i.status !== "dismissed").slice(0, 6), [items]);

  const markAsRead = async (id: string) => {
    setIsBusy(true);
    try {
      await invokeBackendRpc("user-notifications", { body: { action: "mark_read", id } });
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra marcar a notificação");
    } finally {
      setIsBusy(false);
    }
  };

  const markAllRead = async () => {
    setIsBusy(true);
    try {
      await invokeBackendRpc("user-notifications", { body: { action: "mark_all_read" } });
      await refetch();
      toast.success("Todas as notificações marcadas como lidas");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra atualizar as notificações");
    } finally {
      setIsBusy(false);
    }
  };

  const dismiss = async (id: string) => {
    setIsBusy(true);
    try {
      await invokeBackendRpc("user-notifications", { body: { action: "dismiss", id } });
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não deu pra descartar a notificação");
    } finally {
      setIsBusy(false);
    }
  };

  // Best effort login popup check when component mounts and data is available.
  useEffect(() => {
    void (async () => {
      try {
        const response = await invokeBackendRpc<{ item: UserNotificationItem | null }>("user-notifications", {
          body: { action: "login_popup" },
        });
        if (response.item) {
          setPopupItem(response.item);
          setPopupOpen(true);
          await refetch();
        }
      } catch {
        // Silent by design.
      }
    })();
  }, [refetch]);

  return (
    <>
      {/* ── Bell trigger ───────────────────────────────────────── */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className={cn(
              "touch-target relative h-10 w-10 rounded-lg transition-all sm:h-9 sm:w-9",
              unreadCount > 0 && "border-primary/50 shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]",
            )}
            aria-label={unreadCount > 0 ? `${unreadCount} notificações não lidas` : "Notificações"}
          >
            {unreadCount > 0 ? (
              <BellRing className="h-4 w-4 animate-wiggle text-primary" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {unreadCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-2xs font-bold text-destructive-foreground shadow">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={8} className="w-[min(calc(100vw-1rem),380px)] p-0">
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-semibold">Notificações</p>
              {unreadCount > 0 && (
                <Badge variant="destructive" className="h-5 px-1.5 text-2xs">
                  {unreadCount} nova{unreadCount !== 1 ? "s" : ""}
                </Badge>
              )}
            </div>
            {unreadCount > 0 && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={markAllRead} disabled={isBusy}>
                <CheckCheck className="mr-1 h-3.5 w-3.5" />
                Ler tudo
              </Button>
            )}
          </div>

          {/* Unread alert banner */}
          {unreadCount > 0 && (
            <div className="flex items-start gap-2.5 border-b bg-primary/5 px-4 py-2.5">
              <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <p className="text-xs text-muted-foreground">
                Você tem <span className="font-semibold text-foreground">{unreadCount}</span> notificação{unreadCount !== 1 ? "ões" : ""} não lida{unreadCount !== 1 ? "s" : ""}. Clique para marcar como lida.
              </p>
            </div>
          )}

          {/* Notification list */}
          <ScrollArea className="max-h-[340px]">
            <div className="space-y-1.5 p-2.5">
              {previewItems.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Bell className="h-8 w-8 text-muted-foreground/30" />
                  <p className="text-sm font-medium text-muted-foreground">Tudo em dia!</p>
                  <p className="text-xs text-muted-foreground">Nenhuma notificação no momento.</p>
                </div>
              )}
              {previewItems.map((item) => (
                <NotificationCard
                  key={item.id}
                  item={item}
                  onMarkRead={(id) => void markAsRead(id)}
                  onDismiss={(id) => void dismiss(id)}
                  isBusy={isBusy}
                  compact
                />
              ))}
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="border-t px-3 py-2">
            <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => setOpenCenter(true)}>
              Ver histórico completo
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ── Central de Notificações (dialog) ──────────────────── */}
      <Dialog open={openCenter} onOpenChange={setOpenCenter}>
        <DialogContent className="flex h-[88dvh] w-[min(calc(100vw-1rem),42rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:h-[85dvh]">
          <DialogHeader className="shrink-0 border-b px-4 py-3 sm:px-6 sm:py-4">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <Bell className="h-5 w-5" />
                  Central de Notificações
                  {unreadCount > 0 && (
                    <Badge variant="destructive" className="text-xs">
                      {unreadCount} não lida{unreadCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="mt-0.5 text-xs">
                  Comunicados recebidos e histórico de leituras
                </DialogDescription>
              </div>
              {unreadCount > 0 && (
                <Button variant="outline" size="sm" onClick={markAllRead} disabled={isBusy}>
                  <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
                  Marcar tudo como lido
                </Button>
              )}
            </div>
          </DialogHeader>

          <ScrollArea className="flex-1 px-4 py-3 sm:px-6 sm:py-4">
            {items.filter((i) => i.status !== "dismissed").length === 0 && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <Bell className="h-12 w-12 text-muted-foreground/20" />
                <p className="text-base font-medium text-muted-foreground">Nenhuma notificação recebida</p>
                <p className="text-sm text-muted-foreground/70">Quando houver novidades, elas aparecerão aqui.</p>
              </div>
            )}

            {/* Unread section */}
            {unreadItems.length > 0 && (
              <div className="mb-6">
                <div className="mb-3 flex items-center gap-2">
                  <BellRing className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Não lidas</h3>
                  <Badge variant="destructive" className="text-2xs">{unreadItems.length}</Badge>
                </div>
                <div className="space-y-3">
                  {unreadItems.map((item) => (
                    <NotificationCard
                      key={item.id}
                      item={item}
                      onMarkRead={(id) => void markAsRead(id)}
                      onDismiss={(id) => void dismiss(id)}
                      isBusy={isBusy}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Separator between sections */}
            {unreadItems.length > 0 && readItems.length > 0 && (
              <Separator className="mb-6" />
            )}

            {/* Read history section */}
            {readItems.length > 0 && (
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold text-muted-foreground">Histórico</h3>
                  <span className="text-xs text-muted-foreground">({readItems.length})</span>
                </div>
                <div className="space-y-3">
                  {readItems.map((item) => (
                    <NotificationCard
                      key={item.id}
                      item={item}
                      onMarkRead={(id) => void markAsRead(id)}
                      onDismiss={(id) => void dismiss(id)}
                      isBusy={isBusy}
                    />
                  ))}
                </div>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* ── Login popup (critical alert) ──────────────────────── */}
      <Dialog open={popupOpen} onOpenChange={setPopupOpen}>
        <DialogContent className="w-[min(calc(100vw-1rem),32rem)] max-w-none">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              {popupItem?.announcement?.severity === "critical" && (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                  <ShieldAlert className="h-4 w-4 text-destructive" />
                </span>
              )}
              {popupItem?.announcement?.title || "Aviso importante"}
            </DialogTitle>
            <DialogDescription className="pt-1 text-sm leading-relaxed">
              {popupItem?.announcement?.message || "Confira os detalhes na central de notificações."}
            </DialogDescription>
          </DialogHeader>
          {popupItem?.announcement?.severity && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0" />
              Recebida em {popupItem.delivered_at ? formatDate(popupItem.delivered_at) : "—"}. Esta notificação ficará disponível no histórico.
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setPopupOpen(false); setOpenCenter(true); }}>
              Ver histórico
            </Button>
            <Button onClick={() => setPopupOpen(false)}>Entendi</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, RefreshCw, Search, Users, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Group, SessionStatus } from "@/lib/types";
import { StatusIndicator } from "@/components/StatusIndicator";
import { toast } from "sonner";
import { ChannelPlatformIcon } from "@/components/icons/ChannelPlatformIcon";
import { InlineLoadingState } from "@/components/InlineLoadingState";

interface PlatformSession {
  id: string;
  name: string;
  status: SessionStatus;
}

interface Props {
  platform: "whatsapp" | "telegram";
  sessions: PlatformSession[];
  groups: Group[];
  isLoading?: boolean;
  isSyncing?: boolean;
  onSyncSession: (sessionId: string) => Promise<unknown>;
  onSyncAll?: () => Promise<unknown>;
  onRefresh: () => void;
}

export function GruposPorPlataforma({
  platform,
  sessions,
  groups,
  isLoading,
  isSyncing,
  onSyncSession,
  onSyncAll,
  onRefresh,
}: Props) {
  const [search, setSearch] = useState("");
  const [sessionFilter, setSessionFilter] = useState<string>("all");
  const [syncingSessionId, setSyncingSessionId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);

  const isWhatsApp = platform === "whatsapp";
  const platformLabel = isWhatsApp ? "WhatsApp" : "Telegram";

  const sessionNameById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.name])),
    [sessions],
  );

  // Detect external_ids that appear in multiple sessions → show "multissessão" indicator
  const multiSessionExternalIds = useMemo(() => {
    const count = new Map<string, Set<string>>();
    for (const g of groups) {
      if (g.externalId) {
        if (!count.has(g.externalId)) count.set(g.externalId, new Set());
        count.get(g.externalId)!.add(g.sessionId);
      }
    }
    const result = new Set<string>();
    for (const [extId, sessionSet] of count) {
      if (sessionSet.size > 1) result.add(extId);
    }
    return result;
  }, [groups]);

  const filteredGroups = useMemo(() => {
    return groups
      .filter((group) => sessionFilter === "all" || group.sessionId === sessionFilter)
      .filter((group) => {
        const sessionName = sessionNameById.get(group.sessionId) || "";
        const haystack = `${group.name} ${sessionName}`.toLowerCase();
        return haystack.includes(search.toLowerCase());
      });
  }, [groups, search, sessionFilter, sessionNameById]);

  const onlineSessions = sessions.filter((session) => session.status === "online");

  const handleSyncSession = async (sessionId: string) => {
    setSyncingSessionId(sessionId);
    try {
      await onSyncSession(sessionId);
      onRefresh();
      toast.success("Grupos atualizados");
    } catch {
      toast.error("Não foi possível sincronizar os grupos dessa sessão");
    } finally {
      setSyncingSessionId(null);
    }
  };

  const handleSyncAllOnline = async () => {
    if (onSyncAll) {
      setSyncingAll(true);
      try {
        await onSyncAll();
        onRefresh();
      } catch {
        toast.error(`Não foi possível sincronizar os grupos ${platformLabel}.`);
      } finally {
        setSyncingAll(false);
      }
      return;
    }

    if (onlineSessions.length === 0) {
      toast.error(`Nenhuma conta ${platformLabel} online para sincronizar.`);
      return;
    }

    setSyncingAll(true);
    try {
      const results: Array<"fulfilled" | "rejected"> = [];
      for (const session of onlineSessions) {
        try {
          await onSyncSession(session.id);
          results.push("fulfilled");
        } catch {
          results.push("rejected");
        }
      }
      onRefresh();
      const failed = results.filter((status) => status === "rejected").length;
      if (failed === 0) {
        toast.success(`Grupos atualizados de ${onlineSessions.length} conta(s).`);
      } else {
        toast.warning(`Sincronização parcial: ${onlineSessions.length - failed} ok, ${failed} com erro.`);
      }
    } finally {
      setSyncingAll(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {/* Sessions panel */}
      <Card className="glass">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Sessões {platformLabel}</p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="gap-1.5"
                onClick={handleSyncAllOnline}
                disabled={syncingAll || isSyncing}
              >
                {syncingAll || isSyncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Users className="h-3.5 w-3.5" />
                )}
                Sincronizar grupos
              </Button>
            </div>
          </div>

          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhuma conta conectada.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => {
                const groupCount = groups.filter((g) => g.sessionId === session.id).length;
                const isSyncingThis = syncingSessionId === session.id;
                return (
                  <div
                    key={session.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <ChannelPlatformIcon platform={platform} className="h-4 w-4 text-muted-foreground shrink-0" />
                      <p className="text-sm font-medium truncate">{session.name}</p>
                      <StatusIndicator status={session.status} />
                      {groupCount > 0 && (
                        <Badge variant="outline" className="text-2xs tabular-nums">
                          {groupCount} grupo(s)
                        </Badge>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs gap-1.5"
                      onClick={() => void handleSyncSession(session.id)}
                      disabled={isSyncingThis || isSyncing || session.status !== "online"}
                      title={session.status !== "online" ? "Sessão precisa estar online para sincronizar" : undefined}
                    >
                      {isSyncingThis ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      Sincronizar
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Groups list */}
      <Card className="glass">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={`Buscar grupos ${platformLabel}...`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
              />
            </div>

            <Select value={sessionFilter} onValueChange={setSessionFilter}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Filtrar por sessão" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as sessões</SelectItem>
                {sessions.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {session.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <InlineLoadingState label={`Carregando grupos ${platformLabel}...`} />
          ) : groups.length === 0 ? (
            <EmptyState
              icon={Users}
              title={`Nenhum grupo ${platformLabel}`}
              description={`Clique em "Sincronizar grupos" para puxar os grupos das contas online.`}
              actionLabel="Sincronizar grupos"
              onAction={handleSyncAllOnline}
            />
          ) : filteredGroups.length === 0 ? (
            <EmptyState
              icon={Search}
              title="Nenhum resultado"
              description="Mude a busca ou o filtro de sessão."
            />
          ) : (
            <div className="space-y-2">
              {filteredGroups.map((group) => {
                const sessionName = sessionNameById.get(group.sessionId) || "Sessão indisponível";
                const isMultiSession = !!group.externalId && multiSessionExternalIds.has(group.externalId);

                return (
                  <Card
                    key={group.id}
                    className={cn("glass overflow-hidden border-border/60")}
                  >
                    <CardContent className="p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="text-sm font-medium truncate">{group.name}</p>
                            {isMultiSession && (
                              <Badge
                                variant="info"
                                className="text-2xs gap-1"
                                title="Este grupo está disponível em mais de uma sessão"
                              >
                                <Layers className="h-2.5 w-2.5" />
                                Multissessão
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {group.memberCount} membro(s)
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <Badge variant="outline" className="text-2xs">{sessionName}</Badge>
                          <Badge
                            variant={isWhatsApp ? "success" : "info"}
                            className="text-2xs"
                          >
                            {platformLabel}
                          </Badge>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}



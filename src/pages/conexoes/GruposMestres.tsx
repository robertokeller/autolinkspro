import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Copy, Layers, Pencil, Plus, RefreshCw, Trash2, Unlink, Users } from "lucide-react";
import { useGrupos } from "@/hooks/useGrupos";
import type { DistributionMode, Group, MasterGroup } from "@/lib/types";

type MasterFormState = {
  id: string | null;
  name: string;
  distribution: DistributionMode;
  memberLimit: number;
  platform: "whatsapp" | "telegram";
  groupIds: string[];
};

const EMPTY_FORM: MasterFormState = {
  id: null,
  name: "",
  distribution: "balanced",
  memberLimit: 0,
  platform: "whatsapp",
  groupIds: [],
};

function normalizeDistribution(value: DistributionMode): DistributionMode {
  return value === "random" ? "random" : "balanced";
}

function getMasterDisplayPlatform(masterGroup: MasterGroup, linkedGroups: Group[]) {
  const platformSet = new Set(linkedGroups.map((group) => group.platform));
  if (platformSet.size === 1) return [...platformSet][0];
  if (masterGroup.platform === "whatsapp" || masterGroup.platform === "telegram") return masterGroup.platform;
  return "unknown";
}

export default function GruposMestresPage() {
  const {
    syncedGroups,
    masterGroups,
    isLoading,
    syncing,
    syncGroups,
    createMasterGroup,
    updateMasterGroup,
    setMasterGroupGroups,
    removeMasterGroup,
    unlinkGroup,
  } = useGrupos();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [form, setForm] = useState<MasterFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const groupsById = useMemo(() => new Map(syncedGroups.map((group) => [group.id, group])), [syncedGroups]);

  const groupedByPlatform = useMemo(
    () => ({
      whatsapp: syncedGroups.filter((group) => group.platform === "whatsapp"),
      telegram: syncedGroups.filter((group) => group.platform === "telegram"),
    }),
    [syncedGroups],
  );

  const filteredGroups = groupedByPlatform[form.platform] || [];
  const selectedDistribution = normalizeDistribution(form.distribution);
  const distributionHelpText = selectedDistribution === "random"
    ? "Aleatório: sorteia um grupo filho válido a cada entrada."
    : "Equilibrado: prioriza grupos com menos membros para dividir melhor.";

  const openNewDialog = () => {
    setForm(EMPTY_FORM);
    setIsDialogOpen(true);
  };

  const openEditDialog = (masterGroup: MasterGroup) => {
    const linkedGroups = masterGroup.groupIds
      .map((groupId) => groupsById.get(groupId))
      .filter((group): group is Group => Boolean(group));
    const platform = getMasterDisplayPlatform(masterGroup, linkedGroups);
    setForm({
      id: masterGroup.id,
      name: masterGroup.name,
      distribution: normalizeDistribution(masterGroup.distribution),
      memberLimit: masterGroup.memberLimit || 0,
      platform: platform === "telegram" ? "telegram" : "whatsapp",
      groupIds: linkedGroups
        .filter((group) => group.platform === (platform === "telegram" ? "telegram" : "whatsapp"))
        .map((group) => group.id),
    });
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
    setForm(EMPTY_FORM);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error("Informe o nome do grupo mestre");
      return;
    }
    if (form.groupIds.length === 0) {
      toast.error("Escolha pelo menos um grupo filho");
      return;
    }

    const selectedGroups = form.groupIds.map((groupId) => groupsById.get(groupId)).filter((group): group is Group => Boolean(group));
    if (selectedGroups.length !== form.groupIds.length) {
      toast.error("Um ou mais grupos selecionados não foram encontrados");
      return;
    }
    if (selectedGroups.some((group) => group.platform !== form.platform)) {
      toast.error("Grupo mestre só pode ter grupos da mesma rede");
      return;
    }

    setSaving(true);
    try {
      let masterGroupId = form.id;
      if (form.id) {
        const updated = await updateMasterGroup(form.id, {
          name: form.name,
          distribution: normalizeDistribution(form.distribution),
          memberLimit: form.memberLimit,
        });
        if (!updated) return;
      } else {
        masterGroupId = await createMasterGroup(
          form.name,
          normalizeDistribution(form.distribution),
          form.memberLimit,
          90,
        );
        if (!masterGroupId) return;
      }

      const linked = await setMasterGroupGroups(masterGroupId, form.groupIds);
      if (!linked) return;

      toast.success(form.id ? "Grupo mestre atualizado" : "Grupo mestre criado");
      closeDialog();
    } finally {
      setSaving(false);
    }
  };

  const handleCopyMasterLink = async (masterGroupId: string) => {
    const link = `${window.location.origin}/mg/${masterGroupId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link do grupo mestre copiado");
    } catch {
      toast.error("Não foi possível copiar o link agora");
    }
  };

  const handleCopyGroupInvite = async (inviteLink: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      toast.success("Link de convite copiado");
    } catch {
      toast.error("Não foi possível copiar o link agora");
    }
  };

  return (
    <div className="ds-page">
      <PageHeader
        title="Grupos Mestres"
        description="Crie concentradores de grupos filhos para envio em massa e distribuição por link."
      >
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={syncing} onClick={() => void syncGroups()}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            Sincronizar grupos
          </Button>
          <Button size="sm" onClick={openNewDialog}>
            <Plus className="mr-1.5 h-4 w-4" />
            Novo grupo mestre
          </Button>
        </div>
      </PageHeader>

      {masterGroups.length === 0 && !isLoading ? (
        <EmptyState
          icon={Layers}
          title="Nenhum grupo mestre criado"
          description="Crie um grupo mestre e vincule seus grupos filhos de WhatsApp ou Telegram."
          actionLabel="Criar grupo mestre"
          onAction={openNewDialog}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {masterGroups.map((masterGroup) => {
            const linkedGroups = masterGroup.groupIds
              .map((groupId) => groupsById.get(groupId))
              .filter((group): group is Group => Boolean(group));
            const totalMembers = linkedGroups.reduce((sum, group) => sum + Math.max(0, Number(group.memberCount || 0)), 0);
            const displayPlatform = getMasterDisplayPlatform(masterGroup, linkedGroups);
            const distributionLabel = normalizeDistribution(masterGroup.distribution) === "random" ? "Aleatório" : "Equilibrado";

            return (
              <Card key={masterGroup.id} className="glass">
                <CardHeader className="space-y-3 pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{masterGroup.name}</CardTitle>
                    </div>
                    <div className="flex gap-1.5">
                      <Badge variant="outline">{distributionLabel}</Badge>
                      <Badge variant="secondary">
                        {displayPlatform === "whatsapp" ? "WhatsApp" : displayPlatform === "telegram" ? "Telegram" : "Misto"}
                      </Badge>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1">
                      <Users className="h-3.5 w-3.5" />
                      {linkedGroups.length} grupo(s)
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1">
                      <Layers className="h-3.5 w-3.5" />
                      {totalMembers.toLocaleString("pt-BR")} membros
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Input readOnly value={`${window.location.origin}/mg/${masterGroup.id}`} className="h-8 text-xs" />
                    <Button size="sm" variant="outline" onClick={() => void handleCopyMasterLink(masterGroup.id)}>
                      <Copy className="mr-1 h-3.5 w-3.5" />
                      Copiar
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="space-y-3 pt-0">
                  <Separator />
                  <div className="space-y-2">
                    {linkedGroups.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Sem grupos filhos vinculados.</p>
                    ) : (
                      linkedGroups.map((group) => {
                        return (
                          <div key={`${masterGroup.id}-${group.id}`} className="rounded-lg border p-2">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{group.name}</p>
                                <p className="text-xs text-muted-foreground">{group.memberCount} membros</p>
                              </div>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8 shrink-0 text-muted-foreground"
                                onClick={() => void unlinkGroup(masterGroup.id, group.id)}
                                title="Desvincular grupo"
                              >
                                <Unlink className="h-4 w-4" />
                              </Button>
                            </div>
                            <div className="flex items-center justify-between gap-2 rounded-md border border-dashed px-2.5 py-2">
                              {group.inviteLink ? (
                                <p className="truncate text-xs text-muted-foreground">Convite sincronizado automaticamente</p>
                              ) : (
                                <p className="truncate text-xs text-muted-foreground">
                                  Convite automático pendente. Verifique se a sessão é admin do grupo.
                                </p>
                              )}
                              {group.inviteLink ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2"
                                  onClick={() => void handleCopyGroupInvite(group.inviteLink || "")}
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => openEditDialog(masterGroup)}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      Editar
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setDeletingId(masterGroup.id)}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Excluir
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar grupo mestre" : "Novo grupo mestre"}</DialogTitle>
            <DialogDescription>
              Um grupo mestre aceita grupos de apenas uma rede. O link público vai distribuir entradas com base no modo escolhido.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Nome</Label>
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Ex: Ofertas VIP WhatsApp"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12">
              <div className="space-y-2 lg:col-span-4">
                <Label>Rede</Label>
                <Select
                  value={form.platform}
                  onValueChange={(value: "whatsapp" | "telegram") => setForm((prev) => ({
                    ...prev,
                    platform: value,
                    groupIds: prev.groupIds.filter((groupId) => {
                      const group = groupsById.get(groupId);
                      return group?.platform === value;
                    }),
                  }))}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="whatsapp">WhatsApp</SelectItem>
                    <SelectItem value="telegram">Telegram</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 lg:col-span-4">
                <Label>Distribuição de entrada</Label>
                <Select
                  value={selectedDistribution}
                  onValueChange={(value: DistributionMode) => setForm((prev) => ({
                    ...prev,
                    distribution: normalizeDistribution(value),
                  }))}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="balanced">Equilibrado</SelectItem>
                    <SelectItem value="random">Aleatório</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {distributionHelpText}
                </p>
              </div>

              <div className="space-y-2 sm:col-span-2 lg:col-span-4">
                <Label>Limite de membros (opcional)</Label>
                <Input
                  className="h-10"
                  type="number"
                  min={0}
                  value={form.memberLimit}
                  onChange={(event) => setForm((prev) => ({
                    ...prev,
                    memberLimit: Number.isFinite(Number(event.target.value)) ? Math.max(0, Number(event.target.value)) : 0,
                  }))}
                />
                <p className="text-xs text-muted-foreground">
                  Hoje é apenas referência visual. Ainda não bloqueia entradas automaticamente.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Grupos filhos ({filteredGroups.length} disponíveis)</Label>
              <MultiOptionDropdown
                value={form.groupIds}
                onChange={(groupIds) => setForm((prev) => ({ ...prev, groupIds }))}
                items={filteredGroups.map((group) => ({
                  id: group.id,
                  label: group.name,
                  meta: `${group.memberCount}`,
                }))}
                placeholder="Escolher grupos filhos"
                selectedLabel={(count) => `${count} grupo(s) selecionado(s)`}
                emptyMessage={`Nenhum grupo ${form.platform === "whatsapp" ? "WhatsApp" : "Telegram"} disponível`}
                title="Grupos filhos"
                maxHeightClassName="max-h-64"
              />
              <p className="text-xs text-muted-foreground">
                Só entram grupos {form.platform === "whatsapp" ? "WhatsApp" : "Telegram"} neste grupo mestre.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              Cancelar
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Salvando..." : form.id ? "Salvar alterações" : "Criar grupo mestre"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir grupo mestre?</DialogTitle>
            <DialogDescription>
              Essa ação remove o grupo mestre e seus vínculos com grupos filhos.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeletingId(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deletingId) return;
                void removeMasterGroup(deletingId);
                setDeletingId(null);
              }}
            >
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useState, useRef, useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  LinkIcon, Plus, ExternalLink, Trash2, Edit, Layers, Users, Copy, Check,
  Upload, X, Image as ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useLinkHub } from "@/hooks/useLinkHub";
import { useGrupos } from "@/hooks/useGrupos";
import { ChannelPlatformIcon } from "@/components/icons/ChannelPlatformIcon";
import { MultiOptionDropdown } from "@/components/selectors/MultiOptionDropdown";
import { LINK_HUB_DEFAULT_THEME_COLOR, LINK_HUB_PRESET_COLORS } from "@/lib/link-hub-theme";

const PREVIEW_BASE = window.location.origin;

interface FormState {
  slug: string;
  title: string;
  description: string;
  themeColor: string;
  logoUrl: string | null;
  destinationMode: "group" | "master";
  groupIds: string[];
  masterGroupIds: string[];
  groupLabels: Record<string, string>;
}

const emptyForm: FormState = {
  slug: "", title: "", description: "", themeColor: LINK_HUB_DEFAULT_THEME_COLOR,
  logoUrl: null, destinationMode: "group", groupIds: [], masterGroupIds: [], groupLabels: {},
};

export default function LinkHub() {
  const { pages, isLoading, createPage, updatePage, toggleActive, deletePage, uploadLogo } = useLinkHub();
  const { syncedGroups: groups, masterGroups } = useGrupos();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetAndClose = () => { setDialogOpen(false); setEditingId(null); setForm(emptyForm); };

  const openNew = () => { setForm(emptyForm); setEditingId(null); setDialogOpen(true); };

  const openEdit = (page: typeof pages[0]) => {
    setEditingId(page.id);
    setForm({
      slug: page.slug, title: page.title, description: page.description,
      themeColor: page.themeColor, logoUrl: page.logoUrl,
      destinationMode: (page.masterGroupIds?.length || 0) > 0 ? "master" : "group",
      groupIds: [...page.groupIds], masterGroupIds: [...(page.masterGroupIds || [])],
      groupLabels: { ...(page.groupLabels || {}) },
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (form.destinationMode === "group" && form.groupIds.length === 0) {
      toast.error("Escolha pelo menos um grupo individual"); return;
    }
    if (form.destinationMode === "master" && form.masterGroupIds.length === 0) {
      toast.error("Escolha pelo menos um grupo mestre"); return;
    }

    const selectedGroupIds = form.destinationMode === "group" ? form.groupIds : [];
    const selectedMasterGroupIds = form.destinationMode === "master" ? form.masterGroupIds : [];
    const payload = {
      slug: form.slug, title: form.title, description: form.description,
      themeColor: form.themeColor, logoUrl: form.logoUrl,
      groupIds: selectedGroupIds, masterGroupIds: selectedMasterGroupIds,
      groupLabels: form.groupLabels,
    };
    if (editingId) {
      await updatePage(editingId, payload);
    } else {
      const result = await createPage(payload);
      if (!result) return;
    }
    resetAndClose();
  };

  const handleLogoUpload = async (file: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error("A logo pode ter no máximo 2MB"); return; }
    setUploading(true);
    const tempId = editingId || "new-" + Date.now();
    const url = await uploadLogo(tempId, file);
    if (url) setForm(prev => ({ ...prev, logoUrl: url }));
    setUploading(false);
  };

  const copyLink = (slug: string) => {
    navigator.clipboard.writeText(`${PREVIEW_BASE}/hub/${slug}`);
    setCopiedSlug(slug); toast.success("Link copiado!");
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const resolveGroupCount = (page: typeof pages[0]) => {
    const ids = new Set(page.groupIds);
    (page.masterGroupIds || []).forEach((mgId) => {
      const mg = masterGroups.find((m) => m.id === mgId);
      if (mg) mg.groupIds.forEach((gid) => ids.add(gid));
    });
    return ids.size;
  };

  const previewGroupCount = useMemo(() => {
    const ids = new Set<string>();
    if (form.destinationMode === "group") {
      form.groupIds.forEach((gid) => ids.add(gid));
    } else {
      form.masterGroupIds.forEach((mgId) => {
        const mg = masterGroups.find((m) => m.id === mgId);
        if (mg) mg.groupIds.forEach((gid) => ids.add(gid));
      });
    }
    return ids.size;
  }, [form.destinationMode, form.groupIds, form.masterGroupIds, masterGroups]);

  if (isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Link Hub" description="Crie páginas com os links dos seus grupos pra compartilhar" />
        <div className="space-y-3">{Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="glass"><CardContent className="py-4"><Skeleton className="h-12 w-full" /></CardContent></Card>
        ))}</div>
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader title="Link Hub" description="Crie páginas com os links dos seus grupos pra compartilhar">
        <Button size="sm" onClick={openNew}><Plus className="h-4 w-4 mr-1.5" />Nova página</Button>
      </PageHeader>

      {pages.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {pages.map((page) => (
            <Card key={page.id} className="glass group/card relative overflow-hidden transition-all hover:shadow-lg hover:shadow-primary/5">
              <div className="absolute top-0 left-0 right-0 h-1 rounded-t-lg" style={{ background: `linear-gradient(90deg, ${page.themeColor}, ${page.themeColor}88)` }} />
              <CardContent className="p-4 pt-5 flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  {page.logoUrl ? (
                    <img src={page.logoUrl} alt="" className="h-11 w-11 rounded-xl object-cover shrink-0 ring-1 ring-border/40" />
                  ) : (
                    <div
                      className="h-11 w-11 rounded-xl flex items-center justify-center text-base font-bold text-white shrink-0"
                      style={{ background: `linear-gradient(135deg, ${page.themeColor}, ${page.themeColor}bb)` }}
                    >
                      {page.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate">{page.title}</p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">/hub/{page.slug}</p>
                  </div>
                  <Badge variant={page.isActive ? "secondary" : "outline"} className={cn("text-2xs shrink-0", page.isActive ? "bg-success/10 text-success" : "")}>
                    {page.isActive ? "Ativa" : "Inativa"}
                  </Badge>
                </div>

                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="h-3 w-3" />
                  <span>{resolveGroupCount(page)} grupo{resolveGroupCount(page) !== 1 ? "s" : ""}</span>
                </div>

                <Separator className="opacity-50" />

                <div className="flex items-center justify-between">
                  <Switch checked={page.isActive} onCheckedChange={() => toggleActive(page.id, page.isActive)} aria-label="Ativar/desativar" />
                  <div className="flex items-center gap-0.5">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyLink(page.slug)} title="Copiar link">
                      {copiedSlug === page.slug ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" asChild title="Abrir">
                      <a href={`${PREVIEW_BASE}/hub/${page.slug}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" /></a>
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(page)} title="Editar">
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => deletePage(page.id)} title="Remover">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {/* Add new page card */}
          <button
            onClick={openNew}
            className="flex flex-col items-center justify-center gap-2.5 min-h-[180px] rounded-xl border-2 border-dashed border-border/50 text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all duration-200 cursor-pointer"
          >
            <div className="h-10 w-10 rounded-xl bg-muted/50 flex items-center justify-center">
              <Plus className="h-5 w-5" />
            </div>
            <span className="text-sm font-medium">Nova página</span>
          </button>
        </div>
      ) : (
        <EmptyState icon={LinkIcon} title="Nenhuma página ainda" description="Crie uma página com links dos seus grupos pra compartilhar com todo mundo." actionLabel="Criar página" onAction={openNew} />
      )}

      {/* Dialog Editor */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) resetAndClose(); }}>
        <DialogContent className="w-[min(96vw,1040px)] max-w-4xl max-h-[92dvh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b">
            <DialogTitle>{editingId ? "Editar página" : "Nova página"}</DialogTitle>
            <DialogDescription>Monte sua página com os grupos que você quer mostrar.</DialogDescription>
          </DialogHeader>

          <ScrollArea className="flex-1 px-6 overflow-y-auto">
            <div className="grid grid-cols-1 gap-6 py-5 lg:grid-cols-12">
              <div className="space-y-5 lg:col-span-6">
                <div className="rounded-xl border p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Informações da página</p>

                  {/* Title */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Título da página</Label>
                    <Input className="h-10 text-sm" placeholder="Ofertas Tech" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                  </div>

                  {/* Slug */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Endereço da página</Label>
                    <div className="flex items-center rounded-md border border-input overflow-hidden bg-background">
                      <span className="px-3 py-2.5 text-xs text-muted-foreground bg-muted/50 border-r border-input shrink-0 select-none">/hub/</span>
                      <Input className="h-10 text-sm border-0 shadow-none focus-visible:ring-0 rounded-none" placeholder="ofertas" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} />
                    </div>
                  </div>

                  {/* Description */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">Descrição curta</Label>
                    <Textarea
                      placeholder="Descontos e cupons em tempo real."
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      rows={3}
                      className="resize-none text-sm"
                    />
                  </div>

                  {/* Logo */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium flex items-center gap-1.5"><ImageIcon className="h-3.5 w-3.5" />Logo</Label>
                    <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); e.target.value = ""; }} />
                    {form.logoUrl ? (
                      <div className="flex items-center gap-3 rounded-lg border p-2.5">
                        <img src={form.logoUrl} alt="" className="h-12 w-12 rounded-xl object-cover ring-1 ring-border/50" />
                        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={() => setForm(prev => ({ ...prev, logoUrl: null }))}>
                          <X className="h-3 w-3" />Remover
                        </Button>
                      </div>
                    ) : (
                      <Button variant="outline" size="sm" className="h-9 text-xs gap-1.5" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                        <Upload className="h-3.5 w-3.5" />{uploading ? "Enviando..." : "Escolher imagem"}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-5 lg:col-span-6">
                <div className="rounded-xl border p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Aparência e grupos</p>

                  {/* Color */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Cor da página</Label>
                    <div className="flex gap-2 flex-wrap">
                      {LINK_HUB_PRESET_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={cn(
                            "h-8 w-8 rounded-full border-2 transition-all",
                            form.themeColor === color ? "border-foreground scale-105 ring-2 ring-primary/25" : "border-transparent hover:scale-105",
                          )}
                          style={{ backgroundColor: color }}
                          onClick={() => setForm({ ...form, themeColor: color })}
                        >
                          {form.themeColor === color ? <Check className="h-3.5 w-3.5 text-white mx-auto" /> : null}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label className="text-xs font-medium">Tipo de destino</Label>
                    <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, destinationMode: "group", masterGroupIds: [] }))}
                        className={cn(
                          "h-10 rounded-lg border text-xs font-medium transition-colors",
                          form.destinationMode === "group"
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/40",
                        )}
                      >
                        <span className="inline-flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />Grupo individual</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm((prev) => ({ ...prev, destinationMode: "master", groupIds: [] }))}
                        className={cn(
                          "h-10 rounded-lg border text-xs font-medium transition-colors",
                          form.destinationMode === "master"
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/40",
                        )}
                        disabled={masterGroups.length === 0}
                        title={masterGroups.length === 0 ? "Crie um grupo mestre para usar esta opção" : undefined}
                      >
                        <span className="inline-flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" />Grupo mestre</span>
                      </button>
                    </div>
                  </div>

                  {form.destinationMode === "master" ? (
                    <div className="space-y-2">
                      <Label className="text-xs font-medium flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" />Selecionar grupo mestre</Label>
                      <MultiOptionDropdown
                        value={form.masterGroupIds}
                        onChange={(ids) => setForm((prev) => ({ ...prev, masterGroupIds: ids }))}
                        items={masterGroups.map((masterGroup) => ({
                          id: masterGroup.id,
                          label: masterGroup.name,
                          meta: `${masterGroup.linkedGroups.length} grupos`,
                        }))}
                        placeholder="Escolher grupos mestres"
                        selectedLabel={(count) => `${count} grupo(s) mestre(s)`}
                        emptyMessage="Nenhum grupo mestre criado"
                        title="Grupos mestre"
                        maxHeightClassName="max-h-56"
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label className="text-xs font-medium flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />Selecionar grupos individuais</Label>
                      <MultiOptionDropdown
                        value={form.groupIds}
                        onChange={(ids) => setForm((prev) => ({ ...prev, groupIds: ids }))}
                        items={groups.map((group) => ({
                          id: group.id,
                          label: group.name,
                          meta: `${group.memberCount}`,
                        }))}
                        placeholder="Escolher grupos"
                        selectedLabel={(count) => `${count} grupo(s)`}
                        emptyMessage="Nenhum grupo sincronizado"
                        title="Grupos"
                        maxHeightClassName="max-h-56"
                      />
                    </div>
                  )}

                  <p className="text-2xs text-muted-foreground">
                    {previewGroupCount} grupo{previewGroupCount !== 1 ? "s" : ""} selecionado{previewGroupCount !== 1 ? "s" : ""} para a página.
                  </p>
                </div>

                <div className="rounded-xl border">
                  <div className="px-3 py-2.5 border-b">
                    <p className="text-xs font-medium text-muted-foreground">Prévia dos grupos selecionados</p>
                  </div>
                  <ScrollArea className="max-h-[260px]">
                    <div className="p-2 space-y-1">
                      {groups.length > 0 ? groups.map((g) => {
                        const includedViaMaster = form.masterGroupIds.some((mgId) => {
                          const mg = masterGroups.find((m) => m.id === mgId);
                          return mg?.groupIds.includes(g.id);
                        });
                        const isSelected = form.groupIds.includes(g.id) || includedViaMaster;
                        if (!isSelected) return null;
                        return (
                          <div key={g.id} className="space-y-1.5 rounded-lg border p-2">
                            <div className="flex items-center gap-2 text-xs">
                              <div className="h-5 w-5 rounded flex items-center justify-center text-white shrink-0" style={{ backgroundColor: g.platform === "whatsapp" ? "hsl(var(--brand-whatsapp))" : "hsl(var(--brand-telegram))" }}>
                                <ChannelPlatformIcon platform={g.platform} className="h-2.5 w-2.5" />
                              </div>
                              <span className="font-medium truncate flex-1">{g.name}</span>
                              <span className="text-muted-foreground shrink-0">{g.memberCount}</span>
                              {includedViaMaster && <span className="text-2xs text-muted-foreground shrink-0">mestre</span>}
                            </div>
                            <Input
                              placeholder="Nome na página (se quiser mudar)"
                              value={form.groupLabels[g.id] || ""}
                              onChange={(e) => setForm((prev) => ({
                                ...prev,
                                groupLabels: { ...prev.groupLabels, [g.id]: e.target.value },
                              }))}
                              className="h-8 text-xs"
                            />
                          </div>
                        );
                      }) : (
                        <p className="text-xs text-muted-foreground p-2">Sem grupos sincronizados.</p>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </div>
          </ScrollArea>

          <DialogFooter className="px-6 py-4 border-t gap-2">
            <Button variant="ghost" size="sm" onClick={resetAndClose}>Cancelar</Button>
            <Button size="sm" onClick={handleSave}>{editingId ? "Salvar" : "Criar página"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


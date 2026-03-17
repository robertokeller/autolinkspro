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
  groupIds: string[];
  masterGroupIds: string[];
  groupLabels: Record<string, string>;
}

const emptyForm: FormState = {
  slug: "", title: "", description: "", themeColor: LINK_HUB_DEFAULT_THEME_COLOR,
  logoUrl: null, groupIds: [], masterGroupIds: [], groupLabels: {},
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
      groupIds: [...page.groupIds], masterGroupIds: [...(page.masterGroupIds || [])],
      groupLabels: { ...(page.groupLabels || {}) },
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (form.groupIds.length === 0 && form.masterGroupIds.length === 0) {
      toast.error("Selecione pelo menos um grupo"); return;
    }
    const payload = {
      slug: form.slug, title: form.title, description: form.description,
      themeColor: form.themeColor, logoUrl: form.logoUrl,
      groupIds: form.groupIds, masterGroupIds: form.masterGroupIds,
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
    if (file.size > 2 * 1024 * 1024) { toast.error("Logo deve ter no máximo 2MB"); return; }
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
    const ids = new Set(form.groupIds);
    form.masterGroupIds.forEach((mgId) => {
      const mg = masterGroups.find((m) => m.id === mgId);
      if (mg) mg.groupIds.forEach((gid) => ids.add(gid));
    });
    return ids.size;
  }, [form.groupIds, form.masterGroupIds, masterGroups]);

  if (isLoading) {
    return (
      <div className="ds-page">
        <PageHeader title="Link Hub" description="Crie páginas públicas personalizáveis com links dos seus grupos" />
        <div className="space-y-3">{Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="glass"><CardContent className="py-4"><Skeleton className="h-12 w-full" /></CardContent></Card>
        ))}</div>
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader title="Link Hub" description="Crie páginas públicas personalizáveis com links dos seus grupos">
        <Button size="sm" onClick={openNew}><Plus className="h-4 w-4 mr-1.5" />Nova página</Button>
      </PageHeader>

      {pages.length > 0 ? (
        <div className="space-y-3">
          {pages.map((page) => (
            <Card key={page.id} className="glass">
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3 min-w-0">
                  {page.logoUrl ? (
                    <img src={page.logoUrl} alt="" className="h-11 w-11 rounded-xl object-cover shrink-0" />
                  ) : (
                    <div className="h-11 w-11 rounded-xl flex items-center justify-center text-white font-bold shrink-0" style={{ backgroundColor: page.themeColor }}>
                      {page.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{page.title}</p>
                    <p className="text-xs text-muted-foreground truncate">/hub/{page.slug} - {resolveGroupCount(page)} grupo{resolveGroupCount(page) !== 1 ? "s" : ""}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={page.isActive} onCheckedChange={() => toggleActive(page.id, page.isActive)} aria-label="Ativar/desativar" />
                  <Badge variant={page.isActive ? "secondary" : "outline"} className={cn("text-xs", page.isActive ? "bg-success/10 text-success" : "")}>
                    {page.isActive ? "Ativa" : "Inativa"}
                  </Badge>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => copyLink(page.slug)} title="Copiar link">
                    {copiedSlug === page.slug ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" asChild title="Abrir">
                    <a href={`${PREVIEW_BASE}/hub/${page.slug}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" /></a>
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openEdit(page)} title="Editar">
                    <Edit className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => deletePage(page.id)} title="Remover">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState icon={LinkIcon} title="Nenhuma página criada" description="Crie uma página pública personalizada com links para seus grupos." actionLabel="Criar página" onAction={openNew} />
      )}

      {/* Dialog Editor */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) resetAndClose(); }}>
        <DialogContent className="max-w-lg max-h-[92dvh] flex flex-col p-0 gap-0">
          <DialogHeader className="p-5 pb-3">
            <DialogTitle>{editingId ? "Editar página" : "Nova página"}</DialogTitle>
            <DialogDescription>Configure sua página pública de grupos.</DialogDescription>
          </DialogHeader>

          <ScrollArea className="flex-1 px-5 overflow-y-auto">
            <div className="space-y-4 pb-4">

              {/* Slug + Title */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Slug da URL</Label>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">/hub/</span>
                    <Input className="h-9 text-xs" placeholder="ofertas" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Título</Label>
                  <Input className="h-9 text-xs" placeholder="! Ofertas Tech" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                </div>
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <Label className="text-xs">Descrição</Label>
                <Textarea
                  placeholder="Os melhores descontos e cupons em tempo real."
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  className="resize-none text-xs"
                />
              </div>

              {/* Logo + Color row */}
              <div className="flex items-start gap-4">
                {/* Logo */}
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1"><ImageIcon className="h-3 w-3" />Logo</Label>
                  <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); e.target.value = ""; }} />
                  {form.logoUrl ? (
                    <div className="flex items-center gap-2">
                      <img src={form.logoUrl} alt="" className="h-10 w-10 rounded-lg object-cover border" />
                      <Button variant="ghost" size="sm" className="h-8 text-xs px-2" onClick={() => setForm(prev => ({ ...prev, logoUrl: null }))}>
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                      <Upload className="h-3 w-3 mr-1" />{uploading ? "..." : "Upload"}
                    </Button>
                  )}
                </div>

                {/* Color */}
                <div className="space-y-1.5 flex-1">
                  <Label className="text-xs">Cor do Tema</Label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={form.themeColor} onChange={(e) => setForm({ ...form, themeColor: e.target.value })} className="h-8 w-8 rounded-lg cursor-pointer border-0 p-0" />
                    <div className="flex gap-1 flex-wrap">
                      {LINK_HUB_PRESET_COLORS.map((color) => (
                        <button key={color} className={cn("h-6 w-6 rounded-full border-2 transition-all hover:scale-110", form.themeColor === color ? "border-foreground scale-110" : "border-transparent")} style={{ backgroundColor: color }} onClick={() => setForm({ ...form, themeColor: color })} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Master Groups */}
              {masterGroups.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs flex items-center gap-1"><Layers className="h-3 w-3" />Grupos Mestres</Label>
                  <MultiOptionDropdown
                    value={form.masterGroupIds}
                    onChange={(ids) => setForm((prev) => ({ ...prev, masterGroupIds: ids }))}
                    items={masterGroups.map((masterGroup) => ({
                      id: masterGroup.id,
                      label: masterGroup.name,
                      meta: `${masterGroup.linkedGroups.length} grupos`,
                    }))}
                    placeholder="Selecionar grupos mestre"
                    selectedLabel={(count) => `${count} grupo(s) mestre selecionado(s)`}
                    emptyMessage="Nenhum grupo mestre cadastrado"
                    title="Grupos mestre"
                    maxHeightClassName="max-h-52"
                  />
                </div>
              )}

              {/* Individual Groups */}
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1"><Users className="h-3 w-3" />Grupos ({previewGroupCount} selecionados)</Label>
                <MultiOptionDropdown
                  value={form.groupIds}
                  onChange={(ids) => setForm((prev) => ({ ...prev, groupIds: ids }))}
                  items={groups.map((group) => ({
                    id: group.id,
                    label: group.name,
                    meta: `${group.memberCount}`,
                  }))}
                  placeholder="Selecionar grupos individuais"
                  selectedLabel={(count) => `${count} grupo(s) individual(is) selecionado(s)`}
                  emptyMessage="Nenhum grupo sincronizado"
                  title="Grupos individuais"
                  maxHeightClassName="max-h-64"
                />

                <div className="rounded-md border">
                  <ScrollArea className="max-h-[200px]">
                    <div className="p-1.5 space-y-0.5">
                      {groups.length > 0 ? groups.map((g) => {
                        const includedViaMaster = form.masterGroupIds.some((mgId) => {
                          const mg = masterGroups.find((m) => m.id === mgId);
                          return mg?.groupIds.includes(g.id);
                        });
                        const isSelected = form.groupIds.includes(g.id) || includedViaMaster;
                        if (!isSelected) return null;
                        return (
                          <div key={g.id} className="space-y-1 pb-1">
                            <div className="flex items-center gap-2 text-xs p-1.5 rounded bg-secondary/40">
                              <div className="h-5 w-5 rounded flex items-center justify-center text-white shrink-0" style={{ backgroundColor: g.platform === "whatsapp" ? "hsl(var(--brand-whatsapp))" : "hsl(var(--brand-telegram))" }}>
                                <ChannelPlatformIcon platform={g.platform} className="h-2.5 w-2.5" />
                              </div>
                              <span className="font-medium truncate flex-1">{g.name}</span>
                              <span className="text-muted-foreground shrink-0">{g.memberCount}</span>
                              {includedViaMaster && <span className="text-2xs text-muted-foreground shrink-0">mestre</span>}
                            </div>
                            <div className="pl-7 pr-1.5">
                              <Input
                                placeholder="Título na página (opcional)"
                                value={form.groupLabels[g.id] || ""}
                                onChange={(e) => setForm((prev) => ({
                                  ...prev,
                                  groupLabels: { ...prev.groupLabels, [g.id]: e.target.value },
                                }))}
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                        );
                      }) : (
                        <p className="text-xs text-muted-foreground p-2">Nenhum grupo sincronizado.</p>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </div>
          </ScrollArea>

          <DialogFooter className="p-4 pt-3 border-t gap-2">
            <Button variant="ghost" size="sm" onClick={resetAndClose}>Cancelar</Button>
            <Button size="sm" onClick={handleSave}>{editingId ? "Salvar" : "Criar Página"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


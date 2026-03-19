import { useMemo, useRef, useState } from "react";
import { templateSchema } from "@/lib/validations";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Copy, Edit, FileText, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTemplates } from "@/hooks/useTemplates";
import type { Template, TemplateCategory } from "@/lib/types";
import { applyMeliTemplatePlaceholders, buildMeliTemplatePlaceholderData } from "@/lib/meli-template-placeholders";

const DEFAULT_TEMPLATE_FORM = {
  name: "",
  content: "",
  category: "oferta" as TemplateCategory,
};

const DEFAULT_TEMPLATE_CONTENT = "**{titulo}**\nDe R$ {preco_original} por R$ {preco}\n{parcelamento}\n⭐ {avaliacao} ({avaliacoes})\n🛍️ {vendedor}\n{link}";

const PLACEHOLDER_LEGEND: Array<{ key: string; description: string }> = [
  { key: "{titulo}", description: "Titulo do produto" },
  { key: "{preco}", description: "Preco atual" },
  { key: "{preco_original}", description: "Preco antes da oferta" },
  { key: "{link}", description: "Link de afiliado" },
  { key: "{imagem}", description: "Imagem do produto (anexo)" },
  { key: "{avaliacao}", description: "Nota media do produto" },
  { key: "{avaliacoes}", description: "Quantidade de avaliacoes" },
  { key: "{parcelamento}", description: "Condicoes de pagamento parcelado" },
  { key: "{vendedor}", description: "Nome da loja/vendedor" },
];

const PREVIEW_DATA = buildMeliTemplatePlaceholderData(
  {
    title: "Smartwatch Ultra Pro Bluetooth",
    productUrl: "https://www.mercadolivre.com.br/exemplo",
    imageUrl: "",
    price: 149.9,
    oldPrice: 249.9,
    installmentsText: "10x R$14,99 sem juros",
    seller: "Loja Oficial Brasil",
    rating: 4.8,
    reviewsCount: 2311,
  },
  "https://autolinks.pro/exemplo",
);

function renderPreview(content: string) {
  return applyMeliTemplatePlaceholders(content || "", PREVIEW_DATA).trim();
}

export default function TemplatesMeli() {
  const {
    templates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    duplicateTemplate,
  } = useTemplates("meli");

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [form, setForm] = useState(DEFAULT_TEMPLATE_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const deleteTarget = useMemo(
    () => templates.find((item) => item.id === deleteId) || null,
    [deleteId, templates],
  );

  const openNew = () => {
    setForm({
      ...DEFAULT_TEMPLATE_FORM,
      content: DEFAULT_TEMPLATE_CONTENT,
    });
    setEditing(null);
    setShowModal(true);
  };

  const openEdit = (template: Template) => {
    setEditing(template);
    setForm({
      name: template.name,
      content: template.content,
      category: template.category,
    });
    setShowModal(true);
  };

  const insertPlaceholder = (key: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      setForm((prev) => ({ ...prev, content: `${prev.content}${key}` }));
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextContent = form.content.slice(0, start) + key + form.content.slice(end);
    setForm((prev) => ({ ...prev, content: nextContent }));

    setTimeout(() => {
      textarea.focus();
      const cursor = start + key.length;
      textarea.selectionStart = cursor;
      textarea.selectionEnd = cursor;
    }, 0);
  };

  const onSave = async () => {
    const parsed = templateSchema.safeParse({
      name: form.name,
      content: form.content,
      category: form.category,
    });

    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message || "Dados invalidos");
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        await updateTemplate(editing.id, parsed.data);
      } else {
        await createTemplate(parsed.data.name, parsed.data.content, parsed.data.category);
      }
      setShowModal(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ds-page">
      <PageHeader
        title="Templates Meli"
        description="Modelos de mensagem para Vitrine ML, Agendamentos e Piloto automatico"
      >
        <Button onClick={openNew} size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Novo template
        </Button>
      </PageHeader>

      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base">Placeholders Mercado Livre</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {PLACEHOLDER_LEGEND.map((item) => (
            <Button key={item.key} type="button" variant="outline" size="sm" onClick={() => insertPlaceholder(item.key)} title={item.description}>
              {item.key}
            </Button>
          ))}
        </CardContent>
      </Card>

      {templates.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Nenhum template Meli criado"
          description="Crie seu primeiro template para usar nas automacoes e agendamentos do Mercado Livre."
          actionLabel="Criar template"
          onAction={openNew}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.id} className="glass">
              <CardHeader className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="line-clamp-2 text-base">{template.name}</CardTitle>
                  {template.isDefault ? <Badge className="bg-warning text-warning-foreground">Padrao</Badge> : null}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{template.category}</Badge>
                  <Badge variant="outline">meli</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/25 p-3 text-xs leading-relaxed text-muted-foreground">
                  {renderPreview(template.content) || "Template vazio"}
                </pre>
                <Separator />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => openEdit(template)}>
                    <Edit className="mr-1.5 h-3.5 w-3.5" />
                    Editar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => duplicateTemplate(template.id)}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Duplicar
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDefaultTemplate(template.id)}>
                    <Star className="mr-1.5 h-3.5 w-3.5" />
                    {template.isDefault ? "Remover *" : "Padrao *"}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleteId(template.id)}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Apagar
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar template Meli" : "Novo template Meli"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Nome</Label>
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Ex: Oferta padrao ML"
              />
            </div>

            <div className="space-y-2">
              <Label>Categoria</Label>
              <Select value={form.category} onValueChange={(value) => setForm((prev) => ({ ...prev, category: value as TemplateCategory }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oferta">oferta</SelectItem>
                  <SelectItem value="cupom">cupom</SelectItem>
                  <SelectItem value="geral">geral</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Mensagem</Label>
              <Textarea
                ref={textareaRef}
                value={form.content}
                onChange={(event) => setForm((prev) => ({ ...prev, content: event.target.value }))}
                placeholder={DEFAULT_TEMPLATE_CONTENT}
                className="min-h-[220px]"
              />
            </div>

            <div className="space-y-2">
              <Label>Preview</Label>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/25 p-3 text-sm leading-relaxed">
                {renderPreview(form.content) || "Nada para visualizar"}
              </pre>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancelar</Button>
            <Button onClick={() => { void onSave(); }} disabled={saving}>
              {saving ? "Salvando..." : editing ? "Salvar" : "Criar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover template?</AlertDialogTitle>
            <AlertDialogDescription>
              O template <strong>{deleteTarget?.name || "-"}</strong> sera removido permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteId) {
                  void deleteTemplate(deleteId);
                }
                setDeleteId(null);
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

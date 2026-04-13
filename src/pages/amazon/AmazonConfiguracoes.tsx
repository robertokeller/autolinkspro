import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Clock,
  Info,
  ChevronDown,
  Plus,
  Edit2,
  Trash2,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { backend } from "@/integrations/backend/client";
import { amazonTagQueryKey } from "@/hooks/useAmazonAffiliateTag";
import { toast } from "sonner";
import { formatBRT } from "@/lib/timezone";
import { InlineLoadingState } from "@/components/InlineLoadingState";

const TUTORIAL_STEPS = [
  {
    step: 1,
    title: "Acesse o Amazon Associates",
    description: "Faça login em sua conta de Associado da Amazon em associates.amazon.com.br.",
    link: "https://associates.amazon.com.br",
    linkLabel: "Ir para Amazon Associates",
  },
  {
    step: 2,
    title: "Localize o ID de rastreamento padrão",
    description: 'No topo da página do painel, procure por "ID de rastreamento padrão" ou "StoreID".',
  },
  {
    step: 3,
    title: "Identifique o formato da sua tag",
    description: 'Sua tag de afiliado possui o formato: seusite-20 (onde "seusite" é seu identificador único e "-20" é o sufixo do país, como -20 para Brasil)',
  },
  {
    step: 4,
    title: "Copie e cole no campo abaixo",
    description: 'Copie o ID de rastreamento completo (incluindo o "-20") e cole no campo de "Tag de Afiliado" abaixo. Depois clique em Salvar.',
  },
];

type ConnectionStatus = "connected" | "empty";

type AmazonAffiliateTag = {
  id: string;
  user_id: string;
  affiliate_tag: string;
  created_at: string;
  updated_at: string;
};

function tagStatusBadge(status: ConnectionStatus) {
  if (status === "connected") {
    return <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />Configurada</Badge>;
  }
  return <Badge variant="secondary"><Clock className="mr-1 h-3 w-3" />Não configurada</Badge>;
}

export default function AmazonConfiguracoes() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [affiliateTag, setAffiliateTag] = useState("");
  const [savedTag, setSavedTag] = useState<AmazonAffiliateTag | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);

  // Carregar tag existente
  useEffect(() => {
    const loadAffiliateTag = async () => {
      if (!user?.id) {
        setLoading(false);
        return;
      }

      try {
        const { data, error } = await backend
          .from("amazon_affiliate_tags")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (error) {
          throw error;
        }

        setSavedTag(data ? (data as AmazonAffiliateTag) : null);
        setAffiliateTag("");
      } catch (err) {
        console.error("Erro ao carregar tag de afiliado:", err);
        toast.error("Erro ao carregar configurações");
        setSavedTag(null);
      } finally {
        setLoading(false);
      }
    };

    void loadAffiliateTag();
  }, [user?.id]);

  const handleOpenEdit = () => {
    setAffiliateTag(savedTag?.affiliate_tag || "");
    setIsEditOpen(true);
  };

  const handleSave = async () => {
    // Validações
    if (!affiliateTag.trim()) {
      toast.error("Cole sua tag de afiliado da Amazon");
      return;
    }

    if (affiliateTag.trim().length < 4) {
      toast.error("A tag de afiliado parece muito curta");
      return;
    }

    if (!affiliateTag.includes("-")) {
      toast.error("A tag deve conter um hífen (ex: seusite-20)");
      return;
    }

    if (!user?.id) {
      toast.error("Você precisa estar autenticado");
      return;
    }

    setSaving(true);
    try {
      const tagValue = affiliateTag.trim();
      
      if (savedTag) {
        // Atualizar existente
        const { error } = await backend
          .from("amazon_affiliate_tags")
          .update({
            affiliate_tag: tagValue,
            updated_at: new Date().toISOString(),
          })
          .eq("id", savedTag.id);

        if (error) throw new Error(`Falha ao atualizar: ${error.message}`);

        setSavedTag({ ...savedTag, affiliate_tag: tagValue, updated_at: new Date().toISOString() });
        toast.success("Tag atualizada!");
      } else {
        // Criar novo
        const { data, error } = await backend
          .from("amazon_affiliate_tags")
          .insert([{ affiliate_tag: tagValue, user_id: user.id }])
          .select()
          .single();

        if (error) throw new Error(`Falha ao salvar: ${error.message}`);
        if (data) {
          setSavedTag(data as AmazonAffiliateTag);
          toast.success("Tag salva!");
        }
      }

      void queryClient.invalidateQueries({ queryKey: amazonTagQueryKey(user.id) });
      void queryClient.invalidateQueries({ queryKey: ["amazon-vitrine"] });
      void queryClient.invalidateQueries({ queryKey: ["marketplace_automations", "amazon"] });
      setIsEditOpen(false);
      setAffiliateTag("");
    } catch (err) {
      console.error("Erro ao salvar:", err);
      let message = "Não foi possível salvar a tag";
      if (err instanceof Error) {
        message = err.message;
        if (message.includes("unique")) {
          message = "Você já tem uma tag configurada.";
        } else if (message.includes("policies")) {
          message = "Você não tem permissão para salvar esta tag.";
        }
      }
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!savedTag?.id) return;

    setIsDeleting(true);
    try {
      const { error } = await backend
        .from("amazon_affiliate_tags")
        .delete()
        .eq("id", savedTag.id)
        .eq("user_id", user?.id);

      if (error) throw new Error(`Falha ao remover: ${error.message}`);

      setSavedTag(null);
      setDeleteConfirm(false);
      toast.success("Tag removida!");
      void queryClient.invalidateQueries({ queryKey: amazonTagQueryKey(user?.id) });
      void queryClient.invalidateQueries({ queryKey: ["amazon-vitrine"] });
      void queryClient.invalidateQueries({ queryKey: ["marketplace_automations", "amazon"] });
    } catch (err) {
      console.error("Erro ao deletar:", err);
      let message = "Não foi possível remover a tag";
      if (err instanceof Error) message = err.message;
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const connectionStatus: ConnectionStatus = savedTag ? "connected" : "empty";

  if (loading) {
    return (
      <div className="ds-page">
        <PageHeader
          title="Configurações Amazon"
          description="Conecte sua tag de afiliado da Amazon"
        />
        <InlineLoadingState label="Carregando configurações..." className="max-w-2xl" />
      </div>
    );
  }

  return (
    <div className="ds-page">
      <PageHeader
        title="Configurações Amazon"
        description="Conecte sua tag de afiliado da Amazon"
      />

      {/* Tag Card */}
      <Card className="glass">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Tag de Afiliado</CardTitle>
              <CardDescription>Configure sua tag de rastreamento da Amazon Associates</CardDescription>
            </div>
            {!savedTag && (
              <Button onClick={() => setIsEditOpen(true)} size="sm">
                <Plus className="mr-1.5 h-4 w-4" />
                Adicionar
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {savedTag ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/30 p-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-muted px-2 py-1 font-mono text-sm font-medium">
                      {savedTag.affiliate_tag}
                    </code>
                    {tagStatusBadge(connectionStatus)}
                  </div>
                  {savedTag.updated_at && (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      Atualizado em {formatBRT(savedTag.updated_at, "dd/MM/yyyy 'às' HH:mm")}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => handleOpenEdit()}>
                    <Edit2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleteConfirm(true)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
              <AlertCircle className="h-10 w-10 opacity-40" />
              <p className="text-sm">Nenhuma tag configurada</p>
              <p className="text-xs">Adicione sua tag de afiliado da Amazon para começar.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tutorial Instructions */}
      <Collapsible open={tutorialOpen} onOpenChange={setTutorialOpen}>
        <Card className="glass">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer select-none hover:bg-muted/40 transition-colors">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Info className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle className="text-base">Como encontrar sua tag?</CardTitle>
                    <CardDescription className="text-xs mt-0.5">
                      Guia passo a passo para localizar seu ID de rastreamento
                    </CardDescription>
                  </div>
                </div>
                <ChevronDown
                  className={`h-5 w-5 text-muted-foreground transition-transform duration-300 shrink-0 ${
                    tutorialOpen ? "rotate-180" : ""
                  }`}
                />
              </div>
            </CardHeader>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="border-t space-y-6 pt-6 bg-muted/20">
              {TUTORIAL_STEPS.map((step, idx) => (
                <div key={step.step} className="relative flex gap-5">
                  {idx < TUTORIAL_STEPS.length - 1 && (
                    <div className="absolute left-4 top-12 bottom-0 w-px bg-border/40" />
                  )}
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                    {step.step}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                    <p className="text-sm font-semibold">{step.title}</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {step.description}
                    </p>
                    {step.link && (
                      <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 mt-2" asChild>
                        <a href={step.link} target="_blank" rel="noopener noreferrer">
                          {step.linkLabel} <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Edit Dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{savedTag ? "Atualizar" : "Adicionar"} Tag de Afiliado</DialogTitle>
            <DialogDescription>
              {savedTag ? "Atualize sua tag de rastreamento" : "Cole sua tag de rastreamento da Amazon Associates"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Tag de Afiliado</Label>
              <Input
                placeholder="ex: seusite-20"
                value={affiliateTag}
                onChange={(e) => setAffiliateTag(e.target.value)}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                Formato: <code className="bg-muted px-1 py-0.5 rounded">seusite-20</code>
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !affiliateTag.trim()}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Salvando...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  {savedTag ? "Atualizar" : "Salvar"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover tag?</AlertDialogTitle>
            <AlertDialogDescription>
              A tag <strong>{savedTag?.affiliate_tag}</strong> será removida. Você pode adicionar uma nova depois.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Removendo...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Remover
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

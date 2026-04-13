import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Link2, RefreshCw } from "lucide-react";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { ROUTES } from "@/lib/routes";
import { Button } from "@/components/ui/button";

type MasterGroupInviteResponse = {
  redirectUrl: string;
  group: {
    id: string;
    name: string;
    platform: string;
    memberCount: number;
  };
  mode: "balanced" | "random";
  masterGroup: {
    id: string;
    name: string;
  };
};

export default function MasterGroupPublicPage() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, isError, refetch } = useQuery<MasterGroupInviteResponse>({
    queryKey: ["master_group_public_invite", id],
    queryFn: () =>
      invokeBackendRpc<MasterGroupInviteResponse>("master-group-invite", {
        body: { masterGroupId: id },
      }),
    enabled: !!id,
    retry: false,
  });

  useEffect(() => {
    const target = data?.redirectUrl;
    if (!target) return;
    // Security: validate protocol before redirect to prevent javascript: / data: injection
    try {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    } catch {
      return;
    }
    window.location.replace(target);
  }, [data?.redirectUrl]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparando seu acesso ao grupo...
        </div>
      </div>
    );
  }

  if (isError || !data?.redirectUrl) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md rounded-xl border bg-card p-5 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Link2 className="h-5 w-5 text-muted-foreground" />
          </div>
          <h1 className="text-base font-semibold">Não foi possível abrir este convite</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            O link pode estar inválido ou sem grupos filhos com convite ativo.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" onClick={() => void refetch()}>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Tentar novamente
            </Button>
            <Button asChild>
              <Link to={ROUTES.home}>Voltar</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}


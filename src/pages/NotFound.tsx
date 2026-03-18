import { Link } from "react-router-dom";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/routes";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="max-w-md space-y-6 px-4 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-muted">
          <FileQuestion className="h-10 w-10 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">404</h1>
          <p className="text-lg text-muted-foreground">Página não encontrada</p>
          <p className="text-sm text-muted-foreground">Essa página não existe ou foi movida pra outro lugar.</p>
        </div>
        <Button asChild>
          <Link to={ROUTES.app.dashboard}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Voltar pro painel
          </Link>
        </Button>
      </div>
    </div>
  );
}


import { Link, useSearchParams } from "react-router-dom";
import { CardFooter } from "@/components/ui/card";
import { AuthCard } from "@/components/auth/AuthCard";
import { ROUTES } from "@/lib/routes";

function resolveContent(status: string) {
  if (status === "success") {
    return {
      title: "E-mail confirmado",
      description: "Sua conta foi confirmada. Agora voce ja pode entrar no sistema.",
    };
  }
  if (status === "invalid") {
    return {
      title: "Link invalido",
      description: "Este link de confirmacao e invalido ou expirou. Solicite um novo no login.",
    };
  }
  return {
    title: "Falha na confirmacao",
    description: "Não foi possível confirmar o e-mail agora. Tente novamente mais tarde.",
  };
}

export default function VerificacaoEmail() {
  const [searchParams] = useSearchParams();
  const status = searchParams.get("status") || "error";
  const content = resolveContent(status);

  return (
    <AuthCard title={content.title} description={content.description} showLogo={false}>
      <CardFooter className="flex flex-col gap-3">
        <Link to={ROUTES.auth.login} className="text-sm text-primary hover:underline">
          Ir para login
        </Link>
        <Link to={ROUTES.auth.esqueciSenha} className="text-sm text-muted-foreground hover:text-primary">
          Esqueci minha senha
        </Link>
      </CardFooter>
    </AuthCard>
  );
}

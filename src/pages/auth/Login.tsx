import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { backend } from "@/integrations/backend/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { AuthCard } from "@/components/auth/AuthCard";
import { PasswordField } from "@/components/auth/PasswordField";
import { ROUTES } from "@/lib/routes";

const loginSchema = z.object({
  email: z.string().trim().email("E-mail inválido").max(255),
  password: z.string().min(6, "Mínimo 6 caracteres").max(128),
});

function isApiUnavailableMessage(message: string): boolean {
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("serviço api offline")
    || lower.includes("servico api offline")
    || lower.includes("servidor indisponível")
    || lower.includes("servidor indisponivel")
    || lower.includes("failed to fetch")
    || lower.includes("networkerror")
    || lower.includes("timeout")
  );
}

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = loginSchema.safeParse({ email, password });

    if (!parsed.success) {
      toast.error(parsed.error.errors[0].message);
      return;
    }

    setLoading(true);
    try {
      const result = await backend.auth.signInWithPassword({
        email: parsed.data.email,
        password: parsed.data.password,
      });
      const error = result?.error;

      if (error) {
        const msg = error.message || "";
        if (
          msg === "Email not confirmed" ||
          msg.toLowerCase().includes("email not confirmed") ||
          msg.toLowerCase().includes("email_not_confirmed")
        ) {
          toast.error("E-mail ainda não confirmado. Confirme seu e-mail ou use Esqueci minha senha.");
          return;
        }

        if (isApiUnavailableMessage(msg)) {
          toast.error("API indisponível no momento. Verifique se os serviços estão rodando.");
          return;
        }

        toast.error(msg === "Invalid login credentials" ? "E-mail ou senha incorretos" : msg);
        return;
      }

      if (!result?.data?.session) {
        toast.error("API indisponível no momento. Verifique se os serviços estão rodando.");
        return;
      }

      navigate(ROUTES.app.dashboard);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha inesperada ao tentar entrar";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title="Entrar no Auto Links" description="Acesse sua conta para continuar">
      <form onSubmit={handleLogin}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              type="email"
              placeholder="seu@email.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <PasswordField
            id="password"
            label="Senha"
            value={password}
            onChange={setPassword}
            placeholder="********"
            autoComplete="current-password"
            required
          />
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Entrar
          </Button>

          <Link to={ROUTES.auth.esqueciSenha} className="text-sm text-muted-foreground hover:text-primary">
            Esqueci minha senha
          </Link>

          <p className="text-sm text-muted-foreground">
            Não tem conta?{" "}
            <Link to={ROUTES.auth.cadastro} className="font-medium text-primary hover:underline">
              Criar conta
            </Link>
          </p>
        </CardFooter>
      </form>
    </AuthCard>
  );
}


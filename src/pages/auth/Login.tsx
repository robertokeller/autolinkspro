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
import { looksLikePhone, sanitizePhone } from "@/lib/phone-utils";

const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Informe seu e-mail ou telefone"),
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
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState("");

  const handleResendVerification = async () => {
    if (!pendingVerificationEmail) return;
    setResendLoading(true);
    const { error } = await backend.auth.resendVerificationEmail(pendingVerificationEmail);
    setResendLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Se a conta existir e ainda nao estiver confirmada, enviamos um novo link.");
  };

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = loginSchema.safeParse({ identifier, password });

    if (!parsed.success) {
      toast.error(parsed.error.errors[0].message);
      return;
    }

    const rawIdentifier = parsed.data.identifier;
    // If it looks like a phone number, send it sanitized; otherwise send as email
    const emailValue = looksLikePhone(rawIdentifier) ? sanitizePhone(rawIdentifier) : rawIdentifier;

    setLoading(true);
    try {
      const result = await backend.auth.signInWithPassword({
        email: emailValue,
        password: parsed.data.password,
      });
      const error = result?.error;

      if (error) {
        const msg = error.message || "";
        if (
          msg === "Email not confirmed" ||
          msg.toLowerCase().includes("email not confirmed") ||
          msg.toLowerCase().includes("email_not_confirmed") ||
          msg.toLowerCase().includes("ainda nao confirmado")
        ) {
          setPendingVerificationEmail(emailValue);
          toast.error("E-mail ainda nao confirmado. Use o botao para reenviar o link.");
          return;
        }

        if (isApiUnavailableMessage(msg)) {
          toast.error("API fora do ar. Confira se os serviços estão rodando.");
          return;
        }

        toast.error(
          msg === "Invalid login credentials" || msg === "Credenciais inválidas"
            ? "E-mail/telefone ou senha incorretos"
            : msg,
        );
        return;
      }

      if (!result?.data?.session) {
        toast.error("API fora do ar. Confira se os serviços estão rodando.");
        return;
      }

      navigate(ROUTES.app.dashboard);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Algo deu errado ao tentar entrar";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title="Entrar no Auto Links" description="Faça login pra acessar sua conta">
      <form onSubmit={handleLogin}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="identifier">E-mail ou telefone</Label>
            <Input
              id="identifier"
              type="text"
              placeholder="seu@email.com ou +55 11 91234-5678"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              required
              autoComplete="username"
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

          {pendingVerificationEmail ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={handleResendVerification}
              disabled={resendLoading}
            >
              {resendLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reenviar verificacao de e-mail
            </Button>
          ) : null}

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

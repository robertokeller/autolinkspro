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
import { getPasswordPolicyError, PASSWORD_POLICY_HINT } from "@/lib/password-policy";

const cadastroSchema = z.object({
  name: z.string().trim().min(2, "Nome muito curto").max(100),
  email: z.string().trim().email("E-mail inválido").max(255),
  password: z
    .string()
    .max(128)
    .refine((value) => !getPasswordPolicyError(value), {
      message: PASSWORD_POLICY_HINT,
    }),
});

export default function Cadastro() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSignUp = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = cadastroSchema.safeParse({ name, email, password });

    if (!parsed.success) {
      toast.error(parsed.error.errors[0].message);
      return;
    }

    setLoading(true);
    const { data, error } = await backend.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        data: { name: parsed.data.name },
        emailRedirectTo: window.location.origin,
      },
    });
    setLoading(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    if (data.session) {
      toast.success("Conta criada e login realizado com sucesso!");
      navigate(ROUTES.app.dashboard);
      return;
    }

    const verificationEmailSent = (data as { verification_email_sent?: boolean } | null)?.verification_email_sent !== false;
    if (verificationEmailSent) {
      toast.success("Conta criada! Verifique seu e-mail para confirmar o acesso.");
    } else {
      toast.success("Conta criada! Faça login e clique em reenviar verificacao de e-mail.");
    }
    navigate(ROUTES.auth.login);
  };

  return (
    <AuthCard title="Criar conta" description="Comece a usar o Auto Links gratuitamente">
      <form onSubmit={handleSignUp}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nome</Label>
            <Input
              id="name"
              placeholder="Seu nome"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoComplete="name"
            />
          </div>

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
            placeholder={PASSWORD_POLICY_HINT}
            autoComplete="new-password"
            required
          />
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Criar conta
          </Button>

          <p className="text-sm text-muted-foreground">
            Já tem conta?{" "}
            <Link to={ROUTES.auth.login} className="font-medium text-primary hover:underline">
              Entrar
            </Link>
          </p>
        </CardFooter>
      </form>
    </AuthCard>
  );
}

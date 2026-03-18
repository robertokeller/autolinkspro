import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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

const schema = z
  .object({
    password: z
      .string()
      .max(128)
      .refine((value) => !getPasswordPolicyError(value), {
        message: PASSWORD_POLICY_HINT,
      }),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Senhas nao conferem",
    path: ["confirmPassword"],
  });

export default function ResetarSenha() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const resetToken = useMemo(() => searchParams.get("token")?.trim() || "", [searchParams]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = schema.safeParse({ password, confirmPassword });

    if (!parsed.success) {
      toast.error(parsed.error.errors[0].message);
      return;
    }

    setLoading(true);
    const { error } = await backend.auth.resetPasswordWithToken({
      token: resetToken,
      password: parsed.data.password,
    });
    setLoading(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    toast.success("Senha atualizada!");
    navigate(ROUTES.app.dashboard);
  };

  if (!resetToken) {
    return (
      <AuthCard
        title="Redefinir senha"
        description="Link inválido ou expirado. Peça um novo."
        showLogo={false}
      >
        <CardFooter className="flex flex-col gap-3">
          <Link to={ROUTES.auth.esqueciSenha} className="text-sm text-primary hover:underline">
            Solicitar novo link
          </Link>
          <Link to={ROUTES.auth.login} className="text-sm text-muted-foreground hover:text-primary">
            Voltar ao login
          </Link>
        </CardFooter>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Nova senha" description="Digite sua nova senha">
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          <PasswordField
            id="password"
            label="Nova senha"
            value={password}
            onChange={setPassword}
            placeholder={PASSWORD_POLICY_HINT}
            required
          />

          <div className="space-y-2">
            <Label htmlFor="confirm">Confirmar senha</Label>
            <Input
              id="confirm"
              type="password"
              placeholder="********"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          </div>
        </CardContent>

        <CardFooter>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Atualizar senha
          </Button>
        </CardFooter>
      </form>
    </AuthCard>
  );
}

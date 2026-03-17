import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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

const schema = z
  .object({
    password: z.string().min(12, "Mínimo 12 caracteres").max(128),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Senhas não conferem",
    path: ["confirmPassword"],
  });

export default function ResetarSenha() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const {
      data: { subscription },
    } = backend.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setReady(true);
      }
    });
    // Recovery is held in memory for the current tab and exposed by auth events.

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = schema.safeParse({ password, confirmPassword });

    if (!parsed.success) {
      toast.error(parsed.error.errors[0].message);
      return;
    }

    setLoading(true);
    const { error } = await backend.auth.updateUser({ password: parsed.data.password });
    setLoading(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    toast.success("Senha atualizada com sucesso!");
    navigate(ROUTES.app.dashboard);
  };

  if (!ready) {
    return (
      <AuthCard
        title="Redefinir senha"
        description="Aguardando validação do link..."
        showLogo={false}
      >
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </CardContent>
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
            placeholder="********"
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

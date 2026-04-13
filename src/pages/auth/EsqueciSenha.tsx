import { useState } from "react";
import { Link } from "react-router-dom";
import { backend } from "@/integrations/backend/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { AuthCard } from "@/components/auth/AuthCard";
import { ROUTES } from "@/lib/routes";

const schema = z.object({ email: z.string().trim().email("E-mail inválido").max(255) });

export default function EsqueciSenha() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = schema.safeParse({ email });

    if (!parsed.success) {
      toast.error(parsed.error.errors[0].message);
      return;
    }

    setLoading(true);
    const { error } = await backend.auth.resetPasswordForEmail(parsed.data.email, {
      redirectTo: `${window.location.origin}${ROUTES.auth.resetarSenha}`,
    });
    setLoading(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    setSent(true);
    toast.success("Se o e-mail existir, enviamos o link de redefinicao.");
  };

  return (
    <AuthCard
      title="Esqueci minha senha"
      description={
        sent
          ? "Olhe seu e-mail — enviamos o link pra redefinir a senha."
          : "Coloque seu e-mail e a gente manda um link pra redefinir."
      }
    >
      {!sent ? (
        <form onSubmit={handleSubmit}>
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
          </CardContent>

          <CardFooter className="flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Enviar link
            </Button>

            <Link to={ROUTES.auth.login} className="text-sm text-muted-foreground hover:text-primary">
              Voltar ao login
            </Link>
          </CardFooter>
        </form>
      ) : (
        <CardFooter className="flex flex-col gap-3">
          <Link to={ROUTES.auth.login} className="text-sm text-primary hover:underline">
            Voltar ao login
          </Link>
        </CardFooter>
      )}
    </AuthCard>
  );
}

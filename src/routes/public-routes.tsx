import { AuthPageGuard } from "@/components/AuthPageGuard";
import { ROUTES } from "@/lib/routes";
import { Pages } from "@/routes/lazy-pages";
import { Navigate, Route } from "react-router-dom";

export function PublicRoutes() {
  return (
    <>
      <Route path={ROUTES.root} element={<Navigate to={ROUTES.home} replace />} />
      <Route path={ROUTES.home} element={<Pages.Index />} />

      <Route element={<AuthPageGuard />}>
        <Route path={ROUTES.auth.login} element={<Pages.Login />} />
        <Route path={ROUTES.auth.cadastro} element={<Pages.Cadastro />} />
        <Route path={ROUTES.auth.esqueciSenha} element={<Pages.EsqueciSenha />} />
        <Route path={ROUTES.auth.resetarSenha} element={<Pages.ResetarSenha />} />
      </Route>
      <Route path={ROUTES.auth.verificacaoEmail} element={<Pages.VerificacaoEmail />} />

      <Route path={ROUTES.maintenance} element={<Pages.Maintenance />} />
      <Route path={ROUTES.termos} element={<Pages.TermosDeUso />} />
      <Route path={ROUTES.privacidade} element={<Pages.PoliticaPrivacidade />} />

      <Route path={ROUTES.hubPublic} element={<Pages.LinkHubPublicPage />} />
      <Route path={ROUTES.masterGroupPublic} element={<Pages.MasterGroupPublicPage />} />
    </>
  );
}

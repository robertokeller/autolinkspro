import { AppLayout } from "@/components/AppLayout";
import { FeatureRouteGuard } from "@/components/FeatureRouteGuard";
import { RouteGuard } from "@/components/RouteGuard";
import { ROUTES } from "@/lib/routes";
import { Pages } from "@/routes/lazy-pages";
import { Navigate, Route } from "react-router-dom";

export function ProtectedAppRoutes() {
  return (
    <Route element={<RouteGuard />}>
      <Route element={<AppLayout />}>
        <Route path={ROUTES.app.dashboard} element={<Pages.Dashboard />} />
        <Route
          path={ROUTES.app.connectionsRoot}
          element={<Navigate to={ROUTES.app.connectionsWhatsApp} replace />}
        />
        <Route path={ROUTES.app.connectionsWhatsApp} element={<Pages.ConexoesWhatsApp />} />
        <Route
          path={ROUTES.app.connectionsTelegram}
          element={(
            <FeatureRouteGuard feature="telegramConnections">
              <Pages.ConexoesTelegram />
            </FeatureRouteGuard>
          )}
        />
        <Route
          path={ROUTES.app.routes}
          element={(
            <FeatureRouteGuard feature="routes">
              <Pages.Rotas />
            </FeatureRouteGuard>
          )}
        />
        <Route path={ROUTES.app.shopeeRoot} element={<Navigate to={ROUTES.app.shopeeVitrine} replace />} />
        <Route path={ROUTES.app.shopeeVitrine} element={<Pages.ShopeeVitrine />} />
        <Route path={ROUTES.app.shopeePesquisa} element={<Pages.ShopeePesquisa />} />
        <Route path={ROUTES.app.shopeeConversor} element={<Pages.ShopeeConversor />} />
        <Route
          path={ROUTES.app.shopeeAutomacoes}
          element={(
            <FeatureRouteGuard feature="shopeeAutomations">
              <Pages.ShopeeAutomacoes />
            </FeatureRouteGuard>
          )}
        />
        <Route
          path={`${ROUTES.app.shopeeTemplates}/*`}
          element={(
            <FeatureRouteGuard feature="templates">
              <Pages.Modelos />
            </FeatureRouteGuard>
          )}
        />
        <Route path={ROUTES.app.shopeeConfiguracoes} element={<Pages.ShopeeConfiguracoes />} />
        <Route path={ROUTES.app.mercadolivreRoot} element={<Navigate to={ROUTES.app.vitrineMl} replace />} />
        <Route
          path={ROUTES.app.vitrineMl}
          element={(
            <FeatureRouteGuard feature="mercadoLivre">
              <Pages.MercadoLivreVitrine />
            </FeatureRouteGuard>
          )}
        />
        <Route
          path={ROUTES.app.mercadolivreConfiguracoes}
          element={(
            <FeatureRouteGuard feature="mercadoLivre">
              <Pages.MercadoLivreConfiguracoes />
            </FeatureRouteGuard>
          )}
        />
        <Route
          path={ROUTES.app.schedules}
          element={(
            <FeatureRouteGuard feature="schedules">
              <Pages.Agendamentos />
            </FeatureRouteGuard>
          )}
        />
        <Route
          path={ROUTES.app.linkHub}
          element={(
            <FeatureRouteGuard feature="linkHub">
              <Pages.LinkHub />
            </FeatureRouteGuard>
          )}
        />
        <Route path={ROUTES.app.history} element={<Pages.Historico />} />
        <Route path={ROUTES.app.account} element={<Pages.Configuracoes />} />
      </Route>
    </Route>
  );
}

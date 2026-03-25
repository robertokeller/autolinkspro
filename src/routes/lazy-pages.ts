import { lazy, type ComponentType } from "react";

const LAZY_PAGE_TIMEOUT_MS = 12_000;
const LAZY_PAGE_RETRY_DELAY_MS = 250;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`Tempo esgotado ao carregar a página (${label}).`));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function lazyPage<T extends ComponentType<unknown>>(
  label: string,
  loader: () => Promise<{ default: T }>,
) {
  const load = () => withTimeout(loader(), LAZY_PAGE_TIMEOUT_MS, label);
  return lazy(async () => {
    try {
      return await load();
    } catch (firstError) {
      await delay(LAZY_PAGE_RETRY_DELAY_MS);
      try {
        return await load();
      } catch (secondError) {
        throw (secondError instanceof Error
          ? secondError
          : firstError instanceof Error
            ? firstError
            : new Error(String(secondError ?? firstError)));
      }
    }
  });
}

export const Pages = {
  Index: lazyPage("Index", () => import("@/pages/Index")),
  NotFound: lazyPage("NotFound", () => import("@/pages/NotFound")),
  Login: lazyPage("Login", () => import("@/pages/auth/Login")),
  Cadastro: lazyPage("Cadastro", () => import("@/pages/auth/Cadastro")),
  EsqueciSenha: lazyPage("EsqueciSenha", () => import("@/pages/auth/EsqueciSenha")),
  ResetarSenha: lazyPage("ResetarSenha", () => import("@/pages/auth/ResetarSenha")),
  VerificacaoEmail: lazyPage("VerificacaoEmail", () => import("@/pages/auth/VerificacaoEmail")),
  Maintenance: lazyPage("Maintenance", () => import("@/pages/Maintenance")),
  TermosDeUso: lazyPage("TermosDeUso", () => import("@/pages/TermosDeUso")),
  PoliticaPrivacidade: lazyPage("PoliticaPrivacidade", () => import("@/pages/PoliticaPrivacidade")),
  Dashboard: lazyPage("Dashboard", () => import("@/pages/Dashboard")),
  ConexoesWhatsApp: lazyPage("ConexoesWhatsApp", () => import("@/pages/conexoes/ConexoesWhatsApp")),
  ConexoesTelegram: lazyPage("ConexoesTelegram", () => import("@/pages/conexoes/ConexoesTelegram")),
  ConexoesMasterGroups: lazyPage("ConexoesMasterGroups", () => import("@/pages/conexoes/GruposMestres")),
  Rotas: lazyPage("Rotas", () => import("@/pages/Rotas")),
  ShopeeVitrine: lazyPage("ShopeeVitrine", () => import("@/pages/shopee/ShopeeVitrine")),
  ShopeePesquisa: lazyPage("ShopeePesquisa", () => import("@/pages/shopee/ShopeePesquisa")),
  ShopeeConversor: lazyPage("ShopeeConversor", () => import("@/pages/shopee/ShopeeConversor")),
  ShopeeAutomacoes: lazyPage("ShopeeAutomacoes", () => import("@/pages/shopee/ShopeeAutomacoes")),
  ShopeeConfiguracoes: lazyPage("ShopeeConfiguracoes", () => import("@/pages/shopee/ShopeeConfiguracoes")),
  MercadoLivreVitrine: lazyPage("MercadoLivreVitrine", () => import("@/pages/mercadolivre/MercadoLivreVitrine")),
  MercadoLivreAutomacoes: lazyPage("MercadoLivreAutomacoes", () => import("@/pages/mercadolivre/MercadoLivreAutomacoes")),
  TemplatesMeli: lazyPage("TemplatesMeli", () => import("@/pages/mercadolivre/TemplatesMeli")),
  MercadoLivreConfiguracoes: lazyPage("MercadoLivreConfiguracoes", () => import("@/pages/mercadolivre/MercadoLivreConfiguracoes")),
  Agendamentos: lazyPage("Agendamentos", () => import("@/pages/Agendamentos")),
  Modelos: lazyPage("Modelos", () => import("@/pages/Modelos")),
  LinkHub: lazyPage("LinkHub", () => import("@/pages/LinkHub")),
  LinkHubPublicPage: lazyPage("LinkHubPublicPage", () => import("@/pages/LinkHubPublicPage")),
  MasterGroupPublicPage: lazyPage("MasterGroupPublicPage", () => import("@/pages/MasterGroupPublicPage")),
  Historico: lazyPage("Historico", () => import("@/pages/Historico")),
  Configuracoes: lazyPage("Configuracoes", () => import("@/pages/Configuracoes")),
  AdminDashboard: lazyPage("AdminDashboard", () => import("@/pages/admin/AdminDashboard")),
  AdminUsers: lazyPage("AdminUsers", () => import("@/pages/admin/AdminUsers")),
  AdminPlans: lazyPage("AdminPlans", () => import("@/pages/admin/AdminPlans")),
  AdminAccess: lazyPage("AdminAccess", () => import("@/pages/admin/AdminAccess")),
  AdminLogs: lazyPage("AdminLogs", () => import("@/pages/admin/AdminLogs")),
  AdminNotifications: lazyPage("AdminNotifications", () => import("@/pages/admin/AdminNotifications")),
  AdminWhatsApp: lazyPage("AdminWhatsApp", () => import("@/pages/admin/AdminWhatsApp")),
  AdminMensagens: lazyPage("AdminMensagens", () => import("@/pages/admin/AdminMensagens")),
} as const;

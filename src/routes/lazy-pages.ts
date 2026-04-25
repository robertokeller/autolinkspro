import { lazy, type ComponentType } from "react";

const LAZY_PAGE_TIMEOUT_MS = 12_000;
const LAZY_PAGE_RETRY_DELAY_MS = 250;
const RECOVERABLE_DYNAMIC_IMPORT_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getRecoveryKey(label: string) {
  return `lazy-page-recovery:${label}:${window.location.pathname}`;
}

function clearRecoveryFlag(label: string) {
  window.sessionStorage.removeItem(getRecoveryKey(label));
}

async function loadFreshModule<T extends ComponentType<unknown>>(sourcePath: string) {
  const cacheBustedPath = `${sourcePath}${sourcePath.includes("?") ? "&" : "?"}t=${Date.now()}`;
  return import(/* @vite-ignore */ cacheBustedPath) as Promise<{ default: T }>;
}

function tryRecoverDynamicImport(label: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!RECOVERABLE_DYNAMIC_IMPORT_ERROR.test(message)) {
    return false;
  }

  const recoveryKey = getRecoveryKey(label);
  if (window.sessionStorage.getItem(recoveryKey) === "1") {
    return false;
  }

  window.sessionStorage.setItem(recoveryKey, "1");
  window.setTimeout(() => {
    window.location.reload();
  }, 30);
  return true;
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
  sourcePath: string,
  loader: () => Promise<{ default: T }>,
) {
  const load = () => withTimeout(loader(), LAZY_PAGE_TIMEOUT_MS, label);
  const loadFresh = () => withTimeout(loadFreshModule<T>(sourcePath), LAZY_PAGE_TIMEOUT_MS, label);
  return lazy(async () => {
    try {
      const module = await load();
      clearRecoveryFlag(label);
      return module;
    } catch (firstError) {
      await delay(LAZY_PAGE_RETRY_DELAY_MS);
      try {
        const module = await load();
        clearRecoveryFlag(label);
        return module;
      } catch (secondError) {
        if (RECOVERABLE_DYNAMIC_IMPORT_ERROR.test(String(secondError instanceof Error ? secondError.message : secondError ?? ""))) {
          try {
            const module = await loadFresh();
            clearRecoveryFlag(label);
            return module;
          } catch {
            // Fall through to one-time reload recovery below.
          }
        }

        if (tryRecoverDynamicImport(label, secondError ?? firstError)) {
          return new Promise<never>(() => {});
        }

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
  Index: lazyPage("Index", "/src/pages/Index.tsx", () => import("@/pages/Index")),
  NotFound: lazyPage("NotFound", "/src/pages/NotFound.tsx", () => import("@/pages/NotFound")),
  Login: lazyPage("Login", "/src/pages/auth/Login.tsx", () => import("@/pages/auth/Login")),
  Cadastro: lazyPage("Cadastro", "/src/pages/auth/Cadastro.tsx", () => import("@/pages/auth/Cadastro")),
  EsqueciSenha: lazyPage("EsqueciSenha", "/src/pages/auth/EsqueciSenha.tsx", () => import("@/pages/auth/EsqueciSenha")),
  ResetarSenha: lazyPage("ResetarSenha", "/src/pages/auth/ResetarSenha.tsx", () => import("@/pages/auth/ResetarSenha")),
  VerificacaoEmail: lazyPage("VerificacaoEmail", "/src/pages/auth/VerificacaoEmail.tsx", () => import("@/pages/auth/VerificacaoEmail")),
  Maintenance: lazyPage("Maintenance", "/src/pages/Maintenance.tsx", () => import("@/pages/Maintenance")),
  TermosDeUso: lazyPage("TermosDeUso", "/src/pages/TermosDeUso.tsx", () => import("@/pages/TermosDeUso")),
  PoliticaPrivacidade: lazyPage("PoliticaPrivacidade", "/src/pages/PoliticaPrivacidade.tsx", () => import("@/pages/PoliticaPrivacidade")),
  Dashboard: lazyPage("Dashboard", "/src/pages/Dashboard.tsx", () => import("@/pages/Dashboard")),
  ConexoesWhatsApp: lazyPage("ConexoesWhatsApp", "/src/pages/conexoes/ConexoesWhatsApp.tsx", () => import("@/pages/conexoes/ConexoesWhatsApp")),
  TelegramConfiguracoes: lazyPage("TelegramConfiguracoes", "/src/pages/telegram/TelegramConfiguracoes.tsx", () => import("@/pages/telegram/TelegramConfiguracoes")),
  ConexoesMasterGroups: lazyPage("ConexoesMasterGroups", "/src/pages/conexoes/GruposMestres.tsx", () => import("@/pages/conexoes/GruposMestres")),
  Rotas: lazyPage("Rotas", "/src/pages/Rotas.tsx", () => import("@/pages/Rotas")),
  ShopeeVitrine: lazyPage("ShopeeVitrine", "/src/pages/shopee/ShopeeVitrine.tsx", () => import("@/pages/shopee/ShopeeVitrine")),
  ShopeePesquisa: lazyPage("ShopeePesquisa", "/src/pages/shopee/ShopeePesquisa.tsx", () => import("@/pages/shopee/ShopeePesquisa")),
  ShopeeConversor: lazyPage("ShopeeConversor", "/src/pages/shopee/ShopeeConversor.tsx", () => import("@/pages/shopee/ShopeeConversor")),
  ShopeeAutomacoes: lazyPage("ShopeeAutomacoes", "/src/pages/shopee/ShopeeAutomacoes.tsx", () => import("@/pages/shopee/ShopeeAutomacoes")),
  ShopeeReports: lazyPage("ShopeeReports", "/src/pages/shopee/ShopeeReports.tsx", () => import("@/pages/shopee/ShopeeReports")),
  ShopeeConfiguracoes: lazyPage("ShopeeConfiguracoes", "/src/pages/shopee/ShopeeConfiguracoes.tsx", () => import("@/pages/shopee/ShopeeConfiguracoes")),
  MercadoLivreVitrine: lazyPage("MercadoLivreVitrine", "/src/pages/mercadolivre/MercadoLivreVitrine.tsx", () => import("@/pages/mercadolivre/MercadoLivreVitrine")),
  MercadoLivreAutomacoes: lazyPage("MercadoLivreAutomacoes", "/src/pages/mercadolivre/MercadoLivreAutomacoes.tsx", () => import("@/pages/mercadolivre/MercadoLivreAutomacoes")),
  TemplatesMeli: lazyPage("TemplatesMeli", "/src/pages/mercadolivre/TemplatesMeli.tsx", () => import("@/pages/mercadolivre/TemplatesMeli")),
  MercadoLivreConfiguracoes: lazyPage("MercadoLivreConfiguracoes", "/src/pages/mercadolivre/MercadoLivreConfiguracoes.tsx", () => import("@/pages/mercadolivre/MercadoLivreConfiguracoes")),
  AmazonVitrine: lazyPage("AmazonVitrine", "/src/pages/amazon/AmazonVitrine.tsx", () => import("@/pages/amazon/AmazonVitrine")),
  AmazonAutomacoes: lazyPage("AmazonAutomacoes", "/src/pages/amazon/AmazonAutomacoes.tsx", () => import("@/pages/amazon/AmazonAutomacoes")),
  TemplatesAmazon: lazyPage("TemplatesAmazon", "/src/pages/amazon/TemplatesAmazon.tsx", () => import("@/pages/amazon/TemplatesAmazon")),
  AmazonConfiguracoes: lazyPage("AmazonConfiguracoes", "/src/pages/amazon/AmazonConfiguracoes.tsx", () => import("@/pages/amazon/AmazonConfiguracoes")),
  Agendamentos: lazyPage("Agendamentos", "/src/pages/Agendamentos.tsx", () => import("@/pages/Agendamentos")),
  ModelosDeMensagem: lazyPage("ModelosDeMensagem", "/src/pages/ModelosDeMensagem.tsx", () => import("@/pages/ModelosDeMensagem")),
  Modelos: lazyPage("Modelos", "/src/pages/Modelos.tsx", () => import("@/pages/Modelos")),
  LinkHub: lazyPage("LinkHub", "/src/pages/LinkHub.tsx", () => import("@/pages/LinkHub")),
  LinkHubPublicPage: lazyPage("LinkHubPublicPage", "/src/pages/LinkHubPublicPage.tsx", () => import("@/pages/LinkHubPublicPage")),
  MasterGroupPublicPage: lazyPage("MasterGroupPublicPage", "/src/pages/MasterGroupPublicPage.tsx", () => import("@/pages/MasterGroupPublicPage")),
  Historico: lazyPage("Historico", "/src/pages/Historico.tsx", () => import("@/pages/Historico")),
  Configuracoes: lazyPage("Configuracoes", "/src/pages/Configuracoes.tsx", () => import("@/pages/Configuracoes")),
  AdminDashboard: lazyPage("AdminDashboard", "/src/pages/admin/AdminDashboard.tsx", () => import("@/pages/admin/AdminDashboard")),
  AdminUsers: lazyPage("AdminUsers", "/src/pages/admin/AdminUsers.tsx", () => import("@/pages/admin/AdminUsers")),
  AdminPlans: lazyPage("AdminPlans", "/src/pages/admin/AdminPlans.tsx", () => import("@/pages/admin/AdminPlans")),
  AdminAccess: lazyPage("AdminAccess", "/src/pages/admin/AdminAccess.tsx", () => import("@/pages/admin/AdminAccess")),
  AdminLogs: lazyPage("AdminLogs", "/src/pages/admin/AdminLogs.tsx", () => import("@/pages/admin/AdminLogs")),
  AdminNotifications: lazyPage("AdminNotifications", "/src/pages/admin/AdminNotifications.tsx", () => import("@/pages/admin/AdminNotifications")),
  AdminWhatsApp: lazyPage("AdminWhatsApp", "/src/pages/admin/AdminWhatsApp.tsx", () => import("@/pages/admin/AdminWhatsApp")),
  AdminMensagens: lazyPage("AdminMensagens", "/src/pages/admin/AdminMensagens.tsx", () => import("@/pages/admin/AdminMensagens")),
  AdminKiwify: lazyPage("AdminKiwify", "/src/pages/admin/AdminKiwify.tsx", () => import("@/pages/admin/AdminKiwify")),
  Ajuda: lazyPage("Ajuda", "/src/pages/ajuda/Ajuda.tsx", () => import("@/pages/ajuda/Ajuda")),
  Afiliado: lazyPage("Afiliado", "/src/pages/afiliado/Afiliado.tsx", () => import("@/pages/afiliado/Afiliado")),
  Metricas: lazyPage("Metricas", "/src/pages/Metricas.tsx", () => import("@/pages/Metricas")),
} as const;

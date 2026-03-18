import { describe, expect, it, vi } from "vitest";
import { __resetLocalDatabase, backend } from "@/integrations/backend/client";
import { loadAdminControlPlaneState, saveAdminControlPlaneState } from "@/lib/admin-control-plane";

const DEMO_ADMIN_EMAIL = (import.meta.env.VITE_DEMO_ADMIN_EMAIL as string | undefined) || "robertokellercontato@gmail.com";
const DEMO_ADMIN_PASSWORD = (import.meta.env.VITE_DEMO_ADMIN_PASSWORD as string | undefined) || "AutoLinks@Admin2025!";

describe("local frontend/backend/database sync", () => {
  it("creates common and admin users with expected characteristics", async () => {
    __resetLocalDatabase();

    const adminLogin = await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });
    expect(adminLogin.error).toBeNull();

    const createCommon = await backend.functions.invoke("admin-users", {
      body: {
        action: "create_user",
        name: "Cliente Comum",
        email: "cliente.comum@autolinks.dev",
        password: "abcdef",
        role: "user",
      },
    });
    expect(createCommon.error).toBeNull();
    expect(createCommon.data?.created_user?.role).toBe("user");
    expect(createCommon.data?.created_user?.account_status).toBe("active");

    const createAdmin = await backend.functions.invoke("admin-users", {
      body: {
        action: "create_user",
        name: "Admin Novo",
        email: "admin.novo@autolinks.dev",
        password: "abcdef",
        role: "admin",
      },
    });
    expect(createAdmin.error).toBeNull();
    expect(createAdmin.data?.created_user?.role).toBe("admin");
    expect(createAdmin.data?.created_user?.account_status).toBe("active");

    const users = await backend.functions.invoke("admin-users", {
      body: { action: "list_users" },
    });
    expect(users.error).toBeNull();

    const rows = Array.isArray(users.data?.users) ? users.data.users : [];
    const common = rows.find((row) => row.email === "cliente.comum@autolinks.dev");
    const admin = rows.find((row) => row.email === "admin.novo@autolinks.dev");

    expect(common?.role).toBe("user");
    expect(common?.account_status).toBe("active");
    expect(admin?.role).toBe("admin");
    expect(admin?.account_status).toBe("active");
  });

  it("allows admin to create user and login with new credentials", async () => {
    __resetLocalDatabase();

    const adminLogin = await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });
    expect(adminLogin.error).toBeNull();

    const created = await backend.functions.invoke("admin-users", {
      body: {
        action: "create_user",
        name: "Teste Local",
        email: "teste.local@autolinks.dev",
        password: "abcdef",
        plan_id: "plan-starter",
        role: "user",
      },
    });
    expect(created.error).toBeNull();

    await backend.auth.signOut();

    const newUserLogin = await backend.auth.signInWithPassword({
      email: "teste.local@autolinks.dev",
      password: "abcdef",
    });
    expect(newUserLogin.error).toBeNull();
    expect(newUserLogin.data.user?.email).toBe("teste.local@autolinks.dev");

    const {
      data: { session },
    } = await backend.auth.getSession();

    const profileRes = await backend
      .from("profiles")
      .select("plan_id, notification_prefs")
      .eq("user_id", session?.user.id || "")
      .maybeSingle();

    expect(profileRes.error).toBeNull();
    expect(profileRes.data?.plan_id).toBe("plan-starter");
    expect(typeof profileRes.data?.notification_prefs).toBe("object");
  });

  it("edits user name and keeps admin list synchronized", async () => {
    __resetLocalDatabase();

    const adminLogin = await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });
    expect(adminLogin.error).toBeNull();

    const createUser = await backend.functions.invoke("admin-users", {
      body: {
        action: "create_user",
        name: "Nome Antigo",
        email: "nome.editavel@autolinks.dev",
        password: "abcdef",
        role: "user",
      },
    });
    expect(createUser.error).toBeNull();

    const createdUserId = createUser.data?.created_user?.user_id;
    expect(createdUserId).toBeTruthy();

    const rename = await backend.functions.invoke("admin-users", {
      body: {
        action: "set_name",
        user_id: createdUserId,
        name: "Nome Novo",
      },
    });
    expect(rename.error).toBeNull();

    const usersRes = await backend.functions.invoke("admin-users", {
      body: { action: "list_users" },
    });
    expect(usersRes.error).toBeNull();

    const renamed = (usersRes.data?.users || []).find((row) => row.user_id === createdUserId);
    expect(renamed?.name).toBe("Nome Novo");

    const profileRes = await backend
      .from("profiles")
      .select("name")
      .eq("user_id", String(createdUserId))
      .maybeSingle();
    expect(profileRes.error).toBeNull();
    expect(profileRes.data?.name).toBe("Nome Novo");
  });

  it("enforces WhatsApp session cap from access level at backend layer", async () => {
    __resetLocalDatabase();

    const originalState = loadAdminControlPlaneState();

    try {
      const enterprisePlan = originalState.plans.find((plan) => plan.id === "plan-enterprise") || originalState.plans[0];
      expect(enterprisePlan).toBeTruthy();

      const targetLevelId = enterprisePlan?.accessLevelId || originalState.accessLevels[0]?.id || "level-business";

      saveAdminControlPlaneState({
        ...originalState,
        defaultSignupPlanId: enterprisePlan?.id || originalState.defaultSignupPlanId,
        accessLevels: originalState.accessLevels.map((level) => (
          level.id === targetLevelId
            ? {
                ...level,
                limitOverrides: {
                  ...level.limitOverrides,
                  whatsappSessions: 4,
                },
              }
            : level
        )),
      });

      const signUp = await backend.auth.signUp({
        email: "limite.whatsapp@autolinks.local",
        password: "abcdef",
        options: { data: { name: "Cliente Limite WhatsApp" } },
      });
      expect(signUp.error).toBeNull();

      await backend.auth.signOut();

      const login = await backend.auth.signInWithPassword({
        email: "limite.whatsapp@autolinks.local",
        password: "abcdef",
      });
      expect(login.error).toBeNull();

      const {
        data: { session },
      } = await backend.auth.getSession();
      const userId = session?.user.id || "";
      expect(userId).toBeTruthy();

      for (let i = 1; i <= 4; i += 1) {
        const created = await backend.from("whatsapp_sessions").insert({
          user_id: userId,
          name: `WA ${i}`,
          status: "offline",
          auth_method: "qr",
          is_default: i === 1,
          qr_code: "",
          error_message: "",
        });
        expect(created.error).toBeNull();
      }

      const blocked = await backend.from("whatsapp_sessions").insert({
        user_id: userId,
        name: "WA 5",
        status: "offline",
        auth_method: "qr",
        is_default: false,
        qr_code: "",
        error_message: "",
      });

      expect(blocked.error?.message).toBe("Limite de sessoes WhatsApp atingido para o seu plano.");

      const countRes = await backend
        .from("whatsapp_sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);

      expect(countRes.error).toBeNull();
      expect(countRes.count).toBe(4);
    } finally {
      saveAdminControlPlaneState(originalState);
    }
  });

  it("reconciles profile plan_id when admin removes a plan", async () => {
    __resetLocalDatabase();

    const originalState = loadAdminControlPlaneState();

    try {
      const removablePlanId = "plan-starter";
      const fallbackPlan = originalState.plans.find((plan) => plan.id !== removablePlanId && plan.isActive)
        || originalState.plans.find((plan) => plan.id !== removablePlanId)
        || originalState.plans[0];
      expect(fallbackPlan).toBeTruthy();

      saveAdminControlPlaneState({
        ...originalState,
        plans: originalState.plans.filter((plan) => plan.id !== removablePlanId),
        defaultSignupPlanId: fallbackPlan?.id || originalState.defaultSignupPlanId,
      });

      const signUp = await backend.auth.signUp({
        email: "reconcile.plan@autolinks.local",
        password: "abcdef",
        options: { data: { name: "Cliente Reconciliado" } },
      });
      expect(signUp.error).toBeNull();

      await backend.auth.signOut();

      const login = await backend.auth.signInWithPassword({
        email: "reconcile.plan@autolinks.local",
        password: "abcdef",
      });
      expect(login.error).toBeNull();

      const {
        data: { session },
      } = await backend.auth.getSession();
      const userId = session?.user.id || "";
      expect(userId).toBeTruthy();

      const profile = await backend
        .from("profiles")
        .select("plan_id")
        .eq("user_id", userId)
        .maybeSingle();

      expect(profile.error).toBeNull();
      expect(profile.data?.plan_id).toBe(fallbackPlan?.id);
    } finally {
      saveAdminControlPlaneState(originalState);
    }
  });

  it("blocks operational RPC when user plan is expired", async () => {
    __resetLocalDatabase();

    const signUp = await backend.auth.signUp({
      email: "cliente.expirado@autolinks.local",
      password: "abcdef",
      options: { data: { name: "Cliente Expirado" } },
    });
    expect(signUp.error).toBeNull();

    await backend.auth.signOut();

    const login = await backend.auth.signInWithPassword({
      email: "cliente.expirado@autolinks.local",
      password: "abcdef",
    });
    expect(login.error).toBeNull();

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const expireProfile = await backend
      .from("profiles")
      .update({ plan_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("user_id", userId);
    expect(expireProfile.error).toBeNull();

    const dispatch = await backend.functions.invoke("dispatch-messages", {
      body: { source: "expired-plan-test", limit: 1 },
    });

    expect(dispatch.error?.message).toContain("Plano expirado");
  });

  it("dispatches scheduled messages using master groups from metadata", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const groupRes = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Grupo Destino",
        platform: "whatsapp",
        member_count: 100,
        session_id: "wa_1",
      })
      .select()
      .single();
    expect(groupRes.error).toBeNull();

    const masterRes = await backend
      .from("master_groups")
      .insert({
        user_id: userId,
        name: "Master 1",
        slug: "master-1",
        distribution: "balanced",
        member_limit: 500,
      })
      .select()
      .single();
    expect(masterRes.error).toBeNull();

    const linkRes = await backend.from("master_group_links").insert({
      master_group_id: masterRes.data?.id,
      group_id: groupRes.data?.id,
      is_active: true,
    });
    expect(linkRes.error).toBeNull();

    const postRes = await backend
      .from("scheduled_posts")
      .insert({
        user_id: userId,
        content: "Mensagem original",
        scheduled_at: new Date(Date.now() - 5_000).toISOString(),
        recurrence: "once",
        status: "pending",
        metadata: {
          finalContent: "Mensagem final",
          masterGroupIds: [masterRes.data?.id],
        },
      })
      .select()
      .single();
    expect(postRes.error).toBeNull();

    const dispatch = await backend.functions.invoke("dispatch-messages", {
      body: { source: "test", limit: 10 },
    });
    expect(dispatch.error).toBeNull();
    expect(dispatch.data?.sent).toBe(1);
    expect(dispatch.data?.failed).toBe(0);

    const updatedPost = await backend
      .from("scheduled_posts")
      .select("*")
      .eq("id", postRes.data?.id)
      .maybeSingle();

    expect(updatedPost.error).toBeNull();
    expect(updatedPost.data?.status).toBe("sent");

    const historyRes = await backend
      .from("history_entries")
      .select("*")
      .eq("source", "Agendamento")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(historyRes.error).toBeNull();
    expect(historyRes.data?.details).toMatchObject({ message: "Mensagem final" });
  });

  it("blocks route destination link to a group owned by another user", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session: adminSession },
    } = await backend.auth.getSession();

    const adminGroup = await backend
      .from("groups")
      .insert({
        user_id: adminSession?.user.id,
        name: "Grupo Admin",
        platform: "whatsapp",
        member_count: 30,
      })
      .select()
      .single();
    expect(adminGroup.error).toBeNull();

    await backend.auth.signOut();

    const signUp = await backend.auth.signUp({
      email: "tenant.user@autolinks.dev",
      password: "abcdef",
      options: { data: { name: "Tenant User" } },
    });
    expect(signUp.error).toBeNull();

    const {
      data: { session: tenantSession },
    } = await backend.auth.getSession();

    const tenantRoute = await backend
      .from("routes")
      .insert({
        user_id: tenantSession?.user.id,
        name: "Rota Tenant",
        source_group_id: "src_1",
        status: "active",
        rules: {},
      })
      .select()
      .single();
    expect(tenantRoute.error).toBeNull();

    const forbidden = await backend.from("route_destinations").insert({
      route_id: tenantRoute.data?.id,
      group_id: adminGroup.data?.id,
    });

    expect(forbidden.error?.message).toBe("Permissao negada");
  });

  it("keeps template category synchronized on create and edit", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const created = await backend
      .from("templates")
      .insert({
        user_id: userId,
        name: "Template sem categoria",
        content: "{link}",
      })
      .select()
      .single();

    expect(created.error).toBeNull();
    expect(created.data?.category).toBe("geral");

    const updated = await backend
      .from("templates")
      .update({ category: "cupom", name: "Template cupom" })
      .eq("id", created.data?.id)
      .eq("user_id", userId)
      .select()
      .single();

    expect(updated.error).toBeNull();
    expect(updated.data?.category).toBe("cupom");
    expect(updated.data?.name).toBe("Template cupom");
  });

  it("persists created routes and destinations for subsequent reads", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const sourceGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Grupo Origem Persistencia",
        platform: "whatsapp",
        member_count: 40,
        session_id: "wa_persist_source",
      })
      .select()
      .single();
    expect(sourceGroup.error).toBeNull();

    const destinationGroups = await backend
      .from("groups")
      .insert([
        {
          user_id: userId,
          name: "Grupo Destino 1",
          platform: "whatsapp",
          member_count: 50,
          session_id: "wa_persist_dest",
        },
        {
          user_id: userId,
          name: "Grupo Destino 2",
          platform: "whatsapp",
          member_count: 60,
          session_id: "wa_persist_dest",
        },
      ])
      .select();
    expect(destinationGroups.error).toBeNull();

    const route = await backend
      .from("routes")
      .insert({
        user_id: userId,
        name: "Rota Persistida",
        source_group_id: sourceGroup.data?.id,
        status: "active",
        rules: {
          autoConvertShopee: true,
          autoConvertMercadoLivre: false,
          sessionId: "wa_persist_dest",
          positiveKeywords: ["oferta"],
          negativeKeywords: [],
        },
      })
      .select()
      .single();
    expect(route.error).toBeNull();

    const destinationRows = (destinationGroups.data || []).map((group) => ({
      route_id: route.data?.id,
      group_id: group.id,
    }));
    const destinationInsert = await backend.from("route_destinations").insert(destinationRows);
    expect(destinationInsert.error).toBeNull();

    const persistedRoute = await backend
      .from("routes")
      .select("*")
      .eq("id", route.data?.id)
      .eq("user_id", userId)
      .maybeSingle();
    expect(persistedRoute.error).toBeNull();
    expect(persistedRoute.data?.name).toBe("Rota Persistida");

    const persistedDestinations = await backend
      .from("route_destinations")
      .select("*")
      .eq("route_id", route.data?.id);
    expect(persistedDestinations.error).toBeNull();
    expect(persistedDestinations.data?.length).toBe(2);
  });

  it("processes inbound route message and forwards using template/conversion", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const waSourceSession = await backend
      .from("whatsapp_sessions")
      .insert({
        user_id: userId,
        name: "WA Origem",
        status: "online",
      })
      .select()
      .single();
    expect(waSourceSession.error).toBeNull();

    const waDestSession = await backend
      .from("whatsapp_sessions")
      .insert({
        user_id: userId,
        name: "WA Destino",
        status: "online",
      })
      .select()
      .single();
    expect(waDestSession.error).toBeNull();

    const waSourceSessionId = String(waSourceSession.data?.id || "");
    const waDestSessionId = String(waDestSession.data?.id || "");

    const sourceGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Grupo Origem",
        platform: "whatsapp",
        member_count: 150,
        session_id: waSourceSessionId,
        external_id: "wa_group_source",
      })
      .select()
      .single();
    expect(sourceGroup.error).toBeNull();

    const destinationGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Grupo Destino",
        platform: "whatsapp",
        member_count: 210,
        session_id: waDestSessionId,
        external_id: "wa_group_dest",
      })
      .select()
      .single();
    expect(destinationGroup.error).toBeNull();

    const template = await backend
      .from("templates")
      .insert({
        user_id: userId,
        name: "Template Oferta",
        content: "Oferta: {titulo}\nLink: {link}",
        category: "oferta",
      })
      .select()
      .single();
    expect(template.error).toBeNull();

    const route = await backend
      .from("routes")
      .insert({
        user_id: userId,
        name: "Rota Principal",
        source_group_id: sourceGroup.data?.id,
        status: "active",
        rules: {
          autoConvertShopee: true,
          resolvePartnerLinks: false,
          requirePartnerLink: true,
          partnerMarketplaces: ["shopee"],
          positiveKeywords: ["iphone"],
          negativeKeywords: ["spam"],
          templateId: template.data?.id,
          sessionId: waDestSessionId,
        },
      })
      .select()
      .single();
    expect(route.error).toBeNull();

    const destinationLink = await backend.from("route_destinations").insert({
      route_id: route.data?.id,
      group_id: destinationGroup.data?.id,
    });
    expect(destinationLink.error).toBeNull();

    const processed = await backend.functions.invoke("route-process-message", {
      body: {
        platform: "whatsapp",
        sessionId: waSourceSessionId,
        groupId: "wa_group_source",
        groupName: "Grupo Origem",
        from: "Canal Teste",
        message: "iphone promocao https://shopee.com.br/produto-teste",
        media: {
          kind: "image",
          sourcePlatform: "whatsapp",
          base64: "aGVsbG8=",
          mimeType: "image/jpeg",
          fileName: "route.jpg",
        },
      },
    });

    expect(processed.error).toBeNull();
    expect(processed.data?.routesMatched).toBe(1);
    expect(processed.data?.sent).toBe(1);
    expect(processed.data?.failed).toBe(0);

    const routeHistory = await backend
      .from("history_entries")
      .select("*")
      .eq("type", "route_forward")
      .eq("status", "success")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(routeHistory.error).toBeNull();
    const details = (routeHistory.data?.details || {}) as Record<string, unknown>;
    expect(String(details.routeName || "")).toBe("Rota Principal");
    expect(String(details.message || "")).toContain("aff_id=local_");

    const updatedRoute = await backend
      .from("routes")
      .select("*")
      .eq("id", route.data?.id)
      .maybeSingle();
    expect(updatedRoute.error).toBeNull();

    const rules = (updatedRoute.data?.rules || {}) as Record<string, unknown>;
    expect(rules.messagesForwarded).toBe(1);
  });

  it("blocks route forwarding when partner link is required and absent", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const tgSessions = await backend.from("telegram_sessions").insert([
      {
        id: "tg_source",
        user_id: userId,
        name: "TG Origem",
        status: "online",
      },
      {
        id: "tg_dest",
        user_id: userId,
        name: "TG Destino",
        status: "online",
      },
    ]);
    expect(tgSessions.error).toBeNull();

    const sourceGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Origem Sem Link",
        platform: "telegram",
        member_count: 80,
        session_id: "tg_source",
        external_id: "-100source",
      })
      .select()
      .single();
    expect(sourceGroup.error).toBeNull();

    const destinationGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Destino Sem Link",
        platform: "telegram",
        member_count: 95,
        session_id: "tg_dest",
        external_id: "-100dest",
      })
      .select()
      .single();
    expect(destinationGroup.error).toBeNull();

    const route = await backend
      .from("routes")
      .insert({
        user_id: userId,
        name: "Rota Exige Parceiro",
        source_group_id: sourceGroup.data?.id,
        status: "active",
        rules: {
          autoConvertShopee: true,
          resolvePartnerLinks: true,
          requirePartnerLink: true,
          partnerMarketplaces: ["shopee"],
          templateId: null,
          sessionId: "tg_dest",
        },
      })
      .select()
      .single();
    expect(route.error).toBeNull();

    const routeDestination = await backend.from("route_destinations").insert({
      route_id: route.data?.id,
      group_id: destinationGroup.data?.id,
    });
    expect(routeDestination.error).toBeNull();

    const processed = await backend.functions.invoke("route-process-message", {
      body: {
        platform: "telegram",
        sessionId: "tg_source",
        groupId: "-100source",
        groupName: "Origem Sem Link",
        from: "Canal A",
        message: "mensagem sem link de marketplace",
      },
    });

    expect(processed.error).toBeNull();
    expect(processed.data?.routesMatched).toBe(1);
    expect(processed.data?.sent).toBe(0);
    expect(processed.data?.skipped).toBe(1);

    const blockedHistory = await backend
      .from("history_entries")
      .select("*")
      .eq("type", "route_forward")
      .eq("processing_status", "blocked")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(blockedHistory.error).toBeNull();
    expect(blockedHistory.data?.block_reason).toBe("partner_link_required");
  });

  it("resolves unknown redirect link before partner validation", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const waSessions = await backend.from("whatsapp_sessions").insert([
      { id: "wa_source", user_id: userId, name: "WA Origem", status: "online" },
      { id: "wa_dest", user_id: userId, name: "WA Destino", status: "online" },
    ]);
    expect(waSessions.error).toBeNull();

    const sourceGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Origem Redirect",
        platform: "whatsapp",
        member_count: 12,
        session_id: "wa_source",
        external_id: "wa_source_group",
      })
      .select()
      .single();
    expect(sourceGroup.error).toBeNull();

    const destinationGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Destino Redirect",
        platform: "whatsapp",
        member_count: 12,
        session_id: "wa_dest",
        external_id: "wa_dest_group",
      })
      .select()
      .single();
    expect(destinationGroup.error).toBeNull();

    const route = await backend
      .from("routes")
      .insert({
        user_id: userId,
        name: "Rota Resolve Redirect",
        source_group_id: sourceGroup.data?.id,
        status: "active",
        rules: {
          autoConvertShopee: true,
          resolvePartnerLinks: true,
          requirePartnerLink: true,
          partnerMarketplaces: ["shopee"],
          templateId: null,
          sessionId: "wa_dest",
        },
      })
      .select()
      .single();
    expect(route.error).toBeNull();

    const routeDestination = await backend.from("route_destinations").insert({
      route_id: route.data?.id,
      group_id: destinationGroup.data?.id,
    });
    expect(routeDestination.error).toBeNull();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ url: "https://shopee.com.br/oferta-redirecionada" } as unknown as Response);

    const processed = await backend.functions.invoke("route-process-message", {
      body: {
        platform: "whatsapp",
        sessionId: "wa_source",
        groupId: "wa_source_group",
        groupName: "Origem Redirect",
        from: "Canal Redirect",
        message: "oferta https://redir.local/abc123",
        media: {
          kind: "image",
          sourcePlatform: "whatsapp",
          base64: "aGVsbG8=",
          mimeType: "image/jpeg",
          fileName: "route.jpg",
        },
      },
    });
    fetchSpy.mockRestore();

    expect(processed.error).toBeNull();
    expect(processed.data?.routesMatched).toBe(1);
    expect(processed.data?.sent).toBe(1);
    expect(processed.data?.skipped).toBe(0);
  });

  it("resolves known short marketplace links before route conversion", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const waSessions = await backend.from("whatsapp_sessions").insert([
      { id: "wa_source_short", user_id: userId, name: "WA Origem Short", status: "online" },
      { id: "wa_dest_short", user_id: userId, name: "WA Destino Short", status: "online" },
    ]);
    expect(waSessions.error).toBeNull();

    const sourceGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Origem Shopee Curto",
        platform: "whatsapp",
        member_count: 14,
        session_id: "wa_source_short",
        external_id: "wa_source_short_group",
      })
      .select()
      .single();
    expect(sourceGroup.error).toBeNull();

    const destinationGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Destino Shopee Curto",
        platform: "whatsapp",
        member_count: 14,
        session_id: "wa_dest_short",
        external_id: "wa_dest_short_group",
      })
      .select()
      .single();
    expect(destinationGroup.error).toBeNull();

    const route = await backend
      .from("routes")
      .insert({
        user_id: userId,
        name: "Rota Resolve Shopee Curto",
        source_group_id: sourceGroup.data?.id,
        status: "active",
        rules: {
          autoConvertShopee: true,
          resolvePartnerLinks: true,
          requirePartnerLink: true,
          partnerMarketplaces: ["shopee"],
          templateId: null,
          sessionId: "wa_dest_short",
        },
      })
      .select()
      .single();
    expect(route.error).toBeNull();

    const routeDestination = await backend.from("route_destinations").insert({
      route_id: route.data?.id,
      group_id: destinationGroup.data?.id,
    });
    expect(routeDestination.error).toBeNull();

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ url: "https://shopee.com.br/produto-final" } as unknown as Response);

    const processed = await backend.functions.invoke("route-process-message", {
      body: {
        platform: "whatsapp",
        sessionId: "wa_source_short",
        groupId: "wa_source_short_group",
        groupName: "Origem Shopee Curto",
        from: "Canal Shopee Curto",
        message: "oferta https://shope.ee/abc123",
        media: {
          kind: "image",
          sourcePlatform: "whatsapp",
          base64: "aGVsbG8=",
          mimeType: "image/jpeg",
          fileName: "route.jpg",
        },
      },
    });
    fetchSpy.mockRestore();

    expect(processed.error).toBeNull();
    expect(processed.data?.routesMatched).toBe(1);
    expect(processed.data?.sent).toBe(1);
    expect(processed.data?.skipped).toBe(0);
  });

  it("forwards original link when partner requirement is disabled", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const tgSessions = await backend.from("telegram_sessions").insert([
      { id: "tg_source", user_id: userId, name: "TG Origem", status: "online" },
      { id: "tg_dest", user_id: userId, name: "TG Destino", status: "online" },
    ]);
    expect(tgSessions.error).toBeNull();

    const sourceGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Origem Livre",
        platform: "telegram",
        member_count: 51,
        session_id: "tg_source",
        external_id: "-100livre",
      })
      .select()
      .single();
    expect(sourceGroup.error).toBeNull();

    const destinationGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Destino Livre",
        platform: "telegram",
        member_count: 51,
        session_id: "tg_dest",
        external_id: "-100destlivre",
      })
      .select()
      .single();
    expect(destinationGroup.error).toBeNull();

    const route = await backend
      .from("routes")
      .insert({
        user_id: userId,
        name: "Rota Sem Exigir Parceiro",
        source_group_id: sourceGroup.data?.id,
        status: "active",
        rules: {
          autoConvertShopee: false,
          resolvePartnerLinks: false,
          requirePartnerLink: false,
          partnerMarketplaces: ["shopee"],
          templateId: null,
          sessionId: "tg_dest",
        },
      })
      .select()
      .single();
    expect(route.error).toBeNull();

    const routeDestination = await backend.from("route_destinations").insert({
      route_id: route.data?.id,
      group_id: destinationGroup.data?.id,
    });
    expect(routeDestination.error).toBeNull();

    const originalMessage = "segue link geral https://exemplo.com/produto/123";
    const processed = await backend.functions.invoke("route-process-message", {
      body: {
        platform: "telegram",
        sessionId: "tg_source",
        groupId: "-100livre",
        groupName: "Origem Livre",
        from: "Canal Livre",
        message: originalMessage,
        media: {
          kind: "image",
          sourcePlatform: "telegram",
          base64: "aGVsbG8=",
          mimeType: "image/jpeg",
          fileName: "route.jpg",
        },
      },
    });

    expect(processed.error).toBeNull();
    expect(processed.data?.routesMatched).toBe(1);
    expect(processed.data?.sent).toBe(1);

    const routeHistory = await backend
      .from("history_entries")
      .select("*")
      .eq("type", "route_forward")
      .eq("status", "success")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(routeHistory.error).toBeNull();
    const details = (routeHistory.data?.details || {}) as Record<string, unknown>;
    expect(String(details.message || "")).toContain("https://exemplo.com/produto/123");
  });

  it("blocks Mercado Livre links when Mercado Livre conversion is disabled", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const tgSessions = await backend.from("telegram_sessions").insert([
      { id: "tg_source_meli", user_id: userId, name: "TG Origem ML", status: "online" },
      { id: "tg_dest_meli", user_id: userId, name: "TG Destino ML", status: "online" },
    ]);
    expect(tgSessions.error).toBeNull();

    const sourceGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Origem ML",
        platform: "telegram",
        member_count: 51,
        session_id: "tg_source_meli",
        external_id: "-100source_meli",
      })
      .select()
      .single();
    expect(sourceGroup.error).toBeNull();

    const destinationGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Destino ML",
        platform: "telegram",
        member_count: 51,
        session_id: "tg_dest_meli",
        external_id: "-100dest_meli",
      })
      .select()
      .single();
    expect(destinationGroup.error).toBeNull();

    const route = await backend
      .from("routes")
      .insert({
        user_id: userId,
        name: "Rota ML Desligada",
        source_group_id: sourceGroup.data?.id,
        status: "active",
        rules: {
          autoConvertShopee: true,
          autoConvertMercadoLivre: false,
          resolvePartnerLinks: true,
          requirePartnerLink: true,
          partnerMarketplaces: ["shopee", "mercadolivre"],
          templateId: null,
          sessionId: "tg_dest_meli",
        },
      })
      .select()
      .single();
    expect(route.error).toBeNull();

    const routeDestination = await backend.from("route_destinations").insert({
      route_id: route.data?.id,
      group_id: destinationGroup.data?.id,
    });
    expect(routeDestination.error).toBeNull();

    const processed = await backend.functions.invoke("route-process-message", {
      body: {
        platform: "telegram",
        sessionId: "tg_source_meli",
        groupId: "-100source_meli",
        groupName: "Origem ML",
        from: "Canal ML",
        message: "oferta https://mercadolivre.com.br/item/123",
        media: {
          kind: "image",
          sourcePlatform: "telegram",
          base64: "aGVsbG8=",
          mimeType: "image/jpeg",
          fileName: "route.jpg",
        },
      },
    });

    expect(processed.error).toBeNull();
    expect(processed.data?.routesMatched).toBe(1);
    expect(processed.data?.sent).toBe(0);
    expect(processed.data?.skipped).toBe(1);

    const blockedHistory = await backend
      .from("history_entries")
      .select("*")
      .eq("type", "route_forward")
      .eq("processing_status", "blocked")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(blockedHistory.error).toBeNull();
    expect(blockedHistory.data?.block_reason).toBe("marketplace_not_enabled");
  });

  it("runs shopee automations end-to-end for WhatsApp and Telegram", async () => {
    __resetLocalDatabase();

    await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    const {
      data: { session },
    } = await backend.auth.getSession();
    const userId = session?.user.id || "";

    const sessionsInsert = await backend.from("whatsapp_sessions").insert([
      { id: "wa_auto", user_id: userId, name: "WA Auto", status: "online" },
    ]);
    expect(sessionsInsert.error).toBeNull();

    const tgSessionsInsert = await backend.from("telegram_sessions").insert([
      { id: "tg_auto", user_id: userId, name: "TG Auto", status: "online" },
    ]);
    expect(tgSessionsInsert.error).toBeNull();

    const waGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Grupo WA Auto",
        platform: "whatsapp",
        member_count: 20,
        session_id: "wa_auto",
        external_id: "5511999999999-111111@g.us",
      })
      .select()
      .single();
    expect(waGroup.error).toBeNull();

    const tgGroup = await backend
      .from("groups")
      .insert({
        user_id: userId,
        name: "Grupo TG Auto",
        platform: "telegram",
        member_count: 20,
        session_id: "tg_auto",
        external_id: "-1001234567890",
      })
      .select()
      .single();
    expect(tgGroup.error).toBeNull();

    const template = await backend
      .from("templates")
      .insert({
        user_id: userId,
        name: "Template Auto",
        content: "{title}\n{affiliateLink}",
        is_default: true,
      })
      .select()
      .single();
    expect(template.error).toBeNull();

    const creds = await backend.from("api_credentials").insert({
      user_id: userId,
      provider: "shopee",
      app_id: "dummy",
      secret_key: "dummy",
      affiliate_id: "dummy",
      shop_id: "dummy",
    });
    expect(creds.error).toBeNull();

    const waAutomation = await backend.from("shopee_automations").insert({
      user_id: userId,
      name: "Auto WA",
      is_active: true,
      interval_minutes: 1,
      min_discount: 0,
      min_price: 0,
      max_price: 9999,
      categories: [],
      destination_group_ids: [waGroup.data?.id],
      master_group_ids: [],
      template_id: template.data?.id,
      session_id: "wa_auto",
      active_hours_start: "00:00",
      active_hours_end: "23:59",
      products_sent: 0,
    });
    expect(waAutomation.error).toBeNull();

    const tgAutomation = await backend.from("shopee_automations").insert({
      user_id: userId,
      name: "Auto TG",
      is_active: true,
      interval_minutes: 1,
      min_discount: 0,
      min_price: 0,
      max_price: 9999,
      categories: [],
      destination_group_ids: [tgGroup.data?.id],
      master_group_ids: [],
      template_id: template.data?.id,
      session_id: "tg_auto",
      active_hours_start: "00:00",
      active_hours_end: "23:59",
      products_sent: 0,
    });
    expect(tgAutomation.error).toBeNull();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes("/api/shopee/batch")) {
        return new Response(
          JSON.stringify({
            results: {
              cat_0: {
                products: [
                  {
                    title: "Oferta E2E Shopee",
                    discount: 25,
                    salePrice: 79.9,
                    offerLink: "https://s.shopee.com.br/abc123",
                    imageUrl: "https://cdn.autolinks.dev/oferta-e2e.jpg",
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === "https://cdn.autolinks.dev/oferta-e2e.jpg") {
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": "4",
          },
        });
      }

      if (url.includes(":3111/api/send-message")) {
        return new Response(JSON.stringify({ id: "wa-msg-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes(":3111/api/sessions/") && url.includes("/events")) {
        return new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes(":3112/api/telegram/send-message")) {
        return new Response(JSON.stringify({ id: "tg-msg-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes(":3112/api/telegram/events/")) {
        return new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    });

    const run = await backend.functions.invoke("shopee-automation-run", {
      body: { source: "test-e2e" },
    });
    fetchSpy.mockRestore();

    expect(run.error).toBeNull();
    expect(run.data?.ok).toBe(true);
    expect(run.data?.processed).toBe(2);
    expect(run.data?.sent).toBe(2);
    expect(run.data?.failed).toBe(0);

    const allAutomationHistory = await backend
      .from("history_entries")
      .select("*")
      .eq("type", "automation_run")
      .eq("status", "success");
    expect(allAutomationHistory.error).toBeNull();
    expect(allAutomationHistory.data?.length).toBe(2);

    const waHistory = await backend
      .from("history_entries")
      .select("*")
      .eq("type", "automation_run")
      .eq("destination", "Grupo WA Auto")
      .maybeSingle();
    expect(waHistory.error).toBeNull();
    expect(waHistory.data?.status).toBe("success");

    const tgHistory = await backend
      .from("history_entries")
      .select("*")
      .eq("type", "automation_run")
      .eq("destination", "Grupo TG Auto")
      .maybeSingle();
    expect(tgHistory.error).toBeNull();
    expect(tgHistory.data?.status).toBe("success");
  });
});


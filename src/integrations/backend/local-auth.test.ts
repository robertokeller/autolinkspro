import { describe, expect, it } from "vitest";
import { __resetLocalDatabase, backend } from "@/integrations/backend/client";

const DEMO_ADMIN_EMAIL = (import.meta.env.VITE_DEMO_ADMIN_EMAIL as string | undefined) || "robertokellercontato@gmail.com";
const DEMO_ADMIN_PASSWORD = (import.meta.env.VITE_DEMO_ADMIN_PASSWORD as string | undefined) || "AutoLinks@Admin2025!";
const DEMO_USER_EMAIL = (import.meta.env.VITE_DEMO_USER_EMAIL as string | undefined) || "aliancaslovely@gmail.com";
const DEMO_USER_PASSWORD = (import.meta.env.VITE_DEMO_USER_PASSWORD as string | undefined) || "AutoLinks@User2025!";

describe("local auth", () => {
  it("logs in with seeded admin credentials", async () => {
    __resetLocalDatabase();

    const { error } = await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: DEMO_ADMIN_PASSWORD,
    });

    expect(error).toBeNull();

    const {
      data: { session },
    } = await backend.auth.getSession();

    expect(session?.user?.email).toBe(DEMO_ADMIN_EMAIL);
  });

  it("logs in with seeded basic user credentials", async () => {
    __resetLocalDatabase();

    const { error } = await backend.auth.signInWithPassword({
      email: DEMO_USER_EMAIL,
      password: DEMO_USER_PASSWORD,
    });

    expect(error).toBeNull();

    const {
      data: { session },
    } = await backend.auth.getSession();

    expect(session?.user?.email).toBe(DEMO_USER_EMAIL);

    const roleRes = await backend
      .from("user_roles")
      .select("role")
      .eq("user_id", session?.user?.id || "")
      .maybeSingle();
    expect(roleRes.error).toBeNull();
    expect(roleRes.data?.role).toBe("user");

    const profileRes = await backend
      .from("profiles")
      .select("plan_id")
      .eq("user_id", session?.user?.id || "")
      .maybeSingle();
    expect(profileRes.error).toBeNull();
    expect(profileRes.data?.plan_id).toBe("plan-starter");
  });

  it("signs up and logs in with client credentials", async () => {
    __resetLocalDatabase();

    const signUp = await backend.auth.signUp({
      email: "cliente.teste@autolinks.local",
      password: "Mudar@1234!",
      options: { data: { name: "Cliente Teste" } },
    });
    expect(signUp.error).toBeNull();

    await backend.auth.signOut();

    const { error } = await backend.auth.signInWithPassword({
      email: "cliente.teste@autolinks.local",
      password: "Mudar@1234!",
    });

    expect(error).toBeNull();

    const {
      data: { session },
    } = await backend.auth.getSession();

    expect(session?.user?.email).toBe("cliente.teste@autolinks.local");
  });

  it("rejects invalid credentials", async () => {
    __resetLocalDatabase();

    const { error } = await backend.auth.signInWithPassword({
      email: DEMO_ADMIN_EMAIL,
      password: "senha-errada",
    });

    expect(error?.message).toBe("Invalid login credentials");
  });

  it("prevents a regular user from escalating to admin role", async () => {
    __resetLocalDatabase();

    const signUp = await backend.auth.signUp({
      email: "cliente.regular@autolinks.local",
      password: "Mudar@1234!",
      options: { data: { name: "Cliente Regular" } },
    });
    expect(signUp.error).toBeNull();

    await backend.auth.signOut();

    const login = await backend.auth.signInWithPassword({
      email: "cliente.regular@autolinks.local",
      password: "Mudar@1234!",
    });
    expect(login.error).toBeNull();

    const roleInsert = await backend.from("user_roles").insert({
      user_id: login.data.user?.id,
      role: "admin",
    });

    expect(roleInsert.error?.message).toBe("Permissao negada");
  });

  it("keeps profile data isolated by user id", async () => {
    __resetLocalDatabase();

    const signUp = await backend.auth.signUp({
      email: "cliente.isolado@autolinks.local",
      password: "Mudar@1234!",
      options: { data: { name: "Cliente Isolado" } },
    });
    expect(signUp.error).toBeNull();

    await backend.auth.signOut();

    const login = await backend.auth.signInWithPassword({
      email: "cliente.isolado@autolinks.local",
      password: "Mudar@1234!",
    });
    expect(login.error).toBeNull();

    const profilesRes = await backend.from("profiles").select("*");
    expect(profilesRes.error).toBeNull();
    expect((profilesRes.data || []).length).toBe(1);
    expect(profilesRes.data?.[0]?.user_id).toBe(login.data.user?.id);
  });
});

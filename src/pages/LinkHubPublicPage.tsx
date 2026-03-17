import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Bell,
  ChevronRight,
  Crown,
  Gift,
  Link2,
  Loader2,
  ShieldCheck,
  Star,
  Tag,
  TrendingUp,
  Users,
} from "lucide-react";
import { invokeBackendRpc } from "@/integrations/backend/rpc";
import { ChannelPlatformIcon } from "@/components/icons/ChannelPlatformIcon";
import { ROUTES } from "@/lib/routes";
import {
  LINK_HUB_DEFAULT_THEME_COLOR,
  LINK_HUB_PUBLIC_THEME,
  getPlatformGradient,
  getReadableTextColor,
  hexToHsl,
  normalizeHexColor,
} from "@/lib/link-hub-theme";

const fadeUp = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: "easeOut" as const } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const benefits = [
  { icon: Bell, text: "Alertas instantâneos" },
  { icon: ShieldCheck, text: "Ofertas verificadas" },
  { icon: Tag, text: "Cupons exclusivos" },
  { icon: TrendingUp, text: "Promoções relâmpago" },
  { icon: Gift, text: "100% gratuito" },
  { icon: Users, text: "Comunidade ativa" },
];

const testimonials = [
  { name: "Ana C.", text: "Economizei uns R$ 500 no primeiro mês, melhor grupo em que já entrei kkk." },
  { name: "Rafael M.", text: "Os cupons daqui não têm em lugar nenhum, sempre compro com desconto agora!" },
  { name: "Juliana S.", text: "achei uma TV de 2k por 900 reais!! recomendo pra todo mundo" },
];

type LinkHubGroup = {
  id: string;
  name: string;
  platform: string;
  external_id: string | null;
  member_count: number;
};

type LinkHubPageConfig = {
  description?: string;
  logoUrl?: string | null;
  themeColor?: string;
};

type LinkHubPage = {
  title: string;
  config?: LinkHubPageConfig;
};

type LinkHubPublicResponse = {
  page: LinkHubPage | null;
  groups: LinkHubGroup[];
  groupLabels: Record<string, string>;
};

function getInviteLink(group: LinkHubGroup) {
  if (!group.external_id) return null;
  return group.platform === "whatsapp"
    ? `https://chat.whatsapp.com/${group.external_id}`
    : `https://t.me/${group.external_id}`;
}

export default function LinkHubPublicPage() {
  const { slug } = useParams<{ slug: string }>();

  const { data, isLoading } = useQuery<LinkHubPublicResponse>({
    queryKey: ["link_hub_public", slug],
    queryFn: () =>
      invokeBackendRpc<LinkHubPublicResponse>("link-hub-public", {
        body: { slug },
      }),
    enabled: !!slug,
  });

  const page = data?.page;
  const groups = data?.groups ?? [];
  const groupLabels = data?.groupLabels ?? {};
  const config = page?.config || {};
  const themeColor = normalizeHexColor(config.themeColor || LINK_HUB_DEFAULT_THEME_COLOR);
  const title = page?.title || "";
  const description = config.description || "";
  const logoUrl = config.logoUrl || null;
  const hsl = hexToHsl(themeColor);

  const accent = `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
  const accentGlow = `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, 0.15)`;
  const accentSoft = `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, 0.08)`;
  const accentBorder = `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, 0.18)`;
  const textOnAccent = getReadableTextColor(hsl.l);

  const totalMembers = groups.reduce((sum, group) => sum + (group.member_count || 0), 0);
  const primaryGroup = groups[0] || null;
  const primaryInviteLink = primaryGroup ? getInviteLink(primaryGroup) : null;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: LINK_HUB_PUBLIC_THEME.background }}>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: accent }} />
        </motion.div>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center" style={{ background: LINK_HUB_PUBLIC_THEME.background, color: LINK_HUB_PUBLIC_THEME.text }}>
        <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="mb-4">
          <Link2 className="h-12 w-12 opacity-50" />
        </motion.div>
        <h1 className="text-xl font-bold mb-2">Página não encontrada</h1>
        <p className="text-sm opacity-40 mb-6">Esta página não existe ou foi desativada.</p>
        <Link to={ROUTES.home} className="text-sm hover:underline flex items-center gap-1.5 opacity-60" style={{ color: accent }}>
          <ArrowLeft className="h-4 w-4" />
          Voltar
        </Link>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen selection:bg-white/10"
      style={{
        background: LINK_HUB_PUBLIC_THEME.background,
        color: LINK_HUB_PUBLIC_THEME.text,
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      }}
    >
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse 60% 40% at 50% -5%, hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.12) 0%, transparent 60%),
            radial-gradient(ellipse 40% 30% at 80% 60%, hsla(${hsl.h},${Math.max(hsl.s - 20, 0)}%,${Math.min(hsl.l + 10, 100)}%,0.04) 0%, transparent 50%)
          `,
        }}
      />

      <motion.div
        initial={{ y: -40 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="sticky top-0 z-50 text-center py-2 px-4 backdrop-blur-xl"
        style={{
          background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 15) % 360},${hsl.s}%,${Math.min(hsl.l + 8, 90)}%,1))`,
          color: textOnAccent,
          boxShadow: `0 4px 30px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.3)`,
        }}
      >
        <p className="text-2xs sm:text-xs font-bold tracking-widest uppercase flex items-center justify-center gap-1.5">
          <Star className="h-3 w-3" />
          Vagas limitadas, entre antes que feche
          <Star className="h-3 w-3" />
        </p>
      </motion.div>

      <section className="relative z-10">
        <div className="ds-linkhub-shell pt-10 pb-6 sm:pt-14 sm:pb-8">
          <motion.div
            className="flex justify-center mb-5"
            initial={{ opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          >
            {logoUrl ? (
              <div className="relative">
                <img src={logoUrl} alt={title} className="h-24 w-24 rounded-3xl object-cover" style={{ boxShadow: `0 8px 40px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.25)` }} />
                <div className="absolute -inset-1 rounded-3xl -z-10" style={{ background: `linear-gradient(135deg, ${accentGlow}, transparent)`, filter: "blur(10px)" }} />
              </div>
            ) : (
              <div className="relative">
                <div
                  className="h-24 w-24 rounded-3xl flex items-center justify-center text-5xl font-black"
                  style={{
                    background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 20) % 360},${hsl.s}%,${Math.min(hsl.l + 12, 85)}%,1))`,
                    color: textOnAccent,
                    boxShadow: `0 8px 40px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.3)`,
                  }}
                >
                  {title.charAt(0).toUpperCase()}
                </div>
                <div className="absolute -inset-2 rounded-3xl -z-10" style={{ background: accentGlow, filter: "blur(20px)" }} />
              </div>
            )}
          </motion.div>

          {totalMembers > 0 && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="flex justify-center mb-4">
              <span
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-2xs font-semibold backdrop-blur-sm border"
                style={{ background: accentSoft, borderColor: accentBorder, color: accent }}
              >
                <Crown className="h-3 w-3" />
                +{totalMembers.toLocaleString("pt-BR")} membros ativos
              </span>
            </motion.div>
          )}

          <motion.h1
            className="text-2xl sm:text-3xl font-black leading-tight tracking-tight text-center"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.4 }}
          >
            {title}
          </motion.h1>

          {description && (
            <motion.p
              className="mt-2.5 text-xs sm:text-sm text-center max-w-xs mx-auto leading-relaxed"
              style={{ color: LINK_HUB_PUBLIC_THEME.textSubtle }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
            >
              {description}
            </motion.p>
          )}

          <motion.div className="mt-7 space-y-3" variants={stagger} initial="hidden" animate="show">
            {groups.map((group) => {
              const isWhatsApp = group.platform === "whatsapp";
              const inviteLink = getInviteLink(group);
              const label = groupLabels[group.id] || group.name;
              const platformGradient = getPlatformGradient(group.platform);

              return (
                <motion.a
                  key={group.id}
                  variants={fadeUp}
                  href={inviteLink || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative flex items-center gap-3.5 p-4 rounded-2xl border transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                  style={{
                    background: LINK_HUB_PUBLIC_THEME.surfaceMuted,
                    borderColor: LINK_HUB_PUBLIC_THEME.borderMuted,
                  }}
                  whileHover={{
                    borderColor: accentBorder,
                    boxShadow: `0 0 30px ${accentSoft}`,
                  }}
                >
                  <div
                    className="h-11 w-11 rounded-xl flex items-center justify-center text-white shrink-0 shadow-lg"
                    style={{ background: platformGradient }}
                  >
                    <ChannelPlatformIcon platform={isWhatsApp ? "whatsapp" : "telegram"} className="h-5 w-5" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate">{label}</p>
                    <p className="text-2xs mt-0.5 flex items-center gap-1" style={{ color: LINK_HUB_PUBLIC_THEME.textFaint }}>
                      <Users className="h-2.5 w-2.5" />
                      {(group.member_count || 0).toLocaleString("pt-BR")} membros
                    </p>
                  </div>

                  <div
                    className="px-4 py-2 rounded-xl text-xs font-bold shrink-0 flex items-center gap-1 transition-all duration-300 group-hover:gap-2"
                    style={{
                      background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 15) % 360},${hsl.s}%,${Math.min(hsl.l + 10, 85)}%,1))`,
                      color: textOnAccent,
                      boxShadow: `0 2px 16px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.25)`,
                    }}
                  >
                    Entrar
                    <ChevronRight className="h-3 w-3" />
                  </div>
                </motion.a>
              );
            })}
          </motion.div>

          {groups.length === 0 && (
            <div className="text-center py-10 mt-4">
              <p className="text-xs" style={{ color: LINK_HUB_PUBLIC_THEME.textFaint }}>Nenhum grupo disponível no momento.</p>
            </div>
          )}
        </div>
      </section>

      <section className="relative z-10 py-7" style={{ borderTop: `1px solid ${LINK_HUB_PUBLIC_THEME.borderSoft}`, borderBottom: `1px solid ${LINK_HUB_PUBLIC_THEME.borderSoft}` }}>
        <motion.div
          className="ds-linkhub-section grid grid-cols-3 gap-3 text-center"
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.5 }}
        >
          {[
            { value: totalMembers > 0 ? `${(totalMembers / 1000).toFixed(totalMembers >= 1000 ? 1 : 0)}k+` : "1k+", label: "Membros" },
            { value: "500+", label: "Ofertas/dia" },
            { value: "Grátis", label: "Pra sempre" },
          ].map((item) => (
            <motion.div key={item.label} variants={fadeUp}>
              <p className="text-xl sm:text-2xl font-black" style={{ color: accent }}>{item.value}</p>
              <p className="text-2xs mt-0.5 uppercase tracking-widest font-medium" style={{ color: LINK_HUB_PUBLIC_THEME.textFaint }}>{item.label}</p>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <section className="relative z-10 py-8 sm:py-10">
        <div className="ds-linkhub-section">
          <motion.h2 className="text-sm sm:text-base font-black text-center mb-5" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>
            Por que entrar?
          </motion.h2>
          <motion.div className="grid grid-cols-2 gap-2" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.3 }}>
            {benefits.map((item) => (
              <motion.div
                key={item.text}
                variants={fadeUp}
                className="flex items-center gap-2.5 p-3 rounded-xl border"
                style={{ background: LINK_HUB_PUBLIC_THEME.surfaceSoft, borderColor: LINK_HUB_PUBLIC_THEME.borderSoft }}
              >
                <div className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: accentSoft }}>
                  <item.icon className="h-3.5 w-3.5" style={{ color: accent }} />
                </div>
                <p className="text-xs font-medium" style={{ color: LINK_HUB_PUBLIC_THEME.textMuted }}>{item.text}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      <section className="relative z-10 py-8 sm:py-10">
        <div className="ds-linkhub-section">
          <motion.h2 className="text-sm sm:text-base font-black text-center mb-5" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>
            O que estão falando
          </motion.h2>
          <motion.div className="space-y-2.5" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.3 }}>
            {testimonials.map((item) => (
              <motion.div
                key={item.name}
                variants={fadeUp}
                className="p-3.5 rounded-xl border"
                style={{ background: LINK_HUB_PUBLIC_THEME.surfaceSoft, borderColor: LINK_HUB_PUBLIC_THEME.borderSoft }}
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <div
                    className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{
                      background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 20) % 360},${hsl.s}%,${Math.min(hsl.l + 12, 85)}%,1))`,
                      color: textOnAccent,
                    }}
                  >
                    {item.name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-xs font-bold" style={{ color: LINK_HUB_PUBLIC_THEME.textMuted }}>{item.name}</p>
                    <div className="flex gap-0.5">
                      {[...Array(5)].map((_, index) => (
                        <Star key={index} className="h-2.5 w-2.5 fill-current" style={{ color: LINK_HUB_PUBLIC_THEME.star }} />
                      ))}
                    </div>
                  </div>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: LINK_HUB_PUBLIC_THEME.textDim }}>
                  "{item.text}"
                </p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {groups.length > 0 && (
        <motion.div
          initial={{ y: 80 }}
          animate={{ y: 0 }}
          transition={{ delay: 0.5, duration: 0.4, ease: "easeOut" }}
          className="sticky bottom-0 z-50 p-4 backdrop-blur-xl"
          style={{
            background: "linear-gradient(to top, rgba(5,5,7,0.95), rgba(5,5,7,0.7))",
            borderTop: `1px solid ${LINK_HUB_PUBLIC_THEME.borderSoft}`,
          }}
        >
          <div className="ds-linkhub-shell px-0">
            <a
              href={primaryInviteLink || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl text-sm font-bold transition-all duration-300 active:scale-[0.97]"
              style={{
                background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 15) % 360},${hsl.s}%,${Math.min(hsl.l + 10, 85)}%,1))`,
                color: textOnAccent,
                boxShadow: `0 4px 30px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.3)`,
              }}
            >
              <ChannelPlatformIcon platform={primaryGroup?.platform === "whatsapp" ? "whatsapp" : "telegram"} className="h-4 w-4" />
              Entrar no Grupo
              <ChevronRight className="h-4 w-4" />
            </a>
          </div>
        </motion.div>
      )}

      <footer className="relative z-10 py-6 text-center" style={{ paddingBottom: groups.length > 0 ? "80px" : "24px" }}>
        <p className="text-2xs font-medium" style={{ color: LINK_HUB_PUBLIC_THEME.textFaint }}>
          Powered by <span style={{ color: accent }}>Auto Links</span>
        </p>
      </footer>
    </div>
  );
}

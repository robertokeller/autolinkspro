import { useEffect } from "react";
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
  invite_link?: string | null;
  redirect_url?: string | null;
  member_count: number;
};

type LinkHubPageConfig = {
  description?: string;
  logoUrl?: string | null;
  themeColor?: string;
  texts?: {
    benefitsTitle?: string;
    testimonialsTitle?: string;
    testimonials?: { name: string; text: string }[];
  };
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
  // Security: validate protocol on all URL fields to prevent javascript: / data: injection
  if (group.redirect_url && /^https?:\/\//i.test(group.redirect_url)) return group.redirect_url;
  if (group.invite_link && /^https?:\/\//i.test(group.invite_link)) return group.invite_link;
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

  useEffect(() => {
    if (title) {
      document.title = title;
    } else {
      document.title = "AutoLinks!";
    }
  }, [title]);
  const logoUrl = config.logoUrl || null;
  const texts = config.texts || {};
  const benefitsTitle = texts.benefitsTitle?.trim() || "Por que entrar?";
  const testimonialsTitle = texts.testimonialsTitle?.trim() || "O que estão falando";
  const customTestimonials = texts.testimonials?.filter(t => t.name && t.name.trim() && t.text && t.text.trim()) || [];
  const activeTestimonials = customTestimonials.length > 0 ? customTestimonials : testimonials;
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
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 selection:bg-white/10">
      {/* Noise grain overlay */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.025] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundSize: "200px 200px",
        }}
      />

      {/* Ambient gradient orbs */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse 55% 35% at 50% -8%, hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.10) 0%, transparent 65%),
            radial-gradient(ellipse 35% 25% at 85% 65%, hsla(${hsl.h},${Math.max(hsl.s - 20, 0)}%,${Math.min(hsl.l + 10, 100)}%,0.04) 0%, transparent 55%)
          `,
        }}
      />

      <motion.div
        initial={{ y: -40 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="sticky top-0 z-50 text-center py-2.5 px-4 backdrop-blur-xl"
        style={{
          background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 15) % 360},${hsl.s}%,${Math.min(hsl.l + 8, 90)}%,1))`,
          color: textOnAccent,
          boxShadow: `0 4px 30px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.3)`,
        }}
      >
        <p className="text-2xs sm:text-xs font-bold tracking-[0.2em] uppercase flex items-center justify-center gap-2">
          <Star className="h-3 w-3" />
          Vagas limitadas — entre antes que feche
          <Star className="h-3 w-3" />
        </p>
      </motion.div>

      <section className="relative z-10">
        <div className="ds-linkhub-shell pt-12 pb-8 sm:pt-16 sm:pb-10">
          <motion.div
            className="flex justify-center mb-6"
            initial={{ opacity: 0, scale: 0.85, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          >
            {logoUrl ? (
              <div className="relative">
                <img src={logoUrl} alt={title} className="h-20 w-20 sm:h-24 sm:w-24 rounded-2xl object-cover" style={{ boxShadow: `0 8px 40px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.3)` }} />
                <div className="absolute -inset-2 rounded-3xl -z-10 animate-pulse" style={{ background: `radial-gradient(circle, hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.15), transparent 70%)` }} />
              </div>
            ) : (
              <div className="relative">
                <div
                  className="h-20 w-20 sm:h-24 sm:w-24 rounded-2xl flex items-center justify-center text-4xl sm:text-5xl font-black"
                  style={{
                    background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 20) % 360},${hsl.s}%,${Math.min(hsl.l + 15, 85)}%,1))`,
                    color: textOnAccent,
                    boxShadow: `0 8px 40px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.35)`,
                  }}
                >
                  {title.charAt(0).toUpperCase()}
                </div>
                <div className="absolute -inset-3 rounded-3xl -z-10 animate-pulse" style={{ background: `radial-gradient(circle, hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.12), transparent 70%)` }} />
              </div>
            )}
          </motion.div>

          {totalMembers > 0 && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="flex justify-center mb-5">
              <span
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-2xs font-semibold backdrop-blur-md border"
                style={{ background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.65)" }}
              >
                <Crown className="h-3 w-3" style={{ color: accent }} />
                <span style={{ color: accent, fontWeight: 800 }}>+{totalMembers.toLocaleString("pt-BR")}</span> membros ativos
              </span>
            </motion.div>
          )}

          <motion.h1
            className="text-2xl sm:text-4xl font-black leading-tight tracking-tight text-center px-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.4 }}
          >
            {title}
          </motion.h1>

          {description && (
            <motion.p
              className="mt-3 text-sm sm:text-base text-center max-w-sm mx-auto leading-relaxed px-5"
              style={{ color: "rgba(255,255,255,0.5)" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
            >
              {description}
            </motion.p>
          )}

          <motion.div className="mt-8 space-y-3" variants={stagger} initial="hidden" animate="show">
            {groups.map((group) => {
              const isWhatsApp = group.platform === "whatsapp";
              const inviteLink = getInviteLink(group);
              const label = groupLabels[group.id] || group.name;
              const platformGradient = getPlatformGradient(group.platform);

              return (
                <motion.a
                  key={group.id}
                  variants={fadeUp}
                  href={inviteLink || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group relative flex items-center gap-4 p-4 sm:p-5 rounded-2xl border transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] overflow-hidden"
                  style={{
                    background: "rgba(255,255,255,0.025)",
                    borderColor: "rgba(255,255,255,0.06)",
                  }}
                  whileHover={{
                    borderColor: `hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.2)`,
                    boxShadow: `0 0 40px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.08)`,
                  }}
                >
                  {/* Hover glow effect */}
                  <div
                    className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                    style={{ background: `radial-gradient(circle at 50% 100%, hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.04), transparent 70%)` }}
                  />
                  <div
                    className="h-12 w-12 rounded-2xl flex items-center justify-center text-white shrink-0 shadow-lg relative z-10"
                    style={{ background: platformGradient }}
                  >
                    <ChannelPlatformIcon platform={isWhatsApp ? "whatsapp" : "telegram"} className="h-5 w-5" />
                  </div>

                  <div className="flex-1 min-w-0 relative z-10">
                    <p className="text-base font-bold truncate">{label}</p>
                    <p className="text-xs mt-1 flex items-center gap-1.5" style={{ color: "rgba(255,255,255,0.35)" }}>
                      <Users className="h-2.5 w-2.5" />
                      {(group.member_count || 0).toLocaleString("pt-BR")} membros
                    </p>
                  </div>

                  <div
                    className="relative z-10 px-6 py-2.5 rounded-xl text-sm font-bold shrink-0 flex items-center gap-1 transition-all duration-300 group-hover:gap-2"
                    style={{
                      background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 15) % 360},${hsl.s}%,${Math.min(hsl.l + 10, 85)}%,1))`,
                      color: textOnAccent,
                      boxShadow: `0 2px 20px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.3)`,
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
            <div className="text-center py-12 mt-4">
              <p className="text-sm" style={{ color: "rgba(255,255,255,0.25)" }}>Nenhum grupo disponível no momento.</p>
            </div>
          )}
        </div>
      </section>

      <section className="relative z-10 py-8" style={{ borderTop: "1px solid rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <motion.div
          className="ds-linkhub-section grid grid-cols-3 gap-4 text-center"
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
              <p className="text-2xs mt-1 uppercase tracking-[0.15em] font-medium" style={{ color: "rgba(255,255,255,0.3)" }}>{item.label}</p>
            </motion.div>
          ))}
        </motion.div>
      </section>

      <section className="relative z-10 py-10 sm:py-12">
        <div className="ds-linkhub-section">
          <motion.h2 className="text-xl font-black text-center tracking-tight mb-6" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>{benefitsTitle}</motion.h2>
          <motion.div className="grid grid-cols-2 gap-2.5" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.3 }}>
            {benefits.map((item) => (
              <motion.div
                key={item.text}
                variants={fadeUp}
                className="flex items-center gap-2.5 p-3.5 rounded-xl border backdrop-blur-sm"
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
              >
                <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.10)` }}>
                  <item.icon className="h-4 w-4" style={{ color: accent }} />
                </div>
                <p className="text-xs font-semibold" style={{ color: "rgba(255,255,255,0.7)" }}>{item.text}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      <section className="relative z-10 py-10 sm:py-12">
        <div className="ds-linkhub-section">
          <motion.h2 className="text-xl font-black text-center tracking-tight mb-6" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>{testimonialsTitle}</motion.h2>
          <motion.div className="space-y-3" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.3 }}>
            {activeTestimonials.map((item, idx) => (
              <motion.div
                key={idx}
                variants={fadeUp}
                className="relative p-4 rounded-xl border overflow-hidden"
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
              >
                {/* Accent left indicator */}
                <div className="absolute top-0 left-0 w-1 h-full rounded-r" style={{ background: accent, opacity: 0.5 }} />

                <div className="flex items-center gap-3 mb-2.5 pl-2">
                  <div
                    className="h-9 w-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{
                      background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 20) % 360},${hsl.s}%,${Math.min(hsl.l + 12, 85)}%,1))`,
                      color: textOnAccent,
                    }}
                  >
                    {item.name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-xs font-bold" style={{ color: "rgba(255,255,255,0.8)" }}>{item.name}</p>
                    <div className="flex gap-0.5 mt-0.5">
                      {[...Array(5)].map((_, index) => (
                        <Star key={index} className="h-2.5 w-2.5 fill-current text-yellow-400" />
                      ))}
                    </div>
                  </div>
                </div>
                <p className="text-xs leading-relaxed pl-14" style={{ color: "rgba(255,255,255,0.5)" }}>
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
          className="sticky bottom-0 z-50 p-4 pb-5 backdrop-blur-xl"
          style={{
            background: "linear-gradient(to top, rgba(8,8,12,0.98), rgba(8,8,12,0.75))",
            borderTop: "1px solid rgba(255,255,255,0.04)",
          }}
        >
          <div className="ds-linkhub-shell px-0">
            <a
              href={primaryInviteLink || undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2.5 w-full py-4 rounded-2xl text-sm font-bold transition-all duration-300 active:scale-[0.97]"
              style={{
                background: `linear-gradient(135deg, ${accent}, hsla(${(hsl.h + 15) % 360},${hsl.s}%,${Math.min(hsl.l + 10, 85)}%,1))`,
                color: textOnAccent,
                boxShadow: `0 4px 30px hsla(${hsl.h},${hsl.s}%,${hsl.l}%,0.35)`,
              }}
            >
              <ChannelPlatformIcon platform={primaryGroup?.platform === "whatsapp" ? "whatsapp" : "telegram"} className="h-4 w-4" />
              Entrar no Grupo
              <ChevronRight className="h-4 w-4" />
            </a>
          </div>
        </motion.div>
      )}

      <footer className="relative z-10 py-8 text-center" style={{ paddingBottom: groups.length > 0 ? "90px" : "32px" }}>
        <p className="text-2xs font-medium" style={{ color: "rgba(255,255,255,0.2)" }}>
          Powered by <span style={{ color: accent }}>AutoLinks!</span>
        </p>
      </footer>
    </div>
  );
}

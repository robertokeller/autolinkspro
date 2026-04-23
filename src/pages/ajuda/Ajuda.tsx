import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PageHeader } from "@/components/PageHeader";
import { WhatsAppIcon } from "@/components/icons/ChannelPlatformIcon";
import { cn } from "@/lib/utils";
import {
  BookOpen,
  Bot,
  HelpCircle,
  Link2,
  MessageCircle,
  Package,
  Rocket,
  Search,
  Send,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Wrench,
  X,
} from "lucide-react";
import { HELP_ARTICLES, HELP_CATEGORIES } from "./help-content";

type LucideIcon = ComponentType<{ className?: string }>;

const IconMap: Record<string, LucideIcon> = {
  Rocket,
  Link2,
  ShoppingCart,
  ShoppingBag,
  Bot,
  Wrench,
  Smartphone,
  Package,
  Send,
  MessageCircle,
};

const WHATSAPP_URL = "http://wa.me/5549998193237";

function openWhatsApp() {
  window.open(WHATSAPP_URL, "_blank", "noopener,noreferrer");
}

/** Remove acentos para busca tolerante (ex: "conexao" encontra "Conexões") */
function normalize(str: string) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export default function Ajuda() {
  const [searchTerm, setSearchTerm] = useState("");
  const term = normalize(searchTerm);

  const filteredCategories = useMemo(
    () =>
      HELP_CATEGORIES.map((category) => ({
        ...category,
        items: category.items.filter(
          (item) =>
            normalize(item.question).includes(term)
            || normalize(item.answer).includes(term),
        ),
      })).filter((category) => category.items.length > 0),
    [term],
  );

  const filteredArticles = useMemo(
    () =>
      term
        ? HELP_ARTICLES.filter(
            (article) =>
              normalize(article.title).includes(term)
              || normalize(article.summary).includes(term)
              || article.steps.some((step) => normalize(step).includes(term)),
          )
        : HELP_ARTICLES,
    [term],
  );

  const noResults = filteredCategories.length === 0 && filteredArticles.length === 0;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="ds-page animate-in fade-in duration-300">
        <PageHeader
          title="Ajuda"
          description="Encontre respostas, tutoriais e guias de uso do sistema."
        />

        <div className="relative mx-auto w-full max-w-3xl space-y-8 pb-24">
          <div className="relative">
            <Search
              className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="text"
              aria-label="Buscar na Central de Ajuda"
              placeholder="Buscar dúvidas e tutoriais... (ex: automação, conexão, shopee)"
              className="h-12 rounded-xl border-border/60 bg-muted/40 pl-11 pr-10 text-base shadow-none transition-colors focus-visible:bg-background"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
            {searchTerm && (
              <button
                type="button"
                aria-label="Limpar busca"
                onClick={() => setSearchTerm("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {noResults ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <div className="rounded-full bg-muted p-4">
                <HelpCircle className="h-8 w-8 text-muted-foreground" />
              </div>
              <p className="font-medium">Nenhum resultado para &ldquo;{searchTerm}&rdquo;</p>
              <p className="text-sm text-muted-foreground">
                Tente palavras diferentes ou fale com o suporte via WhatsApp.
              </p>
            </div>
          ) : (
            <div className="space-y-10">
              {filteredArticles.length > 0 && (
                <section>
                  <div className="mb-4 flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-primary" />
                    <h2 className="text-base font-semibold tracking-tight">Guias e tutoriais</h2>
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {filteredArticles.length}
                    </Badge>
                  </div>

                  <Accordion type="multiple" className="space-y-2">
                    {filteredArticles.map((article) => {
                      const Icon = IconMap[article.icon] ?? MessageCircle;
                      return (
                        <AccordionItem
                          key={article.id}
                          value={article.id}
                          className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-none data-[state=open]:border-primary/30 data-[state=open]:shadow-sm"
                        >
                          <AccordionTrigger className="px-4 py-3.5 hover:no-underline [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
                            <div className="flex items-center gap-3 text-left">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                <Icon className="h-4 w-4" />
                              </div>
                              <div>
                                <p className="font-medium leading-snug">{article.title}</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">{article.category}</p>
                              </div>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-4 pb-4">
                            <Separator className="mb-4" />
                            <p className="mb-4 text-sm text-muted-foreground">{article.summary}</p>
                            <ol className="space-y-2.5">
                              {article.steps.map((step, index) => (
                                <li key={index} className="flex gap-3 text-sm">
                                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                                    {index + 1}
                                  </span>
                                  <span className="leading-relaxed">{step}</span>
                                </li>
                              ))}
                            </ol>
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                  </Accordion>
                </section>
              )}

              {filteredCategories.length > 0 && (
                <section>
                  <div className="mb-4 flex items-center gap-2">
                    <MessageCircle className="h-4 w-4 text-primary" />
                    <h2 className="text-base font-semibold tracking-tight">Perguntas frequentes</h2>
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {filteredCategories.reduce((acc, category) => acc + category.items.length, 0)}
                    </Badge>
                  </div>

                  <div className="space-y-6">
                    {filteredCategories.map((category) => {
                      const Icon = IconMap[category.icon] ?? MessageCircle;
                      return (
                        <div key={category.id}>
                          <div className="mb-2 flex items-center gap-2 px-1">
                            <Icon className="h-3.5 w-3.5 text-primary/70" />
                            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              {category.title}
                            </span>
                          </div>

                          <Accordion type="multiple" className="space-y-2">
                            {category.items.map((item) => (
                              <AccordionItem
                                key={item.id}
                                value={item.id}
                                className="overflow-hidden rounded-xl border border-border/60 bg-card data-[state=open]:border-primary/30 data-[state=open]:shadow-sm"
                              >
                                <AccordionTrigger className="px-4 py-3.5 text-left font-medium hover:text-primary hover:no-underline [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
                                  {item.question}
                                </AccordionTrigger>
                                <AccordionContent className="px-4 pb-4">
                                  <Separator className="mb-3" />
                                  <p className="text-sm leading-relaxed text-muted-foreground">
                                    {item.answer}
                                  </p>
                                </AccordionContent>
                              </AccordionItem>
                            ))}
                          </Accordion>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Falar com suporte no WhatsApp"
            onClick={openWhatsApp}
            className={cn(
              "fixed bottom-6 right-6 z-50",
              "flex h-14 w-14 items-center justify-center",
              "rounded-full bg-[#25D366] text-white shadow-lg",
              "transition-all duration-200 hover:scale-110 hover:bg-[#1ebc59] hover:shadow-xl",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366] focus-visible:ring-offset-2",
            )}
          >
            <WhatsAppIcon className="h-7 w-7" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="font-medium">
          Falar com suporte no WhatsApp
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

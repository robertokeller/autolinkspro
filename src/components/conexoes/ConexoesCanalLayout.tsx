import type { ReactNode } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Props {
  title: string;
  description: string;
  headerActions: ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  sessionsContent: ReactNode;
  groupsContent: ReactNode;
  centered?: boolean;
}

export function ConexoesCanalLayout({
  title,
  description,
  headerActions,
  activeTab,
  onTabChange,
  sessionsContent,
  groupsContent,
  centered = false,
}: Props) {
  const contentMaxWidth = centered ? "max-w-4xl" : "max-w-5xl";

  return (
    <div className="ds-page">
      {centered ? (
        <header className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3 text-center">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">{headerActions}</div>
        </header>
      ) : (
        <div className="mx-auto w-full max-w-5xl">
          <PageHeader title={title} description={description}>
            {headerActions}
          </PageHeader>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <div className={`mx-auto w-full ${contentMaxWidth}`}>
          <TabsList className="mx-auto grid h-auto w-full max-w-xl grid-cols-2 gap-1 rounded-xl border bg-muted/40 p-1.5">
            <TabsTrigger
              value="sessions"
              className="h-11 rounded-lg text-base font-semibold data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              Sessões
            </TabsTrigger>
            <TabsTrigger
              value="groups"
              className="h-11 rounded-lg text-base font-semibold data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              Grupos
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sessions" className="mt-4">
            {sessionsContent}
          </TabsContent>

          <TabsContent value="groups" className="mt-4">
            {groupsContent}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { SHOPEE_CATEGORIES, type ShopeeCategory } from "@/lib/shopee-categories";
import { cn } from "@/lib/utils";

interface CategoryMultiSelectProps {
  value: string[];
  onChange: (categoryIds: string[]) => void;
  placeholder?: string;
  maxHeight?: string;
}

/** Build a flat label map for all categories + subcategories keyed by string ID */
function buildCategoryMap(): Map<string, { label: string; icon: string; parentLabel?: string }> {
  const map = new Map<string, { label: string; icon: string; parentLabel?: string }>();
  for (const cat of SHOPEE_CATEGORIES) {
    map.set(String(cat.id), { label: cat.label, icon: cat.icon });
    for (const sub of cat.subcategories) {
      map.set(String(sub.id), { label: sub.label, icon: cat.icon, parentLabel: cat.label });
    }
  }
  return map;
}

export function CategoryMultiSelect({
  value,
  onChange,
  placeholder = "Selecione categorias...",
  maxHeight = "max-h-72",
}: CategoryMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const categoryMap = useMemo(() => buildCategoryMap(), []);

  const handleToggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  const handleRemove = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(value.filter((v) => v !== id));
  };

  const toggleExpand = (catId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };

  const selectedCount = value.length;

  return (
    <div className="space-y-2">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between h-auto min-h-9 py-2">
            <span className="text-muted-foreground text-sm">
              {selectedCount > 0
                ? `${selectedCount} categoria(s) selecionada(s)`
                : placeholder}
            </span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent className="w-72 p-0" align="start" side="bottom">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Categorias Shopee
            </p>
            {selectedCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={(e) => { e.stopPropagation(); onChange([]); }}
              >
                Limpar
              </Button>
            )}
          </div>

          {/* Category list */}
          <div className={cn("overflow-y-auto", maxHeight)}>
            {SHOPEE_CATEGORIES.map((cat: ShopeeCategory) => {
              const catId = String(cat.id);
              const isChecked = value.includes(catId);
              const hasSubs = cat.subcategories.length > 0;
              const isExpanded = expandedIds.has(cat.id);
              // Check if any subcategory is selected
              const someSubChecked = cat.subcategories.some((s) => value.includes(String(s.id)));

              return (
                <div key={cat.id}>
                  {/* Parent category row */}
                  <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors">
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => handleToggle(catId)}
                      className="shrink-0"
                    />
                    <button
                      type="button"
                      className="flex items-center gap-2 flex-1 text-left min-w-0"
                      onClick={() => handleToggle(catId)}
                    >
                      <span className="text-base leading-none shrink-0">{cat.icon}</span>
                      <span className={cn("text-sm truncate flex-1", someSubChecked && !isChecked ? "text-primary/80" : "")}>
                        {cat.label}
                      </span>
                    </button>
                    {hasSubs && (
                      <button
                        type="button"
                        onClick={(e) => toggleExpand(cat.id, e)}
                        className="shrink-0 p-0.5 rounded hover:bg-accent"
                      >
                        <ChevronRight
                          className={cn(
                            "h-3.5 w-3.5 text-muted-foreground transition-transform",
                            isExpanded ? "rotate-90" : ""
                          )}
                        />
                      </button>
                    )}
                  </div>

                  {/* Subcategory rows (collapsible) */}
                  {hasSubs && isExpanded && (
                    <div className="ml-4 pl-2 border-l border-border/60">
                      {cat.subcategories.map((sub) => {
                        const subId = String(sub.id);
                        const isSubChecked = value.includes(subId);
                        return (
                          <div
                            key={sub.id}
                            className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors"
                          >
                            <Checkbox
                              checked={isSubChecked}
                              onCheckedChange={() => handleToggle(subId)}
                              className="shrink-0"
                            />
                            <button
                              type="button"
                              className="flex-1 text-left"
                              onClick={() => handleToggle(subId)}
                            >
                              <span className="text-xs text-muted-foreground">{sub.label}</span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Selected categories as removable badges */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {value.map((id) => {
            const info = categoryMap.get(id);
            if (!info) return null;
            return (
              <Badge key={id} variant="secondary" className="gap-1 pl-2 pr-1.5 text-xs">
                <span>{info.icon}</span>
                <span>{info.parentLabel ? `${info.parentLabel} › ${info.label}` : info.label}</span>
                <button
                  type="button"
                  className="ml-0.5 hover:opacity-70"
                  onClick={(e) => handleRemove(id, e)}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}


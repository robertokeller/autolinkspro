import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MultiOptionDropdownItem {
  id: string;
  label: string;
  meta?: string;
}

interface MultiOptionDropdownProps {
  value: string[];
  onChange: (ids: string[]) => void;
  items?: MultiOptionDropdownItem[];
  placeholder: string;
  selectedLabel: (count: number) => string;
  emptyMessage: string;
  title?: string;
  maxHeightClassName?: string;
}

export function MultiOptionDropdown({
  value,
  onChange,
  items = [],
  placeholder,
  selectedLabel,
  emptyMessage,
  title,
  maxHeightClassName = "max-h-[min(56dvh,16rem)]",
}: MultiOptionDropdownProps) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const selectedMap = useMemo(() => {
    return new Map(items.map((item) => [item.id, item] as const));
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!searchTerm) return items;
    return items.filter((item) =>
      item.label.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [items, searchTerm]);

  const toggle = (id: string) => {
    if (value.includes(id)) {
      onChange(value.filter((item) => item !== id));
      return;
    }
    onChange([...value, id]);
  };

  const selectedItems = value.map((id) => selectedMap.get(id)).filter(Boolean) as MultiOptionDropdownItem[];

  return (
    <div className="space-y-2">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="touch-target h-auto min-h-10 w-full justify-between py-2 max-sm:min-h-11">
            <span className="text-muted-foreground text-sm">
              {value.length > 0 ? selectedLabel(value.length) : placeholder}
            </span>
            <ChevronDown className="h-4 w-4 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-[min(var(--radix-dropdown-menu-trigger-width),calc(100vw-1rem))] max-h-[min(72dvh,30rem)] p-0" align="start" side="bottom">
          {title && (
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
              {value.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={(event) => {
                    event.stopPropagation();
                    onChange([]);
                  }}
                >
                  Limpar
                </Button>
              )}
            </div>
          )}

          {/* Search Input */}
          {items.length > 0 && (
            <div className="sticky top-0 z-10 border-b border-border/50 bg-popover p-2">
              <div className="relative flex items-center">
                <Search className="absolute left-3 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Pesquisar..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "h-9 rounded-md border-0 pl-9 pr-8 text-sm",
                    "bg-accent/50 placeholder:text-muted-foreground/60",
                    "focus:outline-none focus:ring-1 focus:ring-ring"
                  )}
                  autoFocus
                />
                {searchTerm && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSearchTerm("");
                    }}
                    className="absolute right-2 p-1 hover:bg-accent rounded transition-colors"
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>
                )}
              </div>
            </div>
          )}

          <div className={`overflow-y-auto p-2 space-y-1 ${maxHeightClassName}`}>
            {filteredItems.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {items.length === 0 ? emptyMessage : "Nenhum item encontrado"}
              </p>
            )}
            {filteredItems.map((item) => (
              <div key={item.id} className="flex w-full items-center gap-2 rounded-md px-2 py-2 hover:bg-accent">
                <Checkbox checked={value.includes(item.id)} onCheckedChange={() => toggle(item.id)} />
                <button type="button" className="text-sm truncate text-left flex-1" onClick={() => toggle(item.id)}>
                  {item.label}
                </button>
                {item.meta && <span className="text-2xs text-muted-foreground shrink-0">{item.meta}</span>}
              </div>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {selectedItems.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {selectedItems.map((item) => (
            <Badge key={item.id} variant="secondary" className="text-xs gap-1 pl-2 pr-1.5">
              <span>{item.label}</span>
              <button
                type="button"
                className="hover:opacity-70"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(item.id);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

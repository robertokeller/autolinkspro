import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown, X } from "lucide-react";

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
  maxHeightClassName = "max-h-56",
}: MultiOptionDropdownProps) {
  const [open, setOpen] = useState(false);

  const selectedMap = useMemo(() => {
    return new Map(items.map((item) => [item.id, item] as const));
  }, [items]);

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
          <Button type="button" variant="outline" className="w-full justify-between h-auto min-h-9 py-2">
            <span className="text-muted-foreground text-sm">
              {value.length > 0 ? selectedLabel(value.length) : placeholder}
            </span>
            <ChevronDown className="h-4 w-4 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)] p-0" align="start" side="bottom">
          {title && (
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
              {value.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
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
          <div className={`overflow-y-auto p-2 space-y-1 ${maxHeightClassName}`}>
            {items.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
            )}
            {items.map((item) => (
              <div key={item.id} className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
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

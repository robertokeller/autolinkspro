import { useState, useMemo } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface GroupOption {
  id: string;
  name: string;
  memberCount?: number;
}

interface GroupSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  groups: GroupOption[];
  placeholder?: string;
  emptyLabel?: string;
}

export function GroupSelect({
  value,
  onValueChange,
  groups,
  placeholder = "Escolha o grupo de origem...",
  emptyLabel = "Nenhum grupo disponível",
}: GroupSelectProps) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const filteredGroups = useMemo(() => {
    if (!searchTerm) return groups;
    return groups.filter((group) =>
      group.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [groups, searchTerm]);

  const selectedGroup = groups.find((g) => g.id === value);

  return (
    <div className="relative w-full">
      <Select value={value} open={open} onOpenChange={setOpen} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent className="p-0">
          {/* Search Input */}
          <div className="sticky top-0 z-10 border-b border-border/50 bg-popover p-2">
            <div className="relative flex items-center">
              <Search className="absolute left-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Pesquisar grupo..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "pl-9 pr-8 h-8 text-sm border-0 rounded-md",
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

          {/* Groups List */}
          <div className="max-h-72 overflow-y-auto">
            {filteredGroups.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-xs text-muted-foreground">
                  {groups.length === 0 ? emptyLabel : "Nenhum grupo encontrado"}
                </p>
              </div>
            ) : (
              filteredGroups.map((group) => (
                <SelectItem
                  key={group.id}
                  value={group.id}
                  className="cursor-pointer mx-1 my-0.5 rounded-md"
                  onSelect={() => {
                    setSearchTerm("");
                    setOpen(false);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{group.name}</span>
                    {group.memberCount !== undefined && (
                      <Badge variant="outline" className="text-2xs">
                        {group.memberCount} membros
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              ))
            )}
          </div>
        </SelectContent>
      </Select>
    </div>
  );
}

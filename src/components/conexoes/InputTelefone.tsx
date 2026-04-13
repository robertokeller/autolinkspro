import { Input } from "@/components/ui/input";
import { Check } from "lucide-react";
import { validatePhone } from "@/lib/phone-utils";
import { cn } from "@/lib/utils";

interface InputTelefoneProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export function InputTelefone({ value, onChange, placeholder = "+55 11 99999-9999" }: InputTelefoneProps) {
  const validation = value ? validatePhone(value) : null;
  return (
    <div className="space-y-1">
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          validation?.valid && "border-success focus-visible:ring-success",
          validation && !validation.valid && value.length > 3 && "border-destructive focus-visible:ring-destructive"
        )}
      />
      {validation?.valid && validation.wasAutoCorrected && (
        <p className="text-xs text-success flex items-center gap-1"><Check className="h-3 w-3" />Normalizado: {validation.formatted}</p>
      )}
      {validation?.valid && !validation.wasAutoCorrected && value.length > 3 && (
        <p className="text-xs text-success flex items-center gap-1"><Check className="h-3 w-3" />{validation.formatted}</p>
      )}
      {validation && !validation.valid && value.length > 3 && (
        <p className="text-xs text-destructive">{validation.error}</p>
      )}
    </div>
  );
}

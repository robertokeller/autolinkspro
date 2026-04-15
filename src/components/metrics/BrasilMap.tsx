// src/components/metrics/BrasilMap.tsx
// Pure-React SVG implementation — no runtime HTTP fetches.
// Data sourced from scripts/extract-brasil-svg.mjs (bundled at build time).

import { useState, useCallback, useMemo, useRef } from "react";
import { BRASIL_STATES, BRASIL_STATE_BY_IBGE } from "@/data/brasil-states";

export interface MapDataPoint {
  codIbge: number;
  fillColor: string;
  strokeColor?: string;
  strokeWidth?: number;
  count?: number;
  percentage?: number;
  /** UF abbreviation, e.g. "SP" */
  state?: string;
}

export interface BrasilMapProps {
  data: MapDataPoint[];
  height?: number;
  onClick?: (state: string, count: number, percentage: number) => void;
  /** Whether to show the built-in gradient legend below the map. Defaults to true. */
  showLegend?: boolean;
}

interface TooltipState {
  x: number;
  y: number;
  ibge: number;
}

/** Fallback ibge → UF lookup when MapDataPoint.state is absent */
const IBGE_TO_UF: Record<number, string> = {
  12: "AC", 27: "AL", 16: "AP", 13: "AM", 29: "BA", 23: "CE", 53: "DF",
  32: "ES", 52: "GO", 21: "MA", 51: "MT", 50: "MS", 31: "MG", 15: "PA",
  25: "PB", 41: "PR", 26: "PE", 22: "PI", 33: "RJ", 24: "RN", 43: "RS",
  11: "RO", 14: "RR", 42: "SC", 35: "SP", 28: "SE", 17: "TO",
};

export function BrasilMap({ data, height = 400, onClick, showLegend = true }: BrasilMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const dataByIbge = useMemo(() => {
    const m = new Map<number, MapDataPoint>();
    for (const d of data) m.set(d.codIbge, d);
    return m;
  }, [data]);

  const handleSvgMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setTooltip((prev) =>
        prev
          ? { ...prev, x: e.clientX - rect.left, y: e.clientY - rect.top }
          : prev,
      );
    },
    [],
  );

  const handlePathEnter = useCallback(
    (ibge: number, e: React.MouseEvent<SVGPathElement>) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setTooltip({
        ibge,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    [],
  );

  const handlePathClick = useCallback(
    (ibge: number) => {
      const dp = dataByIbge.get(ibge);
      const uf = dp?.state ?? IBGE_TO_UF[ibge] ?? "??";
      onClick?.(uf, dp?.count ?? 0, dp?.percentage ?? 0);
    },
    [dataByIbge, onClick],
  );

  const tooltipDp = tooltip ? dataByIbge.get(tooltip.ibge) : undefined;
  const tooltipUf =
    tooltipDp?.state ?? (tooltip ? (IBGE_TO_UF[tooltip.ibge] ?? "??") : "");
  const tooltipStateName =
    tooltip ? (BRASIL_STATE_BY_IBGE[tooltip.ibge]?.name ?? tooltipUf) : "";

  return (
    <div className="relative select-none">
      {/* Map canvas */}
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden"
        style={{ height: `${height}px` }}
      >
        <svg
          viewBox="0 0 800 691"
          width="100%"
          height="100%"
          aria-label="Mapa do Brasil — densidade de membros por estado"
          onMouseMove={handleSvgMouseMove}
          onMouseLeave={() => setTooltip(null)}
        >
          {BRASIL_STATES.map((stateInfo) => {
            const dp = dataByIbge.get(stateInfo.ibge);
            return (
              <path
                key={stateInfo.ibge}
                d={stateInfo.path}
                fill={dp?.fillColor ?? "#E5E7EB"}
                stroke={dp?.strokeColor ?? "#64748b"}
                strokeWidth={dp?.strokeWidth ?? 0.8}
                style={{ cursor: "pointer" }}
                opacity={
                  tooltip && tooltip.ibge !== stateInfo.ibge ? 0.85 : 1
                }
                onMouseEnter={(e) => handlePathEnter(stateInfo.ibge, e)}
                onClick={() => handlePathClick(stateInfo.ibge)}
              >
                <title>{stateInfo.name}</title>
              </path>
            );
          })}
        </svg>

        {/* Hover tooltip */}
        {tooltip && (
          <div
            className="pointer-events-none absolute z-20 max-w-[180px] rounded-md border bg-popover px-3 py-2 text-sm shadow-md"
            style={{
              left: Math.min(tooltip.x + 12, (containerRef.current?.offsetWidth ?? 400) - 196),
              top: tooltip.y - 10,
              transform: "translateY(-100%)",
            }}
          >
            <p className="font-semibold">
              {tooltipUf}
              {tooltipStateName && tooltipStateName !== tooltipUf
                ? ` — ${tooltipStateName.charAt(0) + tooltipStateName.slice(1).toLowerCase()}`
                : ""}
            </p>
            {(tooltipDp?.count ?? 0) > 0 ? (
              <p className="text-muted-foreground">
                {tooltipDp!.count} membros ({tooltipDp!.percentage}%)
              </p>
            ) : (
              <p className="text-muted-foreground">Sem dados</p>
            )}
          </div>
        )}
      </div>

      {/* Gradient legend (optional) */}
      {showLegend && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Menos</span>
          <div className="flex">
            <div className="h-3 w-6 bg-[#E5E7EB]" />
            <div className="h-3 w-6 bg-[#dbeafe]" />
            <div className="h-3 w-6 bg-[#93c5fd]" />
            <div className="h-3 w-6 bg-[#3b82f6]" />
            <div className="h-3 w-6 bg-[#1e3a8a]" />
          </div>
          <span>Mais</span>
        </div>
      )}
    </div>
  );
}

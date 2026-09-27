"use client";

/** Small shared UI pieces in the design's style. Screens should build from these. */

import { useId, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";

import { parseSim } from "@/lib/format";
import { CAUSE, C, ICON, LEVEL, type CauseKind, type Level } from "@/lib/theme";

/** A 24x24 stroke icon from a path string (see ICON / CAUSE in lib/theme). */
export function Icon({
  d,
  size = 22,
  color = "currentColor",
  width = 2,
  className,
  style,
}: {
  d: string;
  size?: number;
  color?: string;
  width?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <path d={d} />
    </svg>
  );
}

/** The BlindSpot mark: a ring with a yellow "spot" (flat colors). */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke={C.ink} strokeWidth="2.2" />
      <circle cx="15.5" cy="9.5" r="3.5" fill="#fbbc04" />
    </svg>
  );
}

/** The "BlindSpot" wordmark (Figtree 800). `pill`: on a floating white / grey pill over the map. */
export function Logo({ size = 18, pill = false }: { size?: number; pill?: boolean }) {
  const inner = (
    <>
      <LogoMark size={size + 6} />
      <span style={{ fontSize: size, fontWeight: 800, letterSpacing: "-0.02em" }}>BlindSpot</span>
    </>
  );
  if (!pill) return <div className="flex items-center gap-2 text-ink">{inner}</div>;
  return (
    <div className="flex h-9 items-center gap-2 rounded-[18px] bg-float pr-3.5 pl-2 text-ink shadow-e1">
      {inner}
    </div>
  );
}

/** A disc with the cause's icon in its color: white on the light theme, grey on the dark one (chips, rows). */
export function CauseDot({ kind, size = 24, ring }: { kind: CauseKind; size?: number; ring?: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: C.marker,
        boxShadow: ring ? `0 0 0 3px ${ring}` : `inset 0 0 0 1px ${C.line}`,
      }}
    >
      <Icon d={CAUSE[kind].icon} size={Math.round(size * 0.54)} color={CAUSE[kind].color} width={2.4} />
    </span>
  );
}

/** Rounded outlined chip with a cause dot: "(o) Rush hour" (light blue when active) */
export function CauseChip({ kind, label, count, onClick, active }: { kind: CauseKind; label?: string; count?: number; onClick?: () => void; active?: boolean }) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-pressed={onClick ? !!active : undefined}
      className={`flex h-[34px] shrink-0 items-center gap-1.5 rounded-[17px] pr-3 pl-1.5 text-[13px] font-medium whitespace-nowrap ${onClick ? "cursor-pointer" : ""}`}
      style={
        active
          ? { background: C.sel, color: C.onSel, border: `1px solid ${C.sel}` }
          : { background: "transparent", color: C.ink, border: `1px solid ${C.edge}` }
      }
    >
      <CauseDot kind={kind} />
      {label ?? CAUSE[kind].label}
      {count !== undefined && <span className="font-num text-[12px] text-muted">{count}</span>}
    </Tag>
  );
}

/** Style of a selectable chip: light blue when selected (like Google's filter chips), outlined otherwise. */
export function chipStyle(selected: boolean): CSSProperties {
  return selected
    ? { background: C.sel, color: C.onSel, border: `1px solid ${C.sel}` }
    : { background: "transparent", color: C.ink, border: `1px solid ${C.edgeStrong}` };
}

/** Filter pill (Alerts, Live cams). */
export function FilterChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className="h-9 shrink-0 cursor-pointer rounded-[18px] px-3.5 text-[14px] font-medium whitespace-nowrap"
      style={chipStyle(selected)}
    >
      {label}
    </button>
  );
}

/** "Heavy traffic" pill. */
export function LevelPill({ level, text }: { level: Level; text?: string }) {
  const lv = LEVEL[level];
  return (
    <span className="rounded-[10px] px-2.5 py-[3px] text-[12px] font-semibold whitespace-nowrap" style={{ background: lv.bg, color: lv.fg }}>
      {text ?? `${lv.label} traffic`}
    </span>
  );
}

export function LevelDot({ level, size = 8 }: { level: Level; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: LEVEL[level].color }} />;
}

/** Big rounded primary button (accent), or outlined when `variant="outline"`. */
export function PillButton({
  children,
  variant = "primary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "outline" | "ghost" }) {
  const style: CSSProperties =
    variant === "primary"
      ? { background: C.accent, color: C.onAccent, border: 0 }
      : variant === "outline"
        ? { background: "transparent", color: C.accent, border: `1px solid ${C.edgeStrong}` }
        : { background: "transparent", color: C.ink, border: `1px solid ${C.edgeStrong}` };
  return (
    <button
      type="button"
      {...rest}
      className={`flex h-[52px] cursor-pointer items-center justify-center gap-2 rounded-[26px] px-5 text-[16px] font-semibold disabled:cursor-default disabled:opacity-50 ${className}`}
      style={{ ...style, ...rest.style }}
    >
      {children}
    </button>
  );
}

/** "‹  Selected road" header row used by sub-screens. */
export function BackHeader({ onBack, label, right }: { onBack: () => void; label?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="-ml-2.5 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-ink hover:bg-card"
      >
        <Icon d={ICON.back} />
      </button>
      {label && <span className="text-[14px] text-muted">{label}</span>}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

/** Card section (outlined, like Google's cards): 16px padding, 16px radius. */
export function Card({ children, className = "", style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <section className={`flex flex-col gap-2.5 rounded-[16px] border border-line bg-bg p-4 ${className}`} style={style}>
      {children}
    </section>
  );
}

/** Round floating map control (48px), like the layers button. */
export function RoundButton({ children, label, onClick, active }: { children: ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink shadow-e1"
      style={{ background: active ? C.sel : C.float, color: active ? C.onSel : C.ink }}
    >
      {children}
    </button>
  );
}

/** Screen title (28px bold) */
export function Title({ children }: { children: ReactNode }) {
  return <h1 className="m-0 text-[28px] leading-[1.1] font-extrabold tracking-[-0.02em]">{children}</h1>;
}

/** Relative "N min ago" in simulated time. */
export function ago(iso: string | null | undefined, now: string | null | undefined): string {
  if (!iso || !now) return "";
  const m = Math.round((parseSim(now).getTime() - parseSim(iso).getTime()) / 60000);
  if (m <= 0) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ago`;
}

/** A small ⓘ button; the note behind it shows only when tapped, so fine print stays out of the way. */
export function InfoToggle({ children, label = "About this" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={open ? `Hide: ${label}` : label}
        title={label}
        className="-m-1.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0"
      >
        <Icon d={ICON.info} size={17} color={open ? C.ink : C.muted} />
      </button>
      {open && (
        <p id={id} className="m-0 text-[12px] leading-snug text-muted">
          {children}
        </p>
      )}
    </div>
  );
}

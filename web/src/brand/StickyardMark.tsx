import { useId, type CSSProperties, type ReactNode } from "react";
import { cn } from "../lib/utils";

/*
 * The Stickyard mark for the welcome screen: four overlapping sticky notes and three
 * collaborators' cursors, adapted from the logo artwork (mark only: no background, grid, glows,
 * badge or baked-in text). Decorative: the whole SVG is aria-hidden, and the wordmark next to it
 * is live text. Colours are var(--sy-brand-*) tokens (styles/tokens.css); gradient and filter
 * ids are unique per instance (useId), so two marks on a page never collide. It scales with its
 * container. The cursors drift slowly in CSS (.sy-mark-drift in index.css), not under reduced motion.
 */

const brand = (name: string) => `var(--sy-brand-${name})`;
const fill = (name: string): CSSProperties => ({ fill: brand(name) });

type Hue = "amber" | "coral" | "cyan" | "emerald";
const HUES: readonly Hue[] = ["amber", "coral", "cyan", "emerald"];

/** One note: a rounded square in its hue's gradient, a folded corner and some content lines. */
function Note({ at, rotate, size, hue, ids, children }: { at: [number, number]; rotate: number; size: number; hue: Hue; ids: Ids; children: ReactNode }) {
  const f = size - 20;
  return (
    <g data-mark-note transform={`translate(${at[0]} ${at[1]}) rotate(${rotate})`}>
      <rect width={size} height={size} rx={size > 120 ? 14 : 12} fill={`url(#${ids.gradient(hue)})`} />
      <path d={`M ${f} ${size} L ${size} ${f} L ${f + 12} ${f} C ${f + 4.5} ${f} ${f} ${f + 3.5} ${f} ${f + 8} Z`} style={{ ...fill(`${hue}-fold`), opacity: 0.6 }} />
      {children}
    </g>
  );
}

function Line({ x1, x2, y, width = 4, colour = "ink", opacity = 0.7 }: { x1: number; x2: number; y: number; width?: number; colour?: string; opacity?: number }) {
  return <line x1={x1} y1={y} x2={x2} y2={y} strokeWidth={width} strokeLinecap="round" style={{ stroke: brand(colour), opacity }} />;
}

function Dot({ cx, cy, r, opacity }: { cx: number; cy: number; r: number; opacity: number }) {
  return <circle cx={cx} cy={cy} r={r} style={{ ...fill("ink"), opacity }} />;
}

/** A collaborator's pointer with a name tag. The outer group places it; the inner one drifts. */
function Cursor({ at, name, width, hue, phase, ids }: { at: [number, number]; name: string; width: number; hue: Hue; phase: number; ids: Ids }) {
  return (
    <g transform={`translate(${at[0]} ${at[1]})`}>
      <g
        data-mark-cursor
        className="sy-mark-drift"
        filter={`url(#${ids.cursorShadow})`}
        // Out of step with each other: each starts part-way through the drift.
        style={{ animationDelay: `calc(var(--sy-brand-drift-duration) * ${-phase})` }}
      >
        <path
          d="M 0 0 L 0 22 L 6 16 L 12 26 L 16 24 L 10 14 L 18 14 Z"
          strokeWidth="2"
          strokeLinejoin="round"
          style={{ fill: brand(`${hue}-tag`), stroke: brand("ink") }}
        />
        <rect x="14" y="20" width={width} height="20" rx="6" style={fill(`${hue}-tag`)} />
        <text x={14 + width / 2} y="34" fontSize="11" fontWeight="700" textAnchor="middle" style={{ ...fill("ink"), fontFamily: "inherit" }}>
          {name}
        </text>
      </g>
    </g>
  );
}

interface Ids {
  gradient(hue: Hue): string;
  noteShadow: string;
  cursorShadow: string;
}

export function StickyardMark({ className }: { className?: string }) {
  // React's ids contain characters that are awkward in url(#...); keep letters, digits, - and _.
  const base = `sy-mark-${useId().replace(/[^\w-]/g, "")}`;
  const ids: Ids = {
    gradient: (hue) => `${base}-${hue}`,
    noteShadow: `${base}-note-shadow`,
    cursorShadow: `${base}-cursor-shadow`,
  };

  return (
    <svg
      data-stickyard-mark
      viewBox="236 84 340 286"
      aria-hidden="true"
      focusable="false"
      className={cn("block h-auto max-w-full", className)}
    >
      <defs>
        {HUES.map((hue) => (
          <linearGradient key={hue} id={ids.gradient(hue)} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style={{ stopColor: brand(`${hue}-from`) }} />
            <stop offset="100%" style={{ stopColor: brand(`${hue}-to`) }} />
          </linearGradient>
        ))}
        <filter id={ids.noteShadow} x="-20%" y="-20%" width="150%" height="150%">
          <feDropShadow dx="0" dy="8" stdDeviation="8" style={{ floodColor: brand("shadow") }} />
          <feDropShadow dx="0" dy="3" stdDeviation="3" style={{ floodColor: brand("shadow") }} />
        </filter>
        <filter id={ids.cursorShadow} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="1" dy="3" stdDeviation="2" style={{ floodColor: brand("shadow-strong") }} />
        </filter>
      </defs>

      <g transform="translate(0 -10)">
        <g filter={`url(#${ids.noteShadow})`}>
          <Note at={[425, 125]} rotate={8} size={105} hue="cyan" ids={ids}>
            <Line x1={20} x2={70} y={30} />
            <Line x1={20} x2={55} y={48} />
          </Note>
          <Note at={[270, 215]} rotate={-10} size={100} hue="emerald" ids={ids}>
            <Dot cx={28} cy={32} r={5} opacity={0.8} />
            <Line x1={42} x2={75} y={32} opacity={0.8} />
            <Dot cx={28} cy={52} r={5} opacity={0.8} />
            <Line x1={42} x2={65} y={52} opacity={0.8} />
          </Note>
          <Note at={[395, 225]} rotate={4} size={110} hue="coral" ids={ids}>
            <Dot cx={30} cy={35} r={8} opacity={0.9} />
            <Dot cx={52} cy={35} r={8} opacity={0.9} />
            <Line x1={22} x2={85} y={65} />
            <Line x1={22} x2={60} y={80} />
          </Note>
          <Note at={[315, 130]} rotate={-4} size={125} hue="amber" ids={ids}>
            <rect x="20" y="22" width="35" height="8" rx="4" style={{ ...fill("amber-line"), opacity: 0.4 }} />
            <Line x1={20} x2={95} y={48} width={5} colour="amber-line" opacity={0.6} />
            <Line x1={20} x2={80} y={68} width={5} colour="amber-line" opacity={0.6} />
            <Line x1={20} x2={60} y={88} width={5} colour="amber-line" opacity={0.6} />
          </Note>
        </g>

        <Cursor at={[485, 110]} name="Alex" width={42} hue="cyan" phase={0} ids={ids} />
        <Cursor at={[260, 280]} name="Sam" width={38} hue="coral" phase={0.4} ids={ids} />
        <Cursor at={[490, 290]} name="Priya" width={44} hue="emerald" phase={0.75} ids={ids} />
      </g>
    </svg>
  );
}

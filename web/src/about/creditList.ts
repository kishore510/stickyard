/*
 * The packages called out by name in About > Credits, with what each one does here.
 * Version and licence are read from each package at build time (vite.config.ts).
 * Plain data, imported by vite.config.ts too, so it must not import app code.
 */
export const CREDIT_LIST = [
  { name: "react", title: "React", role: "The user interface." },
  { name: "@xyflow/react", title: "React Flow", role: "The board canvas: panning, zooming, dragging and the overview map." },
  { name: "zustand", title: "Zustand", role: "App state." },
  { name: "zod", title: "Zod", role: "Checks every message to and from the relay." },
  { name: "tailwindcss", title: "Tailwind CSS", role: "Styling, built on the design tokens." },
  { name: "vite", title: "Vite", role: "Builds and bundles the app." },
  { name: "@fontsource-variable/inter", title: "Inter", role: "The typeface, bundled with the app." },
  { name: "lucide-react", title: "Lucide", role: "The icons." },
  { name: "class-variance-authority", title: "class-variance-authority", role: "Button and component variants (shadcn/ui style)." },
  { name: "tailwind-merge", title: "tailwind-merge", role: "Combines component styles without conflicts." },
  { name: "clsx", title: "clsx", role: "Builds class names." },
  { name: "html-to-image", title: "html-to-image", role: "Draws the board for Export PNG, in your browser (loaded only when you export)." },
] as const;

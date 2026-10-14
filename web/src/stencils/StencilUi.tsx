import { useEffect, useId, useState } from "react";
import { Pencil, Shapes, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Sheet } from "../shell/Sheet";
import { STENCIL_LIMITS } from "./data";
import { STENCIL_TEXT } from "./rules";
import { useStencils } from "./stencilStore";

/*
 * The Stencils tab's own parts (v0.39.0, md and up): what storage allows (blocked, entries that
 * couldn't be read), the saved stencils with Rename and Delete, and Delete all; and the Save as
 * stencil dialog. Names are only ever text.
 */

/** Under the stencil tiles: storage state and managing the saved ones. */
export function StencilManager() {
  const { loaded, rename, remove, removeAll } = useStencils();
  // Read again each time the tab opens: another tab of this browser may have saved or deleted some.
  useEffect(() => useStencils.getState().reload(), []);
  const [error, setError] = useState<string | null>(null);
  const run = (result: { ok: boolean; reason?: string }) => setError(result.ok ? null : (result.reason ?? null));
  return (
    <section data-stencil-manager="" aria-label="Saved stencils" className="flex flex-col gap-sm border-t border-border pt-md">
      {loaded.blocked && (
        <p data-stencil-blocked="" role="status" className="rounded-md bg-surface-muted p-ms text-sm">
          {STENCIL_TEXT.blocked}
        </p>
      )}
      {loaded.malformed > 0 && (
        <p data-stencil-malformed="" role="status" className="text-sm text-status-warn">
          {STENCIL_TEXT.malformed(loaded.malformed)}
        </p>
      )}
      {!loaded.blocked && loaded.stencils.length === 0 && <p className="text-sm text-fg-muted">{STENCIL_TEXT.none}</p>}
      {loaded.stencils.length > 0 && (
        <ul className="flex flex-col gap-2xs">
          {loaded.stencils.map((s) => (
            <li key={s.id} className="flex min-w-0 items-center gap-2xs">
              <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Rename ${s.name}`}
                title="Rename"
                onClick={() => {
                  const name = window.prompt(STENCIL_TEXT.renamePrompt, s.name);
                  if (name !== null) run(rename(s.id, name));
                }}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${s.name}`}
                title="Delete"
                className="text-status-error"
                onClick={() => {
                  if (window.confirm(STENCIL_TEXT.deleteConfirm(s.name))) run(remove(s.id));
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {loaded.stencils.length > 0 && (
        <Button
          variant="ghost"
          aria-label="Delete all saved stencils"
          className="self-start text-status-error"
          onClick={() => {
            if (window.confirm(STENCIL_TEXT.deleteAllConfirm)) run(removeAll());
          }}
        >
          <Trash2 />
          Delete all
        </Button>
      )}
      <p className="text-xs text-fg-muted">
        Up to {STENCIL_LIMITS.count} stencils, saved in this browser only. Nothing is sent until you place one.
      </p>
      {error && (
        <p role="status" className="text-sm text-status-warn">
          {error}
        </p>
      )}
    </section>
  );
}

/** Save as stencil: a name, what's kept and where, Save. `save` builds and stores it (null: saved; else the reason). */
export function StencilSaveDialog({ save }: { save: (name: string) => string | null }) {
  const open = useStencils((s) => s.saveOpen);
  const setOpen = useStencils((s) => s.setSaveOpen);
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;
  const close = () => {
    setOpen(false);
    setName("");
    setError(null);
  };
  return (
    <Sheet title="Save as stencil" icon={<Shapes />} page="stencil-save" onClose={close}>
      <form
        data-stencil-save=""
        className="flex flex-col gap-md pb-md"
        onSubmit={(e) => {
          e.preventDefault();
          const reason = save(name);
          if (reason === null) close();
          else setError(reason);
        }}
      >
        <p className="text-sm">{STENCIL_TEXT.saveNote}</p>
        <div className="flex flex-col gap-xs">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} value={name} maxLength={STENCIL_LIMITS.name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          <p className="text-xs text-fg-muted">Up to {STENCIL_LIMITS.name} characters.</p>
        </div>
        {error && (
          <p role="status" className="text-sm text-status-warn">
            {error}
          </p>
        )}
        <div className="flex gap-sm">
          <Button type="submit" variant="primary">
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

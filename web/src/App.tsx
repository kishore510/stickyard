import { useHashRoute } from "./router";
import { ConnectionCheckScreen } from "./screens/ConnectionCheckScreen";
import { SheetHost } from "./shell/SheetHost";
import { Shell } from "./shell/Shell";

export function App() {
  const route = useHashRoute();

  if (route.name === "not-found") {
    return (
      <Shell>
        <div className="mx-auto flex w-full max-w-content flex-1 flex-col justify-center gap-md py-lg">
          <h1 className="text-2xl font-semibold">Page not found</h1>
          <p>
            <a href="#/" className="inline-flex min-h-touch items-center font-medium text-accent underline">
              Go to the start page
            </a>
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <ConnectionCheckScreen />
      {route.sheet && <SheetHost sheet={route.sheet} />}
    </Shell>
  );
}

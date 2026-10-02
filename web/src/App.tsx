import { useHashRoute } from "./router";
import { ConnectionCheckScreen } from "./screens/ConnectionCheckScreen";

export function App() {
  const route = useHashRoute();

  switch (route.name) {
    case "home":
      return <ConnectionCheckScreen />;
    case "not-found":
      return (
        <main className="mx-auto flex min-h-(--sy-viewport-h) max-w-content flex-col justify-center gap-md p-md">
          <h1 className="text-xl font-bold">Page not found</h1>
          <p>
            <a href="#/" className="inline-flex min-h-touch items-center text-accent underline">
              Go to the start page
            </a>
          </p>
        </main>
      );
  }
}

import DemoApp from "./DemoApp.jsx";
import SiteShell from "./site/SiteShell.jsx";
import PricingPage from "./site/PricingPage.jsx";

function getRouteMode() {
  if (typeof window === "undefined") return "home";
  const url = new URL(window.location.href);
  if (window.location.pathname === "/pricing") return "pricing";
  if (url.searchParams.get("demo") === "1" || url.hash === "#demo" || window.location.pathname === "/demo") return "demo";
  return "home";
}

export default function App() {
  const mode = getRouteMode();
  if (mode === "demo") return <DemoApp />;
  if (mode === "pricing") return <PricingPage />;
  return <SiteShell />;
}

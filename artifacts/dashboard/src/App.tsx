import { Switch, Route, Router as WouterRouter } from "wouter";
import { useState, useEffect } from "react";
import WebDashboard, { SubAdminLoginPage } from "@/pages/WebDashboard";
import MainAdminPanel, { MasterLoginPage } from "@/pages/MainAdminPanel";
import { TopProgressBar } from "@/components/ui/top-progress";

function NotFound() {
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", color: "#f1f5f9", fontFamily: "system-ui" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 48, fontWeight: 900, color: "#6366f1" }}>404</div>
        <div style={{ fontSize: 14, color: "#94a3b8", marginTop: 8 }}>Page not found</div>
      </div>
    </div>
  );
}

// Route strings are never stored — only their SHA-256 hashes
async function _h(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function SecretGateway() {
  const [view, setView] = useState<"loading" | "main" | "access" | "404">("loading");
  useEffect(() => {
    // Strip BASE_URL prefix so hashes match regardless of deployment base path
    const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
    const full = window.location.pathname;
    const p = base && full.startsWith(base) ? full.slice(base.length) || "/" : full;
    _h(p).then(h => {
      if (h === "939f7cec75dba1897bb7394fb92c93e650f84319ab6407cceb576126233aa3c9") setView("main");
      else if (h === "dc80d02df4953447479fc133d0b95389d6222ac8fdecd8781df7851a752a81ff") setView("access");
      else setView("404");
    });
  }, []);
  if (view === "loading") return null;
  if (view === "main") return <MainAdminPanel />;
  if (view === "access") return <MasterLoginPage />;
  return <NotFound />;
}

function Router() {
  return (
    <Switch>
      <Route path="/preview/dashboard/WebDashboard" component={SubAdminLoginPage} />
      <Route path="/sigma/:appId" component={WebDashboard} />
      <Route path="/login/:appId" component={SubAdminLoginPage} />
      <Route path="/login" component={SubAdminLoginPage} />
      <Route component={SecretGateway} />
    </Switch>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <TopProgressBar />
      <Router />
    </WouterRouter>
  );
}

export default App;

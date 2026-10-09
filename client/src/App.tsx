import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import { TickerProvider } from "@/components/TickerContext";
import { ThemeProvider } from "@/components/ThemeContext";
import PreMarketGate from "@/components/PreMarketGate";
import ConnectionGate from "@/components/ConnectionGate";
import { useState } from "react";
import { premarketGateEnabled } from "@/lib/prefs";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  // No launch splash: the dashboard opens straight away. The pre-market
  // checklist is a personal opt-in (Settings), off by default, and never
  // required to reach the app.
  const [showPremarket, setShowPremarket] = useState(premarketGateEnabled);
  const gateActive = showPremarket;

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
      <TooltipProvider>
        <Toaster />
        <ConnectionGate />
        <TickerProvider>
          {showPremarket && (
            <PreMarketGate onAcknowledge={() => setShowPremarket(false)} />
          )}
          <div
            className={
              gateActive
                ? "opacity-0 pointer-events-none"
                : "opacity-100 transition-opacity duration-700"
            }
          >
            <Router hook={useHashLocation}>
              <AppRouter />
            </Router>
          </div>
        </TickerProvider>
      </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;

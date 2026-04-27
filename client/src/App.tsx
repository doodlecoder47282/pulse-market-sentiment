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
import LaunchSplash from "@/components/LaunchSplash";
import PreMarketGate from "@/components/PreMarketGate";
import { useState } from "react";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [showPremarket, setShowPremarket] = useState(true);
  const gateActive = showSplash || showPremarket;

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
      <TooltipProvider>
        <Toaster />
        <TickerProvider>
          {showSplash && <LaunchSplash onExit={() => setShowSplash(false)} />}
          {!showSplash && showPremarket && (
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

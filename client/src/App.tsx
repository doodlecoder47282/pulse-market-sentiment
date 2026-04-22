import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import { TickerProvider } from "@/components/TickerContext";
import LaunchSplash from "@/components/LaunchSplash";
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

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <TickerProvider>
          {showSplash && <LaunchSplash onExit={() => setShowSplash(false)} />}
          <div
            className={
              showSplash
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
    </QueryClientProvider>
  );
}

export default App;

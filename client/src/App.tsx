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
import { useState, lazy, Suspense } from "react";

// LaunchSplash is the only framer-motion consumer (~4MB on disk → big gzip).
// Lazy-load it so framer-motion lands in its own chunk instead of the
// critical-path entry bundle — the dashboard no longer waits on the animation
// lib to download. The fallback is a plain black fill matching the splash's
// own #000 background, so there is no visible flash before the chunk arrives.
const LaunchSplash = lazy(() => import("@/components/LaunchSplash"));

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
          {showSplash && (
            <Suspense fallback={<div className="fixed inset-0 z-[9999] bg-black" />}>
              <LaunchSplash onExit={() => setShowSplash(false)} />
            </Suspense>
          )}
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

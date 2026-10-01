import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { TickerProvider } from "@/components/TickerContext";
import { ThemeProvider } from "@/components/ThemeContext";
import PreMarketGate from "@/components/PreMarketGate";
import { useState, lazy, Suspense } from "react";
import { StartupBoundary, StartupRecovery } from "@/components/StartupBoundary";

// LaunchSplash is the only framer-motion consumer (~4MB on disk → big gzip).
// Lazy-load it so framer-motion lands in its own chunk instead of the
// critical-path entry bundle. Animation failures never block the terminal.
const LaunchSplash = lazy(() => import("@/components/LaunchSplash"));
const Dashboard = lazy(() => import("@/pages/dashboard"));

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
  const skipSplash = () => setShowSplash(false);
  const animationRecovery = (
    <StartupRecovery
      title="Your terminal is ready to open"
      detail="The optional launch animation is loading or unavailable. Continue without it to read your pre-market checklist."
      code="BC-INTRO"
      action={skipSplash}
      actionLabel="Continue without animation"
    />
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
      <TooltipProvider>
        <Toaster />
        <TickerProvider>
          {showSplash && (
            <StartupBoundary fallback={animationRecovery}>
              <Suspense fallback={animationRecovery}>
                <LaunchSplash onExit={skipSplash} />
              </Suspense>
              <button
                type="button"
                onClick={skipSplash}
                data-testid="button-skip-intro"
                className="fixed right-4 top-4 z-[10001] min-h-11 rounded-lg border border-white/25 bg-black/80 px-4 py-2 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-yellow-400"
              >
                Skip animation
              </button>
            </StartupBoundary>
          )}
          {!showSplash && showPremarket && (
            <PreMarketGate onAcknowledge={() => setShowPremarket(false)} />
          )}
          {!showSplash && !showPremarket && (
            <Suspense fallback={<StartupRecovery code="BC-DASHBOARD" />}>
              <Router hook={useHashLocation}>
                <AppRouter />
              </Router>
            </Suspense>
          )}
        </TickerProvider>
      </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;

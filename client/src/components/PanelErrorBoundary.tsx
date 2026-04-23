/**
 * PanelErrorBoundary.tsx
 * Re-export of ErrorBoundary with panel-specific defaults.
 * Use this to wrap individual dashboard panels so one failure
 * doesn't white-screen the entire app.
 *
 * Usage:
 *   <PanelErrorBoundary label="Flow Alerts">
 *     <FlowAlertsPanel />
 *   </PanelErrorBoundary>
 */
export { default as PanelErrorBoundary } from "@/components/ErrorBoundary";
export { default } from "@/components/ErrorBoundary";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ClvPanel from "./edgelab/ClvPanel";
import IvRvPanel from "./edgelab/IvRvPanel";
import GammaCurvePanel from "./edgelab/GammaCurvePanel";
import CrossAssetPanel from "./edgelab/CrossAssetPanel";
import SkewPanel from "./edgelab/SkewPanel";
import MacroFlowPanel from "./edgelab/MacroFlowPanel";
import AnomalyPanel from "./edgelab/AnomalyPanel";
import BacktestPanel from "./edgelab/BacktestPanel";

export default function EdgeLabPanel() {
  const [sub, setSub] = useState("clv");
  return (
    <div className="space-y-3" data-testid="edge-lab-panel">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold tracking-tight">Edge Lab</CardTitle>
          <p className="text-xs text-muted-foreground leading-snug">
            measure edge, price options vs realized, see dealer walls and vacuum, watch macro/cot flow,
            flag anomaly days, and backtest signals before sizing
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          <Tabs value={sub} onValueChange={setSub}>
            <TabsList className="flex flex-wrap gap-1 bg-transparent p-0 h-auto">
              <TabsTrigger value="clv" data-testid="edgelab-tab-clv" className="text-xs">CLV</TabsTrigger>
              <TabsTrigger value="ivrv" data-testid="edgelab-tab-ivrv" className="text-xs">IV/RV</TabsTrigger>
              <TabsTrigger value="gamma" data-testid="edgelab-tab-gamma" className="text-xs">Gamma Curve</TabsTrigger>
              <TabsTrigger value="cross" data-testid="edgelab-tab-cross" className="text-xs">Cross-Asset</TabsTrigger>
              <TabsTrigger value="skew" data-testid="edgelab-tab-skew" className="text-xs">Skew</TabsTrigger>
              <TabsTrigger value="macro" data-testid="edgelab-tab-macro" className="text-xs">Macro/COT</TabsTrigger>
              <TabsTrigger value="anomaly" data-testid="edgelab-tab-anomaly" className="text-xs">Anomaly</TabsTrigger>
              <TabsTrigger value="backtest" data-testid="edgelab-tab-backtest" className="text-xs">Backtest</TabsTrigger>
            </TabsList>
            <TabsContent value="clv" className="mt-3"><ClvPanel /></TabsContent>
            <TabsContent value="ivrv" className="mt-3"><IvRvPanel /></TabsContent>
            <TabsContent value="gamma" className="mt-3"><GammaCurvePanel /></TabsContent>
            <TabsContent value="cross" className="mt-3"><CrossAssetPanel /></TabsContent>
            <TabsContent value="skew" className="mt-3"><SkewPanel /></TabsContent>
            <TabsContent value="macro" className="mt-3"><MacroFlowPanel /></TabsContent>
            <TabsContent value="anomaly" className="mt-3"><AnomalyPanel /></TabsContent>
            <TabsContent value="backtest" className="mt-3"><BacktestPanel /></TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

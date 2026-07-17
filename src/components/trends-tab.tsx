'use client';

export function TrendsTab() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center space-y-2">
        <div className="size-12 mx-auto rounded-xl bg-primary/10 flex items-center justify-center">
          <div className="size-5 rounded-full bg-primary/30 animate-pulse" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">趋势 — 多周期估值与历史回溯</p>
        <p className="text-xs text-muted-foreground/60">内容即将加载...</p>
      </div>
    </div>
  );
}
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fenToYuan } from "@/lib/types";
import type { CashAccountType } from "@/lib/types";

export const runtime = "nodejs";

// ─── GET: List all cash subaccounts with balances & flow totals ─

export async function GET() {
  try {
    const accounts = await db.cashSubaccount.findMany({
      orderBy: { accountType: "asc" },
    });

    // Aggregate inflows and outflows per account type from cash_ledger
    const ledgerEntries = await db.cashLedger.findMany({
      where: { status: "active" },
    });

    // Build a map of accountType → { totalInflow, totalOutflow }
    const flowMap = new Map<
      CashAccountType,
      { totalInflowFen: number; totalOutflowFen: number }
    >();

    // Initialize for all account types
    const allTypes: CashAccountType[] = [
      "daily_cash",
      "weekly_unallocated_cash",
      "rebalance_equity_reserve",
      "qdii_pending_cash_sp500",
      "qdii_pending_cash_nasdaq",
      "manual_cash",
      "weekly_contribution_committed",
    ];
    for (const t of allTypes) {
      flowMap.set(t, { totalInflowFen: 0, totalOutflowFen: 0 });
    }

    for (const entry of ledgerEntries) {
      // Credit account receives money (inflow)
      const creditFlows = flowMap.get(entry.creditAccount);
      if (creditFlows) creditFlows.totalInflowFen += entry.amountFen;

      // Debit account loses money (outflow)
      const debitFlows = flowMap.get(entry.debitAccount);
      if (debitFlows) debitFlows.totalOutflowFen += entry.amountFen;
    }

    const result = accounts.map((acc) => {
      const flows = flowMap.get(acc.accountType as CashAccountType) ?? {
        totalInflowFen: 0,
        totalOutflowFen: 0,
      };

      return {
        id: acc.id,
        accountType: acc.accountType,
        balanceFen: acc.balanceFen,
        balanceYuan: fenToYuan(acc.balanceFen),
        countsAsEquityBase: acc.countsAsEquityBase,
        description: acc.description,
        updatedAt: acc.updatedAt.toISOString(),
        totalInflowFen: flows.totalInflowFen,
        totalInflowYuan: fenToYuan(flows.totalInflowFen),
        totalOutflowFen: flows.totalOutflowFen,
        totalOutflowYuan: fenToYuan(flows.totalOutflowFen),
      };
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[GET /api/cash-accounts] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch cash accounts" },
      { status: 500 },
    );
  }
}
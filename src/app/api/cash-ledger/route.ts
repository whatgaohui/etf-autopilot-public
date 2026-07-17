import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { fenToYuan } from "@/lib/types";
import type { CashAccountType } from "@/lib/types";

export const runtime = "nodejs";

// ─── Zod Schema ───────────────────────────────────────────────

const transferSchema = z.object({
  debitAccountType: z.nativeEnum({
    daily_cash: "daily_cash",
    weekly_unallocated_cash: "weekly_unallocated_cash",
    rebalance_equity_reserve: "rebalance_equity_reserve",
    qdii_pending_cash_sp500: "qdii_pending_cash_sp500",
    qdii_pending_cash_nasdaq: "qdii_pending_cash_nasdaq",
    manual_cash: "manual_cash",
    weekly_contribution_committed: "weekly_contribution_committed",
  }),
  creditAccountType: z.nativeEnum({
    daily_cash: "daily_cash",
    weekly_unallocated_cash: "weekly_unallocated_cash",
    rebalance_equity_reserve: "rebalance_equity_reserve",
    qdii_pending_cash_sp500: "qdii_pending_cash_sp500",
    qdii_pending_cash_nasdaq: "qdii_pending_cash_nasdaq",
    manual_cash: "manual_cash",
    weekly_contribution_committed: "weekly_contribution_committed",
  }),
  amountFen: z.number().int().positive(),
  description: z.string().min(1),
  referenceId: z.string().optional(),
});

// ─── GET: List cash ledger entries ────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get("accountId") as CashAccountType | null;
    const limit = parseInt(searchParams.get("limit") ?? "50", 10);
    const offset = parseInt(searchParams.get("offset") ?? "0", 10);

    const where = {
      status: "active" as const,
      ...(accountId
        ? {
            OR: [
              { debitAccount: accountId },
              { creditAccount: accountId },
            ],
          }
        : {}),
    };

    const [entries, total] = await Promise.all([
      db.cashLedger.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        take: Math.min(limit, 200),
        skip: offset,
      }),
      db.cashLedger.count({ where }),
    ]);

    const result = entries.map((e) => ({
      id: e.id,
      debitAccount: e.debitAccount,
      creditAccount: e.creditAccount,
      amountFen: e.amountFen,
      amountYuan: fenToYuan(e.amountFen),
      transferId: e.transferId,
      entryType: e.entryType,
      referenceId: e.referenceId,
      occurredAt: e.occurredAt.toISOString(),
      status: e.status,
      createdAt: e.createdAt.toISOString(),
    }));

    return NextResponse.json({
      success: true,
      data: result,
      total,
      limit: Math.min(limit, 200),
      offset,
    });
  } catch (error) {
    console.error("[GET /api/cash-ledger] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch cash ledger entries" },
      { status: 500 },
    );
  }
}

// ─── POST: Create manual transfer (double-entry) ──────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = transferSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const { debitAccountType, creditAccountType, amountFen, description, referenceId } =
      parsed.data;

    if (debitAccountType === creditAccountType) {
      return NextResponse.json(
        { success: false, error: "Debit and credit accounts must be different" },
        { status: 400 },
      );
    }

    const transferId = crypto.randomUUID();

    // Create two entries in a transaction (double-entry bookkeeping)
    const [debitEntry, creditEntry] = await db.$transaction(async (tx) => {
      // Debit entry (money leaves debitAccount)
      const debit = await tx.cashLedger.create({
        data: {
          debitAccount: debitAccountType as CashAccountType,
          creditAccount: creditAccountType as CashAccountType,
          amountFen,
          transferId,
          entryType: "debit",
          referenceId,
          description,
          status: "active",
        },
      });

      // Credit entry (money enters creditAccount)
      const credit = await tx.cashLedger.create({
        data: {
          debitAccount: debitAccountType as CashAccountType,
          creditAccount: creditAccountType as CashAccountType,
          amountFen,
          transferId,
          entryType: "credit",
          referenceId,
          description,
          status: "active",
        },
      });

      return [debit, credit];
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          transferId,
          debitEntry: {
            ...debitEntry,
            amountYuan: fenToYuan(debitEntry.amountFen),
            occurredAt: debitEntry.occurredAt.toISOString(),
            createdAt: debitEntry.createdAt.toISOString(),
          },
          creditEntry: {
            ...creditEntry,
            amountYuan: fenToYuan(creditEntry.amountFen),
            occurredAt: creditEntry.occurredAt.toISOString(),
            createdAt: creditEntry.createdAt.toISOString(),
          },
        },
        message: "Transfer recorded successfully",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[POST /api/cash-ledger] error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create transfer" },
      { status: 500 },
    );
  }
}
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// POST /api/notify — 发送通知（V4 PRD§16 P2: 微信/邮件推送）
// 支持 webhook 方式推送到企业微信/钉钉/飞书
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, message, calculationId } = body;

    // 读取通知配置
    const webhookConfig = await db.systemConfig.findUnique({
      where: { key: 'notify_webhook_url' },
    });
    const notifyEnabled = await db.systemConfig.findUnique({
      where: { key: 'notify_enabled' },
    });

    if (notifyEnabled?.value !== 'true' || !webhookConfig?.value) {
      return NextResponse.json({
        success: false,
        message: '通知未启用或 webhook 未配置',
      });
    }

    const webhookUrl = webhookConfig.value;

    // 构造推送消息
    const payload = {
      msgtype: 'text',
      text: {
        content: `📊 ETF定投助手通知\n\n${message}\n\n计算批次: ${calculationId || '—'}\n时间: ${new Date().toLocaleString('zh-CN')}`,
      },
    };

    // 发送到 webhook（企业微信/钉钉/飞书通用格式）
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (resp.ok) {
      return NextResponse.json({ success: true, message: '通知发送成功' });
    } else {
      return NextResponse.json(
        { success: false, message: `webhook 返回 ${resp.status}` },
        { status: 502 }
      );
    }
  } catch (error) {
    console.error('Notify error:', error);
    return NextResponse.json(
      { success: false, message: '通知发送失败' },
      { status: 500 }
    );
  }
}
